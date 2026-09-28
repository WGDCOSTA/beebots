# multi-strategy-gold-breakout

| | |
|---|---|
| **Skill name** | `multi-strategy-gold-breakout` |
| **Version** | 1.0.0 (`STRATEGY_VERSION` in `src/lab/gold/sim.ts`) |
| **Target market** | XAUUSD / gold |
| **Strategy class** | Structural support/resistance breakout, multi-timeframe confirmation, nine portfolio-style sub-strategies |
| **Primary use** | Research, backtesting, paper-trading design, strategy prototyping, execution planning |
| **Default mode** | Simulation / backtest |
| **Live trading** | **Disabled.** This module has no execution adapter and refuses `live_trading: true`. A host system and the user must supply and enable their own execution. |

An independent quantitative research model. It is **not** a copy of any commercial Expert Advisor, contains no proprietary code, parameters or decompiled logic, and makes no claim about what any commercial system runs. Trading leveraged products such as XAUUSD can lose more than the account. Simulated performance does not guarantee future results.

## What it is

The engine does not forecast gold. It finds *confirmed* structural highs and lows, waits until price has moved away from them, arms **stop orders beyond the level** (never a market chase), enters only if price comes back and breaks it, throws the trade out fast if the breakout fails, and trails the ones that work.

```
Market data -> Swing detection -> Support/Resistance -> Strategy profiles S1..S9 -> Eligibility filters
-> Pending order generator -> Breakout trigger -> Fake-breakout confirmation -> Position management
-> Risk & portfolio manager -> Simulation
```

## Where things live

| Spec section | Repository |
|---|---|
| Swing detection, anti-look-ahead (7, 39) | `src/lab/gold/swings.ts` |
| Structural levels (8) | `src/lab/gold/levels.ts` |
| Normalisation, lot sizing (20, 21) | `src/lab/gold/normalization.ts`, `portfolio.ts` |
| Profiles S1-S9, frequency ladder (22-25, 49) | `src/lab/gold/profiles.ts`, `config/*.json` |
| Filters: spread, sessions, news, weekend (28-31) | `src/lab/gold/filters.ts`, `time.ts` |
| Simulator: orders, exits, state machine (9-19, 35-37) | `src/lab/gold/sim.ts` |
| Risk and weights (26, 27, 32, 33) | `src/lab/gold/portfolio.ts`, `sim.ts` |
| Metrics, attribution, breakout quality (44-46) | `src/lab/gold/research/metrics.ts` |
| Walk-forward (40) | `research/walkforward.ts` |
| Monte Carlo (42) | `research/montecarlo.ts` |
| Parameter stability, search (43, 50, 51) | `research/stability.ts`, `params.ts`, `optimizer.ts` |
| Ablation (47) | `research/ablation.ts` |
| Black-box calibration (48) | `research/blackbox.ts` |
| Reports, output contract, reproducibility (55-57) | `research/report.ts`, `hash.ts` |
| MT5 implementation plan | `research/mt5plan.ts` |
| Data: MT5 CSV import, multi-timeframe (6) | `src/lab/history.ts` (`parseMt5Csv`), `src/lab/resample.ts` |
| CLI | `src/tools/gold.ts` (`pnpm gold ...`) |
| Tests | `test/gold-*.test.ts`, `test/synth.ts` |

Deviations from the spec's suggested layout: the config is **JSON**, not YAML (the repo has no YAML dependency and its lab already imports skills as JSON); the code is TypeScript in the lab, not a folder of scripts next to this file; **no news calendar is bundled** (hard-coding "NFP is the first Friday" is wrong often enough to be worse than no filter): load your own with `--news events.csv`.

## Running it

```
pnpm gold init                                   # write the default JSON configs (already in ./config)
pnpm gold run         --csv XAUUSD_M5.csv --base M5 --frequency MODERATE --from 2020-01-01 --to 2025-01-01
pnpm gold walkforward --csv XAUUSD_M5.csv --base M5 --strategies S4,S5 --train 36 --validate 12 --step 12
pnpm gold montecarlo  --csv XAUUSD_M5.csv --base M5 --runs 1000
pnpm gold ablation    --csv XAUUSD_M5.csv --base M5 --strategies S4
pnpm gold stability   --csv XAUUSD_M5.csv --base M5 --strategy S4 --dims arm,sl,tp,fake
pnpm gold fit         --csv XAUUSD_M5.csv --base M5 --trades public_trades.csv
pnpm gold plan        --frequency MODERATE       # an MT5 implementation plan
pnpm gold demo                                   # synthetic data: exercises the code, proves nothing
```

Data: an **MT5 "Export bars" CSV** (`--csv`; `--utc-offset` is the server's offset from UTC, `--point` the point size; the `<SPREAD>` column is used as the real spread history), or a candle cache from `pnpm lab fetch` (`--inst NAME --bar 5m`). Use the finest timeframe you have as `--base` (M1 is best for S9); coarser timeframes are built from it and only count once closed. Reports go to `<LAB_DIR>/gold/reports/` (`.md` and `.json`).

Instruction examples this skill accepts: *Backtest S1-S9 on XAUUSD from 2018-2025. Find stable swing parameters for the H1 breakout family. Compare price-ratio with ATR normalisation. Run an ablation on the fake-breakout filter. Estimate which profile generated these historical trades. Generate an MT5 implementation plan.*

## Configuration

`config/default.json` is the engine (validated by `EngineSchema` in `src/lab/gold/types.ts`); `config/s1.json` .. `s9.json` are the profiles (`StrategySchema`). A field left out takes the schema default. The nine profiles are **starting hypotheses**, written at a reference gold price of 2500 USD and matching section 49's timeframe matrix, section 25's families and section 26.2's example weights. They are meant to be scanned, walk-forwarded and thrown away.

Safety defaults: `mode: backtest`, `live_trading: false`, no martingale, no grid, `max_trade_risk_pct` 0.25 (S8 0.15, S9 0.10), `max_open_risk_pct` 1.0, `max_daily_loss_pct` 2.0, `max_weekly_loss_pct` 4.0.

A small account cannot size the slow strategies: 0.25% of 10,000 is 25 USD, and S1's 55 USD stop at the 0.01 lot minimum risks 55. The engine **rejects** such an order ("sizing: ... under the 0.01 minimum") instead of rounding up, and the report's rejection counts show it. Use a larger balance, or the faster strategies.

## How it decides (the parts that matter)

- **No look-ahead.** A swing with `right_bars = N` is unknown until N further bars have closed (`SwingIndex.known`). Higher timeframes are built from base bars and only count once closed. Orders armed at a bar's close act from the next bar. A test cuts the data off at an arbitrary bar and asserts nothing before the cut changes.
- **Pessimistic bar order.** Inside one bar the stop is checked before the target, and a new order cannot fill and take profit in the same bar. Bars are bid prices; the ask is bid + spread.
- **Orders.** Buy stop at `resistance + offset`, sell stop at `support - offset`, with a finite lifetime; expired or invalidated orders are cancelled and re-armed from the current structure. A strategy's buy and sell stop are one straddle: when one fills the other is cancelled (`oco`, on by default).
- **Fake-breakout filter.** After the fill, the first bar of each checkpoint timeframe that closes after it is compared with the level (or the entry). LOW checks the strategy's exit timeframe, MEDIUM adds the next slower one, HIGH the one after (never slower than the entry timeframe); `fake_breakout.checks` overrides. A failed check closes the trade (`FAKE_BREAKOUT`).
- **Exits.** Hard stop and target on every trade, break-even, classic trailing, structure trailing under the first confirmed swing formed after the entry, optional trailing take profit. A stop only ever tightens (a test records every stop change on a long noisy run). Exit reasons: `TP SL BE TRAIL STRUCTURE_TRAIL FAKE_BREAKOUT NEWS_EXIT SESSION_EXIT RISK_KILL END`.
- **Normalisation.** `NONE`, `PRICE_RATIO`, `ATR`, `HYBRID`; the factor is clamped to [0.25, 4]. A missing reference ATR is taken from the median of the first 500 bars of the data, never from the period under test.
- **Risk.** Lots make the stop cost the intended fraction of equity, rounded **down** to the volume step; below the minimum the order is rejected. Open risk plus what pending orders could add must stay under `max_open_risk_pct` (checked when arming and again at the fill with the risk the fill really carries); concurrent and same-direction positions are capped; a daily or weekly loss breach closes everything and blocks entries until the next day or week. Duplicate levels across strategies follow `ALLOW / MERGE / KEEP_HIGHEST_PRIORITY / REDUCE_POSITION_SIZE`. Optional drawdown-aware weights use only trades that have already closed.

## Output contract

Every report holds: 1 configuration, 2 data period, 3 data source, 4 broker assumptions, 5 trade count, 6 portfolio metrics, 7 per-strategy metrics (and attribution), 8 drawdown (the report opens with it) and the worst months, 9 equity curve, 10 parameter stability, 11 failed **or unrun** tests, 12 limitations, 13 reproducibility (`run_id`, `strategy_version`, `config_hash`, `data_hash`, `code_commit`, dates, spread and slippage models, timezone, seed). A performance claim without those fields is not reproducible. Walk-forward output lists every window, the losing ones included.

## Rules for the agent operating this skill

1. Separate observed evidence from hypotheses; label fitted parameters **estimated**, never as facts about a commercial system.
2. Reject look-ahead-contaminated backtests. Report losing periods and the drawdown prominently. Prefer parameter stability over maximum historical profit.
3. Never describe an in-sample result as evidence; the gates in section 11 need a walk-forward, a Monte Carlo and a stability scan, and a gate that was not run is *not passed*.
4. No martingale, no averaging, no grid, no size increase after a loss. Never change parameters silently in a live setting.
5. Default to research. Never enable live execution: that is the host system's and the user's explicit act, outside this module.

## Acceptance criteria (section 60) and where each is tested

| Criterion | Test (`test/gold-*.test.ts`) |
|---|---|
| Deterministic swing detection, no look-ahead | `swings and the anti-look-ahead rule`; `has no look-ahead: cutting the data off...` |
| S1-S9 run independently | `frequency profiles add strategies step by step; profiles are independent` |
| Pending orders, expiry, invalidation | `arms a buy stop above the level...`; `a pending order that never fills expires...` |
| Fake-breakout logic | `a fake breakout closes the trade when...` |
| Break-even, classic and structural trailing | `break-even moves the stop...`; `classic trailing follows the peak...`; `structure trailing moves the stop...`; `a stop only ever moves in the position's favour` |
| Normalisation | `normalisation modes scale distances...` |
| Portfolio risk limits | `open plus reserved risk never exceeds the ceiling`; `never more than the configured concurrent...`; `the daily loss limit closes everything...` |
| News / spread / session filters | `filters and limits` |
| Reproducible backtests | `is deterministic and reproducible...` |
| Per-strategy attribution | `attributes every trade to a strategy...` |
| Monte Carlo, walk-forward | `test/gold-research.test.ts` |
| Regression on fixed datasets (section 59) | `golden regression` |
