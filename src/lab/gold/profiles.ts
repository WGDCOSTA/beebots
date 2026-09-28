// The nine strategy profiles, the frequency ladder and the fake-breakout checkpoint rules.
//
// EVERY number below is a starting hypothesis for research, written at a reference gold price of 2500 USD. None is a
// claim about any commercial EA's parameters. They are meant to be scanned, walk-forwarded and thrown away.
import { TF_MS, TFS, type Tf } from "../resample.js";
import { EngineSchema, FREQUENCIES, StrategySchema, STRATEGY_IDS, type EngineConfig, type Frequency, type StrategyId, type StrategyProfile } from "./types.js";

type Row = {
  entry: Tf;
  exit: Tf;
  left: number;
  right: number;
  lookback: number;
  arm: number;
  offset: number;
  sl: number;
  tp: number;
  be: [number, number];
  trail: [number, number];
  structOffset: number;
  expiryBars: number;
  fake: "LOW" | "MEDIUM" | "HIGH";
  weight: number;
  maxRisk: number;
};

// Section 49's starting matrix (entry/exit timeframes), section 25's families (slow S1-S3, medium S4-S7, fast S8-S9)
// and section 26.2's example weights. Distances are USD at the reference price.
const ROWS: Record<StrategyId, Row> = {
  S1: { entry: "D1", exit: "H1", left: 3, right: 3, lookback: 60, arm: 40, offset: 2.0, sl: 55, tp: 80, be: [28, 2], trail: [40, 22], structOffset: 1.5, expiryBars: 6, fake: "HIGH", weight: 1.0, maxRisk: 0.25 },
  S2: { entry: "H4", exit: "M30", left: 3, right: 4, lookback: 90, arm: 25, offset: 1.5, sl: 38, tp: 55, be: [18, 1.5], trail: [28, 15], structOffset: 1.2, expiryBars: 12, fake: "HIGH", weight: 0.9, maxRisk: 0.25 },
  S3: { entry: "H4", exit: "M15", left: 3, right: 5, lookback: 100, arm: 20, offset: 1.5, sl: 32, tp: 45, be: [15, 1.2], trail: [22, 12], structOffset: 1.0, expiryBars: 12, fake: "MEDIUM", weight: 0.9, maxRisk: 0.25 },
  S4: { entry: "H1", exit: "M15", left: 3, right: 5, lookback: 100, arm: 12, offset: 1.5, sl: 26, tp: 34, be: [10, 1], trail: [16, 9], structOffset: 1.0, expiryBars: 24, fake: "MEDIUM", weight: 0.75, maxRisk: 0.25 },
  S5: { entry: "H1", exit: "M5", left: 3, right: 4, lookback: 100, arm: 10, offset: 1.2, sl: 22, tp: 28, be: [9, 1], trail: [14, 8], structOffset: 0.8, expiryBars: 24, fake: "MEDIUM", weight: 0.75, maxRisk: 0.25 },
  S6: { entry: "M30", exit: "M5", left: 3, right: 4, lookback: 120, arm: 8, offset: 1.0, sl: 16, tp: 20, be: [7, 0.8], trail: [11, 6], structOffset: 0.6, expiryBars: 32, fake: "LOW", weight: 0.65, maxRisk: 0.2 },
  S7: { entry: "M30", exit: "M5", left: 4, right: 3, lookback: 120, arm: 7, offset: 1.0, sl: 14, tp: 18, be: [6, 0.8], trail: [10, 5], structOffset: 0.6, expiryBars: 32, fake: "LOW", weight: 0.65, maxRisk: 0.2 },
  S8: { entry: "M15", exit: "M5", left: 3, right: 3, lookback: 150, arm: 5, offset: 0.8, sl: 10, tp: 12, be: [4.5, 0.6], trail: [7, 4], structOffset: 0.5, expiryBars: 40, fake: "LOW", weight: 0.5, maxRisk: 0.15 },
  S9: { entry: "M15", exit: "M1", left: 2, right: 3, lookback: 150, arm: 4, offset: 0.6, sl: 8, tp: 9, be: [3.5, 0.5], trail: [5.5, 3], structOffset: 0.4, expiryBars: 40, fake: "LOW", weight: 0.4, maxRisk: 0.1 },
};

export function defaultProfile(id: StrategyId): StrategyProfile {
  const r = ROWS[id];
  return StrategySchema.parse({
    id,
    enabled: true,
    entry_timeframe: r.entry,
    exit_timeframe: r.exit,
    structure: { left_bars: r.left, right_bars: r.right, max_lookback_bars: r.lookback, level_selection: "recent" },
    entry: { min_arm_distance: r.arm, breakout_offset: r.offset, pending_expiry_bars: r.expiryBars },
    stop_loss: { base_distance: r.sl },
    take_profit: { base_distance: r.tp },
    break_even: { enabled: true, trigger_distance: r.be[0], lock_distance: r.be[1] },
    trailing: { enabled: true, trigger_distance: r.trail[0], distance: r.trail[1] },
    structure_trailing: { enabled: true, timeframe: r.exit, offset: r.structOffset },
    fake_breakout: { enabled: true, mode: r.fake, reference: "structural_level", tolerance_points: 0, close_on_failure: true },
    risk: { weight: r.weight, max_trade_risk_pct: r.maxRisk },
  });
}

export const defaultProfiles = (): StrategyProfile[] => STRATEGY_IDS.map(defaultProfile);

/** Section 24, kept configurable: each step adds the next strategies. */
export const FREQUENCY_PROFILES: Record<Frequency, StrategyId[]> = {
  VERY_CONSERVATIVE: ["S1", "S2", "S3"],
  CONSERVATIVE: ["S1", "S2", "S3", "S4", "S5"],
  MODERATE: ["S1", "S2", "S3", "S4", "S5", "S6", "S7"],
  INTENSE: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"],
  EXTREME: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"],
};

export function activeProfiles(profiles: StrategyProfile[], frequency: Frequency, table = FREQUENCY_PROFILES): StrategyProfile[] {
  const on = new Set(table[frequency]);
  return profiles.filter((p) => p.enabled && on.has(p.id));
}

export const defaultEngine = (over: unknown = {}): EngineConfig => EngineSchema.parse(over);

export { FREQUENCIES };

/**
 * Confirmation checkpoints for the post-entry fake-breakout filter. After a fill, the first bar of each listed
 * timeframe that CLOSES after the fill is compared with the reference: LOW checks the strategy's exit timeframe once,
 * MEDIUM adds the next slower timeframe, HIGH the one after that (never slower than the entry timeframe).
 * `fake_breakout.checks` overrides all of it.
 */
export function fakeChecks(p: StrategyProfile): Array<{ timeframe: Tf; bars: number }> {
  const fb = p.fake_breakout;
  if (!fb.enabled) return [];
  if (fb.checks?.length) return fb.checks.map((c) => ({ timeframe: c.timeframe, bars: c.bars }));
  const n = fb.mode === "LOW" ? 1 : fb.mode === "MEDIUM" ? 2 : 3;
  const out: Array<{ timeframe: Tf; bars: number }> = [];
  let ix = TFS.indexOf(p.exit_timeframe);
  const cap = TFS.indexOf(p.entry_timeframe);
  for (let k = 0; k < n && ix < TFS.length; k++, ix++) {
    if (k > 0 && ix > cap) break;
    out.push({ timeframe: TFS[ix]!, bars: 1 });
  }
  return out;
}

/** Bars of a timeframe -> minutes. */
export const tfMinutes = (tf: Tf) => TF_MS[tf] / 60_000;
