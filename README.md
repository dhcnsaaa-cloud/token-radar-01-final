[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/dhcnsaaa-cloud/token-radar-01-final/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/dhcnsaaa-cloud/token-radar-01-final/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar

A token launch radar: pre-token protocols ranked by implied value, valued
from their own record in the sealed snapshot. Model radar-2: a size curve
fitted on the snapshot's priced protocols, token odds by age bucket, and
costed farm verdicts. No network, no hand-picked figures.

## Run it

Node 22 or later, standard library only, no install:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

The program reads the snapshot, writes `board.json` (the ranked board),
`data.js` (the dashboard's dataset), copies `dashboard/` and `screenshots/`
into the output directory, and writes `dossier.json` last. Re-running it on
the same snapshot bytes reproduces the same board exactly.

## What it builds

- **Board** — every watchlist protocol plus the strongest pre-token
  protocols below the floor, ranked by implied value
  (fitted cap × token odds), with bootstrap ranges, priced peers, a
  10-step costed farm plan per row, and FARM / MARGINAL / SKIP verdicts
  that re-price live with the fee and horizon controls.
- **Detail** — one protocol: how the value is built, the costed verdict,
  sensitivities, the farm plan, and its priced peers.
- **Live token** — protocols that already record a token, set aside at the
  market's own value; they are the fit's comps, not the board's rows.
- **Set aside** — the whole snapshot accounted for, closing at the total.
- **Method** — what was tested, what was kept, what was not: the size
  curve held out twice, the odds buckets Brier-tested, the ranges' honesty.

## Model, in one paragraph

`ln(market cap) = a + b × ln(TVL)` on the snapshot's priced protocols.
Implied value is the fitted cap times the token odds for the protocol's
age bucket. Ranges come from a seeded 50-draw bootstrap of the curve.
Economics: deposit `min($10,000, 0.02% of TVL)`, a 14% drop share pro-rata
by deposit share, a $2.95 fee, 12 weeks, a 4% T-bill benchmark. A protocol
is listed as recording no token, never as having none; market caps are the
snapshot's recorded caps, not fully diluted value.

## Layout

- `main.ts` — the entry program: snapshot in, board + dashboard + dossier out.
- `lib/model.ts` — the snapshot parser, the radar-2 fit, the board, the farm plans.
- `lib/dossier.ts` — the dossier builder, written from the dossier contract.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`. Renders
  `data.js` with no network.
- `screenshots/` — three captures of the dashboard running: the board, a
  detail view, and a filtered view.

## Verification

Before submission the program was run twice on the sealed snapshot: the
board, the dataset and the dossier came out byte-identical, the board
covers the whole watchlist with ranks 1–N in implied-value order, every
row carries 10 farm steps inside the length limits, the three screenshots
are within the size and dimension caps, and the dashboard source fits the
dossier text cap whole.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tsqpcvvq&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
