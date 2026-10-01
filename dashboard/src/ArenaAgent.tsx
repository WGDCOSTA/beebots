// One agent's page: its state and the buttons that change it (pause, resume, stop, start again), then four tabs:
// Performance (curve, numbers, trades), Decisions (facts), Versions (what each run was), Settings.
// Pause keeps the position under its stop and opens nothing new. Stop closes the position and ends this run.
import { useCallback, useEffect, useState } from "react";
import { arena, type Limits } from "./arenaApi";
import { fmtPct, fmtUsd, pnlTone, quarantineDaysLeft, sparkPath, STYLE_KEYS, styleTitleKey } from "./arenaModel";
import { ArenaDecisions, useAgo, type DecisionFact } from "./ArenaDecisions";
import { ArenaSettings } from "./ArenaSettings";
import { Portrait, StatePill, type ArenaData } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

interface Trade {
  ts: number;
  coin: string;
  side: "buy" | "sell";
  sizeUsd: number;
  feeUsd: number;
  realisedUsd: number;
}
interface Insights {
  equity: Array<[number, number]>;
  maxDrawdownPct: number;
  decisions: DecisionFact[];
  trades: Trade[];
  closedTrades: number;
  winningTrades: number;
}
interface Version {
  version: number;
  style: string;
  coins: string[];
  rules: string;
  createdAt: number;
}
interface Standing {
  rows: Array<{ botId: string; rank: number | null; league: string; mine: boolean }>;
}

const TABS = ["performance", "decisions", "versions", "settings"] as const;
type Tab = (typeof TABS)[number];

function Curve({ points, start }: { points: Array<[number, number]>; start: number }) {
  const { t } = useI18n();
  const values = points.map((p) => p[1]);
  const d = sparkPath(values, 600, 150, 6, start * 0.01);
  if (!d) return <p className="dim small">{t("perf.noCurve")}</p>;
  const last = values[values.length - 1]!;
  return (
    <svg className={`ag-curve ${pnlTone(last - start)}`} viewBox="0 0 600 150" role="img" aria-label={t("perf.curve")}>
      <path d={d} fill="none" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function ArenaAgent({ data, limits, days, id, onGone }: { data: ArenaData; limits: Limits; days: number; id: string; onGone: () => void }) {
  const { t, locale } = useI18n();
  const ago = useAgo();
  const agent = data.agents.find((a) => a.id === id);
  const [tab, setTab] = useState<Tab>("performance");
  const [ins, setIns] = useState<Insights | null>(null);
  const [styles, setStyles] = useState<Array<{ ts: number; style: string; reason: string; changed: boolean }>>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [rank, setRank] = useState<{ rank: number; league: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadInsights = useCallback(async () => {
    try {
      const r = await arena<{ insights: Insights | null; styleLog?: Array<{ ts: number; style: string; reason: string; changed: boolean }> }>("GET", `bots/insights?id=${encodeURIComponent(id)}`);
      if (r.status === 200) {
        setIns(r.data.insights);
        setStyles(r.data.styleLog ?? []);
      }
    } catch {
      /* the page keeps showing what it has */
    }
  }, [id]);
  useEffect(() => {
    void loadInsights();
    const timer = setInterval(() => void loadInsights(), 15_000);
    return () => clearInterval(timer);
  }, [loadInsights, agent?.version, agent?.state]);
  useEffect(() => {
    void arena<{ versions: Version[] }>("POST", "bots/versions", { id }).then((r) => setVersions(r.data.versions ?? [])).catch(() => {});
  }, [id, agent?.version]);
  useEffect(() => {
    void arena<Standing>("GET", "leaderboard").then((r) => {
      const row = r.data.rows?.find((x) => x.mine && x.botId === id && x.rank !== null);
      setRank(row ? { rank: row.rank!, league: row.league.replace(":", " · ") } : null);
    }).catch(() => {});
  }, [id]);

  if (!agent)
    return (
      <div className="pcard arena-card">
        <p className="dim">{t("agent.missing")}</p>
        <a className="pbtn ghost" href="#/arena">
          {t("agent.back")}
        </a>
      </div>
    );

  const skillName = data.skills.skills.find((s) => s.id === agent.skill)?.name ?? null;
  const run = data.runner.runs[id];
  const pnl = run?.pnlUsd;
  const tone = pnlTone(pnl);
  const act = async (to: "pause" | "resume" | "stop" | "again") => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "bots/state", { id, to });
      if (r.status !== 200) setError(r.data.error ?? t("err.save"));
      setConfirmStop(false);
      await data.reload();
      await loadInsights();
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a className="linkbtn ag-back" href="#/arena">
        ← {t("agent.back")}
      </a>
      <div className="pcard arena-card ag-head">
        <div className="ag-card-top">
          <Portrait cat={data.cat} theme={agent.theme} avatar={agent.avatar} botId={agent.image ? agent.id : undefined} size={56} />
          <div className="ag-card-name">
            <h1 className="as-title ag-name">{agent.name}</h1>
            <span className="dim small">
              {agent.tagline && `${agent.tagline} · `}
              {t(styleTitleKey(agent.mode, agent.style))}{agent.mode === "skill" && skillName ? `: ${skillName}` : ""}
              {agent.mode === "autonomous" && run?.style ? ` (${t("auto.now", { style: t(STYLE_KEYS[run.style]?.title ?? "style.breezy.t") })})` : ""} · v{agent.version}
            </span>
          </div>
          <StatePill enabled={data.runner.enabled} state={agent.state} run={run} />
        </div>
        <div className="ag-card-nums">
          <div>
            <div className="num ag-big">{run?.equityUsd !== undefined ? fmtUsd(run.equityUsd, locale) : "—"}</div>
            <div className={`num small ${tone}`}>{run?.pnlPct !== undefined ? `${fmtPct(run.pnlPct, locale)} · ${fmtUsd(pnl ?? 0, locale, true)}` : t("card.starting")}</div>
          </div>
        </div>

        {agent.state === "quarantined" && (
          <div className="ag-confirm" role="status">
            <p>{t("agent.quarantine", { n: quarantineDaysLeft(agent.quarantinedAt, Date.now(), days) })}</p>
            <a className="pbtn" href="#/arena/plans">
              {t("home.quarantine.cta")}
            </a>
          </div>
        )}
        {agent.state !== "stopped" && agent.state !== "quarantined" && !confirmStop && (
          <div className="arena-actions">
            {agent.state === "running" && (
              <button className="pbtn ghost" disabled={busy} title={t("act.pauseHelp")} onClick={() => void act("pause")}>
                {t("act.pause")}
              </button>
            )}
            {agent.state === "paused" && (
              <button className="pbtn" disabled={busy} onClick={() => void act("resume")}>
                {t("act.resume")}
              </button>
            )}
            <button className="pbtn ghost" disabled={busy} title={t("act.stopHelp")} onClick={() => setConfirmStop(true)}>
              {t("act.stop")}
            </button>
          </div>
        )}
        {agent.state === "paused" && <p className="dim small">{t("act.pauseHelp")}</p>}
        {confirmStop && (
          <div className="ag-confirm" role="alertdialog" aria-label={t("act.stop")}>
            <p>{t("act.stopConfirm", { name: agent.name })}</p>
            <p className="dim small">{t("act.stopHelp")}</p>
            <div className="arena-actions">
              <button className="pbtn danger" disabled={busy} onClick={() => void act("stop")}>
                {t("act.stopYes")}
              </button>
              <button className="linkbtn" onClick={() => setConfirmStop(false)}>
                {t("new.cancel")}
              </button>
            </div>
          </div>
        )}
        {agent.state === "stopped" && (
          <div className="arena-actions">
            <button className="pbtn" disabled={busy} onClick={() => void act("again")}>
              {t("act.again")}
            </button>
            <span className="dim small">{t("act.againHelp")}</span>
          </div>
        )}
        {error && <p className="bad">{error}</p>}
      </div>

      <div className="ag-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : ""} onClick={() => setTab(x)}>
            {t(`agent.tab.${x}` as const)}
          </button>
        ))}
      </div>

      <div className="pcard arena-card" role="tabpanel">
        {tab === "performance" && (
          <>
            <Curve points={ins?.equity ?? []} start={run?.startEquityUsd ?? 1000} />
            <div className="ag-stats">
              <div>
                <span className="dim small">{t("perf.return")}</span>
                <strong className={`num ${tone}`}>{run?.pnlPct !== undefined ? fmtPct(run.pnlPct, locale) : "—"}</strong>
              </div>
              <div>
                <span className="dim small">{t("perf.drawdown")}</span>
                <strong className="num">{ins ? fmtPct(-ins.maxDrawdownPct, locale) : "—"}</strong>
              </div>
              <div>
                <span className="dim small">{t("perf.trades")}</span>
                <strong className="num">{ins ? ins.closedTrades : "—"}</strong>
              </div>
              <div>
                <span className="dim small">{t("perf.win")}</span>
                <strong className="num">{ins && ins.closedTrades > 0 ? `${Math.round((ins.winningTrades / ins.closedTrades) * 100)}%` : "—"}</strong>
              </div>
              <div>
                <span className="dim small">{t("perf.decisions")}</span>
                <strong className="num">{run?.decisions ?? "—"}</strong>
              </div>
              <div>
                <span className="dim small">{t("perf.spent")}</span>
                <strong className="num">{run?.spentUsd !== undefined ? fmtUsd(run.spentUsd, locale) : "—"}</strong>
              </div>
            </div>
            <p className="small">
              {!agent.listed ? t("perf.private") : rank ? t("perf.rank", { rank: rank.rank, league: rank.league }) : t("perf.unranked")}
            </p>
            <div className="eyebrow">{t("perf.position")}</div>
            <p className="small">{run?.position ? `${t(run.position.side === "short" ? "side.short" : "side.long")} ${run.position.coin}${run.position.sizeUsd !== null ? ` ${fmtUsd(run.position.sizeUsd, locale)}` : ""} · ${fmtUsd(run.position.uplUsd, locale, true)}` : t("perf.flat")}</p>
            {run?.capped && <p className="dim small">{t("perf.capped")}</p>}
            <div className="eyebrow">{t("perf.recent")}</div>
            {ins && ins.trades.length > 0 ? (
              <ul className="ag-trades">
                {ins.trades.slice(0, 12).map((x, i) => (
                  <li key={`${x.ts}-${i}`}>
                    <span>
                      <strong>{t(x.side === "buy" ? "trade.buy" : "trade.sell")}</strong> {x.coin} {fmtUsd(x.sizeUsd, locale)}
                    </span>
                    <span className={`num ${pnlTone(x.realisedUsd)}`}>{x.realisedUsd !== 0 ? fmtUsd(x.realisedUsd, locale, true) : "·"}</span>
                    <span className="dim small">{ago(x.ts)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dim small">{t("perf.noTrades")}</p>
            )}
          </>
        )}
        {tab === "decisions" && <ArenaDecisions decisions={ins?.decisions ?? []} styles={agent.mode === "autonomous" ? styles : null} brains={agent.brains.length} />}
        {tab === "versions" && (
          <>
            <p className="dim small">{t("ver.intro")}</p>
            <ul className="ag-versions">
              {versions.map((v) => (
                <li key={v.version}>
                  <div>
                    <strong>v{v.version}</strong> {v.version === agent.version && <span className="ag-pill run">{t("ver.current")}</span>} <span className="dim small">{t("ver.started", { when: new Date(v.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) })}</span>
                  </div>
                  <div className="small">
                    {t(styleTitleKey(agent.mode, v.style))} · {agent.mode === "autonomous" ? t("coins.any") : v.coins.join(", ")}
                  </div>
                  <div className="ab-rules-preview small">{v.rules}</div>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "settings" && agent.state !== "quarantined" && <ArenaSettings data={data} limits={limits} agent={agent} onGone={onGone} />}
      </div>
    </>
  );
}
