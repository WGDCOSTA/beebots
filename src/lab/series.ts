// Causal indicator series for the strategy lab. Every function returns one value per input bar (oldest first) and the
// value at bar i only uses bars 0..i, so a signal read at bar i's close can never peek at the future. NaN = not enough
// data yet.
import type { Candle } from "../market/types.js";

export type Series = Float64Array;

const nan = (n: number) => new Float64Array(n).fill(NaN);

export const closes = (c: Candle[]): Series => Float64Array.from(c, (x) => x.c);

export function sma(xs: Series, n: number): Series {
  const out = nan(xs.length);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]!;
    if (i >= n) sum -= xs[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(xs: Series, n: number): Series {
  const out = nan(xs.length);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (Number.isNaN(x)) continue;
    prev = Number.isNaN(prev) ? x : x * k + prev * (1 - k);
    // Seeded from the first value: only trust it after n bars.
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export function stdev(xs: Series, n: number): Series {
  const out = nan(xs.length);
  for (let i = n - 1; i < xs.length; i++) {
    let m = 0;
    for (let j = i - n + 1; j <= i; j++) m += xs[j]!;
    m /= n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (xs[j]! - m) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

/** Wilder RSI. */
export function rsi(xs: Series, n = 14): Series {
  const out = nan(xs.length);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (i >= n) out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder ATR in price units. */
export function atr(c: Candle[], n = 14): Series {
  const out = nan(c.length);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const pc = c[i - 1]!.c;
    const tr = Math.max(c[i]!.h - c[i]!.l, Math.abs(c[i]!.h - pc), Math.abs(c[i]!.l - pc));
    if (i <= n) a += tr / n;
    else a = (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

/** Highest high of the n bars BEFORE bar i (a breakout compares today's close to the prior channel). */
export function priorHigh(c: Candle[], n: number): Series {
  const out = nan(c.length);
  for (let i = n; i < c.length; i++) {
    let h = -Infinity;
    for (let j = i - n; j < i; j++) h = Math.max(h, c[j]!.h);
    out[i] = h;
  }
  return out;
}

export function priorLow(c: Candle[], n: number): Series {
  const out = nan(c.length);
  for (let i = n; i < c.length; i++) {
    let l = Infinity;
    for (let j = i - n; j < i; j++) l = Math.min(l, c[j]!.l);
    out[i] = l;
  }
  return out;
}

/** Rate of change over n bars, in %. */
export function roc(xs: Series, n: number): Series {
  const out = nan(xs.length);
  for (let i = n; i < xs.length; i++) out[i] = xs[i - n]! > 0 ? (xs[i]! / xs[i - n]! - 1) * 100 : NaN;
  return out;
}

export function bollinger(xs: Series, n = 20, k = 2): { mid: Series; upper: Series; lower: Series; pctB: Series } {
  const mid = sma(xs, n);
  const sd = stdev(xs, n);
  const upper = mid.map((m, i) => m + k * sd[i]!);
  const lower = mid.map((m, i) => m - k * sd[i]!);
  const pctB = xs.map((x, i) => (upper[i]! === lower[i]! ? 0.5 : (x - lower[i]!) / (upper[i]! - lower[i]!)));
  return { mid, upper, lower, pctB };
}

export function macd(xs: Series, fast = 12, slow = 26, signal = 9): { line: Series; signal: Series; hist: Series } {
  const f = ema(xs, fast);
  const s = ema(xs, slow);
  const line = f.map((v, i) => v - s[i]!);
  const sig = ema(line, signal);
  // ema() skips leading NaNs but counts bars from 0, so the signal is only valid `signal` bars after the line is.
  for (let i = 0; i < Math.min(line.length, slow + signal - 2); i++) sig[i] = NaN;
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]!) };
}

/** (close - SMA) / stdev over n bars. */
export function zscore(xs: Series, n: number): Series {
  const m = sma(xs, n);
  const sd = stdev(xs, n);
  return xs.map((x, i) => (sd[i]! > 0 ? (x - m[i]!) / sd[i]! : NaN));
}

/** Stochastic %K over n bars. */
export function stochK(c: Candle[], n = 14): Series {
  const out = nan(c.length);
  for (let i = n - 1; i < c.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      h = Math.max(h, c[j]!.h);
      l = Math.min(l, c[j]!.l);
    }
    out[i] = h === l ? 50 : ((c[i]!.c - l) / (h - l)) * 100;
  }
  return out;
}

/** Supertrend direction: +1 up, -1 down (NaN until ATR is ready). */
export function supertrend(c: Candle[], n = 10, mult = 3): Series {
  const a = atr(c, n);
  const out = nan(c.length);
  let upper = NaN;
  let lower = NaN;
  let dir = 1;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(a[i]!)) continue;
    const hl2 = (c[i]!.h + c[i]!.l) / 2;
    const bu = hl2 + mult * a[i]!;
    const bl = hl2 - mult * a[i]!;
    const pc = c[i - 1]?.c ?? c[i]!.c;
    upper = Number.isNaN(upper) || bu < upper || pc > upper ? bu : upper;
    lower = Number.isNaN(lower) || bl > lower || pc < lower ? bl : lower;
    if (c[i]!.c > upper) dir = 1;
    else if (c[i]!.c < lower) dir = -1;
    out[i] = dir;
  }
  return out;
}

/** Candle bars per year, for annualising (bar length taken from the median gap). */
export function barsPerYear(c: Candle[]): number {
  if (c.length < 3) return 365 * 24;
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(c.length, 200); i++) gaps.push(c[i]!.ts - c[i - 1]!.ts);
  gaps.sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)]!;
  return g > 0 ? (365 * 86_400_000) / g : 365 * 24;
}
