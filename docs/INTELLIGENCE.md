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
| bee2 | Claude (Anthropic) | `ANTHROPIC_API_KEY`, or an Anthropic Console sign-in (below) | `CLAUDE_MODEL=claude-opus-5` |
| bee3 | Kimi (Moonshot AI) | `KIMI_API_KEY` or `MOONSHOT_API_KEY` | `KIMI_MODEL=kimi-k2.5` |

A fourth built-in brain, **GLM (Z.ai)**, uses `ZAI_API_KEY`, `ZAI_MODEL` (default `glm-4.6`; use the model id shown in
your Z.ai console) and `ZAI_BASE_URL` (international `https://api.z.ai/api/paas/v4`, China
`https://open.bigmodel.cn/api/paas/v4`).

Change who thinks with what via `BEE1_BRAIN` / `BEE2_BRAIN` / `BEE3_BRAIN` (`openai`, `claude`, `kimi`, `zai`, or the id
of a custom brain). Keys can also be entered on the Setup page (Claude and Kimi are optional there and checked with a
free call). `pnpm lab keys` checks all three.

### Custom brains: any number of them

Admin → API keys → **Custom brains** adds any LLM that speaks the OpenAI-compatible chat API (OpenRouter, DeepSeek,
Together, Groq, a local Ollama or LM Studio, ...): a name, an id, the API address, the model, an optional key and how it
is asked for JSON (`object` = JSON mode with the schema in the prompt, the widest support and the default; `schema` =
OpenAI's strict json_schema; `prompt` = no response format, for servers that reject both; the answer is validated
whatever the mode). Up to 50. A new brain is tested with one tiny chat call before it is saved (or saved anyway, on
purpose, if its server is down right now). Rules: the address must be `https://` (plain `http://` only for `localhost` or
`host.docker.internal`, for a local model), the key is stored in the Setup file like the others, never shown again and
only ever sent to that address, the id may not be a built-in's (`openai`, `claude`, `kimi`, `zai`, `rules`, `ensemble`,
`jev`, `hive`), and a brain a bee uses cannot be removed. Once registered a brain can be a bee's brain (extra bees pick
it when created; the main three via Settings → Brains), sit in councils, do research and draft skills. A new or changed
brain comes online after **Restart engine**. Built on `CompatBrain` in `src/brains/llm.ts`, which Kimi and GLM use too.

### Signing Claude in instead of pasting a key

Claude can use an **Anthropic Console sign-in** (OAuth) instead of an API key. The engine image ships the Anthropic CLI
(`ant`); run this once on the server:

```sh
docker compose exec engine ant --profile beebots auth login --no-browser
```

Open the link it prints, sign in at platform.claude.com, choose the organisation (and workspace), and paste the code
back into the terminal. The sign-in is stored in the data volume (`/data/anthropic`, `ANTHROPIC_CONFIG_DIR`), the SDK
refreshes it by itself, and usage is billed to that Console organisation like an API key. Check it in **Admin → Keys**
(or on the Setup page), then restart. A set `ANTHROPIC_API_KEY` wins over the sign-in. Outside Docker, run
`ant --profile beebots auth login` on the same machine (install `ant` from github.com/anthropics/anthropic-cli).

What is **not** possible: a claude.ai Pro/Max, ChatGPT Plus or Kimi app login. Consumer subscriptions are not for
powering other apps (Anthropic does not allow claude.ai logins in third-party products), so ChatGPT and Kimi still use
API keys from platform.openai.com and platform.moonshot.ai.

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
`run`, `regime`, `style`, `memory`. Edges include `thinks_with`, `adopts`, `recommends`, `ranked`, `performs_on`, `in_family`, `traded` (real P&L per
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
start after a restart; only the last bees can be removed, and only while flat. Extra bees race in the leaderboard, the
"Challengers" card, the lab and the councils; the Hive shows the main three.

Creating a bee has two steps: **1. Bee & brain** (name, style, market, assets, rules, brain), then **2. Wallet &
exchange**:

- **Wallet**: the money the bee starts with (and is revived with), instead of the shared `BEE_START_EQUITY_USD`. Its
  P&L, health, survival tiers and death line are all measured from it. It is fixed once the bee trades. The main three
  keep sharing `BEE_START_EQUITY_USD` (Settings → Risk) so the Hive can compare them.
- **OKX sub-account**: key, secret and passphrase for demo or live. **Test connection & balance** runs a read-only
  check (`src/okx/account.ts`, no orders, no transfers): the keys answer, they have Trade and no Withdraw permission,
  they belong to a sub-account not already used by another bee, and it holds at least the wallet in USDC.
- Outside paper trading (`MODE=demo` or `live`) a new bee is **not created** until it has keys for that mode that pass
  the check; the server repeats the check when the bee is saved. On paper the keys are optional.
- The keys are stored in the Setup file (owner-only permissions), are write-only (the page only sees where they
  come from and the last balance), and any `BEE<n>_OKX_*` keys in `.env` still win. Keys can be replaced while the bee
  is flat. The trading mode and `LIVE_ACK` remain `.env` decisions.

## Autonomy: each bee chooses its own method

With `SPECIALIZATION=true` (the default) a bee's brains are free to choose **the method it trades**
(`src/brains/specialization.ts`), in paper, demo and live alike:

- **Options:** keep the current method; any built-in style its market allows (Breakout, Trend, Momentum; Macro for the
  macro squad); or **any lab skill** with a positive out-of-sample score and 40%+ stability, including skills a bee
  wrote itself and imported ones. The council, the coach (on the bee's real results) and survival councils (by vote,
  in danger too) can all switch it. Every switch is written to the bee's diary in the hive mind.
- **A skill as the method** (`src/bees/skill.ts`): the skill runs live on each coin's latest closed 1h candles, exactly
  as in the lab. Jev is offered the coins where it signals (`SMA_CROSS_LONG_BTC`, …) plus `WAIT`; positioned, `HOLD`,
  `TAKE_PROFIT`, or `EXIT` when the method goes flat or flips. Stops use the skill's ATR multiple.
- **When:** the engine adopts a new method only while the bee holds nothing, and keeps each method at least
  `SPECIALIZE_MIN_HOURS` (6). The active method survives restarts and shows on each bee's card (`METHOD …`).
- **What never changes:** Jev decides every tick, and the risk layer (leverage ≤ `MAX_LEVERAGE`, stops, daily caps,
  survival sizing) has the last word. Autonomy is over the method, not over the risk.

## Graph memory (graphify-style)

The hive mind works like [graphify](https://github.com/Graphify-Labs/graphify) for trading (`src/graph/memory.ts`):

- **Confidence on every link:** EXTRACTED (measured: trades, backtests, configuration), INFERRED (a brain's
  conclusion: lessons, adoptions, recommendations) and AMBIGUOUS (facts that disagree: the lab says a skill works on a
  coin, the bee's real trades there lose). Brains are told to weigh facts first.
- **Communities** (weighted label propagation) and **god nodes** (the most connected entities).
- **Scoped recall:** each brain gets the slice of the graph around its bee, the coins it trades or watches and its
  method (best-first, strong and fresh facts first, 20 nodes), not the whole graph. Its context has its newest
  lessons, its **memories**, its record, that slice, and the conflicts that concern it.
- **Consolidation without forgetting:** every 6 h (and after each coach round) a bee's older lessons are folded into
  one memory per community, written by its own brain at low effort (a rules digest without one). Originals stay,
  marked consolidated, so nothing is lost and the prompt stays small.
- **Speed:** routine upkeep (coach, memories) runs Claude at low effort, rescue councils at high effort.
- **Reads:** `GET /hive-mind/query?q=…`, `/hive-mind/path?from=…&to=…`, `/hive-mind/explain?node=…`,
  `/hive-mind/report` (HIVE_REPORT.md), the Lab page's "Ask the hive mind", and `pnpm lab query|path|explain|report|remember`.

## The macro squad

Extra bees can trade gold, oil and stocks instead of crypto (Admin → Bees → Market, or "Form the macro squad"). Their
councils, coach and watchlists stay inside their market, and they open only in trading hours the engine has verified
from the market. See [MACRO_SQUAD.md](MACRO_SQUAD.md).

## CoinMarketCap: the whole market

With a CoinMarketCap Pro API key (`COINMARKETCAP_API_KEY`, or Admin → API keys, checked with a free call before it is
saved) the engine adds market-wide context the exchange feed does not have (`src/market/cmc.ts`). Every
`CMC_REFRESH_MIN` minutes (15) it reads CMC's top `CMC_TOP` coins (200), the global metrics and the Fear & Greed index:
three calls, under the free Basic plan's 10,000 monthly credits, with `CMC_MAX_CALLS_DAY` (300) as a hard cap.

- **Jev** (`CMC_IN_JEV`, on): crypto bees' state carries `mkt` (fear_greed, btc_dom_pct, mcap_24h_pct) with one line
  in its instructions: background only, never above the menu or the coin data. Macro bees do not get it.
- **Brains**: each coin in the watchlist evidence gets `live.cmc` (CMC rank, market cap, volume across all exchanges,
  24h and 30d moves), and councils, the coach and survival councils read the market mood. The lab's CLI council reads
  the last mood the engine saved (`<LAB_DIR>/cmc-mood.json`).
- **Dashboard**: the system bar shows Fear & Greed, BTC dominance and the market cap's 24h move.

It is read-only and optional: without a key, or if CMC is down (the last good values are kept up to 2 hours), the
bees trade on the exchange feed alone. The key only travels in CMC's request header; it is never logged or shown.

## The scalper (optional, off)

A scalp aims at a few basis points and a round trip costs about as much: the taker fee alone is 10 bp in and out. So the
scalper is built around costs, in three stages, and it stays off unless every one of them says yes.

1. **The lab decides whether it may exist** (`src/lab/scalp.ts`, `pnpm lab fetch --bar 1m --days 14`, `pnpm lab scalp`).
   A cost-first simulator: maker entries fill only when price trades *through* the limit, targets rest as maker limits,
   stops and time exits are taker fills with slippage and half a spread, bars are ordered pessimistically, and a cost
   gate skips a trade whose target is under 3x its own round trip. Two rules (a micro breakout, a stretch-and-revert)
   are picked on expanding walk-forward windows and judged on the next chunk, with a plateau check (an isolated peak is
   rejected). The report (`<LAB_DIR>/scalp-report.md`) says **EDGE FOUND** or **NO EDGE** and why. Synthetic data can
   exercise the lab but never opens the gate. A random walk correctly shows no edge.
2. **A bee may choose it** (`bees/scalp.ts`). With `SCALP=true` the councils, the coach and the survival councils are
   offered the `scalp` method, but only while the report is real, positive and under `SCALP_LAB_MAX_AGE_DAYS` old.
   Jev is the slow clock: with no mandate it is asked, at most every `SCALP_MANDATE_MIN` minutes, for `SCALP_ON_<coin>_<bias>`
   or WAIT (each coin shows the lab's edge, its 1-minute ATR and how many times its target covers the round trip). The
   answer is a **mandate**: a coin, long/short/both, a lifetime and a trade budget. Inside it, code (the engine's scalp
   loop, every `SCALP_TICK_MS`) runs the lab's rule on the coin's 1-minute candles and trades it with no Jev call per
   trade. The risk layer keeps its last word on every entry, stop and cap; a scalper holds one position; stops and the
   time stop run through the same `applyRisk` as everything else.
3. **Maker execution** (`exec/executor.ts`). Entries and targets are post-only limits at the touch that wait up to
   `SCALP_MAKER_WAIT_S` and are then cancelled: a missed fill is not an error and never becomes a taker order. On OKX
   the order is placed with `--ordType post_only`, polled, cancelled on timeout, and its final state read (a fill that
   lands while cancelling is booked as the fill it is); if the state is uncertain the result is "unknown" and
   reconciliation settles it. Every scalper order id starts with `sc`, so a start after a crash cancels any leftovers, and
   only those. Paper trading fills a limit only when the market trades through it and refuses one that would cross the
   book, but it cannot see queue position or adverse selection: a paper fill rate is an upper bound, not a forecast.
   Confirm on OKX demo before trusting any result.

Safety: a circuit breaker pauses the bee after `SCALP_MAX_LOSS_STREAK` losses in a row (counted net of both fees) for
`SCALP_PAUSE_MIN` minutes; per-day trade and fee caps apply; with real money the lab gate cannot be switched off
(`SCALP_REQUIRE_LAB` is forced on). Scalping loses to fees in dead or wild markets, and it may well be that no rule ever
passes the lab: that is a valid answer, and the bee then never scalps.

## Gold breakout research (a lab tool, not a live style)

`pnpm gold ...` runs the multi-strategy gold breakout engine (`src/lab/gold`, the `skills/multi-strategy-gold-breakout`
package): structural support/resistance breakouts on XAUUSD with pending stop orders, nine strategy profiles S1-S9, a
fake-breakout filter, break-even and trailing exits, and portfolio risk limits. It is simulation and research only:
it has no execution adapter and refuses `live_trading`. Backtests, walk-forward, Monte Carlo, parameter stability,
ablation and a black-box calibration (estimates, never facts) all write a 13-part report that leads with the drawdown and
counts any validation that was not run as not passed. See `skills/multi-strategy-gold-breakout/SKILL.md`.

## The profit-lock ratchet

Every style keeps its own stops, and on top of them the engine runs a dynamic profit-locking ratchet
(`src/bees/ratchet.ts`) for the methods in `RATCHET_STYLES` (default Breakout, Momentum, the macro squad and any
lab-skill specialisation; the Trend style is left out so it can ride 4h trends). It tracks the best price since entry
and computes two stop candidates; the more protective wins, and the stop only ever moves in the trade's favour:

- **Hard profit floor** (`RATCHET_LOCK`, default `2.5:0.5,5:0.65`): past +2.5% the stop locks at least 50% of the
  best move, past +5% it locks 65%. A trade that reached +2.5% can no longer be stopped out at break-even.
- **Runner hug** (`RATCHET_HUG`, default `2.5:1.2,5:0.8,8:0.6`): the trail sits 1.2x ATR behind the peak from +2.5%,
  0.8x from +5% and 0.6x from +8%, so a runner is hugged tighter the further it has run.

Legs (multi-orders) get the same ratchet. `RATCHET=false` turns it off and leaves each style's own lock. A stop is a
level, not a guaranteed fill: a gap or slippage can still close a trade below it. The lab's backtests do not simulate
the ratchet yet.

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
| 3 | 300 | 6 skills, **one extra brain** in its councils, +30% max position, **2 positions (multi-orders)** |
| 4 | 500 | +40% max position, +2 trades a day |
| 5 | 800 | **two extra brains**, +50% max position (`REWARD_MAX_LIMIT_BOOST`), **3 positions** |

A level-up wakes a reward council (the prize in action). Leverage is never raised (hard rule: `MAX_LEVERAGE` ≤ 2
still caps every position), and with real money limit boosts are off unless `REWARDS_IN_LIVE=true`. The Lab page's
**Evolution** table ranks the bees by points with health, level progress, prizes, the last days and deaths.

### Multi-orders (a prize for top performers)

A bee that performs well earns more **position slots**: **2 at level 3, 3 at level 5** (capped by
`MAX_POSITIONS_PER_BEE`, default 3; 1 turns it off). While it holds its main position, Jev's menu then also offers
`LEG_*` options (the openings the bee's style would offer if it were flat, on coins it does not hold yet) and
`CLOSE_LEG_<coin>` for each extra position it holds. What stays fixed:

- **one leverage cap for everything**: each position gets at most `max / slots`, and all of them together never pass
  `MAX_LEVERAGE` × equity (the hard rule). Multi-orders spread the same risk budget; they never add leverage;
- every leg has its own code stop, trailing and profit lock, and code closes it at its stop, a macro session close,
  a time stop, or the bee's retire / daily loss stop, whatever Jev says;
- a bee in danger or worse is back to one position (legs it holds are still managed to their exits);
- with real money it follows `REWARDS_IN_LIVE` (off by default, like limit boosts);
- when the main position closes, the oldest leg becomes the main one. Reconciliation (demo/live) compares every
  position against OKX and rebuilds all of them from OKX on a mismatch.

The live board shows each bee's positions table (main + legs), `POS used/slots`, and exposure against its cap.

Settings (Admin → Settings → Survival & rewards, or `.env`): `SURVIVAL_MODE`, `SURVIVAL_DANGER_PCT`,
`SURVIVAL_CRITICAL_PCT`, `SURVIVAL_MAX_CALLS_DAY`, `REWARDS`, `REWARD_MAX_LIMIT_BOOST`, `REWARDS_IN_LIVE`,
`MAX_POSITIONS_PER_BEE`.

## Dashboard pages

- **`#/` – Home**, with four views in a tab bar (each one linkable, e.g. `#/?v=market`):
  - **Overview**: the live bee columns (each shows its **AI WATCHLIST** chips under the tech strip), leaderboard,
    squads and the decision stream;
  - **Market**: Fear & Greed, BTC dominance and total market cap (CoinMarketCap), 24h breadth and volume, then a
    sortable, filterable table of every coin the bees can trade (CMC rank and market cap, price, 1h/24h/7d, volume,
    open interest, funding, spread, ATR, RSI) with which bees watch or hold each one;
  - **AI watchlists**: a coin × bee matrix of what each bee's brains chose (trial coins marked), and per bee the
    reason the brains gave for every coin and when it was added;
  - **Positions**: every open position and leg across bees (size, entry, mark, stop, distance to stop, uP&L, R,
    time held), gross exposure and long/short split, and each bee's exposure against its cap.
- **`#/lab` – Lab & hive mind** (public, read-only, like the rest of the dashboard):
  - the last ranking, sortable and filterable by family, with a diverging score bar; click a skill to see every
    out-of-sample fold and the parameters picked on the past;
  - each bee's playbook: its brain, the skills it leans on and their weights, its message to the hive and lessons;
  - the hive-mind graph, built on React Flow with d3-force physics: bees, brains, skills, coins, styles, lessons,
    messages and memories, each with its own colour and shape; drag a node and the rest reacts; pan, zoom and minimap.
    Links show their confidence by line style (solid = measured fact, dashed = a brain's inference, dotted = disputed)
    and the legend filters kinds and confidence. Hover for details, click to pin a node and list its links (each link
    jumps to the other end), double-click to isolate its neighbourhood (1-3 hops), search highlights matches, Live
    follows the 30 s refresh (new nodes pulse) or freezes the picture. A table view carries the same data;
  - the latest messages and lessons.
- **`#/admin` – Admin** (owner password, the same gate and 15-minute lockout as joining the Hive):
  - **Overview**: mode, keys, brains, hive-mind size, the current lab job, restart;
  - **API keys**: Jev, OpenAI, Anthropic, Kimi. Write-only (the page only learns whether a key is set and where from),
    each tested with a free call before saving; keys set in `.env` stay there;
  - **Bees**: add or remove bees, and edit each one's name, tagline, style, assets (coin picker), rules and brain;
    see its health and level, revive a dead bee, or convene its brains now;
  - **Settings**: brains and models, Jev's cap, every risk limit, the per-style knobs, cadence and alerts. Saved as
    overrides in `admin.json`; a variable set in the environment always wins and shows as "set in .env";
  - **Lab, skills & evolution**: the **Real-data check** card runs the whole testing roteiro as one background job
    (1H history and skill ranking, 1m history and the scalper cost test, gold walk-forward / Monte Carlo / stability,
    council, hive report). It uses public candles only, places no orders and turns nothing on. A preflight lists what
    is ready, each step shows its status, and every stage ends with a verdict read back from the reports: skills must
    beat buy-and-hold out of sample on real data, the scalper needs an edge after costs (synthetic data never counts),
    gold needs its validation gates (a gate that did not run is not passed). Gold needs your own XAUUSD bar export
    from MT5 in `<LAB_DIR>/gold/data/`; without it those steps are skipped. Below it: start fetch / run / council / cycle (a child process, so the engine keeps trading),
    watch its log, run a coach review, the **Skill workshop** (below), **import a skill** (compiled and backtested on the spot), and set learning,
    survival and rewards;
  - **Skill workshop** (Lab tab): write skills in the JSON rule language from a template or blank, keep every version
    (30 per draft, the live one never dropped), check that it compiles, run a walk-forward backtest, and publish.
    Publishing needs a passing backtest on **real** history (positive out-of-sample score, 50%+ of folds positive, the
    same bar a bee's own skill must clear); a synthetic-data backtest is labelled and does not count, and only an explicit
    "publish anyway" overrides it. A draft cannot take a built-in's id. Published skills are written to
    `<LAB_DIR>/learned/owner_<id>.json`, join every lab run and can be adopted by a council, where they are one vote
    Jev may weigh. Skills the bees write themselves land here too: the ones that passed as live, the ones that
    compiled but failed their backtest as "proposed by a bee", so you can read, improve and re-test them. Drafts live in
    `<LAB_DIR>/workspace/`.
  - The Skill workshop also has an **Ask the skill agent** box: describe a strategy in words (or, on an open draft, the
    change you want) and pick any brain that can answer (default Claude, then ChatGPT, GLM, Kimi, then custom ones). The
    brain writes the JSON with the rule language in its prompt; the app compiles it and, if it does not compile, sends it
    back once with the compiler's complaints. The result is saved as a **draft** authored "AI · <brain>", never
    published: the brain has no market data and says so, and the normal backtest and publish gate apply. A revision
    keeps the same draft and id. Capped per day (the larger of `COACH_MAX_CALLS_DAY` and 20).
  - **Research & background** (Lab tab): what each bee has been studying, kept apart from lessons. Write a bee's
    **background** yourself (it applies at once), or press "Ask the brain to research": the bee's brain reads only what
    the app already holds (the lab ranking, the bee's trades and lessons, its peers, the market mood; no web, no external
    tool), drafts up to 3 notes that each cite evidence from that pack (a note without evidence is dropped), and they
    wait as **pending** until you approve them (at most 6 pending per bee, one research per bee per 30 minutes, within
    the daily brain-call cap). Approved notes are mirrored into the hive mind as memory nodes (`bee -researched-> note`,
    `note -about-> coin`, marked INFERRED) and reach the brains in their context under `background`, framed as
    hypotheses and never as orders or measured facts. A note written as "approved" by a brain is impossible: only you
    approve. Notes live in `<LAB_DIR>/notes.json`.
  - **Security**: change the owner password.

  Saved changes apply after **Restart engine** (the engine exits and Docker starts it again). The trading mode and
  `LIVE_ACK` are deliberately not in the panel: real money stays an `.env` decision.

## Suggested routine

1. `pnpm lab cycle` once a week (or after adding skills).
2. Read `data/lab/report.md`. Skills that do not beat buy-and-hold after costs, or with a large overfit gap, deserve
   suspicion whatever their rank.
3. Watch the bees on paper with `LAB_SIGNALS=true` and `COACH_INTERVAL_MIN=360` for a while before trusting anything.

Paper trading on simulated money. Backtests on past data do not predict future results. Not financial advice.
