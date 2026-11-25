// Launch Radar: read the sealed snapshot, rank the board, write the page.
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// Node 22+, standard library only. The program is deterministic: the same
// snapshot bytes always produce the same /output bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, boardRows, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch radar: no snapshot at ${inputFile}\n`);
  process.exit(2);
}
const out = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: board refused: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: boardRows(board) })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

function copyDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

copyDir(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyDir(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`launch radar: screenshots/ holds ${shots.length} images: hand in 3 or 4\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(name)) {
    process.stderr.write(`launch radar: bad screenshot name ${name}\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }),
);

const verdicts = new Map<string, number>();
for (const r of board) verdicts.set(r.verdict, (verdicts.get(r.verdict) ?? 0) + 1);
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} watchlist, ${board.length} rows\n` +
    `launch radar: size curve ln(mcap) = ${radar.model.intercept} + ${radar.model.slope} ln(TVL), LOO x${radar.model.looMiss}, walk-forward x${radar.model.wfMiss}\n` +
    `launch radar: verdicts ${[...verdicts.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}\n` +
    `launch radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, dashboard, ${shots.length} screenshots, dossier.json\n`,
);
