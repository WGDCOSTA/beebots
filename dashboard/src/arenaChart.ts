// The pure side of the report charts: the types a report arrives in (the server's Report, as JSON) and the geometry that turns
// prices into pixels. Nothing here draws; ArenaChart.tsx does. Kept apart so the numbers can be tested.

export type Bar = [ts: number, o: number, h: number, l: number, c: number, volUsd: number];
export interface ChartSeries {
  bars: Bar[];
  sma20: Array<number | null>;
  sma50: Array<number | null>;
  rsi: Array<number | null>;
}
export interface ChartMark {
  ts: number;
  px: number;
  kind: "high" | "low" | "entry" | "break" | "note";
  label: string;
  note: string;
  corrected: boolean;
}
export interface ChartData {
  id: string;
  kind: "price" | "equity";
  symbol: string;
  title: string;
  caption: string;
  overlays: Array<"sma20" | "sma50" | "levels">;
  panels: Array<"volume" | "rsi">;
  marks: ChartMark[];
  levels: Array<{ px: number; kind: "support" | "resistance" }>;
  barMs: number;
  series: ChartSeries | null;
  equity: Array<[number, number]> | null;
}
export interface ReportData {
  stance: "bullish" | "bearish" | "neutral" | "unclear";
  confidence: number;
  headline: string;
  summary: string;
  sections: Array<{ heading: string; text: string; evidence: string[] }>;
  charts: ChartData[];
  metrics: Array<{ symbol: string; id: string; label: string; text: string; value: number; help: string }>;
  counter: string;
  caveats: string[];
  sources: Array<{ symbol: string; label: string; note: string; kind: string; bar: string; bars: number; from: number; to: number }>;
  unchecked: string[];
}
export interface ChatMsg {
  id: number;
  role: "you" | "agent";
  ts: number;
  text: string;
  report: ReportData | null;
  unavailable: string[];
}

/** The lowest and highest of some numbers, padded so a flat line still has height. */
export function extent(values: number[], pad = 0.04): [number, number] {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return [0, 1];
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (hi - lo < Math.abs(hi) * 1e-9) {
    lo -= Math.abs(lo) * 0.005 || 0.5;
    hi += Math.abs(hi) * 0.005 || 0.5;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

/** Round axis values between lo and hi: about `n` of them, on 1, 2 or 5 steps. */
export function ticks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let x = Math.ceil(lo / step) * step; x <= hi + step * 1e-9; x += step) out.push(Number(x.toPrecision(12)));
  return out;
}

export const scale = (lo: number, hi: number, from: number, to: number) => (x: number) => from + ((x - lo) / (hi - lo || 1)) * (to - from);

/** A price on an axis: no decimals for large prices, more for small ones. */
export function axisPrice(x: number, locale: string): string {
  const dec = Math.abs(x) >= 1000 ? 0 : Math.abs(x) >= 100 ? 1 : Math.abs(x) >= 1 ? 2 : 4;
  return x.toLocaleString(locale, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** A time on the axis, in UTC: a day and month, with the hour when bars are shorter than a day. */
export function axisTime(ts: number, barMs: number, locale: string): string {
  return new Date(ts).toLocaleString(locale, barMs < 86_400_000 ? { day: "numeric", month: "short", hour: "2-digit", minute: barMs < 3_600_000 ? "2-digit" : undefined, timeZone: "UTC", hour12: false } : { day: "numeric", month: "short", timeZone: "UTC" });
}

/** A line through points, lifting the pen where a value is missing. */
export function linePath(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Index of the bar a timestamp belongs to (the nearest), or -1 when there are none. */
export function indexAt(times: number[], ts: number): number {
  let best = -1;
  let gap = Infinity;
  times.forEach((t, i) => {
    const g = Math.abs(t - ts);
    if (g < gap) {
      gap = g;
      best = i;
    }
  });
  return best;
}

/** The metric ids a section cites that are tiles on this report, for a "see the figures" line. */
export const evidenceKind = (e: string, chartIds: string[]): "chart" | "metric" => (chartIds.includes(e) ? "chart" : "metric");
