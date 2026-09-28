// Multi-timeframe helpers for the lab: build M5..D1 candles from a finer base, without peeking at the future.
//
// A bucket is only usable once it has closed: `resample` marks the last, still-forming bucket unconfirmed, and
// `closedAt(bucket)` (start + timeframe) is the moment its right edge is known. Buckets align to UTC (D1 = UTC day,
// H4 = 00/04/08/... UTC), which is not every broker's server clock: use the MT5 importer's utcOffsetHours to align.
import type { Candle } from "../market/types.js";

export type Tf = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
export const TF_MS: Record<Tf, number> = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };
export const TFS = Object.keys(TF_MS) as Tf[];

export function isTf(x: string): x is Tf {
  return x in TF_MS;
}

/**
 * Aggregate `base` candles (oldest first, constant `baseMs`) into `tfMs` buckets. Gaps (weekends, missing bars) simply
 * make a bucket with fewer bars. The last bucket is `confirmed` only when the base data reaches its right edge.
 */
export function resample(base: Candle[], baseMs: number, tfMs: number): Candle[] {
  if (tfMs === baseMs) return base.map((c) => ({ ...c }));
  if (tfMs < baseMs || tfMs % baseMs !== 0) throw new Error(`cannot build ${tfMs} ms bars from ${baseMs} ms bars`);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let lastEnd = 0;
  for (const b of base) {
    const start = Math.floor(b.ts / tfMs) * tfMs;
    if (!cur || cur.ts !== start) {
      if (cur) out.push(cur);
      cur = { ts: start, o: b.o, h: b.h, l: b.l, c: b.c, volUsd: b.volUsd, confirmed: true };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.volUsd += b.volUsd;
    }
    lastEnd = b.ts + baseMs;
  }
  if (cur) {
    // Only a full bucket is final. Data that stops mid-bucket leaves it forming.
    cur.confirmed = lastEnd >= cur.ts + tfMs;
    out.push(cur);
  }
  return out;
}

/** Right edge of a bar: the moment its close is known. */
export const closedAt = (c: Candle, tfMs: number) => c.ts + tfMs;

/** Index of the last bar of `series` (oldest first, bar length `tfMs`) already closed at time `t`, or -1. */
export function lastClosedIndex(series: Candle[], tfMs: number, t: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.ts + tfMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
