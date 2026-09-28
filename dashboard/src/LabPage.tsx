// #/lab: the strategy lab's ranking, each bee's playbook, and the hive mind (graph + the bees' latest messages and
// lessons). Read-only and public, like the rest of the dashboard: no keys ever reach these endpoints.
import { useEffect, useMemo, useState } from "react";
import { HiveGraph } from "./HiveGraph";
import { BRAIN_LABEL, FAMILY_LABEL, getJson, when, type GraphJson, type Playbook, type RankedSkill, type Ranking } from "./panelTypes";
import { WatchChips } from "./WatchChips";
import { ALL_BEES, beeMeta, TIER_INFO, type EvolutionRow, type Snapshot } from "./types";

type SortKey = "rank" | "return" | "sharpe" | "sqn" | "dd" | "trades" | "stability" | "overfit";
const SORTS: Record<SortKey, (s: RankedSkill) => number> = {
  rank: (s) => -s.rank,
  return: (s) => s.oos.returnPct,
  sharpe: (s) => s.oos.sharpe,
  sqn: (s) => s.oos.sqn ?? 0,
  dd: (s) => -s.oos.maxDrawdownPct,
  trades: (s) => s.oos.trades,
  stability: (s) => s.stabilityPct,
  overfit: (s) => -s.overfitGap,
};

const pct = (x: number, d = 1) => `${x > 0 ? "+" : ""}${x.toFixed(d)}%`;

/** Diverging bar around zero: blue above, red below, neutral baseline. The number is always printed beside it. */
function ScoreBar({ v, max }: { v: number; max: number }) {
  const w = Math.min(50, (Math.abs(v) / Math.max(max, 0.01)) * 50);
  return (
    <span className="sbar" aria-hidden>
      <span className="sbar-mid" />
      <span className={`sbar-fill ${v >= 0 ? "pos" : "neg"}`} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
    </span>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ptile">
      <div className="eyebrow">{label}</div>
      <div className="ptile-value num">{value}</div>
      {sub && <div className="dim ptile-sub">{sub}</div>}
    </div>
  );
}

function RankingTable({ ranking }: { ranking: Ranking }) {
  const [family, setFamily] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("rank");
  const [open, setOpen] = useState<string | null>(null);
  const families = useMemo(() => ["all", ...new Set(ranking.results.map((r) => r.family))], [ranking]);
  const rows = useMemo(() => {
    const f = ranking.results.filter((r) => family === "all" || r.family === family);
    return [...f].sort((a, b) => SORTS[sort](b) - SORTS[sort](a));
  }, [ranking, family, sort]);
  const max = Math.max(...ranking.results.map((r) => Math.abs(r.score)).filter(Number.isFinite), 0.01);
  const th = (k: SortKey, label: string, cls = "r") => (
    <th className={`${cls} sortable ${sort === k ? "on" : ""}`} onClick={() => setSort(k)} aria-sort={sort === k ? "descending" : "none"}>
      {label}
      {sort === k ? " ▾" : ""}
    </th>
  );

  return (
    <>
      <div className="chips" role="group" aria-label="Filter by family">
        {families.map((f) => (
          <button key={f} className={`chip ${family === f ? "on" : ""}`} onClick={() => setFamily(f)}>
            {f === "all" ? "All families" : (FAMILY_LABEL[f] ?? f)}
          </button>
        ))}
      </div>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              {th("rank", "#", "")}
              <th>Skill</th>
              <th>Family</th>
              <th className="r">Score</th>
              <th aria-label="score bar" />
              {th("return", "OOS return")}
              <th className="r">Buy & hold</th>
              {th("sharpe", "Sharpe")}
              {th("sqn", "SQN")}
              {th("dd", "Max DD")}
              {th("trades", "Trades")}
              {th("stability", "Stable")}
              {th("overfit", "Overfit")}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <FragmentRow key={s.skillId} s={s} max={max} open={open === s.skillId} onToggle={() => setOpen(open === s.skillId ? null : s.skillId)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim small">
        Walk-forward: parameters are picked on the past and scored only on the {ranking.opts.folds} folds they never saw. Stable = share of folds that made money.
        Overfit = in-sample minus out-of-sample score (big = fitted to noise). SQN needs 5+ trades. Click a row for its folds.
      </p>
    </>
  );
}

function FragmentRow({ s, max, open, onToggle }: { s: RankedSkill; max: number; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={`clickable ${open ? "open" : ""}`} onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        <td className="num dim">{s.rank}</td>
        <td className="skill-cell">
          <div className="skill-name">{s.name}</div>
          <div className="dim mono small">{s.skillId}</div>
        </td>
        <td>{FAMILY_LABEL[s.family] ?? s.family}</td>
        <td className="r num strong">{s.score.toFixed(2)}</td>
        <td className="bar-cell">
          <ScoreBar v={s.score} max={max} />
        </td>
        <td className="r num">{pct(s.oos.returnPct)}</td>
        <td className="r num dim">{pct(s.oos.benchmarkPct)}</td>
        <td className="r num">{s.oos.sharpe.toFixed(2)}</td>
        <td className="r num">{(s.oos.sqn ?? 0).toFixed(2)}</td>
        <td className="r num">{s.oos.maxDrawdownPct.toFixed(1)}%</td>
        <td className="r num">{s.oos.trades}</td>
        <td className="r num">{s.stabilityPct.toFixed(0)}%</td>
        <td className="r num">{s.overfitGap.toFixed(2)}</td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={13}>
            <p>{s.description}</p>
            <p className="dim small">
              Source: {s.source} · consensus params:{" "}
              <span className="mono">
                {Object.entries(s.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ") || "none"}
              </span>
            </p>
            {s.folds?.length ? (
              <table className="ptable inner">
                <thead>
                  <tr>
                    <th>Dataset</th>
                    <th className="r">Fold</th>
                    <th className="r">Score</th>
                    <th className="r">Return</th>
                    <th className="r">Buy & hold</th>
                    <th className="r">Sharpe</th>
                    <th className="r">Max DD</th>
                    <th className="r">Trades</th>
                    <th>Params picked on the past</th>
                  </tr>
                </thead>
                <tbody>
                  {s.folds.map((f) => (
                    <tr key={`${f.dataset}-${f.fold}`}>
                      <td>{f.dataset}</td>
                      <td className="r num">{f.fold + 1}</td>
                      <td className="r num">{f.score.toFixed(2)}</td>
                      <td className={`r num ${f.returnPct >= 0 ? "good" : "bad"}`}>
                        {f.returnPct >= 0 ? "▲ " : "▼ "}
                        {pct(f.returnPct)}
                      </td>
                      <td className="r num dim">{pct(f.benchmarkPct)}</td>
                      <td className="r num">{f.sharpe.toFixed(2)}</td>
                      <td className="r num">{f.maxDrawdownPct.toFixed(1)}%</td>
                      <td className="r num">{f.trades}</td>
                      <td className="mono small dim">
                        {Object.entries(f.params)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(" ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

function PlaybookCards({ playbook }: { playbook: Playbook | null }) {
  if (!playbook) return <p className="dim">No playbook yet: run the council (Admin → Lab → council) after a lab run.</p>;
  return (
    <div className="pb-grid">
      {ALL_BEES.map((slot) => {
        const p = playbook.bees[slot];
        const meta = beeMeta(slot);
        return (
          <section key={slot} className="pcard pb-card" style={{ ["--bee" as string]: meta.color }}>
            <div className="pb-head">
              <img src={meta.img} alt="" />
              <div>
                <div className="pb-name">{meta.short}</div>
                <div className="dim small">
                  thinks with <strong>{p?.brain === "ensemble" ? "combined brains" : (BRAIN_LABEL[p?.brain ?? "rules"] ?? p?.brain)}</strong>
                  {p?.model && p.model !== "rules" ? <span className="mono"> · {p.model}</span> : null}
                </div>
              </div>
            </div>
            {!p ? (
              <p className="dim">No plan yet.</p>
            ) : (
              <>
                <div className="eyebrow">Skills it leans on</div>
                <ul className="pb-skills">
                  {p.skills.map((s) => (
                    <li key={s.id} title={s.reason}>
                      <span className="mono">{s.id}</span>
                      <span className="pb-bar">
                        <span style={{ width: `${Math.max(3, s.weight * 100)}%` }} />
                      </span>
                      <span className="num">{Math.round(s.weight * 100)}%</span>
                      {s.reason && <span className="pb-reason dim small">{s.reason}</span>}
                    </li>
                  ))}
                </ul>
                {p.watchlist && p.watchlist.length > 0 && (
                  <>
                    <div className="eyebrow">Coins its brains chose</div>
                    <WatchChips items={p.watchlist} />
                  </>
                )}
                {p.message && (
                  <>
                    <div className="eyebrow">To the hive</div>
                    <blockquote className="pb-msg">{p.message}</blockquote>
                  </>
                )}
                {p.lessons.length > 0 && (
                  <>
                    <div className="eyebrow">Lessons</div>
                    <ul className="pb-lessons">
                      {p.lessons.slice(0, 4).map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="dim small">decided {when(p.decidedAt)}</div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

const LEVEL_POINTS = [0, 50, 150, 300, 500, 800];

function perkText(p: EvolutionRow["perks"]): string {
  const out = [`${p.skillSlots} skill slots`];
  if (p.canAuthorSkills) out.push("writes new skills");
  if (p.extraBrains) out.push(`+${p.extraBrains} brain${p.extraBrains > 1 ? "s" : ""} in councils`);
  if (p.limitBoost) out.push(`+${Math.round(p.limitBoost * 100)}% max size`);
  if (p.extraTrades) out.push(`+${p.extraTrades} trades/day`);
  return out.join(" · ");
}

/** Survival and rewards: bees ranked by points, with health against the danger and death lines. */
function EvolutionBoard({ evo }: { evo: NonNullable<Snapshot["evolution"]> }) {
  if (!evo.board.length) return <p className="dim">No bee has a record yet: the board fills in after the first tick.</p>;
  return (
    <>
      <p className="dim small">
        {evo.survival ? "Survival mode is on: every bee knows it dies at the retire line. In danger it trades smaller and its brains meet to save it." : "Survival mode is off."}{" "}
        {evo.rewards ? "Profitable days earn points (10 per 1% gained, half that lost on a losing day, +1 for surviving, +5 for the day's best bee); levels unlock prizes." : "Rewards are off."}
      </p>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th>#</th>
              <th>Bee</th>
              <th>State</th>
              <th>Health (% of start)</th>
              <th className="r">Points</th>
              <th>Level</th>
              <th>Prizes unlocked</th>
              <th>Last days</th>
              <th className="r">Deaths</th>
              <th className="r">Skills written</th>
            </tr>
          </thead>
          <tbody>
            {evo.board.map((r, i) => {
              const m = beeMeta(r.bee);
              const t = TIER_INFO[r.tier];
              const lo = LEVEL_POINTS[r.level] ?? 0;
              const next = r.nextLevelAt;
              const prog = next ? Math.max(0, Math.min(1, (r.points - lo) / (next - lo))) : 1;
              return (
                <tr key={r.bee}>
                  <td className="num dim">{i + 1}</td>
                  <td className="skill-cell">
                    <span className="evo-dot" style={{ background: m.color }} aria-hidden /> <strong>{r.name}</strong> <span className="dim mono small">{r.bee}</span>
                  </td>
                  <td className={`tier-cell ${t.tone}`}>
                    {t.icon} {t.label}
                  </td>
                  <td>
                    <span className="health" title={`${r.health}%`}>
                      <span className={`health-fill ${t.tone}`} style={{ width: `${Math.max(1, Math.min(100, (r.health / 150) * 100))}%` }} />
                      <span className="health-line" style={{ left: `${(100 / 150) * 100}%` }} title="start" />
                    </span>
                    <span className="num small"> {r.health.toFixed(1)}%</span>
                  </td>
                  <td className="r num strong">{r.points}</td>
                  <td>
                    <span className="num">L{r.level}</span>
                    <span className="lvl" title={next ? `${r.points} / ${next} points to level ${r.level + 1}` : "top level"}>
                      <span style={{ width: `${prog * 100}%` }} />
                    </span>
                  </td>
                  <td className="small">{perkText(r.perks)}</td>
                  <td className="small num">
                    {r.history.length
                      ? r.history
                          .slice(0, 5)
                          .map((h) => `${h.points >= 0 ? "+" : ""}${h.points}${h.bonus ? "★" : ""}`)
                          .join("  ")
                      : "–"}
                  </td>
                  <td className="r num">{r.deaths}</td>
                  <td className="r num">{r.skillsAuthored}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="dim small">Levels at 50, 150, 300, 500 and 800 points. ★ = best bee of the day. Leverage is never raised; bigger limits are off with real money unless the owner allows it.</p>
    </>
  );
}

function HiveFeed({ graph }: { graph: GraphJson }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const notes = graph.nodes
    .filter((n) => n.type === "message" || n.type === "lesson")
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 30);
  if (!notes.length) return <p className="dim">No messages or lessons yet.</p>;
  const author = (n: (typeof notes)[number]) => {
    const id = String(n.from ?? n.author ?? "");
    return byId.get(id)?.label ?? (id.startsWith("run:") ? "the lab" : id || "?");
  };
  return (
    <ul className="feed">
      {notes.map((n) => (
        <li key={n.id}>
          <div className="feed-head">
            <span className={`feed-kind ${n.type}`}>{n.type === "message" ? "✉ message" : "✎ lesson"}</span>
            <strong>{author(n)}</strong>
            {n.type === "message" && n.to && n.to !== "hive" ? <span className="dim"> → {byId.get(String(n.to))?.label ?? String(n.to)}</span> : null}
            {n.brain ? <span className="dim small"> · {BRAIN_LABEL[String(n.brain)] ?? String(n.brain)}</span> : null}
            <span className="dim small num feed-when">{when(n.updated_at)}</span>
          </div>
          <div>{String(n.text ?? n.label)}</div>
        </li>
      ))}
    </ul>
  );
}

export function LabPage() {
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [graph, setGraph] = useState<GraphJson | null>(null);
  const [evo, setEvo] = useState<Snapshot["evolution"] | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [r, p, g, snap] = await Promise.all([getJson<Ranking>("/lab/ranking"), getJson<Playbook>("/lab/playbook"), getJson<GraphJson>("/hive-mind"), getJson<Snapshot>("/snapshot")]);
        if (alive) setEvo(snap?.evolution ?? null);
        if (!alive) return;
        setRanking(r && Array.isArray(r.results) && r.results.length ? r : null);
        setPlaybook(p && p.bees ? p : null);
        setGraph(g && Array.isArray(g.nodes) ? g : null);
        setError("");
      } catch {
        if (alive) setError("Can't reach the engine right now. Retrying…");
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [reload]);

  const best = ranking?.results.find((r) => r.family !== "benchmark");
  const bh = ranking?.results.find((r) => r.skillId === "buy_hold");

  return (
    <div className="page">
      <PageNav current="lab" />
      <div className="page-inner">
        <h1>Strategy lab & hive mind</h1>
        <p className="lead">
          Every skill is simulated on history with fees, slippage and funding, and ranked only on data its parameters never saw. Each bee's brain picks from
          this ranking; the hive mind remembers what they learned and what they told each other. Paper only, not financial advice.
        </p>
        {error && <p className="bad">{error}</p>}

        <section>
          <h2>Ranking</h2>
          {!loaded ? (
            <p className="dim">Loading…</p>
          ) : !ranking ? (
            <p className="dim">No lab run yet. Start one from Admin → Lab (or `pnpm lab cycle`).</p>
          ) : (
            <>
              <div className="ptiles">
                <Tile label="Last run" value={when(ranking.createdAt)} sub={ranking.datasets.map((d) => d.id).join(", ")} />
                <Tile label="Skills tested" value={String(ranking.results.length)} sub={`${ranking.opts.folds} out-of-sample folds each`} />
                <Tile label="Best out of sample" value={best ? best.skillId : "–"} sub={best ? `score ${best.score.toFixed(2)} · ${pct(best.oos.returnPct)}` : undefined} />
                <Tile label="Buy & hold, same folds" value={bh ? pct(bh.oos.returnPct) : "–"} sub="the bar every skill must clear" />
              </div>
              <RankingTable ranking={ranking} />
              {ranking.errors.length > 0 && <p className="bad small">Errors: {ranking.errors.join("; ")}</p>}
            </>
          )}
        </section>

        <section>
          <h2>Evolution: survival & rewards</h2>
          {evo ? <EvolutionBoard evo={evo} /> : <p className="dim">{loaded ? "Survival and rewards are not running." : "Loading…"}</p>}
        </section>

        <section>
          <h2>Playbooks</h2>
          <PlaybookCards playbook={playbook} />
        </section>

        <section>
          <h2>Hive mind</h2>
          <p className="dim small">Bees, their brains, skills, coins, lessons and messages. Hover a node for details, click to pin it and see its links.</p>
          <div className="pcard">{graph ? <HiveGraph graph={graph} onRefresh={() => setReload((n) => n + 1)} /> : <p className="dim">{loaded ? "No graph yet." : "Loading…"}</p>}</div>
        </section>

        <section>
          <h2>Ask the hive mind</h2>
          <p className="dim small">
            Graphify-style recall: the slice of the graph about your words, each link marked as a measured fact (EXTRACTED), a brain's conclusion (INFERRED) or facts that
            disagree. The report lists the god nodes, communities, surprising connections, each bee's specialisation and its memories.
          </p>
          <div className="pcard">
            <HiveQuery />
          </div>
        </section>

        <section>
          <h2>Latest from the hive</h2>
          <div className="pcard">{graph ? <HiveFeed graph={graph} /> : <p className="dim">–</p>}</div>
        </section>
      </div>
    </div>
  );
}

export function PageNav({ current }: { current: "lab" | "admin" }) {
  return (
    <nav className="pnav">
      <a className="logo" href="#/">
        beebots
      </a>
      <a href="#/">Live</a>
      <a href="#/lab" className={current === "lab" ? "on" : ""}>
        Lab & hive mind
      </a>
      <a href="#/admin" className={current === "admin" ? "on" : ""}>
        Admin
      </a>
    </nav>
  );
}

/** A question to the hive mind (/hive-mind/query) and its report (/hive-mind/report). */
function HiveQuery() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ focus: string[]; nodes: Array<{ id: string; type: string; label: string }>; edges: Array<{ src: string; rel: string; dst: string; w: number; confidence: string }> } | null>(null);
  const [report, setReport] = useState<string | null>(null);
  useEffect(() => {
    void fetch("/hive-mind/report", { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : null))
      .then(setReport)
      .catch(() => setReport(null));
  }, []);
  const ask = async () => setRes(await getJson(`/hive-mind/query?q=${encodeURIComponent(q)}`));
  const label = (id: string) => res?.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="hive-query">
      <div className="row-actions">
        <input className="pinput" placeholder="e.g. SOL breakout, bee3, donchian…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void ask()} />
        <button className="pbtn" disabled={!q.trim()} onClick={() => void ask()}>
          Ask
        </button>
      </div>
      {res && (
        <div className="hq-result mono small">
          {res.focus.length === 0 ? (
            <p className="dim">Nothing in the graph matches those words.</p>
          ) : (
            res.edges.map((e, i) => (
              <div key={i} className={`hq-edge conf-${e.confidence.toLowerCase()}`}>
                <span>{label(e.src)}</span> <em>-{e.rel}-&gt;</em> <span>{label(e.dst)}</span> <span className="dim">w {e.w}</span> <b>{e.confidence}</b>
              </div>
            ))
          )}
        </div>
      )}
      {report && (
        <details className="hq-report">
          <summary>Hive report</summary>
          <pre className="mono small">{report}</pre>
        </details>
      )}
    </div>
  );
}
