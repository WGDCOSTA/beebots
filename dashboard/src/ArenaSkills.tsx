// "My skills": the rule sets an agent can trade by. Keep one from the platform's library, or write your own in the Lab's rule
// language (data, never code: it can only compare indicators and open or close a position). A plan has a number of slots.
// Nothing here has been backtested yet: the page says so, and no result is ever promised.
import { useState } from "react";
import { arena } from "./arenaApi";
import type { ArenaData } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

const EXAMPLE = `{
  "id": "dip_buyer",
  "name": "Dip buyer",
  "family": "mean_reversion",
  "description": "Buy when RSI(2) is washed out, sell the bounce.",
  "params": { "lo": { "default": 15 } },
  "stopAtr": 3,
  "long": {
    "entry": [ { "left": "close", "op": ">", "right": "sma(200)" }, { "left": "rsi(2)", "op": "<", "right": "$lo" } ],
    "exit":  [ { "left": "rsi(2)", "op": ">", "right": 70 } ]
  }
}`;

export function ArenaSkills({ data }: { data: ArenaData }) {
  const { t } = useI18n();
  const { slots, skills, library } = data.skills;
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const full = skills.length >= slots;
  const have = new Set(skills.filter((s) => s.kind === "lib").map((s) => s.name));

  const call = async (key: string, path: "skills/add" | "skills/delete", body: Record<string, unknown>, ok?: string) => {
    setBusy(key);
    setMsg(null);
    try {
      const r = await arena(`POST`, path, body);
      if (r.status === 200) {
        if (ok) setMsg({ ok: true, text: ok });
        await data.reload();
        return true;
      }
      setMsg({ ok: false, text: r.data.error ?? t("err.save") });
    } catch {
      setMsg({ ok: false, text: t("common.down") });
    } finally {
      setBusy(null);
    }
    return false;
  };

  return (
    <>
      <h1 className="as-title">{t("skills.title")}</h1>
      <p className="dim">{t("skills.lead")}</p>
      <p className="pcard arena-card small">{t("skills.warn")}</p>

      <div className="pcard arena-card">
        <div className="arena-who">
          <h3>{t("skills.mine")}</h3>
          <span className="dim small">{t("skills.slots", { n: skills.length, max: slots })}</span>
        </div>
        {skills.length === 0 ? (
          <p className="dim small">{t("skills.empty")}</p>
        ) : (
          <ul className="sk-list">
            {skills.map((s) => (
              <li key={s.id} className={s.locked ? "locked" : ""}>
                <div className="sk-main">
                  <strong>{s.name}</strong> <span className="badge">{t(s.kind === "lib" ? "skills.fromLib" : "skills.own")}</span> {s.locked && <span className="badge">{t("skills.locked")}</span>}
                  <div className="dim small">{s.family.replace("_", " ")} · {s.description}</div>
                  {s.usedBy.length > 0 && <div className="small">{t("skills.usedBy", { names: s.usedBy.map((u) => u.name).join(", ") })}</div>}
                  {s.locked && <div className="small">{t("skills.lockedHelp")}</div>}
                </div>
                <button className="pbtn ghost small" disabled={busy !== null || s.usedBy.length > 0} title={s.usedBy.length ? t("skills.inUse") : undefined} onClick={() => void call(`rm${s.id}`, "skills/delete", { id: s.id })}>
                  {t("keys.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
        {full && <p className="dim small">{t("skills.full", { max: slots })} <a href="#/arena/plans">{t("plans.seeLocked")}</a></p>}
      </div>

      <div className="pcard arena-card">
        <h3>{t("skills.library")}</h3>
        <p className="dim small">{t("skills.libraryHelp")}</p>
        <ul className="sk-list">
          {library.map((s) => (
            <li key={s.id}>
              <div className="sk-main">
                <strong>{s.name}</strong>
                <div className="dim small">{s.family.replace("_", " ")} · {s.description}</div>
              </div>
              <button className="pbtn ghost small" disabled={busy !== null || full || have.has(s.name)} onClick={() => void call(`lib${s.id}`, "skills/add", { from: s.id }, t("skills.added"))}>
                {have.has(s.name) ? t("skills.kept") : t("skills.keep")}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="pcard arena-card">
        <h3>{t("skills.write")}</h3>
        <p className="dim small">{t("skills.writeHelp")}</p>
        <textarea className="pinput sk-spec" rows={10} spellCheck={false} maxLength={6000} aria-label={t("skills.write")} placeholder={EXAMPLE} value={spec} onChange={(e) => setSpec(e.target.value)} />
        <div className="arena-actions">
          <button className="pbtn" disabled={busy !== null || full || spec.trim().length < 20} onClick={async () => { if (await call("own", "skills/add", { spec }, t("skills.added"))) setSpec(""); }}>
            {busy === "own" ? t("keys.adding") : t("skills.save")}
          </button>
          <button className="pbtn ghost" type="button" onClick={() => setSpec(EXAMPLE)}>
            {t("skills.example")}
          </button>
        </div>
      </div>
    </>
  );
}
