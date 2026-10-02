// A bunny's own page (#/bunny/<slot>): who it is, how it is doing right now, and everything behind that: its equity,
// trades and coins, the calls it made, what it learned, what it told the Warren and heard back, the skills it leans on.
// Live numbers come from the event stream (useFeed); history from GET /bunny/<slot> (engine bunnyProfile.ts).
import { useEffect, useMemo, useRef, useState } from "react";
import { money, signed } from "./BeeColumn";
import { EquityChart } from "./EquityChart";
import { PageNav } from "./LabPage";
import { BRAIN_LABEL } from "./panelTypes";
import { BarChart, DotStrip, HBars, Ring, type Bar, type Dot } from "./ProfileCharts";
import { ALL_BEES, beeMeta, TIER_INFO, type EvolutionRow, type PublicBee } from "./types";
import { useFeed } from "./useFeed";

interface Msg {
  ts: number;
  fromSlot: string;
  fromName: string;
  toName: string;
  text: string;
  source: string | null;
  brain: string | null;
  mine: boolean;
  toMe: boolean;
}

export interface BunnyProfile {
  slot: string;
  generatedAt: number;
  equity: Array<[number, number]>;
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number | null;
    realisedUsd: number;
    feesUsd: number;
    volumeUsd: number;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    profitFactor: number | null;
    bestUsd: number | null;
    worstUsd: number | null;
    decisions: number;
    jevUsd: number;
    avgConfidence: number | null;
    avgLatencyMs: number | null;
  };
  coins: Array<{ coin: string; trades: number; wins: number; realisedUsd: number; feesUsd: number; volumeUsd: number; winRatePct: number | null; lastTs: number }>;
  daily: Array<{ day: string; realisedUsd: number; feesUsd: number; trades: number }>;
  fills: Array<{ ts: number; coin: string; side: "buy" | "sell"; px: number; notionalUsd: number; feeUsd: number; realisedUsd: number; close: boolean; purpose: string | null }>;
  decisions: Array<{ ts: number; choice: string | null; confidence: number | null; conviction: number | null; latencyMs: number | null; status: string | null; vetoedBy: string | null; forcedBy: string | null; error: string | null }>;
  choiceMix: Array<{ choice: string; n: number }>;
  learning: {
    lessons: Array<{ ts: number; text: string; source: string | null; consolidated: boolean }>;
    adopted: Array<{ skill: string; weight: number; since: number }>;
    specialization: { method: string; reason: string | null; since: number } | null;
    plan: { brain: string; model: string; decidedAt: number; message: string; lessons: string[]; skills: Array<{ id: string; weight: number; reason: string; score: number }> } | null;
  };
  messages: Msg[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "trades", label: "Trades" },
  { id: "decisions", label: "Decisions" },
  { id: "learning", label: "Learning" },
  { id: "warren", label: "Warren chat" },
  { id: "skills", label: "Skills & score" },
] as const;
type TabId = (typeof TABS)[number]["id"];
export const RANGES = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
];

const GOOD = "var(--good)";
const BAD = "var(--critical)";
const pnlTone = (v: number) => (v >= 0 ? GOOD : BAD);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`);
const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
const SOURCE_LABEL: Record<string, string> = { council: "council", coach: "coach", rewards: "rewards", lab: "lab", owner: "owner", research: "research" };
const sourceLabel = (s: string | null) => (s ? (SOURCE_LABEL[s] ?? s) : "note");

function readRoute(): { slot: string; tab: TabId } {
  const [path, q] = location.hash.replace(/^#\/?/, "").split("?");
  const slot = path?.split("/")[1] ?? "bee1";
  const t = new URLSearchParams(q ?? "").get("tab");
  return { slot, tab: TABS.some((x) => x.id === t) ? (t as TabId) : "overview" };
}

export function BunnyPage() {
  const [route, setRoute] = useState(readRoute);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<BunnyProfile | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const feed = useFeed(false);
  const page = useRef<HTMLDivElement>(null);
  const { slot, tab } = route;

  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const load = () =>
      fetch(`/bunny/${slot}?days=${days}`, { cache: "no-store" })
        .then(async (r) => {
          if (!alive) return;
          if (r.status === 404) setMissing(true);
          else if (r.ok) {
            setMissing(false);
            setData((await r.json()) as BunnyProfile);
          }
        })
        .catch(() => undefined)
        .finally(() => alive && setLoading(false));
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slot, days]);

  useEffect(() => {
    page.current?.scrollTo({ top: 0 });
  }, [slot]);

  const openTab = (t: TabId) => {
    history.replaceState(null, "", `#/bunny/${slot}${t === "overview" ? "" : `?tab=${t}`}`);
    setRoute({ slot, tab: t });
  };
  const meta = beeMeta(slot);
  const bee = feed.bees[slot];
  const evo = feed.snap?.evolution?.board.find((r) => r.bee === slot) ?? null;
  const board = [...ALL_BEES].sort((a, b) => (feed.bees[b]?.equityUsd ?? 0) - (feed.bees[a]?.equityUsd ?? 0));
  const rank = board.indexOf(slot) + 1;
  const start = bee?.startEquityUsd ?? feed.snap?.startEquityUsd ?? 333;

  // The live curve beats the fetched one for the last minutes; fall back to the profile's when the stream has none.
  const curve = useMemo(() => {
    const since = Date.now() - days * 86_400_000;
    const live = (feed.curves[slot] ?? []).filter((p) => p[0] >= since);
    return live.length >= 2 ? live : (data?.equity ?? []);
  }, [feed.curves, slot, data, days]);

  if (missing)
    return (
      <div className="bp">
        <PageNav current="bunny" />
        <div className="bp-wrap">
          <div className="pcard">
            No bunny runs in slot <span className="mono">{slot}</span>. <a href="#/">Back to the live board</a>
          </div>
        </div>
      </div>
    );

  return (
    <div className="bp" ref={page} style={{ ["--bee" as string]: meta.color, ["--bee-glow" as string]: meta.glow }}>
      <PageNav current="bunny" />
      <div className="bp-wrap">
        <BunnySwitcher current={slot} />
        <Hero slot={slot} bee={bee} evo={evo} rank={rank} of={board.length} start={start} />

        <div className="bp-filters">
          <div className="seg" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="bp-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => openTab(t.id)}>
                {t.label}
                {t.id === "warren" && data?.messages.length ? <span className="bp-count">{data.messages.length}</span> : null}
              </button>
            ))}
          </div>
          <span className="dim small bp-when">{data ? `updated ${ago(data.generatedAt)}` : loading ? "loading…" : ""}</span>
        </div>

        <div className={`bp-body ${loading && data ? "refreshing" : ""}`}>
          {tab === "overview" && <Overview data={data} curve={curve} start={start} evo={evo} slot={slot} />}
          {tab === "trades" && <Trades data={data} />}
          {tab === "decisions" && <Decisions data={data} live={feed.decisions.filter((d) => d.bee === slot && !d.pulse)} />}
          {tab === "learning" && <Learning data={data} />}
          {tab === "warren" && <WarrenChat data={data} slot={slot} />}
          {tab === "skills" && <Skills data={data} evo={evo} bee={bee} />}
        </div>
      </div>
    </div>
  );
}

/** Jump between bunnies without going back to the board. */
function BunnySwitcher({ current }: { current: string }) {
  return (
    <div className="bp-switch" role="navigation" aria-label="Bunnies">
      <a href="#/" className="bp-back">
        ← Live board
      </a>
      {ALL_BEES.map((id) => {
        const m = beeMeta(id);
        return (
          <a key={id} href={`#/bunny/${id}`} className={`bp-chip ${id === current ? "on" : ""}`} style={{ ["--bee" as string]: m.color }}>
            <img src={m.img} alt="" />
            {m.short}
          </a>
        );
      })}
    </div>
  );
}

export function Hero({ slot, bee, evo, rank, of, start }: { slot: string; bee: PublicBee | undefined; evo: EvolutionRow | null; rank: number; of: number; start: number }) {
  const m = beeMeta(slot);
  const t = evo ? TIER_INFO[evo.tier] : null;
  const p = bee?.position ?? null;
  const brain = bee?.brain;
  return (
    <section className="bp-hero">
      <div className="bp-portrait">
        <img src={m.img} alt={`${m.title} portrait`} />
        {rank > 0 && <span className="bp-rank num">#{rank}</span>}
      </div>
      <div className="bp-id">
        <span className="eyebrow">{m.squad === "macro" ? "Macro squad" : "Crypto bunny"} · {slot}</span>
        <h1>{m.title}</h1>
        <p className="bp-tagline">{m.tagline || m.styleLabel}</p>
        <div className="bp-chips">
          {m.styleLabel && <span className="chip-t">{m.styleLabel}</span>}
          {brain && (
            <span className={`chip-t ${brain.online ? "" : "off"}`} title={brain.online ? `Plans with ${brain.model}` : "No key or sign-in: a rules pick plans for it"}>
              <i className={`dot ${brain.online ? "on" : ""}`} />
              {brain.label ?? BRAIN_LABEL[brain.id] ?? brain.id}
              {brain.model ? <em> {brain.model}</em> : null}
            </span>
          )}
          {bee?.method && bee.method.kind !== "own" && <span className="chip-t method">METHOD {bee.method.name ?? bee.method.id}</span>}
          {t && (
            <span className={`chip-t ${t.tone}`}>
              {t.icon} {t.label}
            </span>
          )}
          {evo && (
            <span className="chip-t">
              L{evo.level} · {evo.points} pts
            </span>
          )}
          {m.coins.length > 0 && <span className="chip-t dim">{m.coins.slice(0, 8).join(" ")}</span>}
        </div>
        {m.rules && (
          <p className="bp-rules" title={m.rules}>
            “{m.rules}”
          </p>
        )}
      </div>
      <div className="bp-now">
        <span className="eyebrow">Equity</span>
        <div className="bp-equity num">{bee ? money(bee.equityUsd) : "–"}</div>
        {bee && (
          <div className={`num ${bee.pnlUsd >= 0 ? "good" : "bad"}`}>
            {bee.pnlUsd >= 0 ? "▲" : "▼"} {signed(bee.pnlUsd)} ({pct(bee.pnlPct, 2)}) <span className="dim">from {money(start, 0)}</span>
          </div>
        )}
        {evo && (
          <div className="bp-health" title={`Health: equity as a share of its start. ${evo.deaths ? `${evo.deaths} death(s).` : ""}`}>
            <span className="dim small">health</span>
            <span className="bp-health-track">
              <i style={{ width: `${Math.max(2, Math.min(100, evo.health))}%` }} className={evo.health < 70 ? "bad" : evo.health < 90 ? "warn" : ""} />
            </span>
            <span className="num small">{evo.health.toFixed(1)}%</span>
          </div>
        )}
        <div className={`bp-pos ${p ? p.side : ""}`}>
          {p ? (
            <>
              <span className="bp-pos-side">
                {p.side === "long" ? "▲ LONG" : "▼ SHORT"} {p.coin}
              </span>
              <span className="num">
                {p.sizeUsd !== null ? money(p.sizeUsd, 0) : ""} @ {p.entryPx.toPrecision(6)} · {p.minutesHeld}m
              </span>
              <span className={`num ${p.uplUsd >= 0 ? "good" : "bad"}`}>open {signed(p.uplUsd)}</span>
            </>
          ) : (
            <span className="dim">Flat{bee?.flatMinutes ? ` for ${bee.flatMinutes}m` : ""} · watching</span>
          )}
        </div>
        {rank > 0 && <span className="dim small">rank {rank} of {of}</span>}
      </div>
    </section>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" | "" }) {
  return (
    <div className="bp-kpi">
      <span className="eyebrow">{label}</span>
      <span className={`bp-kpi-v num ${tone ?? ""}`}>{value}</span>
      {sub && <span className="dim small">{sub}</span>}
    </div>
  );
}

export function Kpis({ s }: { s: BunnyProfile["stats"] }) {
  return (
    <div className="bp-kpis">
      <div className="bp-kpi ring-kpi">
        <Ring value={s.winRatePct} color="var(--bee)" label="Win rate" text={s.winRatePct === null ? "–" : `${Math.round(s.winRatePct)}%`} />
        <span>
          <span className="eyebrow">Win rate</span>
          <span className="dim small">
            {s.wins} wins · {s.losses} losses
          </span>
        </span>
      </div>
      <Kpi label="Realised P&L" value={signed(s.realisedUsd)} tone={s.realisedUsd >= 0 ? "good" : "bad"} sub={`${s.trades} closed trades`} />
      <Kpi label="Profit factor" value={s.profitFactor === null ? "–" : s.profitFactor.toFixed(2)} sub="gross wins ÷ gross losses" tone={s.profitFactor === null ? "" : s.profitFactor >= 1 ? "good" : "bad"} />
      <Kpi label="Avg win / loss" value={`${s.avgWinUsd === null ? "–" : signed(s.avgWinUsd)} / ${s.avgLossUsd === null ? "–" : signed(s.avgLossUsd)}`} sub={`best ${s.bestUsd === null ? "–" : signed(s.bestUsd)} · worst ${s.worstUsd === null ? "–" : signed(s.worstUsd)}`} />
      <Kpi label="Fees" value={money(s.feesUsd)} sub={`on ${money(s.volumeUsd, 0)} traded`} />
      <Kpi label="Decisions" value={s.decisions.toLocaleString()} sub={`avg confidence ${s.avgConfidence === null ? "–" : `${Math.round(s.avgConfidence * 100)}%`} · Jev ${money(s.jevUsd)}`} />
    </div>
  );
}

function Card({ title, hint, children, wide }: { title: string; hint?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`bp-card ${wide ? "wide" : ""}`}>
      <div className="bp-card-head">
        <h3>{title}</h3>
        {hint && <span className="dim small">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Overview({ data, curve, start, evo, slot }: { data: BunnyProfile | null; curve: Array<[number, number]>; start: number; evo: EvolutionRow | null; slot: string }) {
  const m = beeMeta(slot);
  const dailyBars: Bar[] = (data?.daily ?? []).map((d) => ({ key: d.day, label: d.day.slice(5), value: d.realisedUsd, sub: [`${d.trades} closed trades`, `fees ${money(d.feesUsd)}`] }));
  const pointBars: Bar[] = (evo?.history ?? []).map((h) => ({ key: h.day, label: h.day.slice(5), value: h.points, sub: [`day P&L ${pct(h.pnlPct, 2)}`, ...(h.bonus ? [`bonus: ${h.bonus}`] : [])] }));
  return (
    <>
      {data && <Kpis s={data.stats} />}
      <div className="bp-grid">
        <Card title="Equity" hint="hover for the value at any time" wide>
          <div className="bp-equity-chart">
            <EquityChart curve={curve} color={m.color} baseline={start} gradientId={`bp-eq-${slot}`} />
          </div>
        </Card>
        <Card title="Realised P&L by day" hint="UTC days">
          <BarChart bars={dailyBars} format={(v) => signed(v)} tone={pnlTone} empty="No closed trades in this range yet." />
        </Card>
        <Card title="Points by day" hint={evo ? `level ${evo.level}${evo.nextLevelAt ? ` · next at ${evo.nextLevelAt} pts` : ""}` : "survival & rewards"}>
          <BarChart bars={pointBars} format={(v) => `${v >= 0 ? "+" : ""}${v} pts`} tone={(v) => (v >= 0 ? m.color : BAD)} empty="Points start after its first full day." />
        </Card>
        <Card title="Coins it trades" hint="realised P&L per coin">
          {data?.coins.length ? (
            <HBars
              rows={data.coins.slice(0, 10).map((c) => ({ key: c.coin, label: c.coin, value: c.realisedUsd, note: `${c.trades} trades${c.winRatePct === null ? "" : ` · ${c.winRatePct}% wins`}` }))}
              format={(v) => signed(v)}
              tone={pnlTone}
            />
          ) : (
            <div className="chart-empty">No trades yet.</div>
          )}
        </Card>
        <Card title="Latest from its mind" hint="lessons and the Warren">
          <div className="bp-feed">
            {[
              ...(data?.learning.lessons.slice(0, 3).map((l) => ({ ts: l.ts, kind: "lesson", text: l.text, tag: sourceLabel(l.source) })) ?? []),
              ...(data?.messages.filter((x) => x.mine).slice(0, 3).map((x) => ({ ts: x.ts, kind: "said", text: x.text, tag: sourceLabel(x.source) })) ?? []),
            ]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, 5)
              .map((x, i) => (
                <div className="bp-feed-row" key={i}>
                  <span className={`bp-tag ${x.kind}`}>{x.kind === "lesson" ? "learned" : "said"}</span>
                  <span className="bp-feed-text">{x.text}</span>
                  <span className="dim small">
                    {x.tag} · {ago(x.ts)}
                  </span>
                </div>
              ))}
            {!data?.learning.lessons.length && !data?.messages.some((x) => x.mine) && <div className="chart-empty">Nothing learned or said yet. Councils and the coach write here.</div>}
          </div>
        </Card>
      </div>
    </>
  );
}

export function Trades({ data }: { data: BunnyProfile | null }) {
  const [closesOnly, setClosesOnly] = useState(false);
  const rows = (data?.fills ?? []).filter((f) => !closesOnly || f.close);
  return (
    <div className="bp-grid">
      <Card title="Coin record" hint="every coin it has touched" wide>
        <div className="dv-table-wrap">
          <table className="dv-table num">
            <thead>
              <tr>
                <th>Coin</th>
                <th>Trades</th>
                <th>Win rate</th>
                <th>Realised</th>
                <th>Fees</th>
                <th>Volume</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              {(data?.coins ?? []).map((c) => (
                <tr key={c.coin}>
                  <td className="mono">{c.coin}</td>
                  <td>{c.trades}</td>
                  <td>{c.winRatePct === null ? "–" : `${c.winRatePct}%`}</td>
                  <td className={c.realisedUsd >= 0 ? "good" : "bad"}>{signed(c.realisedUsd)}</td>
                  <td>{money(c.feesUsd)}</td>
                  <td>{money(c.volumeUsd, 0)}</td>
                  <td className="dim">{ago(c.lastTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.coins.length && <div className="chart-empty">No trades yet.</div>}
        </div>
      </Card>
      <Card title="Fills" hint={`latest ${rows.length}`} wide>
        <label className="dv-check">
          <input type="checkbox" checked={closesOnly} onChange={(e) => setClosesOnly(e.target.checked)} /> Closes only
        </label>
        <div className="dv-table-wrap">
          <table className="dv-table num">
            <thead>
              <tr>
                <th>When</th>
                <th>Coin</th>
                <th>Side</th>
                <th>Why</th>
                <th>Price</th>
                <th>Size</th>
                <th>Fee</th>
                <th>Realised</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f, i) => (
                <tr key={`${f.ts}-${i}`}>
                  <td className="dim">{when(f.ts)}</td>
                  <td className="mono">{f.coin}</td>
                  <td className={f.side === "buy" ? "good" : "bad"}>{f.side === "buy" ? "▲ buy" : "▼ sell"}</td>
                  <td className="dim">{f.purpose ?? (f.close ? "close" : "open")}</td>
                  <td>{f.px.toPrecision(6)}</td>
                  <td>{money(f.notionalUsd, 0)}</td>
                  <td>{money(f.feeUsd)}</td>
                  <td className={f.close ? (f.realisedUsd >= 0 ? "good" : "bad") : "dim"}>{f.close ? signed(f.realisedUsd) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="chart-empty">No fills yet.</div>}
        </div>
      </Card>
    </div>
  );
}

export function Decisions({ data, live }: { data: BunnyProfile | null; live: ReturnType<typeof useFeed>["decisions"] }) {
  const dots: Dot[] = (data?.decisions ?? [])
    .filter((d) => d.confidence !== null)
    .map((d) => ({ ts: d.ts, value: d.confidence!, label: d.choice ?? d.status ?? "–", sub: d.vetoedBy ? `vetoed by ${d.vetoedBy}` : d.forcedBy ? `forced by ${d.forcedBy}` : undefined, hollow: !!d.vetoedBy }));
  const total = (data?.choiceMix ?? []).reduce((a, c) => a + c.n, 0);
  return (
    <div className="bp-grid">
      <Card title="Confidence of each call" hint="hollow = vetoed by the risk layer" wide>
        <DotStrip dots={dots} color="var(--bee)" empty="No decisions yet." />
      </Card>
      <Card title="What it chose" hint={`last ${total} decisions`}>
        {data?.choiceMix.length ? (
          <HBars rows={data.choiceMix.map((c) => ({ key: c.choice, label: c.choice.replace(/_/g, " ").toLowerCase(), value: c.n, note: `${Math.round((100 * c.n) / Math.max(1, total))}%` }))} format={(v) => String(v)} tone={() => "var(--bee)"} />
        ) : (
          <div className="chart-empty">No decisions yet.</div>
        )}
      </Card>
      <Card title="Live" hint="as it happens">
        <div className="bp-live">
          {live.slice(0, 8).map((d, i) => (
            <div className="bp-live-row" key={`${d.ts}-${i}`}>
              <span className="dim small num">{new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className="mono">{d.choice ?? d.watch ?? d.status}</span>
              {d.confidence !== null && <span className="num dim">{Math.round(d.confidence * 100)}%</span>}
              {d.vetoedBy && <span className="bp-tag warn">vetoed</span>}
            </div>
          ))}
          {!live.length && <div className="chart-empty">Waiting for its next call…</div>}
        </div>
      </Card>
      <Card title="Decision log" wide>
        <div className="dv-table-wrap">
          <table className="dv-table num">
            <thead>
              <tr>
                <th>When</th>
                <th>Choice</th>
                <th>Confidence</th>
                <th>Conviction</th>
                <th>Latency</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {(data?.decisions ?? []).slice(0, 60).map((d, i) => (
                <tr key={`${d.ts}-${i}`}>
                  <td className="dim">{when(d.ts)}</td>
                  <td className="mono">{d.choice ?? "–"}</td>
                  <td>{d.confidence === null ? "–" : `${Math.round(d.confidence * 100)}%`}</td>
                  <td>{d.conviction === null ? "–" : d.conviction.toFixed(2)}</td>
                  <td>{d.latencyMs === null ? "–" : `${(d.latencyMs / 1000).toFixed(1)}s`}</td>
                  <td className={d.vetoedBy || d.error ? "bad" : "dim"}>{d.error ? "error" : d.vetoedBy ? `vetoed · ${d.vetoedBy}` : d.forcedBy ? `forced · ${d.forcedBy}` : (d.status ?? "ok")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Learning({ data }: { data: BunnyProfile | null }) {
  const l = data?.learning;
  return (
    <div className="bp-grid">
      <Card title="What it has learned" hint="newest first" wide>
        <ol className="bp-timeline">
          {(l?.lessons ?? []).map((x, i) => (
            <li key={i} className={x.consolidated ? "old" : ""}>
              <span className="bp-tl-dot" aria-hidden />
              <div>
                <p>{x.text}</p>
                <span className="dim small">
                  <span className="bp-tag lesson">{sourceLabel(x.source)}</span> {when(x.ts)}
                  {x.consolidated ? " · consolidated into memory" : ""}
                </span>
              </div>
            </li>
          ))}
          {!l?.lessons.length && <div className="chart-empty">No lessons yet. The coach and the councils write them after trades and lab runs.</div>}
        </ol>
      </Card>
      <Card title="Specialisation" hint="the method its brains chose">
        {l?.specialization ? (
          <div className="bp-spec">
            <strong>{l.specialization.method}</strong>
            {l.specialization.reason && <p>{l.specialization.reason}</p>}
            <span className="dim small">since {when(l.specialization.since)}</span>
          </div>
        ) : (
          <div className="chart-empty">Trades its own style. A council can specialise it once the lab has evidence.</div>
        )}
      </Card>
      <Card title="Last council" hint={l?.plan ? `${BRAIN_LABEL[l.plan.brain] ?? l.plan.brain} · ${ago(l.plan.decidedAt)}` : ""}>
        {l?.plan ? (
          <div className="bp-spec">
            {l.plan.message && <blockquote>{l.plan.message}</blockquote>}
            {l.plan.lessons.map((x, i) => (
              <p key={i} className="small">
                • {x}
              </p>
            ))}
          </div>
        ) : (
          <div className="chart-empty">No council yet. One meets after each lab run.</div>
        )}
      </Card>
    </div>
  );
}

function WarrenChat({ data, slot }: { data: BunnyProfile | null; slot: string }) {
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const msgs = (data?.messages ?? []).filter((m) => filter === "all" || m.mine || m.toMe);
  return (
    <div className="bp-grid">
      <Card title="Warren chat" hint="what the bunnies tell each other after councils, coaching and level-ups" wide>
        <div className="seg" role="group" aria-label="Messages">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            Everyone
          </button>
          <button className={filter === "mine" ? "on" : ""} onClick={() => setFilter("mine")}>
            {beeMeta(slot).short} only
          </button>
        </div>
        <div className="bp-chat">
          {[...msgs].reverse().map((m, i) => {
            const who = beeMeta(m.fromSlot);
            return (
              <div key={`${m.ts}-${i}`} className={`bp-msg ${m.mine ? "mine" : ""}`} style={{ ["--who" as string]: who.color }}>
                <a href={`#/bunny/${m.fromSlot}`} className="bp-avatar" title={`${m.fromName}'s profile`}>
                  <img src={who.img} alt="" />
                </a>
                <div className="bp-bubble">
                  <div className="bp-msg-head">
                    <strong>{m.fromName}</strong>
                    <span className="dim small">→ {m.toName}</span>
                    {m.source && <span className="bp-tag">{sourceLabel(m.source)}</span>}
                    {m.brain && <span className="dim small">{m.brain.split("+").map((b) => BRAIN_LABEL[b] ?? b).join(" + ")}</span>}
                  </div>
                  <p>{m.text}</p>
                  <span className="dim small">{when(m.ts)}</span>
                </div>
              </div>
            );
          })}
          {!msgs.length && <div className="chart-empty">The Warren is quiet. Messages appear after councils, coach reviews and level-ups.</div>}
        </div>
      </Card>
    </div>
  );
}

function Skills({ data, evo, bee }: { data: BunnyProfile | null; evo: EvolutionRow | null; bee: PublicBee | undefined }) {
  const plan = data?.learning.plan;
  const adopted = data?.learning.adopted ?? [];
  return (
    <div className="bp-grid">
      <Card title="Score" hint="survival & rewards">
        {evo ? (
          <div className="bp-score">
            <Ring value={evo.nextLevelAt ? (evo.points / evo.nextLevelAt) * 100 : 100} color="var(--bee)" label="Progress to next level" text={`L${evo.level}`} />
            <div>
              <div className="bp-kpi-v num">{evo.points} pts</div>
              <span className="dim small">{evo.nextLevelAt ? `${Math.max(0, evo.nextLevelAt - evo.points)} to level ${evo.level + 1}` : "top level"}</span>
              <div className="small">
                {TIER_INFO[evo.tier].icon} {TIER_INFO[evo.tier].label} · {evo.deaths} death{evo.deaths === 1 ? "" : "s"} · {evo.skillsAuthored} skill{evo.skillsAuthored === 1 ? "" : "s"} authored
              </div>
            </div>
          </div>
        ) : (
          <div className="chart-empty">Survival and rewards are off.</div>
        )}
      </Card>
      <Card title="Perks unlocked" hint="what its level buys">
        {evo ? (
          <ul className="bp-perks">
            <li className={evo.perks.skillSlots > 0 ? "on" : ""}>{evo.perks.skillSlots} skill slot{evo.perks.skillSlots === 1 ? "" : "s"}</li>
            <li className={evo.perks.canAuthorSkills ? "on" : ""}>{evo.perks.canAuthorSkills ? "✓" : "✗"} writes its own skills</li>
            <li className={evo.perks.extraBrains > 0 ? "on" : ""}>+{evo.perks.extraBrains} brain{evo.perks.extraBrains === 1 ? "" : "s"} in councils</li>
            <li className={evo.perks.limitBoost > 0 ? "on" : ""}>+{Math.round(evo.perks.limitBoost * 100)}% size limit</li>
            <li className={evo.perks.extraTrades > 0 ? "on" : ""}>+{evo.perks.extraTrades} trades a day</li>
            {bee?.slots ? <li className="on">{bee.slots} position slot{bee.slots === 1 ? "" : "s"}</li> : null}
          </ul>
        ) : (
          <div className="chart-empty">–</div>
        )}
      </Card>
      <Card title="Skills its council chose" hint={plan ? `${BRAIN_LABEL[plan.brain] ?? plan.brain} · ${plan.model}` : "from the strategy lab"} wide>
        {plan?.skills.length ? (
          <div className="bp-skills">
            {plan.skills.map((s) => (
              <div className="bp-skill" key={s.id}>
                <div className="bp-skill-head">
                  <span className="mono">{s.id}</span>
                  <span className="num dim small">lab score {s.score.toFixed(2)}</span>
                </div>
                <span className="bp-skill-w">
                  <i style={{ width: `${Math.max(2, s.weight * 100)}%` }} />
                </span>
                <span className="num small">{Math.round(s.weight * 100)}% weight</span>
                {s.reason && <p className="small">{s.reason}</p>}
              </div>
            ))}
          </div>
        ) : adopted.length ? (
          <HBars rows={adopted.map((a) => ({ key: a.skill, label: a.skill, value: a.weight, note: `since ${when(a.since)}` }))} format={(v) => `${Math.round(v * 100)}%`} tone={() => "var(--bee)"} />
        ) : (
          <div className="chart-empty">No skills adopted yet. Run the strategy lab (Admin → Lab) and a council picks them.</div>
        )}
      </Card>
    </div>
  );
}
