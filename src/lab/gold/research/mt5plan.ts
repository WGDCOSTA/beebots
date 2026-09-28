// "Generate an MT5 implementation plan for the current configuration": a build plan for an MQL5 Expert Advisor that
// implements this model, derived from the config. This module writes text; it does not talk to MetaTrader and it does
// not enable trading. The host system and the user must enable live execution themselves.
import { fakeChecks } from "../profiles.js";
import type { EngineConfig, StrategyProfile } from "../types.js";
import { magicOf } from "../types.js";

const MQ_TF: Record<string, string> = { M1: "PERIOD_M1", M5: "PERIOD_M5", M15: "PERIOD_M15", M30: "PERIOD_M30", H1: "PERIOD_H1", H4: "PERIOD_H4", D1: "PERIOD_D1" };

export function mt5Plan(cfg: EngineConfig, profiles: StrategyProfile[]): string {
  const L: string[] = [];
  L.push(`# MT5 implementation plan: multi-strategy gold breakout (${cfg.symbol})`, "");
  L.push(`Independent implementation plan for an MQL5 Expert Advisor. It follows the research model in this repository; it does not reproduce any commercial EA. **Live trading stays disabled** until the user explicitly enables it in the EA inputs (\`InpLiveTrading=false\` by default; without it the EA logs what it would do).`, "");
  L.push(`## 1. Inputs`, "", "| input | default | note |", "|---|---|---|");
  const rows: Array<[string, string, string]> = [
    ["InpLiveTrading", "false", "the master switch; false = log only"],
    ["InpBaseMagic", "620000", "strategy Sn uses BaseMagic + n"],
    ["InpFrequency", cfg.frequency, "which of S1..S9 run (very conservative .. extreme)"],
    ["InpMaxTradeRiskPct", "0.25", "per strategy, times its weight"],
    ["InpMaxOpenRiskPct", String(cfg.risk.max_open_risk_pct), "open + pending reservation"],
    ["InpMaxDailyLossPct / InpMaxWeeklyLossPct", `${cfg.risk.max_daily_loss_pct} / ${cfg.risk.max_weekly_loss_pct}`, "kill: close all, block until the next day / week"],
    ["InpMaxConcurrent / InpMaxCorrelated", `${cfg.risk.max_concurrent_positions} / ${cfg.risk.max_correlated_positions}`, ""],
    ["InpMaxSpread", String(cfg.filters.spread.max_allowed), "price units; the same on every entry"],
    ["InpServerTimezone", cfg.timezone, "explicit; sessions, weekend and rollovers use it"],
  ];
  for (const [a, b, c] of rows) L.push(`| ${a} | ${b} | ${c} |`);
  L.push("", `## 2. Modules (one .mqh each)`, "");
  L.push("- `Swings.mqh`: `IsSwingHigh/Low(rates, i, left, right)` with strict comparisons. A swing at index i is usable only when bar i-right has closed: scan `shift >= right` on closed bars, never shift 0.");
  L.push("- `Levels.mqh`: latest / most prominent / most touched / nearest level inside `max_lookback_bars`; level age, touches, minutes since the last touch (logged with every trade).");
  L.push("- `Normalization.mqh`: NONE, PRICE_RATIO (`SymbolInfoDouble(SYMBOL_BID) / reference`), ATR (`iATR` handle per entry timeframe over a stored reference ATR), HYBRID, clamped to [0.25, 4].");
  L.push("- `Filters.mqh`: spread (`SYMBOL_SPREAD` * `SYMBOL_POINT`), sessions with `TimeGMT()` and explicit windows, news via `CalendarValueHistory` (block before/after, cancel pendings), Friday cut-off and weekly close.");
  L.push("- `Orders.mqh`: `CTrade.BuyStop/SellStop` with `ORDER_TIME_SPECIFIED` expiry, OCO by deleting the sibling in `OnTradeTransaction`, `SYMBOL_TRADE_STOPS_LEVEL` and `SYMBOL_TRADE_FREEZE_LEVEL` checks before every place and modify. Reject rather than adjust.");
  L.push("- `Exits.mqh`: break-even, classic trailing (only tightens), structure trailing on the exit timeframe (swing low/high formed after the entry and confirmed), fake-breakout checkpoints on the first bar of each listed timeframe that closes after the fill, news and session exits.");
  L.push("- `Risk.mqh`: lots from `OrderCalcProfit` for the stop distance, rounded DOWN to `SYMBOL_VOLUME_STEP`, rejected under `SYMBOL_VOLUME_MIN`; margin check with `OrderCalcMargin`; portfolio ceiling, kill switches, duplicate-level clustering (ALLOW / MERGE / KEEP_HIGHEST_PRIORITY / REDUCE_POSITION_SIZE).");
  L.push("- `Log.mqh`: one structured line per signal (strategy, time, side, level, entry, stop, target, level age, arm distance, spread, normalization factor, risk %, state), plus the trade comment `Sn|level|ver`.", "");
  L.push(`## 3. Strategies in this configuration`, "", "| id | magic | entry TF | exit TF | swing L/R | lookback | arm | offset | SL | TP | fake | weight |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of profiles) L.push(`| ${p.id} | ${magicOf(p.id)} | ${MQ_TF[p.entry_timeframe]} | ${MQ_TF[p.exit_timeframe]} | ${p.structure.left_bars}/${p.structure.right_bars} | ${p.structure.max_lookback_bars} | ${p.entry.min_arm_distance} | ${p.entry.breakout_offset} | ${p.stop_loss.base_distance} | ${p.take_profit.base_distance} | ${p.fake_breakout.enabled ? `${p.fake_breakout.mode}: ${fakeChecks(p).map((c) => c.timeframe).join("+")}` : "off"} | ${p.risk.weight} |`);
  L.push("", "Distances are USD at the reference gold price and are scaled by the normalization factor at run time.", "");
  L.push(`## 4. Event flow`, "", "1. `OnInit`: build indicator handles per timeframe, load the news calendar, refuse to start if `InpLiveTrading` is set without the explicit acknowledgement input.", "2. `OnTimer` (1 s) and `OnTick`: on each new closed bar of a strategy's entry timeframe, cancel expired or invalidated pendings and re-arm from the current structure.", "3. `OnTradeTransaction`: on a fill, cancel the OCO sibling, start the fake-breakout checkpoints, record the entry snapshot (level, ATR, spread, normalization factor).", "4. On each closed bar of the exit timeframe: fake-breakout check, break-even, trailing, structure trailing.", "5. Risk manager on every tick: daily / weekly loss kill, weekend and news policies.", "");
  L.push(`## 5. Before any real money`, "", "Run the same configuration through the research harness (walk-forward, Monte Carlo, parameter stability, ablation), then MT5 Strategy Tester on tick data with real spreads, then demo trading. Compare the EA's trades with the simulator's on the same period: any systematic difference is a bug in one of them.", "");
  return L.join("\n");
}
