// An agent's report, made safe to show. The model proposes a stance, an argument, charts with marks on them, and the figures
// it wants shown; this file keeps only what the data supports. A mark's price is read from the real bar (a wrong claim is
// corrected and flagged), a figure comes from a placeholder that the code fills with the computed value, evidence must point
// at a chart or a metric that exists, and any other number written in a text that the data does not contain is listed as
// unchecked, so a reader can see which figures the platform did not compute.
import { z } from "zod";
import { BAR_MS, fmtNum, metricsOf, type BarSize, type Facts, type Metric, type Series } from "./analysis.js";

export const STANCES = ["bullish", "bearish", "neutral", "unclear"] as const;
export const OVERLAYS = ["sma20", "sma50", "levels"] as const;
export const PANELS = ["volume", "rsi"] as const;
export const MARK_KINDS = ["high", "low", "entry", "break", "note"] as const;

/** What the model may return. Strict, so a stray field is an error and not a surprise. */
export const RawReport = z.object({
  stance: z.enum(STANCES),
  confidence: z.number(),
  headline: z.string().max(160),
  summary: z.string().max(800),
  sections: z
    .array(z.object({ heading: z.string().max(80), text: z.string().max(1200), evidence: z.array(z.string().max(40)).max(6) }))
    .max(6),
  charts: z
    .array(
      z.object({
        id: z.string().max(24),
        kind: z.enum(["price", "equity"]),
        symbol: z.string().max(16),
        title: z.string().max(100),
        caption: z.string().max(240),
        overlays: z.array(z.enum(OVERLAYS)).max(3),
        panels: z.array(z.enum(PANELS)).max(2),
        marks: z.array(z.object({ ts: z.number(), price: z.number(), kind: z.enum(MARK_KINDS), label: z.string().max(50), note: z.string().max(200) })).max(8),
      }),
    )
    .max(4),
  metrics: z.array(z.string().max(40)).max(10),
  counter: z.string().max(600),
  caveats: z.array(z.string().max(240)).max(4),
});
export type RawReport = z.infer<typeof RawReport>;

/** The JSON schema the model is given for the same thing (the provider's strict form). */
export const REPORT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "confidence", "headline", "summary", "sections", "charts", "metrics", "counter", "caveats"],
  properties: {
    stance: { type: "string", enum: [...STANCES] },
    confidence: { type: "number" },
    headline: { type: "string" },
    summary: { type: "string" },
    sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["heading", "text", "evidence"], properties: { heading: { type: "string" }, text: { type: "string" }, evidence: { type: "array", items: { type: "string" } } } } },
    charts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "symbol", "title", "caption", "overlays", "panels", "marks"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["price", "equity"] },
          symbol: { type: "string" },
          title: { type: "string" },
          caption: { type: "string" },
          overlays: { type: "array", items: { type: "string", enum: [...OVERLAYS] } },
          panels: { type: "array", items: { type: "string", enum: [...PANELS] } },
          marks: { type: "array", items: { type: "object", additionalProperties: false, required: ["ts", "price", "kind", "label", "note"], properties: { ts: { type: "number" }, price: { type: "number" }, kind: { type: "string", enum: [...MARK_KINDS] }, label: { type: "string" }, note: { type: "string" } } } },
        },
      },
    },
    metrics: { type: "array", items: { type: "string" } },
    counter: { type: "string" },
    caveats: { type: "array", items: { type: "string" } },
  },
};

export interface ReportMark {
  ts: number;
  px: number;
  kind: (typeof MARK_KINDS)[number];
  label: string;
  note: string;
  /** The model's price was not the bar's: the real one is shown. */
  corrected: boolean;
}
export interface ReportChart {
  id: string;
  kind: "price" | "equity";
  symbol: string;
  title: string;
  caption: string;
  overlays: Array<(typeof OVERLAYS)[number]>;
  panels: Array<(typeof PANELS)[number]>;
  marks: ReportMark[];
  /** Support and resistance, drawn when "levels" is asked for. */
  levels: Array<{ px: number; kind: "support" | "resistance" }>;
  barMs: number;
  /** Candles with their averages (price) or the account's equity as [ts, value] pairs (equity). */
  series: Series | null;
  equity: Array<[number, number]> | null;
}
export interface ReportMetric {
  symbol: string;
  id: string;
  label: string;
  /** The figure as written. */
  text: string;
  value: number;
  help: string;
}
export interface ReportSource {
  symbol: string;
  label: string;
  note: string;
  kind: string;
  bar: BarSize;
  bars: number;
  from: number;
  to: number;
}
export interface Report {
  stance: (typeof STANCES)[number];
  /** The model's own confidence, 0 to 1. It is an opinion, not a measurement. */
  confidence: number;
  headline: string;
  summary: string;
  sections: Array<{ heading: string; text: string; evidence: string[] }>;
  charts: ReportChart[];
  metrics: ReportMetric[];
  counter: string;
  caveats: string[];
  sources: ReportSource[];
  /** Figures written in the text that the data does not contain. */
  unchecked: string[];
}

export interface Prepared {
  facts: Facts;
  series: Series;
  metrics: Metric[];
}
export interface OwnData {
  equity: Array<[number, number]>;
}

export const prepare = (facts: Facts, series: Series): Prepared => ({ facts, series, metrics: metricsOf(facts) });

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** Fills {{id}} (the first symbol) and {{SYM.id}}; what cannot be filled becomes [n/a] and is counted. */
export function fillPlaceholders(text: string, data: Map<string, Prepared>, missing: string[]): string {
  const first = [...data.values()][0];
  return text.replace(/\{\{\s*(?:([A-Za-z0-9]{1,16})\.)?([a-z0-9]{1,12})\s*\}\}/g, (_m, sym: string | undefined, id: string) => {
    const p = sym ? data.get(sym.toUpperCase()) : first;
    const m = p?.metrics.find((x) => x.id === id);
    if (!m) {
      missing.push(`${sym ? sym + "." : ""}${id}`);
      return "[n/a]";
    }
    return fmtNum(m.value, m.unit);
  });
}

const NUM_RE = /[-+]?\d[\d,]*(?:\.\d+)?/g;

/** Numbers in a text that match nothing the data holds. Small whole numbers (days, counts, hours) and years are not figures. */
export function uncheckedNumbers(texts: string[], known: number[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    // times and dates (14:00, 2026-10-02) are not figures either
    const scrub = t.replace(/\b\d{1,2}:\d{2}\b/g, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ");
    for (const m of scrub.matchAll(NUM_RE)) {
      const raw = m[0].replace(/,/g, "");
      const x = Number(raw);
      if (!Number.isFinite(x)) continue;
      if (Number.isInteger(x) && Math.abs(x) <= 31) continue;
      if (Number.isInteger(x) && x >= 1990 && x <= 2100) continue;
      const ok = known.some((k) => Math.abs(Math.abs(x) - Math.abs(k)) <= Math.max(0.011, Math.abs(k) * 0.006));
      if (!ok) out.add(m[0]);
    }
  }
  return [...out].slice(0, 8);
}

function snap(series: Series, ts: number, barMs: number): number {
  let best = -1;
  let gap = Infinity;
  series.bars.forEach((b, i) => {
    const g = Math.abs(b[0] - ts);
    if (g < gap) {
      gap = g;
      best = i;
    }
  });
  return gap <= barMs * 1.5 ? best : -1;
}

/**
 * Turns the model's report into the one that is shown. `data` is what was fetched, by symbol; `own` the agent's own equity
 * (for charts of how it is doing). Never throws on a bad detail: it drops the detail and keeps the rest.
 */
export function finalizeReport(raw: RawReport, data: Map<string, Prepared>, own: OwnData | null, windowDays: number): Report {
  const missing: string[] = [];
  const fill = (s: string) => clean(fillPlaceholders(s, data, missing));
  const charts: ReportChart[] = [];
  const used = new Set<string>();
  for (const c of raw.charts) {
    const id = c.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || `c${charts.length + 1}`;
    if (used.has(id)) continue;
    if (c.kind === "price") {
      const p = data.get(c.symbol.toUpperCase());
      if (!p) continue;
      const barMs = BAR_MS[p.facts.bar];
      const marks: ReportMark[] = [];
      for (const m of c.marks) {
        const i = snap(p.series, m.ts, barMs);
        if (i < 0) continue;
        const bar = p.series.bars[i]!;
        const px = m.kind === "high" ? bar[2] : m.kind === "low" ? bar[3] : bar[4];
        const claimed = Number.isFinite(m.price) && m.price > 0 ? m.price : px;
        marks.push({ ts: bar[0], px, kind: m.kind, label: clean(m.label), note: fill(m.note), corrected: Math.abs(claimed - px) / px > 0.015 });
      }
      const levels = [...p.facts.support.map((px) => ({ px, kind: "support" as const })), ...p.facts.resistance.map((px) => ({ px, kind: "resistance" as const }))];
      charts.push({ id, kind: "price", symbol: p.facts.symbol, title: clean(c.title), caption: fill(c.caption), overlays: [...new Set(c.overlays)].filter((o) => o !== "sma50" || p.facts.sma50 !== null), panels: [...new Set(c.panels)], marks, levels, barMs, series: p.series, equity: null });
    } else {
      if (!own || own.equity.length < 3) continue;
      const marks: ReportMark[] = [];
      for (const m of c.marks) {
        let bi = -1;
        let gap = Infinity;
        own.equity.forEach((e, i) => {
          const g = Math.abs(e[0] - m.ts);
          if (g < gap) {
            gap = g;
            bi = i;
          }
        });
        const span = (own.equity[own.equity.length - 1]![0] - own.equity[0]![0]) / own.equity.length;
        if (bi < 0 || gap > Math.max(span * 2, 600_000)) continue;
        marks.push({ ts: own.equity[bi]![0], px: own.equity[bi]![1], kind: m.kind, label: clean(m.label), note: fill(m.note), corrected: false });
      }
      charts.push({ id, kind: "equity", symbol: "", title: clean(c.title), caption: fill(c.caption), overlays: [], panels: [], marks, levels: [], barMs: 0, series: null, equity: own.equity });
    }
    used.add(id);
  }

  // Metrics the model asked to show: "id" (first symbol) or "SYM.id".
  const shown: ReportMetric[] = [];
  const seen = new Set<string>();
  const first = [...data.values()][0];
  for (const ref of raw.metrics) {
    const [a, b] = ref.includes(".") ? ref.split(".") : [undefined, ref];
    const p = a ? data.get(a.toUpperCase()) : first;
    const m = p?.metrics.find((x) => x.id === b);
    const key = `${p?.facts.symbol}.${b}`;
    if (!p || !m || seen.has(key)) continue;
    seen.add(key);
    shown.push({ symbol: p.facts.symbol, id: m.id, label: m.label, text: fmtNum(m.value, m.unit), value: m.value, help: m.help });
  }

  // Evidence points at a chart that is shown, or at a metric ("id" for the first symbol, "SYM.id") that exists.
  const evidenceOk = (e: string): boolean => {
    if (used.has(e)) return true;
    const [a, b] = e.includes(".") ? e.split(".") : [undefined, e];
    const p = a ? data.get(a.toUpperCase()) : first;
    return !!p?.metrics.some((m) => m.id === b);
  };
  const sections = raw.sections.map((s) => ({ heading: clean(s.heading), text: fill(s.text), evidence: s.evidence.filter(evidenceOk).slice(0, 4) }));
  const out: Report = {
    stance: raw.stance,
    confidence: Math.max(0, Math.min(1, Number.isFinite(raw.confidence) ? raw.confidence : 0)),
    headline: fill(raw.headline),
    summary: fill(raw.summary),
    sections,
    charts,
    metrics: shown,
    counter: fill(raw.counter),
    caveats: raw.caveats.map(fill),
    sources: [...data.values()].map((p) => ({ symbol: p.facts.symbol, label: p.facts.label, note: p.facts.note, kind: p.facts.kind, bar: p.facts.bar, bars: p.facts.bars, from: p.facts.from, to: p.facts.to })),
    unchecked: [],
  };

  // The figures the data holds, for the audit: every metric, every mark, the window.
  const known: number[] = [windowDays];
  for (const p of data.values()) {
    known.push(p.facts.bars, p.facts.r2, ...p.metrics.map((m) => m.value), ...p.facts.pivots.map((x) => x.px));
    for (const b of p.series.bars) known.push(b[2], b[3], b[4]);
  }
  if (own) for (const e of own.equity.slice(-400)) known.push(e[1]);
  const texts = [out.headline, out.summary, out.counter, ...out.caveats, ...out.sections.map((s) => s.text), ...charts.flatMap((c) => [c.caption, ...c.marks.map((m) => m.note)])];
  // a figure that came from a placeholder is in `known` already; anything else is listed
  out.unchecked = [...new Set([...uncheckedNumbers(texts, known), ...missing.map((m) => `{{${m}}}`)])].slice(0, 8);
  return out;
}
