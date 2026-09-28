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

## Borrowed from the big frameworks

The lab stays in TypeScript inside beebots, but takes the proven parts of the established open-source tools:

| From | What beebots uses | Where |
|---|---|---|
| [CCXT](https://github.com/ccxt/ccxt) (MIT) | Public OHLCV history from 100+ exchanges (`pnpm lab fetch --exchange binance --symbol BTC/USDT`). **Data only**: orders still go only to OKX, through the risk layer. | `src/lab/history.ts` |
| [Freqtrade](https://www.freqtrade.io) | Its exit model: `minimal_roi` (take profit by minutes held), `stoploss`, trailing stop (`trailing_stop_positive` / `_offset`), as `roi` / `stoploss` / `trailing` in JSON skills. Its data files (`BTC_USDT-1h.json`) import with `pnpm lab import`. Hyperopt's role is played by the walk-forward grid search. | `src/lab/backtest.ts`, `src/lab/skills/dsl.ts` |
| [Backtrader](https://www.backtrader.com) | The SQN analyzer (Van Tharp's System Quality Number) next to Sharpe and drawdown, and its classic sample strategies. | `src/lab/backtest.ts`, `skills/backtrader-samples-pack.json` |

Indicators common in those strategies are in the rule language too: ADX with +DI/-DI, CCI, MFI, Williams %R,
Stochastic %D and volume averages. `skills/freqtrade-style-pack.json` and `skills/backtrader-samples-pack.json`
rewrite well-known community patterns in that language (Bollinger + RSI dip, ADX/DI trend, CCI reversal, MFI washout,
EMA momentum with volume, SMA crossover, MACD with ATR stop). They are re-expressed ideas, not copied code: the
`freqtrade-strategies` repository is GPL-3.0, beebots is MIT.

## The lab

```sh
pnpm lab fetch --inst BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP --bar 1H --days 365   # public OKX history, cached
pnpm lab fetch --exchange binance --symbol BTC/USDT,ETH/USDT --days 365                # any CCXT exchange
pnpm lab import mydata.csv --inst MYCOIN --bar 1H                                     # CSV or a Freqtrade .json file
pnpm lab run [--bar 1H] [--folds 3] [--leverage 1] [--long-only] [--synthetic 4]       # the tournament
pnpm lab council                                                                       # brains pick skills
pnpm lab cycle                                                                         # all of the above
```

**Walk-forward.** The last half of each dataset is split into folds. For each fold the best parameters on everything
before it are frozen and run on the fold. Only those out-of-sample runs are scored, then averaged across coins.

**Exits.** A skill's own exit rule, plus optional ATR stop and Freqtrade-style ROI / stoploss / trailing stop,
checked inside each bar against its high and low (stop first, the worst case). After a stop or take-profit the skill
must leave the signal before it may re-enter that side.

**Costs.** Taker fee per side (`TAKER_FEE_RATE`, 5 bp), 2 bp slippage, funding every 8 h (0.01% by default, longs pay),
optional ATR stop per skill, leverage capped at `MAX_LEVERAGE`.

**Score.** `0.55 × Sharpe + 0.30 × Calmar (capped ±3) + 0.15 × (profit factor − 1, capped)`, scaled down when a fold has
too few trades, then weighted by **stability** (share of folds that made money). The table also shows
**SQN** (needs 5+ trades) and the **overfit gap** (in-sample minus out-of-sample score): a big gap means the parameters were fitted to noise.

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
  lab run and the council. It also reviews the watchlist (see below). At most `COACH_MAX_CALLS_DAY` calls a day.

## Which coins each bee trades: the watchlist

With `BRAIN_WATCHLIST=true` (the default) the brains choose each bee's coins, not only its skills
(`src/brains/watchlist.ts`). Jev still decides every tick and the risk layer still has the last word; the watchlist
only decides **which coins Jev is offered**.

1. **Candidates.** The owner's coins for the bee when set (a hard limit); otherwise the coins its style can trade
   (Breakout: BTC/ETH/SOL/HYPE, Trend: BTC/ETH); otherwise, for Momentum, the most liquid gated coins right now, the
   lab's coins and the coins the bee has traded.
2. **Evidence per candidate.** How the lab's skills did out of sample on that coin (the best skill and the mean over
   the bee's adopted skills), the bee's real record there (net USD, trades, win rate) and live liquidity (volume,
   spread, 7-day move, ATR).
3. **The choice.** The council picks up to `3 + level` coins (at most 8; 3 in danger) with a reason each. With no
   brain key a rules pick ranks the candidates on the same evidence. A brain may only pick candidates.
4. **Reviews.** The coach may drop coins that keep losing (never the last one) and add **one** candidate at a time on
   **probation**: it trades at half size until a later review keeps it. A survival council re-picks the list by vote
   across its brains; in danger it keeps 3 coins and favours the 10 most liquid.
5. **What the engine applies.** The watchlist, filtered again by the owner's coins and the style, and in danger or
   critical only liquid coins with nothing on probation. If nothing usable is left, the bee falls back to its style's
   normal coin choice. A position already held on a coin that left the list is still managed (stops, exits).

The watchlist lives in the playbook, is shown on the Lab page (per bee, reasons on hover, probation marked), in Admin →
Bees and on each bee's column, and is recorded in the hive mind as `bee -watches-> coin`. `pnpm lab council` picks it
too (without the live market: its candidates come from the owner, the style, the lab and the record).

## More bees

The three main bees are the live dashboard's columns, Setup's bees and the Hive's slots. From **Admin → Bees** the
owner can add up to six more (slots `bee4`..`bee9`, nine in all), each with its own name, style, assets, rules and
brain (ChatGPT, Claude or Kimi), and edit the assets every bee may trade (chips from OKX's live coin list). New bees
start with fresh paper money after a restart; only the last bees can be removed, and only while flat. Extra bees race
in the leaderboard, the "Challengers" card, the lab and the councils; the Hive shows the main three. Outside paper
trading an extra bee needs its own exchange keys in `.env` (`BEE4_OKX_DEMO_API_KEY`, …) or it sits out.

## Survival mode

Every bee knows it can die. Its **health** is equity as a % of its start:

| Tier | Health | What changes |
|---|---|---|
| ★ thriving | ≥ 110% | nothing |
| ● healthy | ≥ `SURVIVAL_DANGER_PCT` (80) | nothing |
| ⚠ danger | below 80 | position size ×0.6; a survival council meets |
| ✚ critical | below `SURVIVAL_CRITICAL_PCT` (60) | size ×0.35; every available brain joins its council |
| ✖ dead | at `BEE_RETIRE_AT_PCT` (40) | the risk layer retires it: no more trading until the owner revives it |

Jev sees `survival: { health, tier, deathAt }` in every snapshot with one line of instructions: protect capital first
in danger. The **survival council** (`src/brains/survival.ts`) combines brains: the bee's own brain answers first,
then the others, each reading its teammates' advice. Their skill picks are averaged (in danger, stable low-drawdown
skills are favoured), and each brain may write a **new skill** in the JSON rule language. A written skill is
compiled, backtested walk-forward on the lab's history and adopted only with a positive out-of-sample score and 50%+
stability; it is saved to `<LAB_DIR>/learned/` (named after its author, e.g. `bee4_calm_trend`), used by the lab
votes at once and ranked in every later lab run. A death is written into the hive mind as a lesson. **Revive** (Admin
→ Bees) gives a dead bee fresh paper money; it keeps half its points and all its lessons.

## Rewards

At each UTC day's end every living bee scores: **+10 points per 1% gained** (losses cost half that rate), **+1 for
surviving the day**, **+5 for the day's best bee**. Points never go below zero. Levels and prizes:

| Level | Points | Prizes |
|---|---|---|
| 0 | 0 | 3 skills in its playbook |
| 1 | 50 | 4 skills, **writes new skills** in its councils, +10% max position |
| 2 | 150 | 5 skills, +20% max position, +1 trade a day |
| 3 | 300 | 6 skills, **one extra brain** in its councils, +30% max position |
| 4 | 500 | +40% max position, +2 trades a day |
| 5 | 800 | **two extra brains**, +50% max position (`REWARD_MAX_LIMIT_BOOST`) |

A level-up wakes a reward council (the prize in action). Leverage is never raised (hard rule: `MAX_LEVERAGE` ≤ 2
still caps every position), and with real money limit boosts are off unless `REWARDS_IN_LIVE=true`. The Lab page's
**Evolution** table ranks the bees by points with health, level progress, prizes, the last days and deaths.

Settings (Admin → Settings → Survival & rewards, or `.env`): `SURVIVAL_MODE`, `SURVIVAL_DANGER_PCT`,
`SURVIVAL_CRITICAL_PCT`, `SURVIVAL_MAX_CALLS_DAY`, `REWARDS`, `REWARD_MAX_LIMIT_BOOST`, `REWARDS_IN_LIVE`.

## Dashboard pages

- **`#/lab` – Lab & hive mind** (public, read-only, like the rest of the dashboard):
  - the last ranking, sortable and filterable by family, with a diverging score bar; click a skill to see every
    out-of-sample fold and the parameters picked on the past;
  - each bee's playbook: its brain, the skills it leans on and their weights, its message to the hive and lessons;
  - the hive-mind graph (force layout; node type shown by colour and shape, the legend filters types; hover for
    details, click to pin a node and list its links; a table view carries the same data);
  - the latest messages and lessons.
- **`#/admin` – Admin** (owner password, the same gate and 15-minute lockout as joining the Hive):
  - **Overview**: mode, keys, brains, hive-mind size, the current lab job, restart;
  - **API keys**: Jev, OpenAI, Anthropic, Kimi. Write-only (the page only learns whether a key is set and where from),
    each tested with a free call before saving; keys set in `.env` stay there;
  - **Bees**: add or remove bees, and edit each one's name, tagline, style, assets (coin picker), rules and brain;
    see its health and level, revive a dead bee, or convene its brains now;
  - **Settings**: brains and models, Jev's cap, every risk limit, the per-style knobs, cadence and alerts. Saved as
    overrides in `admin.json`; a variable set in the environment always wins and shows as "set in .env";
  - **Lab, skills & evolution**: start fetch / run / council / cycle (a child process, so the engine keeps trading),
    watch its log, run a coach review, **import a skill** (compiled and backtested on the spot), and set learning,
    survival and rewards;
  - **Security**: change the owner password.

  Saved changes apply after **Restart engine** (the engine exits and Docker starts it again). The trading mode,
  `LIVE_ACK` and exchange keys are deliberately not in the panel: real money stays an `.env` decision.

## Suggested routine

1. `pnpm lab cycle` once a week (or after adding skills).
2. Read `data/lab/report.md`. Skills that do not beat buy-and-hold after costs, or with a large overfit gap, deserve
   suspicion whatever their rank.
3. Watch the bees on paper with `LAB_SIGNALS=true` and `COACH_INTERVAL_MIN=360` for a while before trusting anything.

Paper trading on simulated money. Backtests on past data do not predict future results. Not financial advice.
