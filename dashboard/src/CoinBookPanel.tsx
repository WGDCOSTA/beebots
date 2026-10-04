// The coin book (lab/coinBook.ts): each coin's scalp rules, where they came from, what the lab measured and what live
// trades did, plus the lab brain's latest studies (brains/labBrain.ts). Read-only on #/lab; with `act` (Admin) the
// owner can run a study, add a rule and block, pin, retire or requeue one.
import { useState } from "react";
import { when } from "./panelTypes";

export interface BookCandidate {
  ruleId: string;
  name: string;
  status: "queued" | "validated" | "failing" | "retired" | "demoted";
  source: string;
  reason: string;
  tests: number;
  lastTest: { at: number; netBps: number; trades: number; folds: string; plateauPct: number; edge: boolean; why: string } | null;
  live: { trades: number; wins: number; netUsd: number; netBps: number } | null;
  until: number | null;
  pinned: boolean;
  blocked: boolean;
}

export interface BookStudy {
  at: number;
  trigger: string;
  brain: string;
  model: string;
  summary: string;
  findings: Array<{ coin: string; text: string }>;
  applied: Array<{ coin: string; ruleId: string | null; action: "proposed" | "retired" | "rejected"; source: string; note: string }>;
  focus: string[];
  bunny: { slot: string; brain: string; proposed: number; note: string } | null;
  labRequested: boolean;
}

export interface BookView {
  at: number;
  totals: { coins: number; rules: number; queued: number; validated: number; failing: number; retired: number; demoted: number };
  rules: Array<{ id: string; name: string; description: string; source: string; createdAt: number; spec?: unknown }>;
  coins: Array<{ coin: string; candidates: BookCandidate[] }>;
  log: Array<{ at: number; coin: string; ruleId: string | null; event: string; source: string; text: string }>;
}

export interface LabBrainStatus {
  enabled: boolean;
  brain: string | null;
  running: boolean;
  intervalMin: number;
  callsToday: number;
  maxCallsPerDay: number;
  lastAt: number | null;
  nextAt: number | null;
  studies: BookStudy[];
}

type Act = (path: string, body: unknown, ok: string) => Promise<void>;

const STATUS: Record<BookCandidate["status"], { label: string; cls: string }> = {
  validated: { label: "✓ validated", cls: "ok" },
  queued: { label: "● waiting for the lab", cls: "" },
  failing: { label: "✗ no edge yet", cls: "" },
  retired: { label: "retired", cls: "dim" },
  demoted: { label: "▼ demoted (live)", cls: "bad" },
};

const sourceLabel = (s: string) => (s === "builtin" ? "built in" : s === "lab-brain" ? "lab brain" : s === "manual" ? "you" : s === "autonomous" ? "the book" : s.startsWith("bunny:") ? `bunny ${s.slice(6)}` : s);
const bp = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(2)} bp`;

function Study({ s }: { s: BookStudy }) {
  const proposed = s.applied.filter((a) => a.action === "proposed");
  const rejected = s.applied.filter((a) => a.action === "rejected");
  return (
    <div className="study">
      <div className="dim small">
        {when(s.at)} · {s.brain}:{s.model} · {s.trigger}
        {s.labRequested ? " · lab run requested" : ""}
      </div>
      <p className="small">{s.summary}</p>
      {s.findings.length > 0 && (
        <ul className="small">
          {s.findings.map((f, i) => (
            <li key={i}>
              <strong>{f.coin}</strong>: {f.text}
            </li>
          ))}
        </ul>
      )}
      <p className="dim small">
        {proposed.length ? `Filed: ${proposed.map((a) => `${a.ruleId} on ${a.coin} (${sourceLabel(a.source)})`).join(", ")}. ` : "Nothing new filed. "}
        {s.applied.filter((a) => a.action === "retired").map((a) => `Retired ${a.ruleId} on ${a.coin}. `)}
        {rejected.length ? `Refused by the book: ${rejected.map((a) => `${a.ruleId ?? "a rule"} on ${a.coin} (${a.note})`).join("; ")}.` : ""}
        {s.focus.length ? ` Focus: ${s.focus.join(", ")}.` : ""}
        {s.bunny ? ` ${s.bunny.slot} (${s.bunny.brain}) proposed ${s.bunny.proposed}${s.bunny.note ? `: ${s.bunny.note}` : ""}` : ""}
      </p>
    </div>
  );
}

export function CoinBookPanel({ book, brain, act, title }: { book: BookView | null; brain: LabBrainStatus | null; act?: Act; title?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [coin, setCoin] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [spec, setSpec] = useState("");
  if (!book) return <p className="dim">The coin book is not running.</p>;
  const t = book.totals;
  const study = brain?.studies[0] ?? null;
  const go = (body: Record<string, unknown>, ok: string) => void act?.("lab/book", body, ok).catch(() => {});
  return (
    <div className="pcard coinbook">
      {title && <h3>{title}</h3>}
      <div className="ptiles">
        <div className="ptile">
          <div className="eyebrow">Validated</div>
          <div className="ptile-value num">{t.validated}</div>
          <div className="dim ptile-sub">rule × coin pairs the lab passed</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Waiting for the lab</div>
          <div className="ptile-value num">{t.queued}</div>
          <div className="dim ptile-sub">{t.failing} failing · {t.retired} retired · {t.demoted} demoted</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Rules</div>
          <div className="ptile-value num">{t.rules}</div>
          <div className="dim ptile-sub">on {t.coins} coins</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Lab brain</div>
          <div className="ptile-value">{brain?.enabled ? (brain.running ? "studying…" : "on") : "off"}</div>
          <div className="dim ptile-sub">
            {brain?.enabled ? `${brain.brain} · every ${Math.round(brain.intervalMin / 60)} h · ${brain.callsToday}/${brain.maxCallsPerDay} calls today` : "needs an OpenAI key (or LAB_BRAIN)"}
          </div>
        </div>
      </div>

      {act && (
        <div className="row-actions">
          <button className="pbtn" disabled={!brain?.enabled || brain?.running} onClick={() => void act("lab/study", {}, "The lab brain is studying everything the brains know; the study shows here in a minute or two.").catch(() => {})}>
            {brain?.running ? "Studying…" : "Run a full study now"}
          </button>
        </div>
      )}

      <h3>Latest study</h3>
      {study ? <Study s={study} /> : <p className="dim small">No study yet. {brain?.enabled ? `The first runs ${brain.nextAt ? when(brain.nextAt) : "shortly after start"}.` : ""}</p>}

      <h3>Rules by coin</h3>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Rule</th>
              <th>Status</th>
              <th>From</th>
              <th className="r">Lab net</th>
              <th className="r">Lab trades</th>
              <th className="r">Live</th>
              {act && <th />}
            </tr>
          </thead>
          <tbody>
            {book.coins.flatMap((c) =>
              c.candidates.map((x) => {
                const key = `${c.coin}:${x.ruleId}`;
                const st = STATUS[x.status];
                return [
                  <tr key={key} className={x.status === "retired" ? "dim" : ""} onClick={() => setOpen(open === key ? null : key)} style={{ cursor: "pointer" }}>
                    <td>
                      <strong>{c.coin === "*" ? "every coin" : c.coin}</strong>
                    </td>
                    <td>
                      {x.name}
                      {x.pinned ? " 📌" : ""}
                      {x.blocked ? " ⛔" : ""}
                    </td>
                    <td className={st.cls}>{st.label}</td>
                    <td className="dim">{sourceLabel(x.source)}</td>
                    <td className={`r num ${x.lastTest ? (x.lastTest.netBps > 0 ? "good" : "bad") : ""}`}>{x.lastTest ? bp(x.lastTest.netBps) : "–"}</td>
                    <td className="r num">{x.lastTest ? `${x.lastTest.trades} · ${x.lastTest.folds}` : "–"}</td>
                    <td className="r num">{x.live ? `${x.live.trades} · ${bp(x.live.netBps)}` : "–"}</td>
                    {act && (
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        <select
                          className="pinput"
                          value=""
                          aria-label={`Change ${x.ruleId} on ${c.coin}`}
                          onChange={(e) => e.target.value && go({ action: e.target.value, coin: c.coin, ruleId: x.ruleId }, `${e.target.value}: ${x.ruleId} on ${c.coin}`)}
                        >
                          <option value="">…</option>
                          <option value={x.pinned ? "unpin" : "pin"}>{x.pinned ? "Unpin" : "Pin (always test)"}</option>
                          <option value={x.blocked ? "unblock" : "block"}>{x.blocked ? "Unblock" : "Block (never trade)"}</option>
                          <option value="requeue">Test again</option>
                          <option value="retire">Retire</option>
                        </select>
                      </td>
                    )}
                  </tr>,
                  open === key ? (
                    <tr key={`${key}:d`} className="detail">
                      <td colSpan={act ? 8 : 7} className="small">
                        <div>{x.reason}</div>
                        {x.lastTest && (
                          <div className="dim">
                            Lab {when(x.lastTest.at)}: {x.lastTest.why} (plateau {x.lastTest.plateauPct}%, {x.tests} test{x.tests === 1 ? "" : "s"})
                          </div>
                        )}
                        {x.until && <div className="dim">Back in the queue {when(x.until)}.</div>}
                      </td>
                    </tr>
                  ) : null,
                ];
              }),
            )}
          </tbody>
        </table>
      </div>
      {book.coins.length === 0 && <p className="dim small">Empty: the book fills from the next lab run and the lab brain's first study.</p>}

      {act && (
        <details>
          <summary>Add a rule by hand</summary>
          <p className="dim small">
            Queue an existing rule for a coin (or <code>*</code> for every coin the lab tests next), or paste a new rule in the scalp DSL (see docs/LAB_BRAIN.md). It trades only after the lab passes it on real data.
          </p>
          <div className="row-actions">
            <input className="pinput" placeholder="Coin, e.g. BTC or *" value={coin} onChange={(e) => setCoin(e.target.value)} />
            <select className="pinput" value={ruleId} onChange={(e) => setRuleId(e.target.value)} aria-label="Existing rule">
              <option value="">New rule (JSON below)</option>
              {book.rules.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.id})
                </option>
              ))}
            </select>
          </div>
          {!ruleId && <textarea className="pinput code" rows={8} placeholder='{"id":"my_rule","name":"…","long":{"entry":[…]},"trade":{…}}' value={spec} onChange={(e) => setSpec(e.target.value)} />}
          <button className="pbtn" disabled={!coin.trim() || (!ruleId && !spec.trim())} onClick={() => go({ action: "propose", coin, ...(ruleId ? { ruleId } : { specJson: spec }) }, "Queued for the lab.")}>
            Queue for the lab
          </button>
        </details>
      )}

      <details>
        <summary>Book log</summary>
        <ul className="small">
          {book.log.map((l, i) => (
            <li key={i}>
              <span className="dim">{when(l.at)}</span> <strong>{l.coin}</strong> {l.ruleId ?? ""} · {l.event} ({sourceLabel(l.source)}): {l.text}
            </li>
          ))}
        </ul>
      </details>

      {brain && brain.studies.length > 1 && (
        <details>
          <summary>Earlier studies</summary>
          {brain.studies.slice(1).map((s) => (
            <Study key={s.at} s={s} />
          ))}
        </details>
      )}
    </div>
  );
}
