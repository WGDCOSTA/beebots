// Dynamic profit-locking ratchet: an overlay on every opted-in style's own stops (engine.ts markBee).
//
// Two stop candidates from the best price since entry (the peak), and the more protective one wins:
//   - Hard profit floor: past +atPct% of gain the stop keeps `keep` of the move (e.g. +2.5% -> 50%, +5% -> 65%).
//   - Runner hug: past +atPct% the stop trails `atr` x ATR behind the peak, tighter the more the trade has run
//     (e.g. 1.2x ATR from +2.5%, 0.8x from +5%, 0.6x from +8%).
// The engine only ever moves a stop in the position's favour, so once a rung is reached the floor never loosens.
// A gap or slippage can still fill past the stop: the floor is a stop level, not a guaranteed fill.
import type { Side } from "./types.js";
import { profitLockStop } from "./common.js";

export interface LockRung {
  atPct: number;
  keep: number;
}
export interface HugRung {
  atPct: number;
  atr: number;
}

/**
 * Parse "2.5:0.5,5:0.65" into rungs sorted by threshold. Bad pairs are dropped; `max` bounds the second number
 * (a keep fraction must stay below 1, an ATR multiple above 0).
 */
export function parseRungs(spec: string, max: number): Array<{ atPct: number; v: number }> {
  return spec
    .split(",")
    .map((p) => p.trim().split(":").map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite) && p[0]! > 0 && p[1]! > 0 && p[1]! <= max)
    .map(([atPct, v]) => ({ atPct, v }))
    .sort((a, b) => a.atPct - b.atPct);
}

export const parseLock = (spec: string): LockRung[] => parseRungs(spec, 0.99).map((r) => ({ atPct: r.atPct, keep: r.v }));
export const parseHug = (spec: string): HugRung[] => parseRungs(spec, 20).map((r) => ({ atPct: r.atPct, atr: r.v }));

/** The runner hug's ATR multiple at this gain (the tightest rung reached), or null below the first rung. */
export function hugMult(gainPct: number, hug: readonly HugRung[]): number | null {
  let k: number | null = null;
  for (const r of hug) if (gainPct >= r.atPct) k = k === null ? r.atr : Math.min(k, r.atr);
  return k;
}

/**
 * The ratchet's stop candidate, or null before the first rung. `atrPct` is the coin's ATR as % of price (null when
 * unknown: then only the hard floor applies).
 */
export function dynamicRatchetStop(
  side: Side,
  entryPx: number,
  peakPx: number,
  atrPct: number | null,
  lock: readonly LockRung[],
  hug: readonly HugRung[],
): number | null {
  const dir = side === "long" ? 1 : -1;
  if (!(entryPx > 0) || !(peakPx > 0)) return null;
  const gainPct = ((dir * (peakPx - entryPx)) / entryPx) * 100;
  if (!(gainPct > 0)) return null;
  const floor = profitLockStop(side, entryPx, peakPx, lock);
  const k = atrPct !== null && atrPct > 0 ? hugMult(gainPct, hug) : null;
  const runner = k !== null ? peakPx - dir * k * peakPx * (atrPct! / 100) : null;
  if (floor === null) return runner;
  if (runner === null) return floor;
  return side === "long" ? Math.max(floor, runner) : Math.min(floor, runner);
}
