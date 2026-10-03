// Historical data on the member's pages (Pro and Premium): a skill's backtest on the Skills page, and an agent's simulated
// training on its page. Both run on real OKX candles stored by the platform. Results are records of the past, said plainly:
// they are not the paper account, never reach the leaderboard, and promise nothing about what comes next.
import { useCallback, useEffect, useState } from "react";
import { arena } from "./arenaApi";
import { ArenaChart } from "./ArenaChart";
import type { ChartData } from "./arenaChart";
import { fmtPct, fmtUsd, pnlTone } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

const DAYS = [7, 14, 30] as const;

interface HistoryInfo {
  open: boolean;
  allowed: boolean;
  coins: Array<{ coin: string; from: number; to: number }>;
  backtests: { perDay: number; used: number };
}
export interface Backtest {
  skill: { id: string; name: string };
  coin: string;
  days: number;
  fromTs: number;
  toTs: number;
  startUsd: number;
  metrics: { returnPct: number; maxDrawdownPct: number; trades: number; winRatePct: number; profitFactor: number; exposurePct: number; feesPct: number; sharpe: number; benchmarkPct: number };
  equity: Array<[number, number]>;
  trades: Array<{ side: "long" | "short"; entryTs: number; exitTs: number; entryPx: number; exitPx: number; pnlUsd: number; retPct: number; reason: string }>;
  assumptions: { feePct: number; slippageBps: number; fundingPer8hPct: number; leverage: number };
}
export interface Training {
  id: string;
  createdAt: number;
  days: number;
  fromTs: number;
  toTs: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "budget";
  progress: number;
  startUsd: number;
  equityUsd: number | null;
  returnPct: number | null;
  maxDrawdownPct: number | null;
  trades: number;
  wins: number;
  decisions: number;
  benchmarkPct: number | null;
  benchmarkCoin: string;
  spentUsd: number;
  style: string;
  error: string | null;
}

const equityChart = (id: string, title: string, equity: Array<[number, number]>): ChartData => ({ id, kind: "equity", symbol: "", title, caption: "", overlays: [], panels: [], marks: [], levels: [], barMs: 3_600_000, series: null, equity });

function Tile({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rp-tile">
      <span className="dim small">{label}</span>
      <strong className={`num ${tone}`}>{value}</strong>
    </div>
  );
}

function Locked() {
  const { t } = useI18n();
  return (
    <p className="small">
      {t("hist.locked")} <a href="#/arena/plans">{t("plans.seeLocked")}</a>
    </p>
  );
}

const span = (from: number, to: number, locale: string) => {
  const f = (x: number) => new Date(x).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${f(from)} – ${f(to)}`;
};

/** A skill's backtest: pick a coin with history and a window, run it, see the curve and the numbers against buy and hold. */
export function SkillBacktest({ skillId, skillName }: { skillId: string; skillName: string }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const [coin, setCoin] = useState("");
  const [days, setDays] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [r, setR] = useState<Backtest | null>(null);
  useEffect(() => {
    void arena<HistoryInfo>("GET", "history").then((x) => {
      if (x.status !== 200) return;
      setInfo(x.data);
      setCoin((c) => c || x.data.coins[0]?.coin || "");
    }).catch(() => {});
  }, []);
  if (!info) return null;
  if (!info.allowed) return <Locked />;
  if (!info.open || info.coins.length === 0) return <p className="dim small">{t("hist.none")}</p>;
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const x = await arena<{ result: Backtest; used: number }>("POST", "skills/backtest", { skill: skillId, coin, days });
      if (x.status === 200) {
        setR(x.data.result);
        setInfo({ ...info, backtests: { ...info.backtests, used: x.data.used } });
      } else setError(x.data.error ?? t("err.save"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };
  const m = r?.metrics;
  return (
    <div className="hs">
      <div className="hs-form">
        <label className="small">
          {t("hist.coin")}{" "}
          <select className="pinput" value={coin} onChange={(e) => setCoin(e.target.value)}>
            {info.coins.map((c) => (
              <option key={c.coin}>{c.coin}</option>
            ))}
          </select>
        </label>
        <div className="hs-days" role="group" aria-label={t("hist.window")}>
          {DAYS.map((d) => (
            <button key={d} className={`pbtn ghost small ${days === d ? "on" : ""}`} aria-pressed={days === d} onClick={() => setDays(d)}>
              {t("hist.days", { n: d })}
            </button>
          ))}
        </div>
        <button className="pbtn small" disabled={busy || !coin || info.backtests.used >= info.backtests.perDay} onClick={() => void run()}>
          {busy ? t("hist.running") : t("hist.backtest")}
        </button>
      </div>
      <p className="dim small">{t("hist.left", { n: Math.max(0, info.backtests.perDay - info.backtests.used), max: info.backtests.perDay })}</p>
      {error && <p className="bad small">{error}</p>}
      {r && m && (
        <div className="hs-result">
          <p className="small">
            <strong>{t("hist.btTitle", { skill: skillName, coin: r.coin })}</strong> <span className="dim">· {span(r.fromTs, r.toTs, locale)} · {t("hist.hourly")}</span>
          </p>
          <div className="rp-tiles">
            <Tile label={t("hist.return")} value={fmtPct(m.returnPct, locale)} tone={pnlTone(m.returnPct)} />
            <Tile label={t("hist.hold", { coin: r.coin })} value={fmtPct(m.benchmarkPct, locale)} tone={pnlTone(m.benchmarkPct)} />
            <Tile label={t("hist.maxdd")} value={fmtPct(-m.maxDrawdownPct, locale)} tone={m.maxDrawdownPct > 0 ? "bad" : ""} />
            <Tile label={t("hist.trades")} value={String(m.trades)} />
            <Tile label={t("hist.winRate")} value={m.trades ? `${Math.round(m.winRatePct)}%` : "—"} />
            <Tile label={t("hist.inMarket")} value={`${Math.round(m.exposurePct)}%`} />
            <Tile label={t("hist.fees")} value={fmtPct(-m.feesPct, locale)} />
            <Tile label={t("hist.pf")} value={m.trades ? m.profitFactor.toFixed(2) : "—"} />
          </div>
          <ArenaChart chart={equityChart("bt", t("hist.curve", { usd: fmtUsd(r.startUsd, locale) }), r.equity)} />
          {r.trades.length > 0 && (
            <details>
              <summary className="small">{t("hist.lastTrades", { n: r.trades.length })}</summary>
              <ul className="ag-trades">
                {r.trades.map((x, i) => (
                  <li key={i}>
                    <span>
                      <strong>{t(x.side === "short" ? "side.short" : "side.long")}</strong> {new Date(x.entryTs).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", timeZone: "UTC", hour12: false })}
                    </span>
                    <span className={`num ${pnlTone(x.pnlUsd)}`}>{fmtUsd(x.pnlUsd, locale, true)}</span>
                    <span className="dim small">{fmtPct(x.retPct, locale)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className="dim small">{t("hist.btAssume", { fee: r.assumptions.feePct, slip: r.assumptions.slippageBps, funding: r.assumptions.fundingPer8hPct })}</p>
          <p className="dim small">{t("hist.past")}</p>
        </div>
      )}
    </div>
  );
}

const STATUS_KEY = { queued: "train.st.queued", running: "train.st.running", done: "train.st.done", failed: "train.st.failed", cancelled: "train.st.cancelled", budget: "train.st.budget" } as const;

/** An agent's simulated trainings: start one over 7, 14 or 30 days of history, follow it, and read its record. */
export function AgentTraining({ id, name }: { id: string; name: string }) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<{ open: boolean; allowed: boolean; perDay: number; used: number; trainings: Training[] } | null>(null);
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ training: Training; insights: { equity: Array<[number, number]>; closedTrades: number; winningTrades: number } | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await arena<{ open: boolean; allowed: boolean; perDay: number; used: number; trainings: Training[] }>("GET", `bots/train?id=${encodeURIComponent(id)}`);
      if (r.status === 200) setState(r.data);
    } catch {
      /* keeps what it shows */
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = state?.trainings.some((x) => x.status === "queued" || x.status === "running") ?? false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [live, load]);
  const first = state?.trainings.find((x) => x.status !== "queued" && x.status !== "running");
  const show = sel ?? first?.id ?? null;
  const shownStatus = state?.trainings.find((x) => x.id === show)?.status;
  useEffect(() => {
    if (!show || shownStatus === "queued" || shownStatus === "running") return setDetail(null);
    void arena<{ training: Training; insights: { equity: Array<[number, number]>; closedTrades: number; winningTrades: number } | null }>("GET", `bots/train/detail?id=${encodeURIComponent(show)}`)
      .then((r) => r.status === 200 && setDetail(r.data))
      .catch(() => {});
  }, [show, shownStatus]);

  if (!state) return null;
  if (!state.allowed)
    return (
      <div className="hs">
        <p className="dim small">{t("train.intro", { name })}</p>
        <Locked />
      </div>
    );
  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena<{ training: Training }>("POST", "bots/train/start", { id, days });
      if (r.status === 200) {
        setSel(null);
        await load();
      } else setError(r.data.error ?? t("err.save"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (tid: string) => {
    await arena("POST", "bots/train/cancel", { id: tid }).catch(() => {});
    await load();
  };
  const d = detail?.training;
  return (
    <div className="hs">
      <p className="dim small">{t("train.intro", { name })}</p>
      {!state.open && <p className="bad small">{t("train.closed")}</p>}
      <div className="hs-form">
        <div className="hs-days" role="group" aria-label={t("hist.window")}>
          {DAYS.map((x) => (
            <button key={x} className={`pbtn ghost small ${days === x ? "on" : ""}`} aria-pressed={days === x} onClick={() => setDays(x)}>
              {t("hist.days", { n: x })}
            </button>
          ))}
        </div>
        <button className="pbtn" disabled={busy || live || !state.open || state.used >= state.perDay} onClick={() => void start()}>
          {t("train.start")}
        </button>
      </div>
      <p className="dim small">{t("train.left", { n: Math.max(0, state.perDay - state.used), max: state.perDay })}</p>
      {error && <p className="bad small">{error}</p>}

      {state.trainings.length > 0 && (
        <ul className="hs-list">
          {state.trainings.map((x) => (
            <li key={x.id} className={x.id === show ? "on" : ""}>
              <button className="hs-row" onClick={() => setSel(x.id)}>
                <span>
                  <strong>{t("hist.days", { n: x.days })}</strong> <span className="dim small">{span(x.fromTs, x.toTs, locale)}</span>
                </span>
                <span className={`small ${x.status === "failed" ? "bad" : ""}`}>
                  {x.status === "running" ? t("train.st.progress", { n: Math.round(x.progress * 100) }) : t(STATUS_KEY[x.status])}
                </span>
                <span className={`num ${pnlTone(x.returnPct ?? 0)}`}>{x.returnPct !== null ? fmtPct(x.returnPct, locale) : "·"}</span>
              </button>
              {(x.status === "running" || x.status === "queued") && (
                <div className="hs-bar">
                  <div style={{ width: `${Math.round(x.progress * 100)}%` }} />
                  <button className="linkbtn small" onClick={() => void cancel(x.id)}>
                    {t("train.cancel")}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {d && (
        <div className="hs-result">
          {d.error && <p className="rp-warn small">{d.status === "budget" ? t("train.budgetHelp") : d.error}</p>}
          <div className="rp-tiles">
            <Tile label={t("hist.return")} value={d.returnPct !== null ? fmtPct(d.returnPct, locale) : "—"} tone={pnlTone(d.returnPct ?? 0)} />
            <Tile label={t("hist.hold", { coin: d.benchmarkCoin })} value={d.benchmarkPct !== null ? fmtPct(d.benchmarkPct, locale) : "—"} tone={pnlTone(d.benchmarkPct ?? 0)} />
            <Tile label={t("hist.maxdd")} value={d.maxDrawdownPct !== null ? fmtPct(-d.maxDrawdownPct, locale) : "—"} tone={d.maxDrawdownPct ? "bad" : ""} />
            <Tile label={t("train.closedTrades")} value={String(d.trades)} />
            <Tile label={t("hist.winRate")} value={d.trades ? `${Math.round((d.wins / d.trades) * 100)}%` : "—"} />
            <Tile label={t("train.decisions")} value={String(d.decisions)} />
            <Tile label={t("train.end")} value={d.equityUsd !== null ? fmtUsd(d.equityUsd, locale) : "—"} />
            <Tile label={t("train.spent")} value={`$${d.spentUsd.toFixed(3)}`} />
          </div>
          {detail?.insights && detail.insights.equity.length > 2 && <ArenaChart chart={equityChart("tr", t("hist.curve", { usd: fmtUsd(d.startUsd, locale) }), detail.insights.equity)} />}
          <p className="dim small">{t("train.how")}</p>
          <p className="dim small">{t("hist.past")}</p>
        </div>
      )}
    </div>
  );
}
