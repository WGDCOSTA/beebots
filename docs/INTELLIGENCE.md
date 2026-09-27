# Brains, the strategy lab and the hive mind

beebots' per-tick decisions still come from **Jev**, and every order still goes through the **risk layer**. This adds a
slower, strategic layer around them:

```
            OKX history (public)            ./skills/*.json + 17 built-in skills
                    │                                   │
                    ▼                                   ▼
            ┌──────────────── strategy lab (pnpm lab run) ────────────────┐
            │  every skill × parameter set × coin, walk-forward:          │
            │  pick params on the past, score only on the unseen fold     │
            └──────────────────────────────┬──────────────────────────────┘
                                           │ ranking.json
                                           ▼
   ┌──────────── council (pnpm lab council) ─────────────┐        ┌──────────────────────┐
   │ bee1 · ChatGPT  → picks skills, lessons, message ───┼──────► │      hive mind       │
   │ bee2 · Claude   → reads bee1's message, picks ... ──┼──────► │  (knowledge graph)   │
   │ bee3 · Kimi     → reads both, picks ...  ───────────┼──────► │  bees, brains,       │
   └─────────────────────────┬───────────────────────────┘        │  skills, coins,      │
                             │ playbook.json                      │  lessons, messages,  │
                             ▼                                    │  real trade results  │
   engine (every tick) ── LAB_SIGNALS: state.lab vote ──► Jev ──► risk layer ──► order │
         │                                                         └──────────▲───────────┘
         └── closed trades + coach reviews (COACH_INTERVAL_MIN) ──────────────┘
```

Nothing here trades by itself, and nothing here can bypass a cap, a stop or the leverage limit.

## The three brains

| Bee | Brain | Key | Default model |
|---|---|---|---|
| bee1 | ChatGPT (OpenAI) | `OPENAI_API_KEY` (the Setup key) | `OPENAI_BRAIN_MODEL=gpt-5.4` |
| bee2 | Claude (Anthropic) | `ANTHROPIC_API_KEY` | `CLAUDE_MODEL=claude-opus-5` |
| bee3 | Kimi (Moonshot AI) | `KIMI_API_KEY` or `MOONSHOT_API_KEY` | `KIMI_MODEL=kimi-k2.5` |

Change who thinks with what via `BEE1_BRAIN` / `BEE2_BRAIN` / `BEE3_BRAIN` (`openai`, `claude`, `kimi`). Keys can also be
entered on the Setup page (Claude and Kimi are optional there and checked with a free call). `pnpm lab keys` checks
all three.

Every answer is JSON checked against a schema (OpenAI: strict `json_schema`; Claude: structured output with adaptive
thinking and server-side refusal fallbacks; Kimi: JSON mode plus validation and one retry). A brain that fails or has
no key is replaced by a **rules pick** (the best positive-scoring skills of the bee's natural family), so a bee always
has a plan. Keys are redacted from every log line.

## Skills

A skill turns candles into a target position per bar (long, short or flat) using only bars it has already seen; the
simulator fills it at the **next** bar's open. Built in (`src/lab/skills/library.ts`):

| Family | Skills |
|---|---|
| trend | SMA crossover, EMA crossover, triple EMA stack, MACD histogram, Supertrend |
| breakout | Donchian (turtle), Bollinger breakout, Keltner breakout, Larry Williams volatility breakout |
| momentum | rate of change, RSI momentum |
| mean reversion | RSI, Bollinger, z-score, stochastic |
| hybrid | trend filter + RSI pullback, volatility squeeze breakout |
| benchmark | buy and hold |

**Import more** as JSON in [`skills/`](../skills/) (or any folder in `SKILLS_DIRS`). The rule language supports
`sma ema rsi atr atr_pct roc zscore stoch highest lowest bb_upper bb_mid bb_lower bb_pctb macd_hist supertrend`, the
operators `< <= > >= crosses_above crosses_below`, `any` groups and `$param` references with a grid to search.
`skills/classic-pack.json` has Connors RSI(2), the golden cross, the Turtles' system 2 and more. `pnpm lab skills`
lists everything and reports files that do not compile.

## The lab

```sh
pnpm lab fetch --inst BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP --bar 1H --days 365   # public OKX history, cached
pnpm lab csv mydata.csv --inst MYCOIN --bar 1H                                        # or bring your own
pnpm lab run [--bar 1H] [--folds 3] [--leverage 1] [--long-only] [--synthetic 4]       # the tournament
pnpm lab council                                                                       # brains pick skills
pnpm lab cycle                                                                         # all of the above
```

**Walk-forward.** The last half of each dataset is split into folds. For each fold the best parameters on everything
before it are frozen and run on the fold. Only those out-of-sample runs are scored, then averaged across coins.

**Costs.** Taker fee per side (`TAKER_FEE_RATE`, 5 bp), 2 bp slippage, funding every 8 h (0.01% by default, longs pay),
optional ATR stop per skill, leverage capped at `MAX_LEVERAGE`.

**Score.** `0.55 × Sharpe + 0.30 × Calmar (capped ±3) + 0.15 × (profit factor − 1, capped)`, scaled down when a fold has
too few trades, then weighted by **stability** (share of folds that made money). The table also shows the
**overfit gap** (in-sample minus out-of-sample score): a big gap means the parameters were fitted to noise.

Output: `data/lab/ranking.json`, a readable `data/lab/report.md`, and the hive mind updated. `--synthetic N` adds
seeded synthetic markets for offline runs; they exercise the machinery and prove nothing about real markets.

## The hive mind

A SQLite knowledge graph (`GRAPH_PATH`). Node types: `bee`, `brain`, `skill`, `family`, `coin`, `lesson`, `message`,
`run`. Edges include `thinks_with`, `adopts`, `recommends`, `ranked`, `performs_on`, `in_family`, `traded` (real P&L per
coin, from the engine's fills), `learned`, `said`, `to`, `about`.

- **Memory.** Every council and coach round starts from `contextFor(bee)`: its own lessons, its real trade record,
  its inbox and what the other bees adopted.
- **Communication.** Brains speak in turn and post messages to the hive (or to one bee); the next brain reads them.
- **Export.** `pnpm lab graph` writes NetworkX node-link JSON (`graph.json`, the format graphify and most graph tools
  read). The engine also serves it at `GET /hive-mind`, a bee's context at `GET /hive-mind/bee1`, and the lab at
  `GET /lab/ranking` and `GET /lab/playbook` (read-only; no keys).

## While the engine runs

- **`LAB_SIGNALS=true`**: Jev's state gains `lab: { BTC: 0.6, ETH: -0.5, ... }`, the weighted vote of the bee's
  playbook skills on the latest closed 1h bars, plus one line in its instructions saying it is a tiebreaker. The menu
  and the risk layer are unchanged. Off by default because it changes what Jev sees (and adds a few tokens).
- **Trade ingest** (always on): closed trades flow into the graph every 5 minutes.
- **`COACH_INTERVAL_MIN`** (0 = off): each brain reviews its bee's last 24 h (closed trades, P&L, fees, equity change,
  risk vetoes) and re-weights its adopted skills. It may drop a skill but never add one; new skills only come from a
  lab run and the council. At most `COACH_MAX_CALLS_DAY` calls a day.

## Suggested routine

1. `pnpm lab cycle` once a week (or after adding skills).
2. Read `data/lab/report.md`. Skills that do not beat buy-and-hold after costs, or with a large overfit gap, deserve
   suspicion whatever their rank.
3. Watch the bees on paper with `LAB_SIGNALS=true` and `COACH_INTERVAL_MIN=360` for a while before trusting anything.

Paper trading on simulated money. Backtests on past data do not predict future results. Not financial advice.
