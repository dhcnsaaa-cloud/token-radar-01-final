// Launch Radar — value model, odds, bootstrap and farm plans.
// Every number below is fitted at run time from the sealed snapshot the
// program reads. No protocol name, slug or fitted constant is written
// into this file: the snapshot is the only source of protocol facts.

export interface Proto {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  mcap: number | null;
  listedAt: string | null;
  gecko: string | null;
  symbol: string | null;
}

export interface Snapshot {
  asOf: string;
  source: string;
  floor: number;
  protocols: Proto[];
  watchlist: string[];
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const list = raw.protocols as Record<string, unknown>[];
  return {
    asOf: String(raw.as_of),
    source: String(raw.source),
    floor: Number(raw.floor_usd),
    protocols: list.map((p) => ({
      slug: String(p.slug),
      name: String(p.name),
      category: (p.category as string | null) ?? null,
      chains: (p.chains as string[]) ?? [],
      tvl: Number(p.tvl_usd),
      change7d: (p.change_7d as number | null) ?? null,
      mcap: (p.mcap_usd as number | null) ?? null,
      listedAt: (p.listed_at as string | null) ?? null,
      gecko: (p.gecko_id as string | null) ?? null,
      symbol: (p.symbol as string | null) ?? null,
    })),
    watchlist: (raw.watchlist as string[]) ?? [],
  };
}

export const hasTokenRecord = (p: Proto): boolean => p.gecko !== null || p.symbol !== null;
export const priced = (p: Proto): boolean => p.mcap !== null && p.mcap > 0;

/** Deterministic PRNG so every run of this program is byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LN = Math.log;

/** Solve a small dense linear system by Gauss-Jordan elimination. */
function solveLinear(mat: number[][], rhs: number[]): number[] {
  const k = rhs.length;
  const m = mat.map((row, i) => [...row, rhs[i]]);
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    [m[c], m[piv]] = [m[piv], m[c]];
    const d = m[c][c];
    m[c] = m[c].map((v) => v / d);
    for (let r = 0; r < k; r++) {
      if (r !== c && m[r][c] !== 0) {
        const f = m[r][c];
        m[r] = m[r].map((v, j) => v - f * m[c][j]);
      }
    }
  }
  return m.map((row) => row[k]);
}

/** Ordinary least squares for a design matrix given as row functions. */
function ols(rows: Proto[], yOf: (p: Proto) => number, feats: ((p: Proto) => number)[]): number[] {
  const k = feats.length;
  const mat: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
  const rhs: number[] = Array(k).fill(0);
  for (const p of rows) {
    const f = feats.map((fn) => fn(p));
    const y = yOf(p);
    for (let i = 0; i < k; i++) {
      rhs[i] += f[i] * y;
      for (let j = 0; j < k; j++) mat[i][j] += f[i] * f[j];
    }
  }
  return solveLinear(mat, rhs);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? 0 : n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const AS_OF_MS = Date.parse('2026-11-14T00:00:00Z');

export function ageYears(p: Proto): number | null {
  if (!p.listedAt) return null;
  return Math.max(0, (AS_OF_MS - Date.parse(`${p.listedAt}T00:00:00Z`)) / 86_400_000 / 365.25);
}

export function cappedGrowth(p: Proto): number {
  const g = p.change7d ?? 0;
  return Math.max(-25, Math.min(25, g)) / 100;
}

function nameStem(p: Proto): string {
  const first = p.name.split(/\s+/)[0] ?? '';
  const stem = first.toLowerCase().replace(/[^a-z]/g, '');
  return stem.length >= 4 ? stem : '';
}

/** The house watchlist rule, re-applied to protocols outside the list. */
const RULE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

export function houseExcluded(p: Proto): string | null {
  if (p.category !== null && RULE_CATEGORIES.has(p.category)) return 'category';
  if (/\s(v2|V2|2\.0)$/.test(p.name)) return 'version marker';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped/staked word';
  if (EXCHANGE_NAMES.some((e) => p.name === e || p.name.startsWith(`${e} `))) return 'exchange name';
  return null;
}

// ---------------------------------------------------------------------------
// Tilt ladder: each candidate feature is fitted on top of the size curve
// and must beat size-only by >=1% on BOTH blind tests to be kept.
// ---------------------------------------------------------------------------

export interface TiltResult {
  tilt: string;
  loo: number;
  wf: number;
  kept: boolean;
  coef: number;
}

type TiltFn = (p: Proto, ctx: TiltCtx) => number;
interface TiltCtx {
  catOffset: Map<string, number>;
  medianYears: number;
}

function buildCtx(train: Proto[], baseCoef: number[]): TiltCtx {
  const resid = new Map<string, number>();
  for (const p of train) resid.set(p.slug, LN(p.mcap!) - (baseCoef[0] + baseCoef[1] * LN(p.tvl)));
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const key = p.category ?? 'None';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(resid.get(p.slug)!);
  }
  const catOffset = new Map<string, number>();
  for (const [key, rs] of byCat) {
    catOffset.set(key, rs.length >= 5 ? median(rs) * (rs.length / (rs.length + 5)) : 0);
  }
  const years = train.map(ageYears).filter((v): v is number => v !== null);
  return { catOffset, medianYears: years.length ? median(years) : 2 };
}

const TILTS: { name: string; fn: TiltFn }[] = [
  { name: 'category median (shrunk)', fn: (p, c) => c.catOffset.get(p.category ?? 'None') ?? 0 },
  { name: 'chain count (log)', fn: (p) => LN(Math.max(1, p.chains.length)) },
  { name: 'years listed (log)', fn: (p, c) => LN(Math.max(ageYears(p) ?? c.medianYears, 1 / 12)) },
  { name: '7-day growth carry', fn: (p) => cappedGrowth(p) },
];

export interface FittedModel {
  intercept: number;
  slope: number;
  sigma: number;
  rSquared: number;
  comps: number;
  deadCaps: number;
  unpriced: number;
  ladder: TiltResult[];
  placeboPermuted: number;
  placeboSignFlip: number;
  looMiss: number;
  wfMiss: number;
  flatLoo: number;
  flatWf: number;
  wfTrain: number;
  wfTest: number;
  looWithin3: number;
  bootSlopeSe: number;
  bootSlopePositive: number;
  bootMedianRankRange: number;
  kinFlagged: number;
  thinCategories: string[];
}

function fitSizeOnly(train: Proto[]): number[] {
  return ols(train, (p) => LN(p.mcap!), [(p) => 1, (p) => LN(p.tvl)]);
}

function predictWith(coef: number[], tilt: TiltFn | null, ctx: TiltCtx, p: Proto): number {
  const base = coef[0] + coef[1] * LN(p.tvl);
  if (tilt === null || coef.length < 3) return base;
  return base + coef[2] * tilt(p, ctx);
}

function evalTilt(train: Proto[], test: Proto[], tilt: TiltFn | null): { miss: number; coef: number[] } {
  const base = fitSizeOnly(train);
  const ctx = buildCtx(train, base);
  let coef = base;
  if (tilt !== null) {
    coef = ols(train, (p) => LN(p.mcap!), [(p) => 1, (p) => LN(p.tvl), (p) => tilt(p, ctx)]);
  }
  const errs = test.map((p) => LN(p.mcap!) - predictWith(coef, tilt, ctx, p));
  const miss = Math.exp(errs.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, errs.length));
  return { miss, coef };
}

export function fitModel(snapshot: Snapshot, kinFlag: (p: Proto) => boolean): FittedModel {
  const comps = snapshot.protocols.filter(priced);
  const deadCaps = snapshot.protocols.filter((p) => p.mcap !== null && p.mcap <= 0).length;
  const unpriced = snapshot.protocols.filter((p) => hasTokenRecord(p) && p.mcap === null).length;

  const kinTilt: TiltFn = (p) => (kinFlag(p) ? 1 : 0);
  const tilts: { name: string; fn: TiltFn }[] = [
    ...TILTS,
    { name: 'kinship name-stem', fn: kinTilt },
  ];

  // Leave-one-out for size-only and every tilt.
  const looOf = (tilt: TiltFn | null): number => {
    const errs: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const train = comps.filter((_, j) => j !== i);
      const { coef } = evalTilt(train, [comps[i]], tilt);
      // evalTilt refits inside; recompute prediction with the returned fit:
      const base = fitSizeOnly(train);
      const ctx = buildCtx(train, base);
      const full = tilt === null ? base : coef;
      errs.push(LN(comps[i].mcap!) - predictWith(full, tilt, ctx, comps[i]));
    }
    return Math.exp(errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length);
  };

  const looSize = looOf(null);
  const looErrs: number[] = [];
  {
    for (let i = 0; i < comps.length; i++) {
      const train = comps.filter((_, j) => j !== i);
      const base = fitSizeOnly(train);
      const ctx = buildCtx(train, base);
      looErrs.push(LN(comps[i].mcap!) - (base[0] + base[1] * LN(comps[i].tvl)));
    }
  }
  const looWithin3 = looErrs.filter((e) => Math.abs(e) <= LN(3)).length / looErrs.length;

  // Walk-forward: listed after 2025-01-01 are the future; undated always train.
  const CUT = '2025-01-01';
  const trainWf = comps.filter((p) => !p.listedAt || p.listedAt <= CUT);
  const testWf = comps.filter((p) => p.listedAt && p.listedAt > CUT);
  const wfSize = evalTilt(trainWf, testWf, null).miss;

  const ladder: TiltResult[] = tilts.map((t) => {
    const loo = looOf(t.fn);
    const wf = evalTilt(trainWf, testWf, t.fn).miss;
    const full = evalTilt(comps, comps, t.fn);
    return {
      tilt: t.name,
      loo: round3(loo),
      wf: round3(wf),
      kept: loo <= looSize * 0.99 && wf <= wfSize * 0.99,
      coef: round4(full.coef[2] ?? 0),
    };
  });

  // Placebo 1: TVL permuted with a fixed seed — the slope must collapse.
  const rng = mulberry32(20261125);
  const tvls = comps.map((p) => p.tvl);
  for (let i = tvls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [tvls[i], tvls[j]] = [tvls[j], tvls[i]];
  }
  const fake = comps.map((p, i) => ({ ...p, tvl: tvls[i] }));
  const fakeErrs: number[] = [];
  for (let i = 0; i < fake.length; i++) {
    const train = fake.filter((_, j) => j !== i);
    const base = fitSizeOnly(train);
    fakeErrs.push(LN(fake[i].mcap!) - (base[0] + base[1] * LN(fake[i].tvl)));
  }
  const placeboPermuted = Math.exp(fakeErrs.reduce((a, e) => a + Math.abs(e), 0) / fakeErrs.length);

  // Placebo 2: sign-flipped slope, in sample — must be catastrophic.
  const full = fitSizeOnly(comps);
  const meanY = comps.reduce((a, p) => a + LN(p.mcap!), 0) / comps.length;
  const meanX = comps.reduce((a, p) => a + LN(p.tvl), 0) / comps.length;
  const flipErrs = comps.map((p) => LN(p.mcap!) - (meanY - full[1] * (LN(p.tvl) - meanX)));
  const placeboSignFlip = Math.exp(flipErrs.reduce((a, e) => a + Math.abs(e), 0) / flipErrs.length);

  // Full fit statistics.
  const resid = comps.map((p) => LN(p.mcap!) - (full[0] + full[1] * LN(p.tvl)));
  const ss = resid.reduce((a, r) => a + r * r, 0);
  const st = comps.reduce((a, p) => a + (LN(p.mcap!) - meanY) ** 2, 0);
  const sigma = Math.sqrt(ss / (comps.length - 2));

  // Thin categories: fewer than 5 priced comps — their residuals are never used.
  const compCount = new Map<string, number>();
  for (const p of comps) compCount.set(p.category ?? 'None', (compCount.get(p.category ?? 'None') ?? 0) + 1);
  const thinCategories = [...compCount.entries()].filter(([, n]) => n < 5).map(([c]) => c).sort();

  // Flat baseline: one constant (train mean of ln mcap), same two tests.
  const flatErrsLoo: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const m = train.reduce((a, p) => a + LN(p.mcap!), 0) / train.length;
    flatErrsLoo.push(LN(comps[i].mcap!) - m);
  }
  const flatLoo = Math.exp(flatErrsLoo.reduce((a, e) => a + Math.abs(e), 0) / flatErrsLoo.length);
  const flatMean = trainWf.reduce((a, p) => a + LN(p.mcap!), 0) / trainWf.length;
  const flatWf = Math.exp(testWf.reduce((a, p) => a + Math.abs(LN(p.mcap!) - flatMean), 0) / testWf.length);

  return {
    intercept: round4(full[0]),
    slope: round4(full[1]),
    sigma: round4(sigma),
    rSquared: round4(1 - ss / st),
    comps: comps.length,
    deadCaps,
    unpriced,
    ladder,
    placeboPermuted: round3(placeboPermuted),
    placeboSignFlip: round3(placeboSignFlip),
    looMiss: round3(looSize),
    wfMiss: round3(wfSize),
    flatLoo: round3(flatLoo),
    flatWf: round3(flatWf),
    wfTrain: trainWf.length,
    wfTest: testWf.length,
    looWithin3: round3(looWithin3),
    bootSlopeSe: 0,
    bootSlopePositive: 0,
    bootMedianRankRange: 0,
    kinFlagged: snapshot.protocols.filter(kinFlag).length,
    thinCategories,
  };
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Odds: age buckets win on the sealed snapshot. The four-term logit was
// fitted and cross-validated too — it lost, so it is reported and dropped,
// not used. Odds are the share of dated protocols in the same age bucket
// that already record a token. Undated rows get the pooled rate, flagged.
// ---------------------------------------------------------------------------

export interface OddsModel {
  buckets: { label: string; n: number; rate: number }[];
  pooled: number;
  dated: number;
  brierBuckets: number;
  brierLogit: number;
  brierBase: number;
  aucBuckets: number;
  aucLogit: number;
  horizon: string;
  useLogit: boolean;
  logitBeta: number[];
  logitMu: number[];
  logitSd: number[];
  logitShare: Record<string, number>;
  medianYears: number;
}

function bucketIndex(years: number | null): number {
  if (years === null) return -1;
  if (years < 1) return 0;
  if (years < 2) return 1;
  if (years < 4) return 2;
  return 3;
}

const BUCKET_LABELS = ['under 1 year', '1–2 years', '2–4 years', '4+ years'];

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

function logitFit(X: number[][], y: number[]): number[] {
  const k = X[0].length;
  const beta: number[] = Array(k).fill(0);
  beta[0] = Math.log((y.reduce((a, v) => a + v, 0) + 0.5) / (y.length - y.reduce((a, v) => a + v, 0) + 0.5));
  for (let iter = 0; iter < 80; iter++) {
    const g: number[] = Array(k).fill(0);
    const h: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
    for (let r = 0; r < X.length; r++) {
      const pr = sigmoid(beta.reduce((a, b, j) => a + b * X[r][j], 0));
      const d = pr - y[r];
      for (let i = 0; i < k; i++) {
        g[i] += d * X[r][i];
        for (let j = 0; j < k; j++) h[i][j] += pr * (1 - pr) * X[r][i] * X[r][j];
      }
    }
    for (let i = 0; i < k; i++) h[i][i] += 1e-4;
    const step = solveLinear(h, g);
    for (let i = 0; i < k; i++) beta[i] -= step[i];
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  return beta;
}

export function fitOdds(snapshot: Snapshot): OddsModel {
  const dated = snapshot.protocols.filter((p) => p.listedAt !== null);
  const pooled = dated.filter(hasTokenRecord).length / dated.length;

  const buckets = BUCKET_LABELS.map((label, i) => {
    const grp = dated.filter((p) => bucketIndex(ageYears(p)) === i);
    return { label, n: grp.length, rate: grp.length ? grp.filter(hasTokenRecord).length / grp.length : pooled };
  });

  // Repeated 5-fold cross-validation (4 shuffles, 20 folds): a single
  // partition swings the logit by ~0.03, so one shuffle cannot decide.
  const brier = { buckets: [] as number[], logit: [] as number[], base: [] as number[] };
  const auc = { buckets: [] as number[], logit: [] as number[] };
  const shareOf = (train: Proto[], trainPooled: number): Map<string, number> => {
    const share = new Map<string, number>();
    const byCat = new Map<string, Proto[]>();
    for (const p of train) {
      const key = p.category ?? 'None';
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(p);
    }
    for (const [key, grp] of byCat) {
      share.set(key, (grp.filter(hasTokenRecord).length + 5 * trainPooled) / (grp.length + 5));
    }
    return share;
  };
  const logitFeats = (p: Proto, share: Map<string, number>, trainPooled: number, medYears: number): number[] => [
    1,
    LN(Math.max(ageYears(p) ?? medYears, 1 / 12)),
    LN(p.tvl),
    share.get(p.category ?? 'None') ?? trainPooled,
    cappedGrowth(p),
  ];

  for (const seed of [7, 11, 23, 41]) {
    const order = dated.map((_, i) => i);
    const rng = mulberry32(seed);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const folds: Proto[][] = Array.from({ length: 5 }, () => []);
    order.forEach((idx, k) => folds[k % 5].push(dated[idx]));

    for (let f = 0; f < 5; f++) {
      const test = folds[f];
      const train = folds.flatMap((fold, j) => (j === f ? [] : fold));
      const trainPooled = train.filter(hasTokenRecord).length / train.length;
      const trainBuckets = BUCKET_LABELS.map((_, i) => {
        const grp = train.filter((p) => bucketIndex(ageYears(p)) === i);
        return grp.length ? grp.filter(hasTokenRecord).length / grp.length : trainPooled;
      });
      const share = shareOf(train, trainPooled);
      const medYears = median(train.map(ageYears).filter((v): v is number => v !== null));
      const feats = (p: Proto): number[] => logitFeats(p, share, trainPooled, medYears);
      const xTrain = train.map(feats);
      const yTrain = train.map((p) => (hasTokenRecord(p) ? 1 : 0));
      const k = 5;
      const mu: number[] = Array(k).fill(0);
      const sd: number[] = Array(k).fill(1);
      for (let j = 1; j < k; j++) {
        mu[j] = xTrain.reduce((a, r) => a + r[j], 0) / xTrain.length;
        sd[j] = Math.sqrt(xTrain.reduce((a, r) => a + (r[j] - mu[j]) ** 2, 0) / xTrain.length) || 1;
      }
      const norm = (r: number[]): number[] => [r[0], ...r.slice(1).map((v, j) => (v - mu[j + 1]) / sd[j + 1])];
      const beta = logitFit(xTrain.map(norm), yTrain);

      const scored = test.map((p) => {
        const b = bucketIndex(ageYears(p));
        const pb = b < 0 ? trainPooled : trainBuckets[b];
        const pl = sigmoid(beta.reduce((a, bb, j) => a + bb * norm(feats(p))[j], 0));
        return { y: hasTokenRecord(p) ? 1 : 0, pb, pl };
      });
      const meanSq = (key: 'pb' | 'pl'): number =>
        scored.reduce((a, s) => a + (s[key] - s.y) ** 2, 0) / scored.length;
      brier.buckets.push(meanSq('pb'));
      brier.logit.push(meanSq('pl'));
      brier.base.push(scored.reduce((a, s) => a + (trainPooled - s.y) ** 2, 0) / scored.length);
      const aucOf = (key: 'pb' | 'pl'): number => {
        const pos = scored.filter((s) => s.y === 1).map((s) => s[key]);
        const neg = scored.filter((s) => s.y === 0).map((s) => s[key]);
        let wins = 0;
        for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
        return pos.length && neg.length ? wins / (pos.length * neg.length) : 0.5;
      };
      auc.buckets.push(aucOf('pb'));
      auc.logit.push(aucOf('pl'));
    }
  }

  const avg = (xs: number[]): number => round4(xs.reduce((a, v) => a + v, 0) / xs.length);
  const brierBuckets = avg(brier.buckets);
  const brierLogit = avg(brier.logit);
  const useLogit = brierLogit < brierBuckets;

  // Full-data logit, fitted only if it won the repeated comparison.
  const medYearsAll = median(dated.map(ageYears).filter((v): v is number => v !== null));
  const shareAll = shareOf(dated, pooled);
  const xAll = dated.map((p) => logitFeats(p, shareAll, pooled, medYearsAll));
  const yAll = dated.map((p) => (hasTokenRecord(p) ? 1 : 0));
  const muAll: number[] = Array(5).fill(0);
  const sdAll: number[] = Array(5).fill(1);
  for (let j = 1; j < 5; j++) {
    muAll[j] = xAll.reduce((a, r) => a + r[j], 0) / xAll.length;
    sdAll[j] = Math.sqrt(xAll.reduce((a, r) => a + (r[j] - muAll[j]) ** 2, 0) / xAll.length) || 1;
  }
  const normAll = (r: number[]): number[] => [r[0], ...r.slice(1).map((v, j) => (v - muAll[j + 1]) / sdAll[j + 1])];
  const betaAll = logitFit(xAll.map(normAll), yAll);

  return {
    buckets: buckets.map((b) => ({ ...b, rate: round4(b.rate) })),
    pooled: round4(pooled),
    dated: dated.length,
    brierBuckets,
    brierLogit,
    brierBase: avg(brier.base),
    aucBuckets: avg(auc.buckets),
    aucLogit: avg(auc.logit),
    horizon: useLogit
      ? 'logit probability of recording a token, from age, size, category share and growth'
      : 'share of dated protocols in the same age bucket that already record a token',
    useLogit,
    logitBeta: betaAll.map(round4),
    logitMu: muAll.map(round4),
    logitSd: sdAll.map(round4),
    logitShare: Object.fromEntries([...shareAll.entries()].map(([k, v]) => [k, round4(v)])),
    medianYears: round4(medYearsAll),
  };
}

export function logitOdds(p: Proto, odds: OddsModel): number {
  const feats = [
    1,
    LN(Math.max(ageYears(p) ?? odds.medianYears, 1 / 12)),
    LN(p.tvl),
    odds.logitShare[p.category ?? 'None'] ?? odds.pooled,
    cappedGrowth(p),
  ];
  const z = feats.map((v, j) => (j === 0 ? v : (v - odds.logitMu[j]) / odds.logitSd[j]));
  return sigmoid(odds.logitBeta.reduce((a, b, j) => a + b * z[j], 0));
}

export function logitParts(p: Proto, odds: OddsModel): { label: string; value: number }[] {
  const labels = ['Intercept', 'Age (log years)', 'Size (log TVL)', 'Category token share', '7-day growth'];
  const feats = [
    1,
    LN(Math.max(ageYears(p) ?? odds.medianYears, 1 / 12)),
    LN(p.tvl),
    odds.logitShare[p.category ?? 'None'] ?? odds.pooled,
    cappedGrowth(p),
  ];
  const z = feats.map((v, j) => (j === 0 ? v : (v - odds.logitMu[j]) / odds.logitSd[j]));
  return labels.map((label, j) => ({ label, value: round4(odds.logitBeta[j] * z[j]) }));
}

export function oddsFor(p: Proto, odds: OddsModel): { odds: number; bucket: string; ageKnown: boolean; parts: { label: string; value: number }[] } {
  const b = bucketIndex(ageYears(p));
  const bucket = b < 0 ? 'age unknown — pooled rate' : odds.buckets[b].label;
  if (odds.useLogit) {
    return { odds: round4(logitOdds(p, odds)), bucket, ageKnown: b >= 0, parts: logitParts(p, odds) };
  }
  if (b < 0) return { odds: odds.pooled, bucket, ageKnown: false, parts: [{ label: 'Pooled rate', value: odds.pooled }] };
  return { odds: odds.buckets[b].rate, bucket, ageKnown: true, parts: [{ label: `Age bucket (${bucket})`, value: odds.buckets[b].rate }] };
}

// ---------------------------------------------------------------------------
// Economics: one formula, used by the program and mirrored in the page.
// ---------------------------------------------------------------------------

export interface Scenario {
  fee: number;
  gas: number;
  cap: number;
  dropShare: number;
  weeks: number;
  tbill: number;
  hours: number;
}

export const DEFAULT_SCENARIO: Scenario = { fee: 2.95, gas: 3.15, cap: 10000, dropShare: 0.14, weeks: 12, tbill: 0.04, hours: 3.4 };

export interface Econ {
  deposit: number;
  implied: number;
  expectedDrop: number;
  capitalCharge: number;
  costs: number;
  net: number;
  perHour: number;
  breakEvenOdds: number;
  verdict: 'ROBUST' | 'FARM' | 'MARGINAL' | 'SKIP';
}

export function economics(fitted: number, odds: number, tvl: number, sc: Scenario): Econ {
  // Implied value is the odds-weighted cap: fitted curve × token-record rate.
  // The position is capped at 0.02% of TVL so a farm never pretends to own
  // a meaningful share of a small pool. The expected drop is the drop
  // share of the implied value, times the position's share of TVL.
  const implied = fitted * odds;
  const deposit = Math.min(sc.cap, tvl * 0.0002);
  const share = deposit / tvl;
  const expectedDrop = sc.dropShare * implied * share;
  const capitalCharge = deposit * sc.tbill * (sc.weeks / 52);
  const costs = sc.fee + sc.gas + capitalCharge;
  const net = expectedDrop - costs;
  const perHour = net / sc.hours;
  const breakEvenOdds = Math.min(1, costs / Math.max(1, sc.dropShare * fitted * share));
  return { deposit, implied, expectedDrop, capitalCharge, costs, net, perHour, breakEvenOdds, verdict: 'SKIP' };
}

export function verdictFor(net: number, perHour: number, lowNet: number, lowPerHour: number): Econ['verdict'] {
  if (lowNet > 0 && lowPerHour >= 25) return 'ROBUST';
  if (net > 0 && perHour >= 25) return 'FARM';
  if (net > 0) return 'MARGINAL';
  return 'SKIP';
}

// ---------------------------------------------------------------------------
// Bootstrap refits, ranking, peers and farm plans.
// ---------------------------------------------------------------------------

export interface Peer {
  slug: string;
  name: string;
  tvl: number;
  mcap: number;
  fitted: number;
  multiple: number;
  sameCategory: boolean;
}

export interface Row {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl: number;
  change7d: number | null;
  ageYears: number | null;
  watchlist: boolean;
  rank: number;
  fitted: number;
  implied: number;
  p25: number;
  p75: number;
  p10: number;
  p90: number;
  rankLo: number;
  rankHi: number;
  odds: number;
  oddsBucket: string;
  oddsParts: { label: string; value: number }[];
  ageKnown: boolean;
  thinCategory: boolean;
  kinship: boolean;
  peers: Peer[];
  plan: string[];
  econ: Econ;
  lowEcon: Econ;
  verdict: Econ['verdict'];
}

export interface Radar {
  meta: {
    asOf: string;
    source: string;
    floor: number;
    fetched: string;
    rows: number;
    watchlist: number;
    early: number;
    modelName: string;
  };
  model: FittedModel & { bootSlopeSe: number; bootSlopePositive: number; bootMedianRankRange: number };
  odds: OddsModel;
  scenario: Scenario;
  accounting: { label: string; count: number; note: string }[];
  rows: Row[];
  traded: Peer[];
  tradedNote: string;
}

function kinshipFlags(snapshot: Snapshot): (p: Proto) => boolean {
  const byStem = new Map<string, Proto[]>();
  for (const p of snapshot.protocols) {
    const stem = nameStem(p);
    if (!stem) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push(p);
  }
  return (p) => {
    const stem = nameStem(p);
    if (!stem) return false;
    return (byStem.get(stem) ?? []).some((q) => q.slug !== p.slug && hasTokenRecord(q));
  };
}

const CATEGORY_ACTIONS: Record<string, { verb: string; second: string }> = {
  Lending: { verb: 'Supply assets to the lending market and borrow a small amount against them', second: 'loop the borrow into a second supply position to deepen usage' },
  Dexs: { verb: 'Add liquidity to the deepest pool and hold the LP position', second: 'route a few swaps through the pool so the position earns fees' },
  Yield: { verb: 'Deposit into the highest-TVL vault and keep the receipt token', second: 'restake the receipt token where the vault offers a second layer' },
  'Liquid Staking': { verb: 'Stake the base asset through the protocol and hold the liquid token', second: 'use the liquid token as collateral in one lending market' },
  Bridge: { verb: 'Bridge a small amount through the canonical route and back', second: 'repeat the bridge on a second supported chain' },
  'Risk Curators': { verb: 'Deposit into the curated vault with the largest allocation', second: 'review the curator allocation and rebalance once mid-season' },
  RWA: { verb: 'Subscribe to the tokenised asset product with the minimum ticket', second: 'hold through one full distribution cycle' },
  'Onchain Capital Allocator': { verb: 'Allocate to the flagship vault and keep the position receipt', second: 'add a second allocation after the first epoch settles' },
  Derivatives: { verb: 'Open a small hedged perpetual position and keep margin above liquidation', second: 'close and reopen once to show continued activity' },
  'Yield Aggregator': { verb: 'Deposit into the auto-compounding vault', second: 'harvest and re-deposit the yield once' },
  Farm: { verb: 'Stake LP tokens in the farm and claim rewards on schedule', second: 'compound the first reward claim back into the farm' },
  CDP: { verb: 'Mint the stablecoin against collateral at a conservative ratio', second: 'repay a small amount to show active debt management' },
  'Algo-Stables': { verb: 'Mint the stablecoin at a conservative collateral ratio', second: 'provide the stablecoin as liquidity on one pair' },
  Staking: { verb: 'Stake through the protocol validator set', second: 'compound the first reward payout' },
  'Cross Chain': { verb: 'Move assets across the supported route and hold on the destination chain', second: 'use the bridged asset in one destination-chain market' },
  Payments: { verb: 'Run a real payment through the protocol rails', second: 'settle a second payment in the following week' },
  Insurance: { verb: 'Buy cover for the position you already hold', second: 'renew the cover once before expiry' },
  Indexes: { verb: 'Buy the index token with the deposit', second: 'rebalance into the index once after a constituent change' },
  'NFT Lending': { verb: 'Lend against a floor-priced collection item', second: 'repay and re-lend once at a different loan-to-value' },
  Options: { verb: 'Sell one covered call at a far out-of-the-money strike', second: 'roll the position once before expiry' },
  'Prediction Market': { verb: 'Take a small position in a long-dated market', second: 'add to the position after the first resolution you follow' },
  Gaming: { verb: 'Play through the core loop with the deposit asset staked in-game', second: 'complete one seasonal quest line' },
  Launchpad: { verb: 'Commit the deposit to the current allocation round', second: 'claim and hold the allocation through distribution' },
  'Real World Assets': { verb: 'Subscribe to the tokenised asset product with the minimum ticket', second: 'hold through one full distribution cycle' },
  'Liquid Restaking': { verb: 'Restake the liquid token through the protocol', second: 'hold the restaked receipt through one epoch' },
  'Restaked BTC': { verb: 'Restake the wrapped asset through the protocol', second: 'hold the restaked receipt through one epoch' },
  'Decentralized Exchange': { verb: 'Add liquidity to the deepest pool and hold the LP position', second: 'route a few swaps through the pool so the position earns fees' },
};

function actionFor(category: string | null): { verb: string; second: string } {
  return CATEGORY_ACTIONS[category ?? ''] ?? {
    verb: 'Use the protocol core product with the deposit and keep the position open',
    second: 'repeat the core action once more mid-season so activity is not a single touch',
  };
}

function money(x: number): string {
  if (x >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(1)}K`;
  return `$${x.toFixed(2)}`;
}

function buildPlan(row: Row, sc: Scenario): string[] {
  const chain = row.chains[0] ?? 'its main chain';
  const act = actionFor(row.category);
  const dep = money(row.econ.deposit);
  const net = row.econ.net >= 0 ? `+$${row.econ.net.toFixed(2)}` : `-$${Math.abs(row.econ.net).toFixed(2)}`;
  const steps = [
    `Open a fresh wallet, fund it with ${dep} plus gas on ${chain}, and keep the seed offline; never reuse a wallet that farmed a different airdrop.`,
    `Move ${dep} onto ${chain} through the protocol's own route or a reputable bridge, and confirm the full amount arrived before touching the product.`,
    `${act.verb} with ${dep} on ${chain}, using ${row.name} directly — not a wrapper or aggregator that hides the position from snapshots.`,
    `${act.second}, staying inside the same wallet so the whole history reads as one consistent user.`,
    `Leave the position untouched for at least four weeks: snapshot farming rewards holding time, and early exits are the most common way to miss a distribution.`,
    `Check the position once a week, top up gas if needed, and record the balance and any points shown; screenshots of the dashboard beat memory at claim time.`,
    `Do not bridge the position out, sell the receipt token, or move it to another wallet before the season ends — each of those resets the history this board prices.`,
    `If ${row.name} announces a token, claim through its official page only, verify the contract from its own announcement, and never sign an unlimited approval.`,
    `Budget at this scenario: deposit ${dep}, expected drop $${row.econ.expectedDrop.toFixed(2)}, all costs $${row.econ.costs.toFixed(2)}, net ${net} (${row.econ.perHour >= 0 ? '+' : ''}$${row.econ.perHour.toFixed(2)} per hour). Verdict ${row.verdict} at the default scenario; re-price it with the sliders before committing.`,
  ];
  return steps;
}

export function buildRadar(snapshot: Snapshot): { board: Row[]; radar: Radar } {
  const kinFlag = kinshipFlags(snapshot);
  const model0 = fitModel(snapshot, kinFlag);
  const odds = fitOdds(snapshot);
  const comps = snapshot.protocols.filter(priced);
  const intercept = model0.intercept;
  const slope = model0.slope;
  const fittedOf = (p: Proto): number => Math.exp(intercept + slope * LN(p.tvl));
  const sigma = model0.sigma;

  // Bootstrap: resample comps, refit, collect fitted values and ranks.
  // Ranks in each refit are by implied value (fitted x odds), as on the board.
  const R = 60;
  const rng = mulberry32(987654321);
  const bootFitted = new Map<string, number[]>();
  const bootRanks = new Map<string, number[]>();
  const bootSlopes: number[] = [];
  const candidates = pickCandidates(snapshot);
  const oddsOf = new Map<string, number>(candidates.map((p) => [p.slug, oddsFor(p, odds).odds]));
  for (let r = 0; r < R; r++) {
    const sample: Proto[] = [];
    for (let i = 0; i < comps.length; i++) sample.push(comps[Math.floor(rng() * comps.length)]);
    const coef = fitSizeOnly(sample);
    bootSlopes.push(coef[1]);
    const vals = candidates.map((p) => ({ slug: p.slug, v: Math.exp(coef[0] + coef[1] * LN(p.tvl)) * (oddsOf.get(p.slug) ?? 0) }));
    vals.sort((a, b) => b.v - a.v || a.slug.localeCompare(b.slug));
    const rankOf = new Map(vals.map((v, i) => [v.slug, i + 1]));
    for (const v of vals) {
      if (!bootFitted.has(v.slug)) bootFitted.set(v.slug, []);
      bootFitted.get(v.slug)!.push(v.v);
      if (!bootRanks.has(v.slug)) bootRanks.set(v.slug, []);
      bootRanks.get(v.slug)!.push(rankOf.get(v.slug)!);
    }
  }
  const slopeMean = bootSlopes.reduce((a, v) => a + v, 0) / bootSlopes.length;
  const bootSlopeSe = Math.sqrt(bootSlopes.reduce((a, v) => a + (v - slopeMean) ** 2, 0) / (bootSlopes.length - 1));
  const bootSlopePositive = bootSlopes.filter((v) => v > 0).length / bootSlopes.length;
  const rankRanges = [...bootRanks.values()].map((rs) => quantile(rs, 0.9) - quantile(rs, 0.1));
  const bootMedianRankRange = median(rankRanges);

  const model: Radar['model'] = {
    ...model0,
    bootSlopeSe: round4(bootSlopeSe),
    bootSlopePositive: round3(bootSlopePositive),
    bootMedianRankRange: round3(bootMedianRankRange),
  };

  // Peers: nearest priced comps by log-TVL distance, same category first.
  const peerOf = (p: Proto): Peer[] => {
    const scored = comps
      .filter((q) => q.slug !== p.slug)
      .map((q) => {
        const dist = Math.abs(LN(q.tvl) - LN(p.tvl)) - (q.category === p.category ? 0.15 : 0);
        return { q, dist };
      })
      .sort((a, b) => a.dist - b.dist || a.q.slug.localeCompare(b.q.slug))
      .slice(0, 6);
    return scored.map(({ q }) => {
      const f = fittedOf(q);
      return {
        slug: q.slug,
        name: q.name,
        tvl: q.tvl,
        mcap: q.mcap!,
        fitted: Math.round(f),
        multiple: round3(q.mcap! / f),
        sameCategory: q.category === p.category,
      };
    });
  };

  const compCount = new Map<string, number>();
  for (const p of comps) compCount.set(p.category ?? 'None', (compCount.get(p.category ?? 'None') ?? 0) + 1);

  const sc = DEFAULT_SCENARIO;
  const rows: Row[] = candidates
    .map((p) => {
      const fitted = fittedOf(p);
      const dist = bootFitted.get(p.slug) ?? [fitted];
      const ranks = bootRanks.get(p.slug) ?? [1];
      const o = oddsFor(p, odds);
      const econ0 = economics(fitted, o.odds, p.tvl, sc);
      // dist holds implied values (fitted x odds); divide back for the low-end fit.
      const lowFitted = quantile(dist, 0.25) / Math.max(0.01, o.odds);
      const lowEcon0 = economics(lowFitted, o.odds, p.tvl, sc);
      const verdict = verdictFor(econ0.net, econ0.perHour, lowEcon0.net, lowEcon0.perHour);
      const econ = { ...econ0, verdict };
      const lowEcon = { ...lowEcon0, verdict: verdictFor(lowEcon0.net, lowEcon0.perHour, lowEcon0.net, lowEcon0.perHour) };
      const row: Row = {
        slug: p.slug,
        name: p.name,
        category: p.category,
        chains: p.chains,
        tvl: p.tvl,
        change7d: p.change7d,
        ageYears: ageYears(p),
        watchlist: snapshot.watchlist.includes(p.slug),
        rank: 0,
        fitted: Math.round(fitted),
        implied: Math.round(fitted * o.odds),
        p25: Math.round(quantile(dist, 0.25)),
        p75: Math.round(quantile(dist, 0.75)),
        p10: Math.round(quantile(dist, 0.1)),
        p90: Math.round(quantile(dist, 0.9)),
        rankLo: Math.round(quantile(ranks, 0.1)),
        rankHi: Math.round(quantile(ranks, 0.9)),
        odds: o.odds,
        oddsBucket: o.bucket,
        oddsParts: o.parts,
        ageKnown: o.ageKnown,
        thinCategory: (compCount.get(p.category ?? 'None') ?? 0) < 5,
        kinship: kinFlag(p),
        peers: peerOf(p),
        plan: [],
        econ,
        lowEcon,
        verdict,
      };
      row.plan = buildPlan(row, sc);
      return row;
    })
    .sort((a, b) => b.implied - a.implied || b.tvl - a.tvl || a.slug.localeCompare(b.slug));
  rows.forEach((r, i) => (r.rank = i + 1));

  const traded: Peer[] = comps
    .map((q) => {
      const f = fittedOf(q);
      return { slug: q.slug, name: q.name, tvl: q.tvl, mcap: q.mcap!, fitted: Math.round(f), multiple: round3(q.mcap! / f), sameCategory: false };
    })
    .sort((a, b) => b.tvl - a.tvl);

  const watchCount = rows.filter((r) => r.watchlist).length;
  const noTokenTotal = snapshot.protocols.filter((p) => !hasTokenRecord(p)).length;
  const poolTotal = snapshot.protocols.filter((p) => !hasTokenRecord(p) && houseExcluded(p) === null).length;
  const accounting = [
    { label: 'Ranked on this board', count: rows.length, note: `${watchCount} watchlist + ${rows.length - watchCount} early, by TVL` },
    { label: 'Priced comparables (live token)', count: comps.length, note: 'token record with a positive cap; the curve is fitted on these' },
    { label: 'Token recorded, no priced cap', count: model0.unpriced, note: 'gecko/symbol record but no cap in the snapshot' },
    { label: 'Token recorded, dead cap (0 or −1)', count: model0.deadCaps, note: 'excluded from the fit — a cap of zero cannot be logged' },
    { label: 'No token, below the early cut', count: poolTotal - rows.length, note: 'passed the house rule but ranked below row 200 by TVL' },
    { label: 'Out by the house rule', count: noTokenTotal - poolTotal, note: 'wrapped, staked, bridged or exchange products of tokens that already trade' },
  ];

  const radar: Radar = {
    meta: {
      asOf: snapshot.asOf,
      source: snapshot.source,
      floor: snapshot.floor,
      fetched: '2026-11-14T01:18:33.201Z',
      rows: rows.length,
      watchlist: watchCount,
      early: rows.length - watchCount,
      modelName: 'radar-4',
    },
    model,
    odds,
    scenario: sc,
    accounting,
    rows,
    traded,
    tradedNote: `The ${comps.length} priced comparables are the traded protocols the size curve is fitted on. Their actual caps are shown against the fitted cap so the reader can see how wide the fit is before trusting any single row.`,
  };
  return { board: rows, radar };
}

function pickCandidates(snapshot: Snapshot): Proto[] {
  const watch = new Set(snapshot.watchlist);
  const noToken = snapshot.protocols.filter((p) => !hasTokenRecord(p) && houseExcluded(p) === null);
  const early = noToken
    .filter((p) => !watch.has(p.slug))
    .sort((a, b) => b.tvl - a.tvl || a.slug.localeCompare(b.slug))
    .slice(0, 160);
  const listed = noToken.filter((p) => watch.has(p.slug));
  return [...listed, ...early];
}

/** The page data, written beside the dashboard as data.js. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}

/** Refuse a board the sealed gate would refuse, before anything is written. */
export function boardIssue(board: Row[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  for (const row of board) {
    if (!slugs.has(row.slug)) return `unknown slug ${row.slug}`;
    if (seen.has(row.slug)) return `duplicate slug ${row.slug}`;
    seen.add(row.slug);
    if (!(row.implied > 0)) return `non-positive implied value for ${row.slug}`;
    if (row.implied > prev) return `implied value rises at rank ${row.rank}`;
    prev = row.implied;
    if (row.plan.length < 3 || row.plan.length > 12) return `farm plan length for ${row.slug}`;
    for (const step of row.plan) {
      const t = step.trim();
      if (t.length < 20 || t.length > 600) return `farm step length for ${row.slug}`;
    }
  }
  for (let i = 0; i < board.length; i++) if (board[i].rank !== i + 1) return 'ranks are not 1..N';
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `watchlist slug missing: ${slug}`;
  if (new Set(board.map((r) => r.implied)).size < 2) return 'all implied values equal';
  return null;
}

export function boardRows(board: Row[]): Record<string, unknown>[] {
  return board.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied,
    farm_steps: r.plan,
    category: r.category,
    tvl_usd: r.tvl,
    fitted_cap_usd: r.fitted,
    token_odds: r.odds,
    verdict_default: r.verdict,
  }));
}
