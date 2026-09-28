// Risk and sizing. Every trade is sized so that hitting its stop costs the intended fraction of equity; the portfolio
// then caps what can be open (and reserved by pending orders) at once. Rejections are explicit: a risk-sensitive input
// is never quietly changed to make an order fit.
import type { ContractSpec, EngineConfig, StrategyId, StrategyProfile } from "./types.js";

/** Cash lost per lot if price moves `dist` (price units) against the position. */
export const lossPerLot = (c: ContractSpec, dist: number) => (Math.abs(dist) / c.tick_size) * c.tick_value;

export type Sized = { ok: true; lots: number; riskCash: number } | { ok: false; reason: string };

/**
 * Lots so that the stop distance costs `riskFraction` of `equity`. Rounded DOWN to the volume step (never up: that
 * would raise the risk). Below the minimum volume the order is rejected, not bumped to the minimum.
 */
export function sizeLots(c: ContractSpec, equity: number, riskFraction: number, entry: number, sl: number): Sized {
  const dist = Math.abs(entry - sl);
  if (!(dist > 0)) return { ok: false, reason: "zero stop distance" };
  const riskCash = equity * riskFraction;
  const raw = riskCash / lossPerLot(c, dist);
  const steps = Math.floor(raw / c.volume_step + 1e-9);
  const lots = Math.round(steps * c.volume_step * 1e8) / 1e8;
  if (lots < c.volume_min) return { ok: false, reason: `risk ${riskCash.toFixed(2)} buys ${raw.toFixed(4)} lots, under the ${c.volume_min} minimum` };
  if (lots > c.volume_max) return { ok: false, reason: `${lots} lots over the ${c.volume_max} maximum` };
  return { ok: true, lots, riskCash: lots * lossPerLot(c, dist) };
}

/** Margin a position needs (USD): notional / leverage. */
export const marginFor = (c: ContractSpec, lots: number, price: number) => (lots * c.contract_size * price) / c.leverage;

/** Broker-side legality of a pending price and a stop, in points from the market (section 33). */
export function stopLevelOk(c: ContractSpec, distance: number): boolean {
  return c.stop_level_points <= 0 || distance >= c.stop_level_points * c.point_size - 1e-9;
}

// ---------- strategy weights ----------

export const staticWeights = (profiles: StrategyProfile[]): Record<string, number> => Object.fromEntries(profiles.map((p) => [p.id, p.risk.weight]));

/**
 * Weights from observed drawdown: raw = 1 / max(maxDD, epsilon), normalised to sum to the static weights' sum (so the
 * total risk budget is unchanged and only the split moves), then blended: alpha x static + (1 - alpha) x drawdown.
 * A strategy with fewer than `min_trades` closed trades keeps its static weight. Only past results may be passed in.
 */
export function blendedWeights(
  profiles: StrategyProfile[],
  maxDrawdownPct: Record<string, number>,
  closedTrades: Record<string, number>,
  cfg: EngineConfig["drawdown_weighting"],
): Record<string, number> {
  const stat = staticWeights(profiles);
  if (!cfg.enabled) return stat;
  const known = profiles.filter((p) => (closedTrades[p.id] ?? 0) >= cfg.min_trades);
  if (known.length < 2) return stat;
  const raw = Object.fromEntries(known.map((p) => [p.id, 1 / Math.max(maxDrawdownPct[p.id] ?? 0, cfg.epsilon)]));
  const rawSum = Object.values(raw).reduce((a, b) => a + b, 0);
  const budget = known.reduce((a, p) => a + stat[p.id]!, 0);
  const out = { ...stat };
  for (const p of known) out[p.id] = cfg.alpha * stat[p.id]! + (1 - cfg.alpha) * ((raw[p.id]! / rawSum) * budget);
  return out;
}

export interface Reserved {
  /** Risk of positions that are open now (to their CURRENT stops: a stop past break-even carries none). */
  open: number;
  /** Per strategy: the larger of its pending buy-stop and sell-stop risk (they are one straddle). */
  pending: Map<StrategyId, number>;
}

export const totalReserved = (r: Reserved, includePending: boolean) => r.open + (includePending ? [...r.pending.values()].reduce((a, b) => a + b, 0) : 0);
