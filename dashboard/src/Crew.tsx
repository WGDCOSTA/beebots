// The crew on the main page, beside the Farmer: the Owl (coach), the Rat (market analyst) and the Pig (accountant). Each card
// shows who it is, what it said last, its latest notes and when it looks next; #/crew/<id> shows everything it wrote.
import { useEffect, useState } from "react";
import { PageNav } from "./LabPage";
import { BarChart, HBars, Ring } from "./ProfileCharts";
import { beeMeta, type CrewEntry, type CrewSummary } from "./types";

const EMOJI: Record<string, string> = { owl: "🦉", rat: "🐀", pig: "🐷" };

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function until(ts: number | null): string {
  if (!ts) return "soon";
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  return m < 1 ? "now" : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}
const every = (min: number) => (min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`);

/** Its face: the painted portrait once the engine made it, else its animal. */
function Face({ m, small = false }: { m: Pick<CrewSummary, "id" | "image">; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (m.image && !broken) return <img className={`farmer-face crew-face ${small ? "sm" : ""}`} src={m.image} alt="" onError={() => setBroken(true)} />;
  return (
    <span className={`farmer-face crew-face crew-emoji ${small ? "sm" : ""}`} aria-hidden>
      {EMOJI[m.id] ?? "•"}
    </span>
  );
}

const forBee = (e: CrewEntry) => (e.bee ? beeMeta(e.bee).short : "Warren");

function CrewCard({ m }: { m: CrewSummary }) {
  return (
    <section className={`farmer crew-card crew-${m.id}`} aria-label={m.name}>
      <div className="farmer-head">
        <Face m={m} />
        <div className="farmer-who">
          <div className="farmer-name">{m.name.toUpperCase()}</div>
          <div className="dim small">
            {m.role} · every {every(m.everyMin)}
          </div>
        </div>
        <div className="farmer-next">
          <span className="dim small">next</span>
          <strong>{until(m.nextAt)}</strong>
        </div>
      </div>
      <p className="dim small crew-job">{m.job}</p>
      {m.said ? (
        <div className="farmer-quote">
          <div>
            <p>“{m.said.text}”</p>
            <div className="farmer-quote-foot">
              <span>Said</span>
              <span className="dim">{ago(m.said.ts)}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="dim farmer-quiet">{m.error ? `Could not finish his round: ${m.error}` : "Has not done his first round yet."}</p>
      )}
      {m.notes.length > 0 && (
        <ul className="farmer-list crew-notes">
          {m.notes.slice(0, 3).map((n) => (
            <li key={n.id}>
              <span className={`crew-level l-${n.level ?? "info"}`}>{n.level === "act" ? "act" : n.level === "watch" ? "watch" : "note"}</span>
              <span>
                <strong>{forBee(n)}</strong> · {n.title ? `${n.title}: ` : ""}
                {n.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      <a className="farmer-more" href={`#/crew/${m.id}`}>
        Everything he wrote →
      </a>
      {m.model && <div className="farmer-by dim small">Thinks with {m.model}</div>}
    </section>
  );
}

/** The three crew cards in a row, under the Farmer. */
export function CrewRow({ crew }: { crew: CrewSummary[] | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const on = (crew ?? []).filter((m) => m.enabled);
  if (!on.length) return null;
  return (
    <div className="crew-row">
      {on.map((m) => (
        <CrewCard key={m.id} m={m} />
      ))}
    </div>
  );
}

interface Dash {
  brain: { model: string | null; brain: string | null; everyMin: number; nextAt: number | null; enabled: boolean };
  metrics: { rounds: number; okRounds: number; successPct: number | null; avgLatencyMs: number | null; inTokens: number; outTokens: number; avgNotes: number | null; lastError: string | null };
  rounds: Array<{ ts: number; ok: number; model: string | null; latencyMs: number | null; inTokens: number | null; outTokens: number | null; notes: number; error: string | null }>;
  levels: Array<{ level: string; n: number }>;
  perBee: Array<{ bee: string; level: string; n: number }>;
  // The data it read last round (brains/crewData.ts): its shape depends on the member.
  input: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const BRAIN: Record<string, string> = { openai: "ChatGPT (OpenAI)", claude: "Claude (Anthropic)", kimi: "Kimi (Moonshot)", zai: "GLM (Z.ai)" };
const COLOR: Record<string, string> = { owl: "#9085e9", rat: "#3fb9c9", pig: "#e77fa4" };
const pctTone = (v: number) => (v >= 0 ? "var(--good)" : "var(--critical)");
const fmtN = (n: number) => n.toLocaleString("en-US");
const pctFmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bp-kpi">
      <span className="eyebrow">{label}</span>
      <span className="bp-kpi-v num">{value}</span>
      {sub && <span className="dim small">{sub}</span>}
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

/** What it read last round, drawn for its job: the Owl's view of each bunny, the Rat's market, the Pig's books. */
function JobCharts({ id, input, color }: { id: string; input: Dash["input"]; color: string }) {
  if (!input) return <Card title="What it read" wide><div className="chart-empty">Its first round's data will show here.</div></Card>;
  if (id === "owl") {
    const bees: Array<{ slot: string; name: string; pnlPct: number | null; callsLast24h: { total: number; avgConfidence: number | null; vetoed: number; byKind: Record<string, number> }; recentClosedTrades: Array<{ netUsd: number | null }> }> = input.bunnies ?? [];
    return (
      <>
        <Card title="Average confidence of each bunny's calls" hint="last 24 h">
          <HBars rows={bees.map((b) => ({ key: b.slot, label: b.name, value: (b.callsLast24h.avgConfidence ?? 0) * 100, note: `${b.callsLast24h.total} calls · ${b.callsLast24h.vetoed} vetoed` }))} format={(v) => `${Math.round(v)}%`} tone={() => color} />
        </Card>
        <Card title="Each bunny's P&L" hint="since start">
          <HBars rows={bees.map((b) => ({ key: b.slot, label: b.name, value: b.pnlPct ?? 0 }))} format={pctFmt} tone={pctTone} />
        </Card>
        {bees.map((b) => (
          <Card key={b.slot} title={`${b.name}: what it chose`} hint={`${b.callsLast24h.total} calls in 24 h`}>
            <HBars rows={Object.entries(b.callsLast24h.byKind).sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ key: k, label: k.toLowerCase(), value: n, note: `${Math.round((100 * n) / Math.max(1, b.callsLast24h.total))}%` }))} format={(v) => String(v)} tone={() => color} />
          </Card>
        ))}
      </>
    );
  }
  if (id === "rat") {
    const okx = input.okx ?? {};
    const mood = input.coinMarketCap ?? {};
    const rows = (xs: Array<Record<string, number | string | null>> | undefined, k: string) => (xs ?? []).map((c) => ({ key: String(c.coin), label: String(c.coin), value: Number(c[k] ?? 0), note: c.rsi !== undefined && c.rsi !== null ? `RSI ${c.rsi}` : undefined }));
    return (
      <>
        <div className="bp-kpis wide-span">
          <Kpi label="Fear & Greed" value={String(mood.fearGreed ?? "–")} sub={mood.fearGreedWeek ? `week ${mood.fearGreedWeek}` : undefined} />
          <Kpi label="Altcoin season" value={String(mood.altcoinSeason ?? "–")} />
          <Kpi label="BTC dominance" value={mood.btcDominancePct != null ? `${mood.btcDominancePct}%` : "–"} />
          <Kpi label="Market cap 24h" value={mood.totalMcapChange24hPct != null ? pctFmt(mood.totalMcapChange24hPct) : "–"} sub={mood.totalMcapTusd ? `$${mood.totalMcapTusd}T` : undefined} />
          <Kpi label="OKX breadth 24h" value={okx.breadth24h ? `${okx.breadth24h.up} ▲ · ${okx.breadth24h.down} ▼` : "–"} sub={`${okx.coins ?? 0} coins`} />
        </div>
        <Card title="Strongest 7 days" hint="OKX perps">
          <HBars rows={rows(okx.strongest7d, "ret7dPct")} format={pctFmt} tone={pctTone} />
        </Card>
        <Card title="Weakest 7 days" hint="OKX perps">
          <HBars rows={rows(okx.weakest7d, "ret7dPct")} format={pctFmt} tone={pctTone} />
        </Card>
        <Card title="Highest funding" hint="longs pay shorts: crowded longs">
          <HBars rows={rows(okx.highestFunding, "fundingPct")} format={(v) => `${v.toFixed(3)}%`} tone={pctTone} />
        </Card>
        <Card title="Lowest funding" hint="shorts pay longs: crowded shorts">
          <HBars rows={rows(okx.lowestFunding, "fundingPct")} format={(v) => `${v.toFixed(3)}%`} tone={pctTone} />
        </Card>
        <Card title="Top movers 24 h" hint="CoinMarketCap, top 150">
          <HBars rows={(input.topMovers24h ?? []).map((c: { coin: string; pct24h: number; rank: number }) => ({ key: c.coin, label: c.coin, value: c.pct24h, note: `rank ${c.rank}` }))} format={pctFmt} tone={pctTone} />
        </Card>
        <Card title="Bottom movers 24 h" hint="CoinMarketCap, top 150">
          <HBars rows={(input.bottomMovers24h ?? []).map((c: { coin: string; pct24h: number; rank: number }) => ({ key: c.coin, label: c.coin, value: c.pct24h, note: `rank ${c.rank}` }))} format={pctFmt} tone={pctTone} />
        </Card>
      </>
    );
  }
  // pig: the books
  const bees: Array<{ slot: string; name: string; pnlUsd: number; allTime: { feesUsd: number; fundingUsd: number; modelUsd: number; realisedUsd: number }; last7d: { netUsd: number } }> = input.bunnies ?? [];
  const w = input.warren ?? {};
  const b = input.budgets ?? {};
  const cmc = b.coinMarketCap;
  return (
    <>
      <div className="bp-kpis wide-span">
        <Kpi label="Warren equity" value={w.equityUsd != null ? usd(w.equityUsd) : "–"} sub={w.startUsd != null ? `start ${usd(w.startUsd)}` : undefined} />
        <Kpi label="Realised P&L" value={w.realisedUsd != null ? usd(w.realisedUsd) : "–"} sub="all time" />
        <Kpi label="Fees" value={w.feesUsd != null ? usd(w.feesUsd) : "–"} sub="all time" />
        <Kpi label="Model spend" value={w.modelUsd != null ? usd(w.modelUsd) : "–"} sub="all time" />
        <Kpi label="Funding" value={w.fundingUsd != null ? usd(w.fundingUsd) : "–"} sub="all time" />
      </div>
      <Card title="Budgets today" hint="how much of each cap is used">
        <div className="crew-rings">
          <div>
            <Ring value={b.jevDailyCapUsd ? (100 * (b.jevTodayUsd ?? 0)) / b.jevDailyCapUsd : null} color={color} label="Decision model budget" text={b.jevDailyCapUsd ? `${Math.round((100 * (b.jevTodayUsd ?? 0)) / b.jevDailyCapUsd)}%` : "–"} />
            <span className="dim small">decision model {usd(b.jevTodayUsd ?? 0)} / {usd(b.jevDailyCapUsd ?? 0)}</span>
          </div>
          {cmc && (
            <div>
              <Ring value={cmc.maxCallsDay ? (100 * cmc.callsToday) / cmc.maxCallsDay : null} color={color} label="CoinMarketCap calls" text={cmc.maxCallsDay ? `${Math.round((100 * cmc.callsToday) / cmc.maxCallsDay)}%` : "–"} />
              <span className="dim small">
                CoinMarketCap {cmc.callsToday} / {cmc.maxCallsDay} calls
              </span>
            </div>
          )}
        </div>
      </Card>
      <Card title="Net result, last 7 days" hint="realised − fees + funding − model spend">
        <HBars rows={bees.map((x) => ({ key: x.slot, label: x.name, value: x.last7d.netUsd ?? 0 }))} format={usd} tone={pctTone} />
      </Card>
      <Card title="Fees per bunny" hint="all time">
        <HBars rows={bees.map((x) => ({ key: x.slot, label: x.name, value: x.allTime.feesUsd ?? 0 }))} format={usd} tone={() => "var(--critical)"} />
      </Card>
      <Card title="Model spend per bunny" hint="all time">
        <HBars rows={bees.map((x) => ({ key: x.slot, label: x.name, value: x.allTime.modelUsd ?? 0 }))} format={usd} tone={() => color} />
      </Card>
    </>
  );
}

/** #/crew/<id>: everything one crew member wrote, newest first. */
const readId = () => location.hash.replace(/^#\/?/, "").split(/[/?]/)[1] ?? "owl";

export function CrewPage() {
  const [id, setId] = useState(readId);
  useEffect(() => {
    const on = () => setId(readId());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [m, setM] = useState<CrewSummary | null>(null);
  const [entries, setEntries] = useState<CrewEntry[]>([]);
  const [more, setMore] = useState(true);
  const [missing, setMissing] = useState(false);
  const [dash, setDash] = useState<Dash | null>(null);
  const load = (before?: number) =>
    fetch(`/crew/${id}?limit=50${before ? `&before=${before}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setMissing(true);
          return;
        }
        const j = (await r.json()) as { member: CrewSummary; entries: CrewEntry[]; dashboard?: Dash };
        setM(j.member);
        if (j.dashboard) setDash(j.dashboard);
        setEntries((x) => (before ? [...x, ...j.entries] : j.entries));
        setMore(j.entries.length === 50);
      })
      .catch(() => setMore(false));
  useEffect(() => {
    setEntries([]);
    setDash(null);
    setM(null);
    setMissing(false);
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="bp">
      <PageNav current="crew" />
      <div className="bp-wrap farmer-page">
        <a href="#/" className="bp-back">
          ← Live board
        </a>
        <div className="crew-tabs">
          {(["owl", "rat", "pig"] as const).map((x) => (
            <a key={x} href={`#/crew/${x}`} className={x === id ? "on" : ""}>
              {EMOJI[x]} {x === "owl" ? "The Owl" : x === "rat" ? "The Rat" : "The Pig"}
            </a>
          ))}
        </div>
        {missing ? (
          <p className="dim">No such crew member.</p>
        ) : (
          <>
            {m && (
              <section className="bp-hero crew-hero" style={{ ["--bee" as string]: COLOR[m.id] ?? "var(--bizzy)", ["--bee-glow" as string]: `${COLOR[m.id] ?? "#f0b43c"}73` }}>
                <div className="bp-portrait">{m.image ? <img src={m.image} alt={`${m.name} portrait`} /> : <span className="crew-big-emoji">{EMOJI[m.id]}</span>}</div>
                <div className="bp-id">
                  <span className="eyebrow">The crew · {m.role}</span>
                  <h1>{m.name}</h1>
                  <p className="bp-tagline">{m.job}</p>
                  <p className="dim small">He advises; he never trades, moves money or changes a bunny's coins, style or size.</p>
                </div>
                <div className="bp-now crew-brain">
                  <span className="eyebrow">Brain</span>
                  <div className="crew-brain-row">
                    {dash && <Ring value={dash.metrics.successPct} color={COLOR[m.id] ?? "var(--bizzy)"} label="Rounds that worked" text={dash.metrics.successPct === null ? "–" : `${dash.metrics.successPct}%`} />}
                    <div>
                      <strong>{dash?.brain.brain ? (BRAIN[dash.brain.brain] ?? dash.brain.brain) : "Off"}</strong>
                      <div className="mono small">{m.model ?? "no model"}</div>
                      <div className="dim small">rounds that worked</div>
                    </div>
                  </div>
                  <div className="dim small">
                    every {every(m.everyMin)} · next {until(m.nextAt)}
                  </div>
                  {m.error && <div className="bad small">Last round failed: {m.error}</div>}
                </div>
              </section>
            )}
            {dash && (
              <>
                <div className="bp-kpis">
                  <Kpi label="Rounds" value={fmtN(dash.metrics.rounds)} sub={`${dash.metrics.okRounds} worked`} />
                  <Kpi label="Avg answer time" value={dash.metrics.avgLatencyMs === null ? "–" : `${(dash.metrics.avgLatencyMs / 1000).toFixed(1)} s`} sub="per round" />
                  <Kpi label="Tokens read" value={fmtN(dash.metrics.inTokens)} sub="all rounds" />
                  <Kpi label="Tokens written" value={fmtN(dash.metrics.outTokens)} sub="all rounds" />
                  <Kpi label="Notes per round" value={dash.metrics.avgNotes === null ? "–" : String(dash.metrics.avgNotes)} sub={`${dash.levels.find((l) => l.level === "act")?.n ?? 0} asked for action`} />
                </div>
                <div className="bp-grid crew-grid">
                  <Card title="Notes per round" hint="red: a round that failed">
                    <BarChart bars={dash.rounds.map((r, i) => ({ key: `${r.ts}-${i}`, label: new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), value: r.ok ? r.notes : -1, sub: r.ok ? [`${r.inTokens ?? 0} tokens in · ${r.outTokens ?? 0} out`, r.model ?? ""] : [`failed: ${r.error ?? ""}`] }))} format={(v) => (v < 0 ? "failed" : `${v} notes`)} tone={(v) => (v < 0 ? "var(--critical)" : COLOR[m!.id] ?? "var(--bizzy)")} empty="No rounds yet." />
                  </Card>
                  <Card title="Answer time per round" hint="seconds">
                    <BarChart bars={dash.rounds.filter((r) => r.ok).map((r, i) => ({ key: `${r.ts}-${i}`, label: new Date(r.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), value: (r.latencyMs ?? 0) / 1000 }))} format={(v) => `${v.toFixed(1)} s`} tone={() => COLOR[m!.id] ?? "var(--bizzy)"} empty="No rounds yet." />
                  </Card>
                  <Card title="Notes by level" hint="info · watch · act">
                    <HBars rows={dash.levels.map((l) => ({ key: l.level, label: l.level, value: l.n }))} format={(v) => String(v)} tone={() => "var(--bizzy)"} />
                  </Card>
                  <Card title="Notes by bunny" hint="who he wrote about">
                    <HBars
                      rows={Object.entries(dash.perBee.reduce<Record<string, number>>((a, r) => ({ ...a, [r.bee]: (a[r.bee] ?? 0) + r.n }), {})).map(([bee, n]) => ({ key: bee || "warren", label: bee ? beeMeta(bee).short : "Whole warren", value: n }))}
                      format={(v) => String(v)}
                      tone={() => COLOR[m!.id] ?? "var(--bizzy)"}
                    />
                  </Card>
                  <JobCharts id={m!.id} input={dash.input} color={COLOR[m!.id] ?? "var(--bizzy)"} />
                </div>
                <h2 className="crew-log-title">Everything he wrote</h2>
              </>
            )}
            <ol className="farmer-log">
              {entries.map((e) => (
                <li key={e.id} className={`k-${e.kind}`}>
                  <div className="farmer-log-top">
                    <strong>{e.kind === "say" ? "Said" : `${forBee(e)} · ${e.title ?? ""}`}</strong>
                    {e.level && <span className={`crew-level l-${e.level}`}>{e.level}</span>}
                    <span className="dim small">{new Date(e.ts).toLocaleString()}</span>
                  </div>
                  <p>{e.kind === "say" ? `“${e.text}”` : e.text}</p>
                </li>
              ))}
            </ol>
            {entries.length === 0 && <p className="dim">{m?.error ? `His last round failed: ${m.error}` : "Nothing yet: his first round is coming."}</p>}
            {more && entries.length > 0 && (
              <button className="pbtn ghost" onClick={() => void load(entries[entries.length - 1]!.id)}>
                Older
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
