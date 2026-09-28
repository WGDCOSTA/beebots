// Structural levels: which confirmed swing high (resistance) or swing low (support) a strategy trades against.
import type { Candle } from "../../market/types.js";
import type { Swing, SwingIndex } from "./swings.js";

export type LevelSelectionMode = "recent" | "prominent" | "touches" | "nearest";

export interface Level {
  kind: "high" | "low";
  price: number;
  /** Bar index of the pivot in the entry-timeframe series. */
  index: number;
  /** Bars between the pivot and the bar at which it was selected. */
  ageBars: number;
  /** Later bars that reached the level (within the tolerance) without breaking it. */
  touches: number;
  minutesSinceLastTouch: number | null;
  /** Distance from the pivot to the lowest low (highest high) around it. */
  prominence: number;
}

/** Bars after the pivot up to bar k whose extreme came within `tol` of the level. */
export function touchesOf(bars: readonly Candle[], s: Swing, k: number, tol: number, barMs: number): { touches: number; minutesSinceLast: number | null } {
  let touches = 0;
  let last = -1;
  for (let j = s.index + 1; j <= k; j++) {
    const b = bars[j]!;
    const near = s.kind === "high" ? b.h >= s.price - tol && b.h <= s.price + tol : b.l <= s.price + tol && b.l >= s.price - tol;
    if (near) {
      touches++;
      last = j;
    }
  }
  return { touches, minutesSinceLast: last >= 0 ? ((k - last) * barMs) / 60_000 : null };
}

function prominenceOf(bars: readonly Candle[], s: Swing, left: number, right: number): number {
  let ext = s.price;
  for (let j = Math.max(0, s.index - 2 * left); j <= Math.min(bars.length - 1, s.index + right); j++) ext = s.kind === "high" ? Math.min(ext, bars[j]!.l) : Math.max(ext, bars[j]!.h);
  return Math.abs(s.price - ext);
}

/**
 * Pick the level for `kind` as known at bar k (the last CLOSED bar of the entry timeframe). `price` is the current
 * market price (only "nearest" uses it: the closest level on the breakout side of it); `tol` is the touch tolerance.
 */
export function selectLevel(bars: readonly Candle[], sw: SwingIndex, k: number, kind: "high" | "low", mode: LevelSelectionMode, lookback: number, price: number, tol: number, barMs: number): Level | null {
  let cands = sw.known(kind, k, lookback);
  if (mode === "nearest") cands = cands.filter((s) => (kind === "high" ? s.price >= price : s.price <= price));
  if (!cands.length) return null;
  const decorate = (s: Swing): Level => {
    const t = touchesOf(bars, s, k, tol, barMs);
    return { kind, price: s.price, index: s.index, ageBars: k - s.index, touches: t.touches, minutesSinceLastTouch: t.minutesSinceLast, prominence: prominenceOf(bars, s, sw.left, sw.right) };
  };
  let pick: Swing;
  if (mode === "recent") pick = cands[cands.length - 1]!;
  else if (mode === "nearest") pick = cands.reduce((a, b) => (Math.abs(b.price - price) < Math.abs(a.price - price) || (Math.abs(b.price - price) === Math.abs(a.price - price) && b.index > a.index) ? b : a));
  else {
    const scored = cands.map((s) => ({ s, l: decorate(s) }));
    const key = (x: { l: Level }) => (mode === "prominent" ? x.l.prominence : x.l.touches);
    // Ties go to the more recent swing.
    pick = scored.reduce((a, b) => (key(b) > key(a) || (key(b) === key(a) && b.s.index > a.s.index) ? b : a)).s;
  }
  return decorate(pick);
}
