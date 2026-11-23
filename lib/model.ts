// Launch Radar, model radar-2: one sealed snapshot in, one ranked board out.
//
// The board covers every watchlist slug (the floor, never a ceiling) plus the
// strongest pre-token protocols below the floor, by TVL. Implied value comes
// only from the snapshot's own figures:
//
//   fitted cap  = exp(a + b * ln(TVL)), a size curve fitted on the snapshot's
//                 own priced protocols (ridge-free OLS on logs), tested
//                 held-out twice (5-fold CV and a walk-forward split);
//   token odds  = the share of protocols that record a token, by age bucket,
//                 shrunk toward the global rate, Brier-tested against the
//                 base rate and a permuted-age control, with an AUC;
//   implied     = fitted cap x token odds, with bootstrap ranges.
//
// No protocol name is special-cased. Category is tested and dropped: the
// curve uses size alone. Every number the dashboard shows is computed here
// from the snapshot, so a re-run on the same bytes reproduces the board.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface FarmPeer {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  fitted_usd: number;
  ratio: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    intercept: number;
    slope: number;
    fitted_cap_usd: number;
    multiple: number;
    token_odds: number;
    odds_bucket: string;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow extends BoardRow {
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  value_if_usd: number;
  deposit_usd: number;
  drop_usd: number;
  fee_usd: number;
  net_usd: number;
  net_per_hour: number;
  tbill_usd: number;
  breakeven_odds: number;
  verdict: 'ROBUST' | 'FARM' | 'MARGINAL' | 'SKIP';
  watchlist: boolean;
  peers: FarmPeer[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface OddsBucket {
  label: string;
  min_days: number;
  max_days: number;
  peers: number;
  tokened: number;
  odds: number;
}

export interface Diagnostics {
  n_comps: number;
  intercept: number;
  slope: number;
  miss_fitted: number;
  miss_cv: number;
  miss_walkforward: number;
  miss_flat: number;
  multiple_at_100m_mean: number;
  multiple_at_100m_sd: number;
  slope_mean: number;
  slope_sd: number;
  coverage_p25_75: number;
  coverage_p10_90: number;
  coverage_within_3x: number;
  odds_buckets: OddsBucket[];
  odds_global: number;
  odds_brier: number;
  odds_brier_base: number;
  odds_brier_permuted: number;
  odds_auc: number;
  kinship_flagged: number;
  kinship_slugs: string[];
  checksum: string;
}

export interface Economics {
  deposit_cap_usd: number;
  deposit_share: number;
  drop_share: number;
  weeks: number;
  fee_usd: number;
  tbill_rate: number;
  active_minutes: number;
}

export const ECONOMICS: Economics = {
  deposit_cap_usd: 10000,
  deposit_share: 0.0002,
  drop_share: 0.14,
  weeks: 12,
  fee_usd: 2.95,
  tbill_rate: 0.04,
  active_minutes: 204,
};

export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;
export const BOOTSTRAP_REPS = 50;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A seeded LCG: every draw is reproducible, so a re-run gives the same board. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. Say that, never that it has none. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** OLS on logs: ln(mcap) = a + b * ln(tvl). Returns [a, b]. */
function fitCurve(points: Array<{ x: number; y: number }>): [number, number] {
  const n = points.length;
  if (n === 0) return [0, 0];
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return [sy / n, 0];
  const b = (n * sxy - sx * sy) / denom;
  return [(sy - b * sx) / n, b];
}

function fittedCap(a: number, b: number, tvl: number): number {
  return Math.exp(a + b * Math.log(Math.max(1, tvl)));
}

/** FNV-1a over rank:slug:implied, one line per row: the board's fingerprint. */
export function boardChecksum(rows: Array<{ rank: number; slug: string; implied_value_usd: number }>): string {
  let h = 0x811c9dc5;
  const text = rows.map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}`).join('\n');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ odds

const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '<3mo', min: 0, max: 90 },
  { label: '3-12mo', min: 90, max: 365 },
  { label: '1-2yr', min: 365, max: 730 },
  { label: '>2yr', min: 730, max: Number.POSITIVE_INFINITY },
];

function bucketOf(age: number | null): number {
  if (age === null) return -1;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (age >= BUCKETS[i]!.min && age < BUCKETS[i]!.max) return i;
  }
  return BUCKETS.length - 1;
}

interface OddsFit {
  buckets: OddsBucket[];
  global: number;
  brier: number;
  brierBase: number;
  brierPermuted: number;
  auc: number;
  oddsFor: (age: number | null) => { odds: number; label: string };
}

function fitOdds(snapshot: Snapshot): OddsFit {
  const aged = snapshot.protocols.map((p) => ({ age: ageDays(snapshot.as_of, p.listed_at), live: !isPreToken(p) }));
  const withAge = aged.filter((r) => r.age !== null);
  const live = withAge.filter((r) => r.live).length;
  const global = withAge.length === 0 ? 0 : live / withAge.length;
  const buckets: OddsBucket[] = BUCKETS.map((b) => {
    const inBucket = withAge.filter((r) => r.age! >= b.min && r.age! < b.max);
    const tokened = inBucket.filter((r) => r.live).length;
    const odds = (tokened + 10 * global) / (inBucket.length + 10);
    return { label: b.label, min_days: b.min, max_days: Number.isFinite(b.max) ? b.max : -1, peers: inBucket.length, tokened, odds: round4(odds) };
  });
  const oddsFor = (age: number | null): { odds: number; label: string } => {
    const i = bucketOf(age);
    if (i < 0) return { odds: round4(global), label: 'unknown age' };
    return { odds: buckets[i]!.odds, label: buckets[i]!.label };
  };
  const brierOf = (predict: (age: number | null) => number): number => {
    if (withAge.length === 0) return 0;
    let s = 0;
    for (const r of withAge) {
      const d = predict(r.age) - (r.live ? 1 : 0);
      s += d * d;
    }
    return s / withAge.length;
  };
  const brier = brierOf((age) => oddsFor(age).odds);
  const brierBase = brierOf(() => global);
  // Permuted-age control: the same bucket rates, ages shuffled, must do worse.
  const rng = lcg(0x51ab3);
  const ages = withAge.map((r) => r.age);
  for (let i = ages.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = ages[i]!;
    ages[i] = ages[j]!;
    ages[j] = t;
  }
  const shuffled = withAge.map((r, i) => ({ age: ages[i]!, live: r.live }));
  const shuffledBuckets = BUCKETS.map((b) => {
    const inBucket = shuffled.filter((r) => r.age >= b.min && r.age < b.max);
    const tokened = inBucket.filter((r) => r.live).length;
    return (tokened + 10 * global) / (inBucket.length + 10);
  });
  let sp = 0;
  for (const r of shuffled) {
    const i = bucketOf(r.age);
    const d = shuffledBuckets[i]! - (r.live ? 1 : 0);
    sp += d * d;
  }
  const brierPermuted = withAge.length === 0 ? 0 : sp / withAge.length;
  // AUC: bucket odds as the score, ties count half.
  const pos = withAge.filter((r) => r.live);
  const neg = withAge.filter((r) => !r.live);
  let wins = 0;
  for (const p of pos) {
    const ps = oddsFor(p.age).odds;
    for (const n of neg) {
      const ns = oddsFor(n.age).odds;
      wins += ps > ns ? 1 : ps === ns ? 0.5 : 0;
    }
  }
  const auc = pos.length === 0 || neg.length === 0 ? 0.5 : wins / (pos.length * neg.length);
  return { buckets, global, brier: round4(brier), brierBase: round4(brierBase), brierPermuted: round4(brierPermuted), auc: round4(auc), oddsFor };
}

// ------------------------------------------------------------- farm steps

const FEE_SHARES = [0.42, 0.85, 0.3, 0.55, 0.28, 0.2, 0.15, 0.1, 0.06, 0.04];
const STEP_MINUTES = [10, 30, 15, 0, 20, 35, 50, 20, 12, 12];

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function actionFor(p: SnapshotProtocol, deposit: number): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const d = money(deposit);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply ${d} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide ${d} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge ${d} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake ${d} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit ${d} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund ${d} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit ${d} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit ${d} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint ${d} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy ${d} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('yield')) return `Deposit ${d} into ${name}'s main yield vault on ${chain} and keep the receipt.`;
  return `Deposit ${d} of USDC into ${name} on ${chain} and keep the position open.`;
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function stepText(text: string, gas: number, minutes: number, holdDays: number): string {
  const time = minutes === 0 ? `${holdDays} days (passive)` : `${minutes} minutes`;
  let s = `${text} Cost: $${gas.toFixed(2)} of gas. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

export function farmSteps(p: SnapshotProtocol, age: number | null, deposit: number): string[] {
  const hold = holdDaysFor(age);
  const action = actionFor(p, deposit);
  const texts = [
    'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
    action,
    'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
    "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
    'Before you claim anything, check the protocol’s own docs for the eligibility rules it publishes.',
    'Keep approvals exact: approve only the amount each transaction needs, and revoke the approval after.',
    'Withdraw a small test amount first to confirm the exit path works before you unwind the position.',
    'Write the wallet, the dates and every transaction in a farm log so you can repeat or unwind the position.',
    'If the protocol announces a token or a snapshot, re-check the rules before you change the position.',
  ];
  return texts.map((t, i) => stepText(t, FEE_SHARES[i]!, STEP_MINUTES[i]!, hold));
}

// ------------------------------------------------------------------ board

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: { intercept: number; slope: number };
  economics: Economics;
  diagnostics: Diagnostics;
  accounting: Record<string, number>;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

function depositFor(tvl: number): number {
  return Math.min(ECONOMICS.deposit_cap_usd, ECONOMICS.deposit_share * tvl);
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX' && !VERSIONED.test(p.name),
  );
  const points = comps.map((p) => ({ x: Math.log(p.tvl_usd), y: Math.log(p.mcap_usd!) }));
  const [a, b] = fitCurve(points);
  const fitted = comps.map((p) => fittedCap(a, b, p.tvl_usd));
  // A miss is a factor, never a ratio: exp(|ln predicted - ln actual|), so
  // x2.30 means the typical fitted value is 2.30x off, high or low.
  const miss = (pred: number[], actual: number[]): number => median(pred.map((v, i) => Math.exp(Math.abs(Math.log(v) - Math.log(actual[i]!)))));
  const missFitted = miss(fitted, comps.map((p) => p.mcap_usd!));
  // 5-fold CV, folds by position: deterministic, no shuffle.
  const cvPred = new Array<number>(comps.length).fill(0);
  for (let f = 0; f < 5; f++) {
    const train = points.filter((_, i) => i % 5 !== f);
    const test = points.map((pt, i) => ({ pt, i })).filter((t) => t.i % 5 === f);
    const [fa, fb] = fitCurve(train);
    for (const t of test) cvPred[t.i] = Math.exp(fa + fb * t.pt.x);
  }
  const missCv = miss(cvPred, comps.map((p) => p.mcap_usd!));
  // Walk-forward: fit the older half (by listed date), test the newer half.
  const dated = comps
    .map((p, i) => ({ p, i, d: p.listed_at ?? '9999' }))
    .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.i - y.i));
  const half = Math.floor(dated.length / 2);
  const [wa, wb] = fitCurve(dated.slice(0, half).map((t) => points[t.i]!));
  const walkPred = dated.slice(half).map((t) => Math.exp(wa + wb * points[t.i]!.x));
  const missWalk = dated.length - half > 0 ? miss(walkPred, dated.slice(half).map((t) => t.p.mcap_usd!)) : missFitted;
  // Flat baseline: one median multiple for every protocol.
  const flatMult = median(comps.map((p) => p.mcap_usd! / p.tvl_usd));
  const missFlat = miss(
    comps.map((p) => p.tvl_usd * flatMult),
    comps.map((p) => p.mcap_usd!),
  );
  // Bootstrap: 50 resamples, seeded. Ranges and coverage come from these draws.
  const rng = lcg(20261123);
  const draws: Array<[number, number]> = [];
  for (let j = 0; j < BOOTSTRAP_REPS; j++) {
    const sample: Array<{ x: number; y: number }> = [];
    for (let k = 0; k < points.length; k++) sample.push(points[Math.floor(rng() * points.length)]!);
    draws.push(fitCurve(sample));
  }
  const mult100 = draws.map(([da, db]) => fittedCap(da, db, 100_000_000) / 100_000_000);
  const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = (xs: number[]): number => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((v) => (v - m) * (v - m))));
  };
  const multMean = mean(mult100);
  const multSd = sd(mult100);
  const slopeMean = mean(draws.map((d) => d[1]));
  const slopeSd = sd(draws.map((d) => d[1]));
  // Residual spread of the fit: predictive intervals add this noise to the
  // parameter draws, or the intervals would be far too narrow to be honest.
  const residuals = comps.map((p, i) => Math.log(p.mcap_usd!) - Math.log(fitted[i]!));
  const residMean = mean(residuals);
  const sigma = Math.sqrt(mean(residuals.map((v) => (v - residMean) * (v - residMean))));
  const epsRng = lcg(0x5eed);
  let spare: number | null = null;
  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const u1 = Math.max(epsRng(), 1e-12);
    const u2 = epsRng();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
  // Coverage of the predictive bootstrap intervals on the comps themselves.
  let in2575 = 0;
  let in1090 = 0;
  let in3x = 0;
  for (let i = 0; i < comps.length; i++) {
    const caps = draws.map(([da, db]) => fittedCap(da, db, comps[i]!.tvl_usd) * Math.exp(normal() * sigma)).sort((x, y) => x - y);
    const actual = comps[i]!.mcap_usd!;
    if (actual >= quantile(caps, 0.25) && actual <= quantile(caps, 0.75)) in2575++;
    if (actual >= quantile(caps, 0.1) && actual <= quantile(caps, 0.9)) in1090++;
    if (Math.abs(Math.log(actual / fitted[i]!)) <= Math.log(3)) in3x++;
  }
  const odds = fitOdds(snapshot);
  // Kinship: shared name stems among the ranked set, flagged, never priced out.
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((x, y) => y.tvl_usd - x.tvl_usd || (x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const stems = new Map<string, string[]>();
  for (const p of chosen.values()) {
    const stem = p.name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean)[0] ?? p.slug;
    const list = stems.get(stem) ?? [];
    list.push(p.slug);
    stems.set(stem, list);
  }
  const kinshipSlugs = [...stems.values()].filter((g) => g.length > 1).flat().sort();
  // Score every chosen protocol.
  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const cap = fittedCap(a, b, p.tvl_usd);
    const { odds: tokOdds, label } = odds.oddsFor(age);
    const implied = Math.max(1, Math.round(cap * tokOdds));
    const drawsImplied = draws.map(([da, db]) => fittedCap(da, db, p.tvl_usd) * Math.exp(normal() * sigma) * tokOdds).sort((x, y) => x - y);
    const deposit = depositFor(p.tvl_usd);
    const drop = implied * ECONOMICS.drop_share * (deposit / p.tvl_usd);
    const fee = ECONOMICS.fee_usd;
    const net = drop - fee;
    const hours = ECONOMICS.active_minutes / 60;
    const tbill = deposit * ECONOMICS.tbill_rate * (ECONOMICS.weeks / 52);
    const denom = cap * ECONOMICS.drop_share * (deposit / p.tvl_usd);
    const breakeven = denom > 0 ? Math.min(1, Math.max(0, (fee + tbill) / denom)) : 1;
    const p25 = quantile(drawsImplied, 0.25);
    const p25Net = p25 * ECONOMICS.drop_share * (deposit / p.tvl_usd) - fee;
    const verdict: RadarRow['verdict'] =
      p25Net > tbill && net / hours >= 25
        ? 'ROBUST'
        : net > tbill && net / hours >= 25
          ? 'FARM'
          : net > 0
            ? 'MARGINAL'
            : 'SKIP';
    const sameCat = comps
      .filter((c) => c.category === p.category)
      .map((c) => ({ c, d: Math.abs(Math.log(c.tvl_usd / p.tvl_usd)) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 3);
    const peers: FarmPeer[] = sameCat.map(({ c }) => {
      const fc = fittedCap(a, b, c.tvl_usd);
      return { slug: c.slug, name: c.name, category: c.category, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd!, fitted_usd: Math.round(fc), ratio: round4(fc / c.mcap_usd!) };
    });
    return { p, age, cap, tokOdds, label, implied, drawsImplied, deposit, drop, fee, net, tbill, breakeven, verdict, peers, hours };
  });
  scored.sort((x, y) => y.implied - x.implied || (x.p.slug < y.p.slug ? -1 : x.p.slug > y.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      intercept: round4(a),
      slope: round4(b),
      fitted_cap_usd: Math.round(s.cap),
      multiple: round4(s.cap / s.p.tvl_usd),
      token_odds: s.tokOdds,
      odds_bucket: s.label,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.deposit),
  }));
  const rows: RadarRow[] = scored.map((s, i) => ({
    ...board[i]!,
    p25_usd: Math.round(quantile(s.drawsImplied, 0.25)),
    p75_usd: Math.round(quantile(s.drawsImplied, 0.75)),
    p10_usd: Math.round(quantile(s.drawsImplied, 0.1)),
    p90_usd: Math.round(quantile(s.drawsImplied, 0.9)),
    value_if_usd: Math.round(s.cap),
    deposit_usd: Math.round(s.deposit),
    drop_usd: round4(s.drop),
    fee_usd: s.fee,
    net_usd: round4(s.net),
    net_per_hour: round4(s.net / s.hours),
    tbill_usd: round4(s.tbill),
    breakeven_odds: round4(s.breakeven),
    verdict: s.verdict,
    watchlist: snapshot.watchlist.includes(s.p.slug),
    peers: s.peers,
  }));
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((x, y) => (y.mcap_usd ?? 0) - (x.mcap_usd ?? 0) || y.tvl_usd - x.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
  // Accounting: partitions that close over the whole snapshot.
  const rankedSlugs = new Set(board.map((r) => r.slug));
  const compSlugs = new Set(comps.map((p) => p.slug));
  let belowCut = 0;
  let pricedOther = 0;
  let recordedNoCap = 0;
  let excludedPre = 0;
  let aboveFloorUnranked = 0;
  for (const p of snapshot.protocols) {
    if (rankedSlugs.has(p.slug)) continue;
    if (compSlugs.has(p.slug)) continue;
    if (!isPreToken(p)) {
      if (p.mcap_usd === null) recordedNoCap++;
      else pricedOther++;
      continue;
    }
    if (!isRankable(p)) {
      excludedPre++;
      continue;
    }
    if (p.tvl_usd < snapshot.floor_usd) belowCut++;
    else aboveFloorUnranked++;
  }
  const accounting: Record<string, number> = {
    total: snapshot.protocols.length,
    ranked: board.length,
    priced_comps: comps.length,
    priced_other: pricedOther,
    recorded_no_cap: recordedNoCap,
    excluded_pre_token: excludedPre,
    below_cut_pre_token: belowCut,
    above_floor_unranked: aboveFloorUnranked,
    live_set_aside: live.length,
  };
  const diagnostics: Diagnostics = {
    n_comps: comps.length,
    intercept: round4(a),
    slope: round4(b),
    miss_fitted: round4(missFitted),
    miss_cv: round4(missCv),
    miss_walkforward: round4(missWalk),
    miss_flat: round4(missFlat),
    multiple_at_100m_mean: round4(multMean),
    multiple_at_100m_sd: round4(multSd),
    slope_mean: round4(slopeMean),
    slope_sd: round4(slopeSd),
    coverage_p25_75: comps.length === 0 ? 0 : round4(in2575 / comps.length),
    coverage_p10_90: comps.length === 0 ? 0 : round4(in1090 / comps.length),
    coverage_within_3x: comps.length === 0 ? 0 : round4(in3x / comps.length),
    odds_buckets: odds.buckets,
    odds_global: round4(odds.global),
    odds_brier: odds.brier,
    odds_brier_base: odds.brierBase,
    odds_brier_permuted: odds.brierPermuted,
    odds_auc: odds.auc,
    kinship_flagged: kinshipSlugs.length,
    kinship_slugs: kinshipSlugs,
    checksum: boardChecksum(board),
  };
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: { intercept: round4(a), slope: round4(b) },
    economics: ECONOMICS,
    diagnostics,
    accounting,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early.length,
    live_size: live.length,
    rows,
    live,
  };
  return { board, radar };
}

// ------------------------------------------------------------------ parse

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, fewer than the 100 the gate takes`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
