// The admin panel's "Arena" tab: every member's agents in one table, with their paper results, and the operator's
// controls: pause, resume or stop one agent, or every agent at once. Served by the engine's /admin/arena/*, which relays to
// the Arena's /ops/* inside the Docker network (arena/ops.ts). It shows public names, agents and results; never keys,
// rules text or e-mail addresses.
import { useCallback, useEffect, useMemo, useState } from "react";
import { adminCall } from "./panelTypes";

interface OpsAgent {
  userId: string;
  handle: string;
  tier: string;
  botId: string;
  name: string;
  mode: string;
  style: string;
  coins: string[];
  listed: boolean;
  version: number;
  brains: number;
  state: "running" | "paused" | "stopped" | "quarantined";
  run: { state: string; equityUsd: number | null; startUsd: number | null; pnlPct: number | null; decisions: number | null; spentUsd: number | null; position: string | null } | null;
}
interface OpsView {
  members: number;
  agents: OpsAgent[];
  states: Record<string, number>;
  running: number;
  at: number;
}

const HOUSE = ["glitchbunny", "glitchbunny-labs"];
const usd = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `$${x.toFixed(2)}`);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}%`);

export function AdminArenaTab({ password }: { password: string }) {
  const [view, setView] = useState<OpsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<"all" | "house" | "members">("all");
  const [confirmAll, setConfirmAll] = useState<"stop" | null>(null);
  const [confirmOne, setConfirmOne] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await adminCall<OpsView>("arena/agents", password));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [password]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: "pause" | "resume" | "stop", target: { all: true } | { userId: string; botId: string }) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await adminCall<OpsView & { changed: number; skipped: string[] }>("arena/state", password, { action, ...target });
      setView(r);
      setNote(`${r.changed} agent${r.changed === 1 ? "" : "s"} ${action === "pause" ? "paused" : action === "resume" ? "resumed" : "stopped"}${r.skipped.length ? ` · ${r.skipped.length} skipped (already in that state or stopped)` : ""}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirmAll(null);
      setConfirmOne(null);
    }
  };

  const rows = useMemo(() => (view?.agents ?? []).filter((a) => who === "all" || (who === "house") === HOUSE.includes(a.handle)), [view, who]);
  if (error && !view) return <div className="pcard"><p className="bad">{error}</p></div>;
  if (!view) return <div className="pcard dim">Loading the Arena…</div>;
  const equity = rows.reduce((a, x) => a + (x.run?.equityUsd ?? 0), 0);
  const start = rows.reduce((a, x) => a + (x.run?.startUsd ?? 0), 0);

  return (
    <>
      <div className="pcard">
        <h3>Arena</h3>
        <p className="dim small">Every member's agents, paper money only. Pause keeps an agent's open position under its stop and opens nothing new; stop closes it and ends the run (it can be started again by its owner as a new version).</p>
        <div className="arena-ops-tiles">
          <div><span className="eyebrow">Members</span><strong className="num">{view.members}</strong></div>
          <div><span className="eyebrow">Agents</span><strong className="num">{view.agents.length}</strong></div>
          <div><span className="eyebrow">Running</span><strong className="num">{view.states.running ?? 0}</strong></div>
          <div><span className="eyebrow">Paused</span><strong className="num">{view.states.paused ?? 0}</strong></div>
          <div><span className="eyebrow">Stopped</span><strong className="num">{(view.states.stopped ?? 0) + (view.states.quarantined ?? 0)}</strong></div>
          <div><span className="eyebrow">Paper equity</span><strong className="num">{usd(equity)}</strong><span className="dim small">of {usd(start)}</span></div>
        </div>
        <div className="row-actions">
          <button className="pbtn" disabled={busy} onClick={() => void act("pause", { all: true })}>⏸ Pause every agent</button>
          <button className="pbtn ghost" disabled={busy} onClick={() => void act("resume", { all: true })}>▶ Resume every agent</button>
          {confirmAll === "stop" ? (
            <>
              <button className="pbtn danger" disabled={busy} onClick={() => void act("stop", { all: true })}>Yes, stop every agent</button>
              <button className="linkbtn" onClick={() => setConfirmAll(null)}>Cancel</button>
            </>
          ) : (
            <button className="pbtn ghost" disabled={busy} onClick={() => setConfirmAll("stop")}>■ Stop every agent…</button>
          )}
        </div>
        {note && <p className="good small">{note}</p>}
        {error && <p className="bad small">{error}</p>}
      </div>

      <div className="pcard">
        <div className="seg" role="group" aria-label="Whose agents">
          {(["all", "house", "members"] as const).map((w) => (
            <button key={w} className={who === w ? "on" : ""} onClick={() => setWho(w)}>
              {w === "all" ? "All" : w === "house" ? "Platform (house)" : "Members"}
            </button>
          ))}
        </div>
        <div className="dv-table-wrap">
          <table className="dv-table num">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>Plan</th>
                <th>Method</th>
                <th>State</th>
                <th>Equity</th>
                <th>P&L</th>
                <th>Position</th>
                <th>Decisions</th>
                <th>Model $</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.botId}>
                  <td>
                    <strong>{a.name}</strong> <span className="dim small">v{a.version}{a.listed ? "" : " · private"}</span>
                  </td>
                  <td className="mono">@{a.handle}</td>
                  <td>{a.tier}</td>
                  <td>{a.mode === "autonomous" ? "autonomous" : a.mode === "skill" ? "skill" : a.style}</td>
                  <td>
                    <span className={`ops-state s-${a.state}`}>{a.state}</span>
                  </td>
                  <td>{usd(a.run?.equityUsd)}</td>
                  <td className={(a.run?.pnlPct ?? 0) >= 0 ? "good" : "bad"}>{pct(a.run?.pnlPct)}</td>
                  <td className="dim">{a.run?.position ?? "flat"}</td>
                  <td>{a.run?.decisions?.toLocaleString() ?? "–"}</td>
                  <td>{usd(a.run?.spentUsd)}</td>
                  <td className="ops-actions">
                    {a.state === "running" && <button className="pbtn ghost small" disabled={busy} onClick={() => void act("pause", { userId: a.userId, botId: a.botId })}>Pause</button>}
                    {a.state === "paused" && <button className="pbtn small" disabled={busy} onClick={() => void act("resume", { userId: a.userId, botId: a.botId })}>Resume</button>}
                    {(a.state === "running" || a.state === "paused") &&
                      (confirmOne === a.botId ? (
                        <button className="pbtn danger small" disabled={busy} onClick={() => void act("stop", { userId: a.userId, botId: a.botId })}>
                          Confirm stop
                        </button>
                      ) : (
                        <button className="pbtn ghost small" disabled={busy} onClick={() => setConfirmOne(a.botId)}>
                          Stop…
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="chart-empty">No agents here.</div>}
        </div>
      </div>
    </>
  );
}
