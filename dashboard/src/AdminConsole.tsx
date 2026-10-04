// The admin console's monitoring views (AdminPage.tsx hosts them beside the configuration tabs). One POST
// /admin/metrics per range (24h, 7d, 30d, 90d) feeds every view, refreshed every 15 s while live and at once when the
// engine streams a fill or an order. Read-only: nothing here changes a setting.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bunnyColor, DataTable, HBars, LineChart, Meter, PnlBars, SERIES, Spark, StackedBars, type Series } from "./consoleCharts";
import { adminCall, when } from "./panelTypes";

export type RangeId = "24h" | "7d" | "30d" | "90d";
export const RANGE_IDS: RangeId[] = ["24h", "7d", "30d", "90d"];

export interface MetricsBee {
  slot: string;
  name: string;
  style: string;
  startEquityUsd: number | null;
  equityUsd: number | null;
  changeUsd: number | null;
  changePct: number | null;
  maxDrawdownPct: number;
  realisedUsd: number;
  feesUsd: number;
  fundingUsd: number;
  netUsd: number;
  volumeUsd: number;
  fills: number;
  closes: number;
  winRatePct: number | null;
  decisions: number;
  opened: number;
  vetoed: number;
  jevErrors: number;
  jevUsd: number;
  jevTokens: number;
  blockers: Array<{ why: string; n: number }>;
}

export interface Metrics {
  range: RangeId;
  at: number;
  bucketMs: number;
  buckets: number[];
  bees: MetricsBee[];
  series: {
    equity: Record<string, Array<number | null>>;
    equityTotal: Array<number | null>;
    netPnl: Record<string, number[]>;
    realised: Record<string, number[]>;
    fees: Record<string, number[]>;
    funding: Record<string, number[]>;
    volume: Record<string, number[]>;
    jevCost: Record<string, number[]>;
    decisions: { total: number[]; opened: number[]; vetoed: number[]; forced: number[]; waited: number[]; errors: number[] };
    llmTokens: Record<string, number[]>;
    llmCostUsd: number[];
  };
  totals: {
    equityUsd: number | null;
    netPnlUsd: number;
    feesUsd: number;
    fundingUsd: number;
    volumeUsd: number;
    decisions: number;
    opened: number;
    vetoed: number;
    jevErrors: number;
    jevUsd: number;
    jevTodayUsd: number;
    jevDailyCapUsd: number;
    jevLatencyMs: { p50: number | null; p95: number | null };
    llmCalls: number;
    llmTokens: number;
    llmCostUsd: number;
    llmTodayTokens: number;
    llmTodayCostUsd: number;
    llmUnpricedModels: number;
  };
  llm: {
    brains: string[];
    purposes: Array<{ purpose: string; calls: number; errors: number; inTokens: number; outTokens: number; avgLatencyMs: number; costUsd: number | null }>;
    models: Array<{ brain: string; model: string; calls: number; errors: number; inTokens: number; outTokens: number; costUsd: number | null }>;
  };
  system: {
    orders: Array<{ state: string; n: number }>;
    orderErrors: Array<{ error: string; n: number }>;
    reconciliations: { ok: number; total: number };
    caps: Array<{ cap: string; n: number }>;
    events: Array<{ type: string; n: number }>;
  };
  recentFills: Array<{ bee: string; ts: number; coin: string; side: string; notionalUsd: number; px: number; feeUsd: number; realisedUsd: number }>;
  live: {
    health: { ok: boolean; mode: string; closed: boolean; flat: boolean; marketAgeMs: number; uptimeS: number };
    autolab: { running: string | null; ranking: { lastSuccessAt: number | null; due: boolean }; scalp: { lastSuccessAt: number | null; due: boolean } };
    labBrain: { enabled: boolean; brain: string | null; running: boolean; callsToday: number; maxCallsPerDay: number; lastAt: number | null; nextAt: number | null; studies: Array<{ at: number; summary: string; brain: string; model: string }> } | null;
    coinBook: { coins: number; rules: number; queued: number; validated: number; failing: number; retired: number; demoted: number };
    ghostproof: { enabled: boolean; sending: boolean; routeMissing: boolean; blocked: boolean; counts: Record<string, number>; lastError: string | null } | null;
    scalpGate: { open: boolean; reason: string; rules: number };
    brains: Record<string, string | null>;
    prices: string;
  };
}

// ---------- formatting ----------
export const usd = (v: number, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const usdSigned = (v: number) => `${v > 0 ? "+" : ""}${usd(v)}`;
const usdSmall = (v: number) => (Math.abs(v) < 1 && v !== 0 ? `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(Math.abs(v) < 0.01 ? 4 : 3)}` : usd(v));
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);
const pct = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const dur = (s: number) => (s >= 86_400 ? `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);
const cum = (a: number[]) => {
  let s = 0;
  return a.map((v) => Math.round((s += v) * 100) / 100);
};
const sumSeries = (rec: Record<string, number[]>, n: number) => Array.from({ length: n }, (_, i) => Object.values(rec).reduce((a, s) => a + (s[i] ?? 0), 0));

// ---------- data ----------

/** Metrics for a range: fetched now, every 15 s while live, and right after a fill or an order streams in. */
export function useMetrics(password: string, range: RangeId, live: boolean) {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pulse, setPulse] = useState<{ type: string; at: number } | null>(null);
  const inflight = useRef(false);
  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      setM(await adminCall<Metrics>("metrics", password, { range }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [password, range]);
  useEffect(() => {
    void load();
    if (!live) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load, live]);
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    let last = 0;
    const es = new EventSource("/events");
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as { type?: string };
        if (!ev.type || ev.type === "heartbeat" || ev.type === "equity") return;
        setPulse({ type: ev.type, at: Date.now() });
        if ((ev.type === "fill" || ev.type === "order") && Date.now() - last > 5000) {
          last = Date.now();
          void load();
        }
      } catch {
        /* not ours */
      }
    };
    return () => es.close();
  }, [live, load]);
  return { m, error, loading, reload: load, pulse };
}

function Kpi({ label, value, sub, spark, color, tone }: { label: string; value: string; sub?: React.ReactNode; spark?: Array<number | null>; color?: string; tone?: "good" | "bad" | null }) {
  return (
    <div className="ptile cx-kpi">
      <div className="eyebrow">{label}</div>
      <div className={`ptile-value num ${tone === "good" ? "good" : tone === "bad" ? "bad" : ""}`}>{value}</div>
      {spark && <Spark values={spark} color={color} />}
      {sub && <div className="dim ptile-sub">{sub}</div>}
    </div>
  );
}

function Card({ title, sub, children, wide }: { title: string; sub?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`pcard cx-card ${wide ? "wide" : ""}`}>
      <h3>{title}</h3>
      {sub && <p className="dim small cx-sub">{sub}</p>}
      {children}
    </section>
  );
}

const beeSeries = (m: Metrics, pick: (slot: string) => Array<number | null>): Series[] => m.bees.map((b) => ({ id: b.slot, label: b.name, color: bunnyColor(b.style, b.slot), values: pick(b.slot) }));

// ---------- views ----------

export function OverviewView({ m }: { m: Metrics }) {
  const t = m.totals;
  const n = m.buckets.length;
  const net = sumSeries(m.series.netPnl, n);
  const first = m.series.equityTotal.find((v) => v !== null) ?? null;
  const change = first !== null && t.equityUsd !== null ? t.equityUsd - first : null;
  const h = m.live.health;
  return (
    <>
      <div className="ptiles cx-kpis">
        <Kpi label="Total equity" value={t.equityUsd === null ? "–" : usd(t.equityUsd)} spark={m.series.equityTotal} color={SERIES[0]} sub={change === null ? "no snapshots yet" : `${usdSigned(change)} in ${m.range}`} tone={change === null ? null : change >= 0 ? "good" : "bad"} />
        <Kpi label={`Net P&L · ${m.range}`} value={usdSigned(t.netPnlUsd)} spark={cum(net)} color={t.netPnlUsd >= 0 ? "#0ca30c" : "#d03b3b"} sub={`realised − fees ${usd(t.feesUsd)} + funding ${usdSigned(t.fundingUsd)}`} tone={t.netPnlUsd > 0 ? "good" : t.netPnlUsd < 0 ? "bad" : null} />
        <Kpi label={`Decisions · ${m.range}`} value={compact(t.decisions)} spark={m.series.decisions.total} color={SERIES[2]} sub={`${t.opened} opened · ${t.vetoed} vetoed · ${t.jevErrors} errors`} />
        <div className="ptile cx-kpi">
          <div className="eyebrow">Jev spend today</div>
          <div className="ptile-value num">{usdSmall(t.jevTodayUsd)}</div>
          <Meter value={t.jevTodayUsd} max={t.jevDailyCapUsd} format={usdSmall} />
        </div>
        <Kpi label="Brain tokens today" value={compact(t.llmTodayTokens)} sub={t.llmTodayCostUsd ? `≈ ${usdSmall(t.llmTodayCostUsd)} today` : "set Brain prices for costs"} spark={sumSeries(m.series.llmTokens, n)} color={SERIES[1]} />
        <Kpi label="Engine" value={h.ok ? "● healthy" : "● stale data"} tone={h.ok ? "good" : "bad"} sub={`${h.mode} · up ${dur(h.uptimeS)} · market ${Math.round(h.marketAgeMs / 1000)}s old`} />
      </div>
      <div className="cx-grid">
        <Card title="Total equity" sub="Every bunny's equity added up, last snapshot per period.">
          <LineChart x={m.buckets} bucketMs={m.bucketMs} series={[{ id: "total", label: "Total equity", color: SERIES[0]!, values: m.series.equityTotal }]} format={(v) => usd(v, 0)} area />
        </Card>
        <Card title="Equity by bunny" sub="Click a name to hide or show it.">
          <LineChart x={m.buckets} bucketMs={m.bucketMs} series={beeSeries(m, (s) => m.series.equity[s] ?? [])} format={(v) => usd(v, 0)} />
        </Card>
        <Card title="Net P&L per period" sub="Realised minus fees plus funding, all bunnies.">
          <PnlBars x={m.buckets} bucketMs={m.bucketMs} values={net} format={usdSigned} />
        </Card>
        <Card title="Decisions per period" sub="What Jev's answers became.">
          <StackedBars
            x={m.buckets}
            bucketMs={m.bucketMs}
            format={compact}
            series={[
              { id: "opened", label: "Opened", color: SERIES[0]!, values: m.series.decisions.opened },
              { id: "vetoed", label: "Vetoed", color: SERIES[1]!, values: m.series.decisions.vetoed },
              { id: "waited", label: "Wait / hold", color: SERIES[2]!, values: m.series.decisions.waited },
              { id: "forced", label: "Forced", color: SERIES[3]!, values: m.series.decisions.forced },
              { id: "errors", label: "Errors", color: SERIES[7]!, values: m.series.decisions.errors },
            ]}
          />
        </Card>
        <Card title="Bunnies" sub={`Over ${m.range}. Sort by any column.`} wide>
          <BunnyTable m={m} />
        </Card>
        <Card title="Latest fills" wide>
          <FillsTable m={m} limit={10} />
        </Card>
      </div>
    </>
  );
}

function BunnyTable({ m }: { m: Metrics }) {
  return (
    <DataTable
      name={`bunnies-${m.range}`}
      rows={m.bees}
      cols={[
        { key: "name", label: "Bunny", value: (b) => b.name, render: (b) => <span className="cx-who"><span className="cx-swatch" style={{ background: bunnyColor(b.style, b.slot) }} />{b.name}</span> },
        { key: "eq", label: "Equity", num: true, value: (b) => b.equityUsd, render: (b) => (b.equityUsd === null ? "–" : usd(b.equityUsd)) },
        { key: "chg", label: "Change", num: true, value: (b) => b.changePct, render: (b) => <span className={b.changePct === null ? "" : b.changePct >= 0 ? "good" : "bad"}>{pct(b.changePct)}</span> },
        { key: "net", label: "Net P&L", num: true, value: (b) => b.netUsd, render: (b) => <span className={b.netUsd > 0 ? "good" : b.netUsd < 0 ? "bad" : ""}>{usdSigned(b.netUsd)}</span> },
        { key: "win", label: "Win rate", num: true, value: (b) => b.winRatePct, render: (b) => (b.winRatePct === null ? "–" : `${b.winRatePct}% of ${b.closes}`) },
        { key: "dd", label: "Max DD", num: true, value: (b) => b.maxDrawdownPct, render: (b) => `${b.maxDrawdownPct.toFixed(2)}%` },
        { key: "dec", label: "Decisions", num: true, value: (b) => b.decisions },
        { key: "open", label: "Opened", num: true, value: (b) => b.opened },
        { key: "jev", label: "Jev", num: true, value: (b) => b.jevUsd, render: (b) => usdSmall(b.jevUsd) },
      ]}
    />
  );
}

function FillsTable({ m, limit = 25 }: { m: Metrics; limit?: number }) {
  const name = (slot: string) => m.bees.find((b) => b.slot === slot)?.name ?? slot;
  return (
    <DataTable
      name="fills"
      rows={m.recentFills.slice(0, limit)}
      empty="No fills yet."
      cols={[
        { key: "ts", label: "When", value: (f) => f.ts, render: (f) => when(f.ts) },
        { key: "bee", label: "Bunny", value: (f) => name(f.bee) },
        { key: "coin", label: "Coin", value: (f) => f.coin },
        { key: "side", label: "Side", value: (f) => f.side },
        { key: "notional", label: "Notional", num: true, value: (f) => f.notionalUsd, render: (f) => usd(f.notionalUsd) },
        { key: "px", label: "Price", num: true, value: (f) => f.px },
        { key: "fee", label: "Fee", num: true, value: (f) => f.feeUsd, render: (f) => usdSmall(f.feeUsd) },
        { key: "pnl", label: "Realised", num: true, value: (f) => f.realisedUsd, render: (f) => (f.realisedUsd ? <span className={f.realisedUsd > 0 ? "good" : "bad"}>{usdSigned(f.realisedUsd)}</span> : "–") },
      ]}
    />
  );
}

export function TradingView({ m }: { m: Metrics }) {
  const t = m.totals;
  const best = [...m.bees].sort((a, b) => b.netUsd - a.netUsd)[0];
  return (
    <>
      <div className="ptiles cx-kpis">
        <Kpi label="Net P&L" value={usdSigned(t.netPnlUsd)} tone={t.netPnlUsd > 0 ? "good" : t.netPnlUsd < 0 ? "bad" : null} sub={`over ${m.range}`} />
        <Kpi label="Volume traded" value={usd(t.volumeUsd, 0)} sub={`${m.bees.reduce((a, b) => a + b.fills, 0)} fills`} />
        <Kpi label="Exchange fees" value={usd(t.feesUsd)} sub={t.volumeUsd ? `${((t.feesUsd / t.volumeUsd) * 1e4).toFixed(1)} bp of volume` : "–"} />
        <Kpi label="Funding" value={usdSigned(t.fundingUsd)} tone={t.fundingUsd > 0 ? "good" : t.fundingUsd < 0 ? "bad" : null} />
        <Kpi label="Best bunny" value={best ? best.name : "–"} sub={best ? usdSigned(best.netUsd) : undefined} />
      </div>
      <div className="cx-grid">
        <Card title="Cumulative net P&L by bunny" sub="Realised − fees + funding, added up over the range.">
          <LineChart x={m.buckets} bucketMs={m.bucketMs} series={beeSeries(m, (s) => cum(m.series.netPnl[s] ?? []))} format={usdSigned} zero />
        </Card>
        <Card title="Volume by bunny" sub="Notional traded per period.">
          <StackedBars x={m.buckets} bucketMs={m.bucketMs} series={beeSeries(m, (s) => m.series.volume[s] ?? [])} format={(v) => usd(v, 0)} />
        </Card>
        <Card title="Fees by bunny" sub="What the exchange took per period.">
          <StackedBars x={m.buckets} bucketMs={m.bucketMs} series={beeSeries(m, (s) => m.series.fees[s] ?? [])} format={usdSmall} />
        </Card>
        <Card title="Net P&L by bunny" sub={`Over ${m.range}.`}>
          <HBars rows={[...m.bees].sort((a, b) => b.netUsd - a.netUsd).map((b) => ({ label: b.name, value: b.netUsd, color: b.netUsd >= 0 ? "var(--good)" : "var(--critical)", sub: `realised ${usdSigned(b.realisedUsd)} · fees ${usd(b.feesUsd)} · funding ${usdSigned(b.fundingUsd)}` }))} format={usdSigned} />
        </Card>
        <Card title="Bunny breakdown" wide>
          <DataTable
            name={`trading-${m.range}`}
            rows={m.bees}
            cols={[
              { key: "name", label: "Bunny", value: (b) => b.name },
              { key: "real", label: "Realised", num: true, value: (b) => b.realisedUsd, render: (b) => usdSigned(b.realisedUsd) },
              { key: "fees", label: "Fees", num: true, value: (b) => b.feesUsd, render: (b) => usd(b.feesUsd) },
              { key: "fund", label: "Funding", num: true, value: (b) => b.fundingUsd, render: (b) => usdSigned(b.fundingUsd) },
              { key: "net", label: "Net", num: true, value: (b) => b.netUsd, render: (b) => <span className={b.netUsd > 0 ? "good" : b.netUsd < 0 ? "bad" : ""}>{usdSigned(b.netUsd)}</span> },
              { key: "vol", label: "Volume", num: true, value: (b) => b.volumeUsd, render: (b) => usd(b.volumeUsd, 0) },
              { key: "fills", label: "Fills", num: true, value: (b) => b.fills },
              { key: "win", label: "Win rate", num: true, value: (b) => b.winRatePct, render: (b) => (b.winRatePct === null ? "–" : `${b.winRatePct}%`) },
              { key: "dd", label: "Max DD", num: true, value: (b) => b.maxDrawdownPct, render: (b) => `${b.maxDrawdownPct.toFixed(2)}%` },
            ]}
          />
        </Card>
        <Card title="Recent fills" wide>
          <FillsTable m={m} />
        </Card>
      </div>
    </>
  );
}

export function ConsumptionView({ m }: { m: Metrics }) {
  const t = m.totals;
  const brainSeries: Series[] = m.llm.brains.slice(0, 8).map((b, i) => ({ id: b, label: b, color: SERIES[i]!, values: m.series.llmTokens[b] ?? [] }));
  const daily = m.bucketMs >= 86_400_000;
  return (
    <>
      <div className="ptiles cx-kpis">
        <div className="ptile cx-kpi">
          <div className="eyebrow">Jev today</div>
          <div className="ptile-value num">{usdSmall(t.jevTodayUsd)}</div>
          <Meter value={t.jevTodayUsd} max={t.jevDailyCapUsd} format={usdSmall} />
        </div>
        <Kpi label={`Jev · ${m.range}`} value={usdSmall(t.jevUsd)} sub={`latency p50 ${t.jevLatencyMs.p50 ?? "–"} ms · p95 ${t.jevLatencyMs.p95 ?? "–"} ms`} />
        <Kpi label={`Brain calls · ${m.range}`} value={compact(t.llmCalls)} sub={`${compact(t.llmTokens)} tokens`} />
        <Kpi label={`Brain cost · ${m.range}`} value={t.llmCostUsd ? `≈ ${usdSmall(t.llmCostUsd)}` : "–"} sub={t.llmUnpricedModels ? `${t.llmUnpricedModels} model(s) without a price: Settings → Brain prices` : "estimated from your prices"} />
        <Kpi label={`Exchange fees · ${m.range}`} value={usd(t.feesUsd)} />
        <Kpi label="All costs" value={`≈ ${usdSmall(t.jevUsd + t.llmCostUsd + t.feesUsd)}`} sub="Jev + brains (priced) + exchange fees" />
      </div>
      <div className="cx-grid">
        <Card title="Jev spend by bunny" sub={daily ? "Per day; the dashed line is the daily cap." : "Per period."}>
          {daily ? (
            <LineChart x={m.buckets} bucketMs={m.bucketMs} series={[{ id: "jev", label: "Jev per day", color: SERIES[0]!, values: sumSeries(m.series.jevCost, m.buckets.length) }]} format={usdSmall} refLine={{ value: t.jevDailyCapUsd, label: `cap ${usdSmall(t.jevDailyCapUsd)}` }} area zero />
          ) : (
            <StackedBars x={m.buckets} bucketMs={m.bucketMs} series={beeSeries(m, (s) => m.series.jevCost[s] ?? [])} format={usdSmall} />
          )}
        </Card>
        <Card title="Brain tokens by provider" sub="Councils, research, coach, Farmer, crew and lab brain; input + output.">
          <StackedBars x={m.buckets} bucketMs={m.bucketMs} series={brainSeries} format={compact} />
        </Card>
        <Card title="Brain cost per period" sub="Estimated from Settings → Brain prices.">
          <LineChart x={m.buckets} bucketMs={m.bucketMs} series={[{ id: "cost", label: "Brain cost", color: SERIES[1]!, values: m.series.llmCostUsd }]} format={usdSmall} area zero />
        </Card>
        <Card title="Jev tokens by bunny" sub={`Input tokens over ${m.range}.`}>
          <HBars rows={[...m.bees].sort((a, b) => b.jevTokens - a.jevTokens).map((b) => ({ label: b.name, value: b.jevTokens, color: bunnyColor(b.style, b.slot), sub: `${b.decisions} calls · ${usdSmall(b.jevUsd)}` }))} format={compact} />
        </Card>
        <Card title="What the brains were asked" sub="Per purpose." wide>
          <DataTable
            name={`brain-purposes-${m.range}`}
            rows={m.llm.purposes}
            empty="No brain calls recorded yet (they are recorded from this version on)."
            cols={[
              { key: "p", label: "Purpose", value: (r) => r.purpose },
              { key: "calls", label: "Calls", num: true, value: (r) => r.calls },
              { key: "err", label: "Errors", num: true, value: (r) => r.errors, render: (r) => (r.errors ? <span className="bad">{r.errors}</span> : "0") },
              { key: "in", label: "Tokens in", num: true, value: (r) => r.inTokens, render: (r) => compact(r.inTokens) },
              { key: "out", label: "Tokens out", num: true, value: (r) => r.outTokens, render: (r) => compact(r.outTokens) },
              { key: "lat", label: "Avg latency", num: true, value: (r) => r.avgLatencyMs, render: (r) => `${(r.avgLatencyMs / 1000).toFixed(1)} s` },
              { key: "cost", label: "Cost", num: true, value: (r) => r.costUsd, render: (r) => (r.costUsd === null ? "no price" : usdSmall(r.costUsd)) },
            ]}
          />
        </Card>
        <Card title="Models" wide>
          <DataTable
            name={`brain-models-${m.range}`}
            rows={m.llm.models}
            empty="No brain calls recorded yet."
            cols={[
              { key: "b", label: "Brain", value: (r) => r.brain },
              { key: "m", label: "Model", value: (r) => r.model },
              { key: "calls", label: "Calls", num: true, value: (r) => r.calls },
              { key: "err", label: "Errors", num: true, value: (r) => r.errors },
              { key: "in", label: "Tokens in", num: true, value: (r) => r.inTokens, render: (r) => compact(r.inTokens) },
              { key: "out", label: "Tokens out", num: true, value: (r) => r.outTokens, render: (r) => compact(r.outTokens) },
              { key: "cost", label: "Cost", num: true, value: (r) => r.costUsd, render: (r) => (r.costUsd === null ? "no price" : usdSmall(r.costUsd)) },
            ]}
          />
        </Card>
      </div>
    </>
  );
}

export function DecisionsView({ m }: { m: Metrics }) {
  const t = m.totals;
  const lb = m.live.labBrain;
  const cb = m.live.coinBook;
  const openRate = t.decisions ? (t.opened / t.decisions) * 100 : 0;
  return (
    <>
      <div className="ptiles cx-kpis">
        <Kpi label={`Decisions · ${m.range}`} value={compact(t.decisions)} sub={`${openRate.toFixed(1)}% opened a trade`} />
        <Kpi label="Vetoed by code" value={compact(t.vetoed)} sub="risk rules said no" />
        <Kpi label="Jev errors" value={compact(t.jevErrors)} tone={t.jevErrors ? "bad" : null} />
        <Kpi label="Scalp gate" value={m.live.scalpGate.open ? "● open" : "● closed"} tone={m.live.scalpGate.open ? "good" : null} sub={m.live.scalpGate.reason} />
        <Kpi label="Coin book" value={`${cb.validated} validated`} sub={`${cb.queued} waiting · ${cb.failing} failing · ${cb.retired} retired · ${cb.demoted} demoted`} />
        <Kpi label="Lab brain" value={lb?.enabled ? (lb.running ? "studying…" : "on") : "off"} sub={lb?.enabled ? `${lb.brain} · ${lb.callsToday}/${lb.maxCallsPerDay} calls today · next ${lb.nextAt ? when(lb.nextAt) : "soon"}` : "needs a brain key"} />
      </div>
      <div className="cx-grid">
        <Card title="Opened vs decided" sub="Share of decisions that opened a trade, per period.">
          <LineChart
            x={m.buckets}
            bucketMs={m.bucketMs}
            series={[{ id: "rate", label: "Open rate", color: SERIES[0]!, values: m.series.decisions.total.map((n, i) => (n ? Math.round((m.series.decisions.opened[i]! / n) * 1000) / 10 : null)) }]}
            format={(v) => `${v.toFixed(0)}%`}
            area
            zero
          />
        </Card>
        <Card title="Decisions by bunny" sub={`Over ${m.range}.`}>
          <HBars rows={[...m.bees].sort((a, b) => b.decisions - a.decisions).map((b) => ({ label: b.name, value: b.decisions, color: bunnyColor(b.style, b.slot), sub: `${b.opened} opened · ${b.vetoed} vetoed · ${b.jevErrors} errors` }))} format={compact} />
        </Card>
        {m.bees.map((b) => (
          <Card key={b.slot} title={`Why ${b.name} isn't trading`} sub="Top reasons over the range (up to 7 days).">
            <HBars rows={b.blockers.map((x) => ({ label: x.why, value: x.n, color: bunnyColor(b.style, b.slot) }))} format={compact} />
          </Card>
        ))}
        {lb?.studies[0] && (
          <Card title="Lab brain: latest study" sub={`${when(lb.studies[0].at)} · ${lb.studies[0].brain}:${lb.studies[0].model}`} wide>
            <p className="small">{lb.studies[0].summary}</p>
            <a className="pbtn ghost small" href="#/lab">
              Open the coin rulebook
            </a>
          </Card>
        )}
      </div>
    </>
  );
}

export function SystemView({ m }: { m: Metrics }) {
  const h = m.live.health;
  const r = m.system.reconciliations;
  const gp = m.live.ghostproof;
  const al = m.live.autolab;
  const brains = Object.entries(m.live.brains).filter(([, v]) => v);
  return (
    <>
      <div className="ptiles cx-kpis">
        <Kpi label="Engine" value={h.ok ? "● healthy" : "● stale data"} tone={h.ok ? "good" : "bad"} sub={`market data ${Math.round(h.marketAgeMs / 1000)} s old`} />
        <Kpi label="Uptime" value={dur(h.uptimeS)} sub={`mode ${h.mode}${h.closed ? " · closed" : ""}${h.flat ? " · flat" : ""}`} />
        <Kpi label="Reconciliations" value={r.total ? `${r.ok}/${r.total}` : "–"} tone={r.total && r.ok < r.total ? "bad" : r.total ? "good" : null} sub={r.total && r.ok < r.total ? `${r.total - r.ok} mismatch(es)` : "books match the exchange"} />
        <Kpi label="Autonomous lab" value={al.running ? `running ${al.running}` : "idle"} sub={`ranking ${al.ranking.lastSuccessAt ? when(al.ranking.lastSuccessAt) : "never"} · scalp ${al.scalp.lastSuccessAt ? when(al.scalp.lastSuccessAt) : "never"}`} />
        <Kpi label="GhostProof" value={gp ? (gp.blocked ? "● blocked" : gp.routeMissing ? "● local only" : gp.sending ? "● sending" : "● local only") : "off"} tone={gp?.blocked ? "bad" : null} sub={gp ? Object.entries(gp.counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(" · ") || "no events yet" : "GHOSTPROOF=1 turns it on"} />
      </div>
      <div className="cx-grid">
        <Card title="Orders by state" sub={`Over ${m.range}.`}>
          <HBars rows={m.system.orders.map((o, i) => ({ label: o.state, value: o.n, color: SERIES[i % 8] }))} format={compact} />
        </Card>
        <Card title="Risk caps hit" sub="The risk layer stopped something.">
          <HBars rows={m.system.caps.map((c) => ({ label: c.cap, value: c.n, color: SERIES[1] }))} format={compact} />
        </Card>
        <Card title="Events" sub="What the engine streamed and stored.">
          <HBars rows={m.system.events.map((e) => ({ label: e.type, value: e.n, color: SERIES[2] }))} format={compact} />
        </Card>
        <Card title="Brains in use">
          <ul className="cx-list small">
            {brains.length ? brains.map(([k, v]) => <li key={k}><strong>{k}</strong> <span className="dim">{v}</span></li>) : <li className="dim">No brain keys.</li>}
          </ul>
          <p className="dim small">Prices: {m.live.prices || "none set (Settings → Brain prices)"}</p>
        </Card>
        {m.system.orderErrors.length > 0 && (
          <Card title="Order errors" wide>
            <DataTable name="order-errors" rows={m.system.orderErrors} cols={[{ key: "e", label: "Error", value: (x) => x.error }, { key: "n", label: "Times", num: true, value: (x) => x.n }]} />
          </Card>
        )}
        {gp?.lastError && (
          <Card title="GhostProof last error" wide>
            <p className="small">{gp.lastError}</p>
          </Card>
        )}
      </div>
    </>
  );
}

/** The console's top bar: range, live updates, the time of the last refresh and the last live event. */
export function ConsoleBar({ range, setRange, live, setLive, m, loading, reload, pulse }: { range: RangeId; setRange: (r: RangeId) => void; live: boolean; setLive: (b: boolean) => void; m: Metrics | null; loading: boolean; reload: () => void; pulse: { type: string; at: number } | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const ago = m ? Math.round((Date.now() - m.at) / 1000) : null;
  const fresh = pulse && Date.now() - pulse.at < 4000;
  return (
    <div className="cx-bar">
      <div className="chips" role="group" aria-label="Range">
        {RANGE_IDS.map((r) => (
          <button key={r} className={`chip ${range === r ? "on" : ""}`} onClick={() => setRange(r)} aria-pressed={range === r}>
            {r}
          </button>
        ))}
      </div>
      <label className="cx-live">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
        <span className={`cx-dot ${live ? (fresh ? "pulse" : "on") : ""}`} aria-hidden />
      </label>
      <span className="dim small cx-updated">
        {loading ? "refreshing…" : ago === null ? "" : `updated ${ago}s ago`}
        {pulse ? ` · last event: ${pulse.type}` : ""}
      </span>
      <button className="pbtn ghost small" onClick={reload} disabled={loading}>
        ⟳ Refresh
      </button>
    </div>
  );
}

export const MONITOR_VIEWS = { dashboard: OverviewView, trading: TradingView, consumption: ConsumptionView, decisions: DecisionsView, system: SystemView } as const;
export type MonitorId = keyof typeof MONITOR_VIEWS;

export function MonitorPane({ view, password }: { view: MonitorId; password: string }) {
  const [range, setRange] = useState<RangeId>(() => {
    try {
      const r = localStorage.getItem("admin-range") as RangeId | null;
      return r && RANGE_IDS.includes(r) ? r : "24h";
    } catch {
      return "24h";
    }
  });
  const [live, setLive] = useState(true);
  const { m, error, loading, reload, pulse } = useMetrics(password, range, live);
  const pick = (r: RangeId) => {
    setRange(r);
    try {
      localStorage.setItem("admin-range", r);
    } catch {
      /* private window */
    }
  };
  const View = MONITOR_VIEWS[view];
  const body = useMemo(() => (m && m.range === range ? <View m={m} /> : null), [m, range, View]);
  return (
    <div className="cx-pane">
      <ConsoleBar range={range} setRange={pick} live={live} setLive={setLive} m={m} loading={loading} reload={() => void reload()} pulse={pulse} />
      {error && <p className="bad">Could not load the metrics: {error}</p>}
      {body ?? (!error && <p className="dim">Loading…</p>)}
    </div>
  );
}
