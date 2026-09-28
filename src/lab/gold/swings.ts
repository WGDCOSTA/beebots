// Structural swing detection. A bar is a swing high when its high is strictly above the highs of `left` bars before it
// and `right` bars after it (and the mirror for a swing low).
//
// ANTI-LOOK-AHEAD: a swing with right = N does not exist in real time until N further bars have CLOSED. Every lookup
// here is "as known at bar k" and only returns swings whose confirmation bar (index + right) is <= k. A backtest that
// marks the pivot at its own bar and trades it at once is invalid; this module cannot produce that.
import type { Candle } from "../../market/types.js";

export function isSwingHigh(bars: readonly Candle[], i: number, left: number, right: number): boolean {
  if (i - left < 0 || i + right >= bars.length) return false;
  const pivot = bars[i]!.h;
  for (let j = 1; j <= left; j++) if (bars[i - j]!.h >= pivot) return false;
  for (let j = 1; j <= right; j++) if (bars[i + j]!.h >= pivot) return false;
  return true;
}

export function isSwingLow(bars: readonly Candle[], i: number, left: number, right: number): boolean {
  if (i - left < 0 || i + right >= bars.length) return false;
  const pivot = bars[i]!.l;
  for (let j = 1; j <= left; j++) if (bars[i - j]!.l <= pivot) return false;
  for (let j = 1; j <= right; j++) if (bars[i + j]!.l <= pivot) return false;
  return true;
}

export interface Swing {
  kind: "high" | "low";
  /** Bar index of the pivot. */
  index: number;
  price: number;
  /** The first bar at whose CLOSE the swing is known: index + right. */
  confirmIndex: number;
}

/** Every swing of a series, oldest first, with the bar at which each becomes known. */
export class SwingIndex {
  readonly highs: Swing[] = [];
  readonly lows: Swing[] = [];

  constructor(
    readonly bars: readonly Candle[],
    readonly left: number,
    readonly right: number,
  ) {
    for (let i = left; i + right < bars.length; i++) {
      if (isSwingHigh(bars, i, left, right)) this.highs.push({ kind: "high", index: i, price: bars[i]!.h, confirmIndex: i + right });
      if (isSwingLow(bars, i, left, right)) this.lows.push({ kind: "low", index: i, price: bars[i]!.l, confirmIndex: i + right });
    }
  }

  private list(kind: "high" | "low") {
    return kind === "high" ? this.highs : this.lows;
  }

  /** Swings known once bar k has closed, whose pivot is within the last `lookback` bars, oldest first. */
  known(kind: "high" | "low", k: number, lookback = Infinity): Swing[] {
    const list = this.list(kind);
    // confirmIndex is increasing with index, so binary search the last known one.
    let lo = 0;
    let hi = list.length - 1;
    let end = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.confirmIndex <= k) {
        end = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (end < 0) return [];
    const out: Swing[] = [];
    for (let j = end; j >= 0 && list[j]!.index >= k - lookback; j--) out.push(list[j]!);
    return out.reverse();
  }

  /** The most recent swing known at bar k, or null. */
  latest(kind: "high" | "low", k: number): Swing | null {
    const s = this.known(kind, k, Infinity);
    return s.length ? s[s.length - 1]! : null;
  }
}
