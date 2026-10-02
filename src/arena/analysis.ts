// The numbers behind an agent's market report. Everything here is computed by code from real candles, so a figure in a report
// is never something a model made up: the model chooses what to look at and how to argue, the code supplies the facts.
import type { Candle } from "../market/types.js";

export type BarSize = "15m" | "1H" | "4H";
export const BAR_MS: Record<BarSize, number> = { "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000 };

/** The bar size and the number of bars for a window of days, within what the exchange's candle call returns in one go. */
export function windowFor(days: number): { bar: BarSize; limit: number; days: number } {
  const d = Math.max(1, Math.min(30, Math.round(days)));
  const bar: BarSize = d <= 2 ? "15m" : d <= 14 ? "1H" : "4H";
  return { bar, limit: Math.min(300, Math.ceil((d * 86_400_000) / BAR_MS[bar])), days: d };
}

export const sma = (v: number[], n: number): Array<number | null> => v.map((_, i) => (i + 1 < n ? null : v.slice(i + 1 - n, i + 1).reduce((s, x) => s + x, 0) / n));

/** Wilder's RSI. */
export function rsi(close: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = close.map(() => null);
  if (close.length <= n) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i]! - close[i - 1]!;
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= n;
  l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i]! - close[i - 1]!;
    g = (g * (n - 1) + Math.max(0, d)) / n;
    l = (l * (n - 1) + Math.max(0, -d)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Average true range, as a share of the last close (percent). */
export function atrPct(c: Candle[], n = 14): number | null {
  if (c.length <= n) return null;
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1]!.c), Math.abs(x.l - c[i - 1]!.c))));
  const a = tr.slice(-n).reduce((s, x) => s + x, 0) / n;
  return (a / c[c.length - 1]!.c) * 100;
}

export interface Point {
  ts: number;
  px: number;
}
export interface Pivot extends Point {
  kind: "high" | "low";
}

/** Swing highs and lows: a bar whose high (low) is the highest (lowest) of the k bars on each side. */
export function pivots(c: Candle[], k = 4): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i < c.length - k; i++) {
    const win = c.slice(i - k, i + k + 1);
    if (c[i]!.h === Math.max(...win.map((x) => x.h))) out.push({ ts: c[i]!.ts, px: c[i]!.h, kind: "high" });
    else if (c[i]!.l === Math.min(...win.map((x) => x.l))) out.push({ ts: c[i]!.ts, px: c[i]!.l, kind: "low" });
  }
  return out;
}

export interface Drawdown {
  pct: number;
  peak: Point;
  trough: Point;
}
/** The deepest fall from a closing peak to a later close. */
export function maxDrawdown(c: Candle[]): Drawdown {
  let peak: Point = { ts: c[0]!.ts, px: c[0]!.c };
  let best: Drawdown = { pct: 0, peak, trough: peak };
  for (const x of c) {
    if (x.c > peak.px) peak = { ts: x.ts, px: x.c };
    const dd = ((peak.px - x.c) / peak.px) * 100;
    if (dd > best.pct) best = { pct: dd, peak, trough: { ts: x.ts, px: x.c } };
  }
  return best;
}

/** Least-squares slope of the closes, as a share of the mean close per day, and how well a line fits (r squared). */
export function trendLine(c: Candle[], barMs: number): { slopePctPerDay: number; r2: number } {
  const n = c.length;
  const y = c.map((x) => x.c);
  const mx = (n - 1) / 2;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mx) * (y[i]! - my);
    sxx += (i - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slopePctPerDay: ((slope * (86_400_000 / barMs)) / my) * 100, r2 };
}

export type TrendWord = "up" | "down" | "sideways";
/** The rule is stated on the report: a clear line (r squared 0.35 or more) rising or falling by 0.25 % a day or more. */
export const TREND_RULE = { minSlopePctPerDay: 0.25, minR2: 0.35 };

export interface Facts {
  symbol: string;
  label: string;
  /** What the data is, when it is not the thing itself (a perpetual contract that tracks gold, say). */
  note: string;
  kind: string;
  bar: BarSize;
  from: number;
  to: number;
  bars: number;
  first: number;
  last: number;
  returnPct: number;
  high: Point;
  low: Point;
  rangePct: number;
  maxDrawdown: Drawdown;
  atrPct: number | null;
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  trend: TrendWord;
  slopePctPerDay: number;
  r2: number;
  bestBar: { ts: number; pct: number };
  worstBar: { ts: number; pct: number };
  upBarsPct: number;
  /** Volume of the second half of the window against the first, in percent (null when the exchange gave no volume). */
  volumeChangePct: number | null;
  support: number[];
  resistance: number[];
  pivots: Pivot[];
}

export interface Series {
  bars: Array<[number, number, number, number, number, number]>;
  sma20: Array<number | null>;
  sma50: Array<number | null>;
  rsi: Array<number | null>;
}

const r4 = (x: number) => Number(x.toPrecision(7));

/** Facts and the series for the charts, from confirmed candles (oldest first). Needs at least 12 bars. */
export function computeFacts(meta: { symbol: string; label: string; note?: string; kind: string; bar: BarSize }, candles: Candle[]): { facts: Facts; series: Series } | null {
  const c = candles.filter((x) => x.confirmed && Number.isFinite(x.c) && x.c > 0 && x.h >= x.l);
  if (c.length < 12) return null;
  const close = c.map((x) => x.c);
  const first = c[0]!.c;
  const last = c[c.length - 1]!;
  const hi = c.reduce((a, x) => (x.h > a.h ? x : a), c[0]!);
  const lo = c.reduce((a, x) => (x.l < a.l ? x : a), c[0]!);
  const barMs = BAR_MS[meta.bar];
  const tl = trendLine(c, barMs);
  const trend: TrendWord = tl.r2 >= TREND_RULE.minR2 && tl.slopePctPerDay >= TREND_RULE.minSlopePctPerDay ? "up" : tl.r2 >= TREND_RULE.minR2 && tl.slopePctPerDay <= -TREND_RULE.minSlopePctPerDay ? "down" : "sideways";
  const steps = c.slice(1).map((x, i) => ({ ts: x.ts, pct: ((x.c - c[i]!.c) / c[i]!.c) * 100 }));
  const best = steps.reduce((a, x) => (x.pct > a.pct ? x : a), steps[0]!);
  const worst = steps.reduce((a, x) => (x.pct < a.pct ? x : a), steps[0]!);
  const half = Math.floor(c.length / 2);
  const v1 = c.slice(0, half).reduce((s, x) => s + x.volUsd, 0);
  const v2 = c.slice(half).reduce((s, x) => s + x.volUsd, 0);
  const pv = pivots(c);
  const res = [...new Set(pv.filter((p) => p.kind === "high" && p.px > last.c).map((p) => r4(p.px)))].sort((a, b) => a - b).slice(0, 2);
  const sup = [...new Set(pv.filter((p) => p.kind === "low" && p.px < last.c).map((p) => r4(p.px)))].sort((a, b) => b - a).slice(0, 2);
  const s20 = sma(close, 20);
  const s50 = sma(close, 50);
  const rs = rsi(close, 14);
  const facts: Facts = {
    symbol: meta.symbol,
    label: meta.label,
    note: meta.note ?? "",
    kind: meta.kind,
    bar: meta.bar,
    from: c[0]!.ts,
    to: last.ts,
    bars: c.length,
    first: r4(first),
    last: r4(last.c),
    returnPct: ((last.c - first) / first) * 100,
    high: { ts: hi.ts, px: r4(hi.h) },
    low: { ts: lo.ts, px: r4(lo.l) },
    rangePct: ((hi.h - lo.l) / lo.l) * 100,
    maxDrawdown: maxDrawdown(c),
    atrPct: atrPct(c),
    rsi14: rs[rs.length - 1] ?? null,
    sma20: s20[s20.length - 1] ?? null,
    sma50: s50[s50.length - 1] ?? null,
    trend,
    slopePctPerDay: tl.slopePctPerDay,
    r2: tl.r2,
    bestBar: best,
    worstBar: worst,
    upBarsPct: (steps.filter((s) => s.pct > 0).length / steps.length) * 100,
    volumeChangePct: v1 > 0 && v2 >= 0 ? ((v2 - v1) / v1) * 100 : null,
    support: sup,
    resistance: res,
    pivots: pv,
  };
  return { facts, series: { bars: c.map((x) => [x.ts, r4(x.o), r4(x.h), r4(x.l), r4(x.c), Math.round(x.volUsd)]), sma20: s20.map((x) => (x === null ? null : r4(x))), sma50: s50.map((x) => (x === null ? null : r4(x))), rsi: rs.map((x) => (x === null ? null : Number(x.toFixed(2)))) } };
}

export interface Metric {
  id: string;
  label: string;
  /** The raw number, for checking a figure written in a text. */
  value: number;
  unit: "%" | "px" | "" | "x";
  /** How to read it, in plain words. */
  help: string;
}

/** The figures a report may show or quote, by id. The ids are what the model refers to. */
export function metricsOf(f: Facts): Metric[] {
  const m: Metric[] = [
    { id: "return", label: "Return over the window", value: f.returnPct, unit: "%", help: "Last close against the first close." },
    { id: "range", label: "High to low range", value: f.rangePct, unit: "%", help: "Highest high against lowest low." },
    { id: "maxdd", label: "Deepest fall from a peak", value: -f.maxDrawdown.pct, unit: "%", help: "From a closing peak to a later close." },
    { id: "slope", label: "Trend slope per day", value: f.slopePctPerDay, unit: "%", help: `A straight line through the closes (fit ${f.r2.toFixed(2)}). Up or down needs a fit of ${TREND_RULE.minR2} or more and ${TREND_RULE.minSlopePctPerDay} % a day or more.` },
    { id: "upbars", label: "Bars that closed up", value: f.upBarsPct, unit: "%", help: "Share of bars that closed above the one before." },
    { id: "best", label: "Best single bar", value: f.bestBar.pct, unit: "%", help: "Largest gain from one close to the next." },
    { id: "worst", label: "Worst single bar", value: f.worstBar.pct, unit: "%", help: "Largest loss from one close to the next." },
    { id: "last", label: "Last close", value: f.last, unit: "px", help: "Price at the last confirmed bar." },
    { id: "high", label: "Highest price", value: f.high.px, unit: "px", help: "Highest high in the window." },
    { id: "low", label: "Lowest price", value: f.low.px, unit: "px", help: "Lowest low in the window." },
  ];
  if (f.atrPct !== null) m.push({ id: "atr", label: "Average bar range (ATR 14)", value: f.atrPct, unit: "%", help: "How far a bar typically moves, as a share of price." });
  if (f.rsi14 !== null) m.push({ id: "rsi", label: "RSI (14)", value: f.rsi14, unit: "", help: "Above 70 is often read as stretched up, below 30 as stretched down." });
  if (f.sma20 !== null) m.push({ id: "sma20", label: "Average of the last 20 closes", value: f.sma20, unit: "px", help: "Price above it leans up, below leans down." });
  if (f.sma50 !== null) m.push({ id: "sma50", label: "Average of the last 50 closes", value: f.sma50, unit: "px", help: "A slower average." });
  if (f.volumeChangePct !== null) m.push({ id: "volchg", label: "Volume, second half vs first", value: f.volumeChangePct, unit: "%", help: "Traded value in the second half of the window against the first." });
  f.support.forEach((p, i) => m.push({ id: `s${i + 1}`, label: `Support ${i + 1}`, value: p, unit: "px", help: "A recent swing low below the price." }));
  f.resistance.forEach((p, i) => m.push({ id: `r${i + 1}`, label: `Resistance ${i + 1}`, value: p, unit: "px", help: "A recent swing high above the price." }));
  return m;
}

/** A number as it is written on a page: 2 decimals for percentages and small prices, thousands separators. */
export function fmtNum(x: number, unit: Metric["unit"]): string {
  const dec = unit === "px" ? (Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 10 ? 2 : 4) : unit === "%" ? 2 : 1;
  const s = Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return `${x < 0 ? "-" : unit === "%" && x > 0 ? "+" : ""}${s}${unit === "%" ? "%" : ""}`;
}
