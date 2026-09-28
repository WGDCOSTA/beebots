// Ablation (section 47): what does each layer add? Start from a bare structural breakout and switch the layers on one
// at a time, in a fixed order, on the same data. The point is to find out which components actually create value.
import { runGold, type GoldData, type RunOpts } from "../sim.js";
import type { EngineConfig, StrategyId, StrategyProfile } from "../types.js";
import { runMetrics, type Metrics } from "./metrics.js";

export const ABLATION_STEPS = [
  "baseline breakout only",
  "+ minimum arm distance",
  "+ entry offset",
  "+ fake-breakout filter",
  "+ break-even",
  "+ classic trailing",
  "+ structural trailing",
  "+ normalization",
  "+ news filter",
  "+ weighted portfolio",
] as const;

/** The config and profiles with layers 1..upto switched on (0 = the bare baseline). */
export function ablate(cfg: EngineConfig, profiles: StrategyProfile[], upto: number): { cfg: EngineConfig; profiles: StrategyProfile[] } {
  const c: EngineConfig = structuredClone(cfg);
  const ps = profiles.map((p0) => {
    const p: StrategyProfile = structuredClone(p0);
    if (upto < 1) p.entry.min_arm_distance = 0;
    if (upto < 2) p.entry.breakout_offset = 0;
    if (upto < 3) p.fake_breakout.enabled = false;
    if (upto < 4) p.break_even.enabled = false;
    if (upto < 5) p.trailing.enabled = false;
    if (upto < 6) p.structure_trailing.enabled = false;
    if (upto < 7) p.normalization = { ...(p.normalization ?? {}), mode: "NONE" };
    if (upto < 9) p.risk.weight = 1;
    return p;
  });
  if (upto < 7) c.normalization.mode = "NONE";
  if (upto < 8) c.filters.news.enabled = false;
  if (upto < 9) c.drawdown_weighting.enabled = false;
  return { cfg: c, profiles: ps };
}

export interface AblationRow {
  step: string;
  metrics: Metrics;
  /** Change against the previous step. */
  delta: { netProfit: number; expectancyR: number; maxDrawdownPct: number; trades: number };
  note?: string;
}

export function runAblation(cfg: EngineConfig, data: GoldData, profiles: StrategyProfile[], strategies: StrategyId[], engineOpts: Pick<RunOpts, "from" | "to" | "commit"> = {}): AblationRow[] {
  const rows: AblationRow[] = [];
  let prev: Metrics | null = null;
  ABLATION_STEPS.forEach((step, k) => {
    const a = ablate(cfg, profiles, k);
    const m = runMetrics(runGold(a.cfg, data, { profiles: a.profiles, strategies, ...engineOpts })).portfolio;
    const note = k === 8 && cfg.filters.news.events.length === 0 ? "no news calendar loaded: this layer cannot change anything" : k === 7 && cfg.normalization.mode === "NONE" ? "normalization is NONE in the config: no effect" : undefined;
    rows.push({
      step,
      metrics: m,
      delta: { netProfit: m.netProfit - (prev?.netProfit ?? 0), expectancyR: m.expectancyR - (prev?.expectancyR ?? 0), maxDrawdownPct: m.maxDrawdownPct - (prev?.maxDrawdownPct ?? 0), trades: m.trades - (prev?.trades ?? 0) },
      ...(note ? { note } : {}),
    });
    prev = m;
  });
  return rows;
}
