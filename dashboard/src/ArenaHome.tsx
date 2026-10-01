// The Arena home: the member's agents as cards (state, paper account, small curve), the season, a getting-started list that
// ticks itself from real data, the plan's quota, and Pause all. Pausing keeps positions under their stops and opens nothing new.
import { useEffect, useState } from "react";
import { arena, type Limits } from "./arenaApi";
import { checklist, fmtPct, fmtUsd, pnlTone, quarantineDaysLeft, seasonEndsSay, STYLE_KEYS, type RunStatus } from "./arenaModel";
import { ArenaOverview, useArenaLive } from "./ArenaOverview";
import { avatarColor, Portrait, Spark, StatePill, useFlash, type Agent, type ArenaData } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

interface Standing {
  season: { id: string; end: number; current: boolean };
  minimums: { minDays: number; minTrades: number };
  rows: Array<{ botId: string; rank: number | null; league: string; mine: boolean }>;
}

const HIDE_KEY = "arena_checklist_hidden";
const hidden = (): boolean => {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
};

export function ArenaHome({ data, limits, days }: { data: ArenaData; limits: Limits; days: number }) {
  const { t, locale } = useI18n();
  const [board, setBoard] = useState<Standing | null>(null);
  const [hide, setHide] = useState(hidden);
  const [busy, setBusy] = useState(false);
  const { agents, runner, cat } = data;
  const live = useArenaLive();
  const styleLabel = (st: string) => (STYLE_KEYS[st] ? t(STYLE_KEYS[st]!.title) : st);

  useEffect(() => {
    void arena<Standing & { enabled?: boolean }>("GET", "leaderboard").then((r) => setBoard(r.status === 200 && r.data.rows ? r.data : null)).catch(() => setBoard(null));
  }, []);

  const ends = board ? seasonEndsSay(board.season.end, Date.now()) : null;
  const mine = board?.rows.filter((r) => r.mine && r.rank !== null) ?? [];
  const best = mine.sort((a, b) => a.rank! - b.rank!)[0];
  const decisions = agents.reduce((n, a) => n + (runner.runs[a.id]?.decisions ?? 0), 0);
  const steps = checklist(agents.length, decisions, mine.length > 0);
  const allDone = steps.every((s) => s.done);
  const anyRunning = agents.some((a) => a.state === "running");
  const anyPaused = agents.some((a) => a.state === "paused");
  const full = agents.length >= limits.bots;
  const quarantined = agents.filter((a) => a.state === "quarantined");

  const pauseAll = async (to: "pause" | "resume") => {
    setBusy(true);
    try {
      await arena("POST", "bots/state-all", { to });
      await data.reload();
    } finally {
      setBusy(false);
    }
  };
  const open = (hash: string) => () => {
    location.hash = hash;
  };

  return (
    <>
      <div className="arena-who">
        <h1 className="as-title">{t("home.title")}</h1>
        {agents.length > 0 && (
          <span className="dim small">
            {t("home.quota", { n: agents.length, max: limits.bots })}
          </span>
        )}
      </div>

      {board && (
        <div className="ag-season">
          <span>
            <strong>{t("home.season", { id: board.season.id })}</strong> <span className="dim small">{ends && t(ends.key, ends.vars)}</span>
          </span>
          <span className="small">{best ? t("home.rank", { rank: best.rank!, league: best.league.replace(":", " · ") }) : t("home.unranked", { days: board.minimums.minDays, trades: board.minimums.minTrades })}</span>
        </div>
      )}

      {quarantined.length > 0 && (
        <div className="pcard arena-card ag-quarantine" role="status">
          <h3>{t("home.quarantine.title")}</h3>
          <p>{t("home.quarantine.body", { days })}</p>
          <a className="pbtn" href="#/arena/plans">
            {t("home.quarantine.cta")}
          </a>
        </div>
      )}

      {agents.length > 0 && !allDone && !hide && (
        <div className="pcard arena-card ag-check">
          <div className="arena-who">
            <h3>{t("home.check.title")}</h3>
            <button
              className="linkbtn"
              onClick={() => {
                setHide(true);
                try {
                  localStorage.setItem(HIDE_KEY, "1");
                } catch {
                  /* the list simply comes back next visit */
                }
              }}
            >
              {t("home.check.hide")}
            </button>
          </div>
          <ul>
            {steps.map((s) => (
              <li key={s.key} className={s.done ? "done" : ""}>
                <span aria-hidden>{s.done ? "✓" : "○"}</span> {t(s.key)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {agents.length === 0 && (
        <div className="pcard arena-card ag-empty">
          <h3>{t("home.empty.title")}</h3>
          <p className="dim">{t("home.empty.body")}</p>
          <div className="arena-actions">
            <button className="pbtn" onClick={open("#/arena/new")}>
              {t("home.empty.cta")}
            </button>
          </div>
        </div>
      )}

      <ArenaOverview
        agents={agents}
        cat={cat}
        live={live}
        styleLabel={styleLabel}
        after={
          <>
        {/* Agents not running right now (queued, paused before start, stopped, in quarantine) keep their card. */}
        {agents.filter((a) => !live[a.id]).map((a) => (
          <AgentCard key={a.id} a={a} data={data} days={days} />
        ))}
        {agents.length > 0 && (
          <button className="pcard arena-card ag-card ag-new" disabled={full} onClick={open("#/arena/new")}>
            <span className="ag-plus" aria-hidden>
              +
            </span>
            <strong>{t("nav.new")}</strong>
            {full && <span className="dim small">{t(limits.bots === 1 ? "home.quotaFull1" : "home.quotaFull", { n: limits.bots })}</span>}
          </button>
        )}
          </>
        }
      />

      <div className="arena-actions">
        <a className="pbtn ghost" href="#/arena/skills">
          {t("skills.link", { n: data.skills.skills.length, max: data.skills.slots })}
        </a>
      </div>

      {agents.length > 0 && (
        <div className="arena-actions">
          {anyRunning && (
            <button className="pbtn ghost" disabled={busy} title={t("home.pauseHelp")} onClick={() => void pauseAll("pause")}>
              {t("home.pauseAll")}
            </button>
          )}
          {anyPaused && (
            <button className="pbtn ghost" disabled={busy} onClick={() => void pauseAll("resume")}>
              {t("home.resumeAll")}
            </button>
          )}
        </div>
      )}
      <p className="dim small">{t("home.paperNote")}</p>
    </>
  );
}

/** One agent on Home: its avatar's glow, its paper account flashing green or red when it moves, its curve. */
function AgentCard({ a, data, days }: { a: Agent; data: ArenaData; days: number }) {
  const { t, locale } = useI18n();
  const { cat, runner } = data;
  const run: RunStatus | undefined = runner.runs[a.id];
  const pnl = run?.pnlUsd;
  const tone = pnlTone(pnl);
  const pos = run?.position;
  const flash = useFlash(run?.equityUsd);
  return (
            <a className={`pcard arena-card ag-card ${flash ? `flash-${flash}` : ""}`} href={`#/arena/agent/${a.id}`} style={{ ["--av" as string]: avatarColor(cat, a.theme, a.avatar) }}>
              <div className="ag-card-top">
                <Portrait cat={cat} theme={a.theme} avatar={a.avatar} botId={a.image ? a.id : undefined} size={44} />
                <div className="ag-card-name">
                  <strong>{a.name}</strong>
                  <span className="dim small">
                    {a.listed ? t("card.listed") : t("card.private")} · v{a.version}
                  </span>
                </div>
                <StatePill enabled={runner.enabled} state={a.state} run={run} />
              </div>
              <div className="ag-card-nums">
                <div>
                  <div className="num ag-big">{run?.equityUsd !== undefined ? fmtUsd(run.equityUsd, locale) : "—"}</div>
                  <div className={`num small ${tone}`}>{run?.pnlPct !== undefined ? `${fmtPct(run.pnlPct, locale)} · ${fmtUsd(pnl ?? 0, locale, true)}` : t("card.starting")}</div>
                </div>
                <Spark values={data.curves[a.id] ?? []} tone={tone} />
              </div>
              <div className="dim small">{a.state === "quarantined" ? t("card.quarantineLeft", { n: quarantineDaysLeft(a.quarantinedAt, Date.now(), days) }) : pos ? t("card.holding", { side: t(pos.side === "short" ? "side.short" : "side.long"), coin: pos.coin }) : t("card.flat")}</div>
            </a>
  );
}
