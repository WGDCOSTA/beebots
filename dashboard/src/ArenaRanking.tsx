// The Arena leaderboard: public, read-only, a season at a time, one league at a time. A league is a plan and a style,
// because Free and Pro never compete together. It shows only what owners chose to show: bot, style, public name, results.
import { useEffect, useMemo, useState } from "react";
import { leagueLabel, pctText, seasonEnds, STYLE_LABEL } from "./arenaModel";

interface Metrics {
  samples: number;
  days: number;
  returnPct: number;
  maxDrawdownPct: number;
  sharpe: number | null;
  trades: number;
  score: number;
}
interface Row {
  rank: number | null;
  botId: string;
  name: string;
  handle: string;
  theme: string;
  avatar: string;
  style: string;
  tier: string;
  version: number;
  league: string;
  metrics: Metrics | null;
  reason: string | null;
  mine: boolean;
}
interface Board {
  enabled: boolean;
  season: { id: string; start: number; end: number; current: boolean };
  seasons: string[];
  leagues: Array<{ id: string; ranked: number; waiting: number }>;
  minimums: { minDays: number; minTrades: number; minSamples: number };
  rows: Row[];
}
interface Theme {
  id: string;
  avatars: Array<{ id: string; glyph: string; color: string }>;
}

function Glyph({ themes, theme, avatar }: { themes: Theme[]; theme: string; avatar: string }) {
  const a = themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar);
  return (
    <span className="ab-portrait rk-glyph" style={{ ["--av" as string]: a?.color ?? "#888" }} aria-hidden>
      {a?.glyph ?? "?"}
    </span>
  );
}

export function ArenaRanking() {
  const [board, setBoard] = useState<Board | null>(null);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [season, setSeason] = useState<string | undefined>(undefined);
  const [league, setLeague] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/arena/leaderboard${season ? `?season=${season}` : ""}`, { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as Board;
        if (alive) {
          setBoard(j);
          setError("");
          setNow(Date.now());
        }
      } catch {
        if (alive) setError("The leaderboard is not reachable right now.");
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [season]);

  useEffect(() => {
    void fetch("/arena/catalogue")
      .then((r) => r.json())
      .then((j: { themes: Theme[] }) => setThemes(j.themes))
      .catch(() => {});
  }, []);

  // Open on the league of the viewer's own agent if they have one, else the first league.
  const active = useMemo(() => league ?? board?.rows?.find((r) => r.mine)?.league ?? board?.leagues?.[0]?.id ?? null, [league, board]);
  const rows = useMemo(() => (board?.rows ?? []).filter((r) => r.league === active), [board, active]);
  const ranked = rows.filter((r) => r.rank !== null);
  const waiting = rows.filter((r) => r.rank === null);

  if (error) return <div className="pcard arena-card"><p className="bad">{error}</p></div>;
  if (!board) return <div className="pcard arena-card dim">Loading the leaderboard…</div>;
  if (!board.enabled) return <div className="pcard arena-card dim">The leaderboard is not open yet.</div>;

  return (
    <>
      <div className="pcard arena-card">
        <div className="arena-who">
          <div>
            <div className="eyebrow">Season</div>
            <h3 className="rk-season">
              {board.season.id} <span className="dim small">{board.season.current ? seasonEnds(board.season.end, now) : "Finished"}</span>
            </h3>
          </div>
          {board.seasons.length > 1 && (
            <select className="pinput rk-select" aria-label="Season" value={board.season.id} onChange={(e) => setSeason(e.target.value)}>
              {board.seasons.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="dim small">Everyone starts with the same paper money on the same prices. Free and Pro race in separate leagues, and each style has its own. Simulated money only.</p>
        <details className="rk-how">
          <summary>How the score works</summary>
          <p className="small">
            Score = return % minus half of the worst drop from a peak (max drawdown) %. An agent that earns a lot by risking a lot loses points for its deep drops.
            To be ranked an agent needs at least {board.minimums.minDays} days of history, {board.minimums.minTrades} trades and enough samples, so a lucky hour does not count. Open positions and rules are never shown.
            Changing an agent's rules starts a fresh account, and its ranking starts over.
          </p>
        </details>
      </div>

      {board.leagues.length === 0 ? (
        <div className="pcard arena-card dim">Nobody is on the board yet. Create an agent in the Arena and leave "Show on the leaderboard" ticked.</div>
      ) : (
        <>
          <div className="ab-chips rk-leagues">
            {board.leagues.map((l) => (
              <button key={l.id} className={`ab-chip ${active === l.id ? "on" : ""}`} aria-pressed={active === l.id} onClick={() => setLeague(l.id)}>
                {leagueLabel(l.id)} <small className="dim">{l.ranked}</small>
              </button>
            ))}
          </div>

          <div className="pcard arena-card">
            {ranked.length === 0 && <p className="dim">No agent is ranked in this league yet.</p>}
            {ranked.map((r) => (
              <div className={`rk-row ${r.mine ? "mine" : ""}`} key={r.botId}>
                <span className={`rk-rank r${r.rank}`}>{r.rank}</span>
                <Glyph themes={themes} theme={r.theme} avatar={r.avatar} />
                <div className="rk-main">
                  <div>
                    <strong>{r.name}</strong> {r.mine && <span className="badge ok">You</span>}
                  </div>
                  <div className="dim small">
                    @{r.handle} · {STYLE_LABEL[r.style]?.label ?? r.style} · v{r.version}
                  </div>
                  <div className="rk-stats small">
                    <span className={r.metrics!.returnPct >= 0 ? "good" : "bad"}>{pctText(r.metrics!.returnPct)}</span>
                    <span title="Worst drop from a peak">drawdown {r.metrics!.maxDrawdownPct.toFixed(1)}%</span>
                    <span>{r.metrics!.trades} trades</span>
                  </div>
                </div>
                <div className="rk-score" title="Return minus half the drawdown">
                  <strong>{r.metrics!.score.toFixed(2)}</strong>
                  <span className="dim small">score</span>
                </div>
              </div>
            ))}
          </div>

          {waiting.length > 0 && (
            <div className="pcard arena-card">
              <h3>Not ranked yet</h3>
              {waiting.map((r) => (
                <div className={`rk-row wait ${r.mine ? "mine" : ""}`} key={r.botId}>
                  <Glyph themes={themes} theme={r.theme} avatar={r.avatar} />
                  <div className="rk-main">
                    <div>
                      <strong>{r.name}</strong> {r.mine && <span className="badge ok">You</span>}
                    </div>
                    <div className="dim small">@{r.handle}</div>
                    <div className="dim small">{r.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
