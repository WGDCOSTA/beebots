// The Arena leaderboard: public, read-only, a season at a time, one league at a time. A league is a plan and a style,
// because Free and Pro never compete together. It shows only what owners chose to show: bot, style, public name, results.
import { useEffect, useMemo, useState } from "react";
import { fmtPct, leagueText, needSays, seasonEndsSay, STYLE_KEYS, type Need } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

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
  need: Need | null;
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

/** An avatar's colour, so a row glows in it (as the live board's rows do in each bunny's colour). */
const avColor = (themes: Theme[], theme: string, avatar: string) => themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar)?.color ?? "#888";

function Glyph({ themes, theme, avatar }: { themes: Theme[]; theme: string; avatar: string }) {
  const a = themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar);
  return (
    <span className="ab-portrait rk-glyph" style={{ ["--av" as string]: a?.color ?? "#888" }} aria-hidden>
      {a?.glyph ?? "?"}
    </span>
  );
}

export function ArenaRanking() {
  const { t, locale } = useI18n();
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
        if (alive) setError(t("rank.error"));
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [season, t]);

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
  if (!board) return <div className="pcard arena-card dim">{t("rank.loading")}</div>;
  if (!board.enabled) return <div className="pcard arena-card dim">{t("rank.closed")}</div>;

  return (
    <>
      <div className="pcard arena-card">
        <div className="arena-who">
          <div>
            <div className="eyebrow">{t("rank.season")}</div>
            <h3 className="rk-season">
              {board.season.id} <span className="dim small">{(() => { const e = board.season.current ? seasonEndsSay(board.season.end, now) : { key: "rank.finished" as const }; return t(e.key, "vars" in e ? e.vars : undefined); })()}</span>
            </h3>
          </div>
          {board.seasons.length > 1 && (
            <select className="pinput rk-select" aria-label={t("rank.season")} value={board.season.id} onChange={(e) => setSeason(e.target.value)}>
              {board.seasons.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="dim small">{t("rank.intro")}</p>
        <details className="rk-how">
          <summary>{t("rank.how.t")}</summary>
          <p className="small">{t("rank.how.b", { days: board.minimums.minDays, trades: board.minimums.minTrades })}</p>
        </details>
      </div>

      {board.leagues.length === 0 ? (
        <div className="pcard arena-card dim">{t("rank.empty")}</div>
      ) : (
        <>
          <div className="ab-chips rk-leagues">
            {board.leagues.map((l) => (
              <button key={l.id} className={`ab-chip ${active === l.id ? "on" : ""}`} aria-pressed={active === l.id} onClick={() => setLeague(l.id)}>
                {leagueText(l.id, t)} <small className="dim">{l.ranked}</small>
              </button>
            ))}
          </div>

          <div className="pcard arena-card">
            {ranked.length === 0 && <p className="dim">{t("rank.none")}</p>}
            {ranked.map((r) => (
              <div className={`rk-row ${r.mine ? "mine" : ""}`} key={r.botId} style={{ ["--av" as string]: avColor(themes, r.theme, r.avatar) }}>
                <span className={`rk-rank r${r.rank}`}>{r.rank}</span>
                <Glyph themes={themes} theme={r.theme} avatar={r.avatar} />
                <div className="rk-main">
                  <div>
                    <strong>{r.name}</strong> {r.mine && <span className="badge ok">{t("rank.you")}</span>}
                  </div>
                  <div className="dim small">
                    @{r.handle} · {r.style === "autonomous" ? t("style.auto.t") : STYLE_KEYS[r.style] ? t(STYLE_KEYS[r.style]!.title) : r.style} · v{r.version}
                  </div>
                  <div className="rk-stats small">
                    <span className={r.metrics!.returnPct >= 0 ? "good" : "bad"}>{fmtPct(r.metrics!.returnPct, locale)}</span>
                    <span title={t("rank.drawdownHelp")}>{t("rank.drawdown", { pct: r.metrics!.maxDrawdownPct.toFixed(1) })}</span>
                    <span>{t("rank.trades", { n: r.metrics!.trades })}</span>
                  </div>
                  <span className="rk-bar" aria-hidden>
                    <i className={r.metrics!.score >= 0 ? "up" : "down"} style={{ width: `${Math.max(4, (Math.abs(r.metrics!.score) / Math.max(1e-9, ...ranked.map((x) => Math.abs(x.metrics!.score)))) * 100)}%` }} />
                  </span>
                </div>
                <div className="rk-score" title={t("rank.scoreHelp")}>
                  <strong>{r.metrics!.score.toFixed(2)}</strong>
                  <span className="dim small">{t("rank.score")}</span>
                </div>
              </div>
            ))}
          </div>

          {waiting.length > 0 && (
            <div className="pcard arena-card">
              <h3>{t("rank.waiting")}</h3>
              {waiting.map((r) => (
                <div className={`rk-row wait ${r.mine ? "mine" : ""}`} key={r.botId} style={{ ["--av" as string]: avColor(themes, r.theme, r.avatar) }}>
                  <Glyph themes={themes} theme={r.theme} avatar={r.avatar} />
                  <div className="rk-main">
                    <div>
                      <strong>{r.name}</strong> {r.mine && <span className="badge ok">{t("rank.you")}</span>}
                    </div>
                    <div className="dim small">@{r.handle}</div>
                    <div className="dim small">{r.need ? needSays(r.need).map((m) => t(m.key, m.vars)).join(" · ") : ""}</div>
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
