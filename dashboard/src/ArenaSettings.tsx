// An agent's Settings tab: edit it (a new style, coins or rules starts a new version), paint its portrait, and delete it.
// Delete asks for the agent's name, because it removes the paper account and the history with it.
import { useState } from "react";
import { arena, type Limits } from "./arenaApi";
import { draftIssue, STYLE_KEYS, type BotDraft } from "./arenaModel";
import { BrainField, ListedField, LookFields, RulesField, StyleFields } from "./ArenaFields";
import type { Agent, ArenaData } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

export function ArenaSettings({ data, limits, agent, onGone }: { data: ArenaData; limits: Limits; agent: Agent; onGone: () => void }) {
  const { t } = useI18n();
  const [d, setD] = useState<BotDraft>({ name: agent.name, theme: agent.theme, avatar: agent.avatar, style: agent.style, coins: agent.coins, rules: agent.rules, tagline: agent.tagline, look: agent.look, listed: agent.listed, brainKey: agent.brainKey ?? null, mode: agent.mode });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [painting, setPainting] = useState(false);
  const [typed, setTyped] = useState("");
  const styleName = (id: string) => t(STYLE_KEYS[id]?.title ?? "style.breezy.t");
  const issue = draftIssue(d, limits.maxCoins, styleName);
  const changesVersion = d.style !== agent.style || d.rules.trim() !== agent.rules || (d.brainKey ?? null) !== (agent.brainKey ?? null) || JSON.stringify(d.coins) !== JSON.stringify(agent.coins);
  const ai = data.ai;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await arena("POST", "bots/update", { ...d, id: agent.id });
      if (r.status === 200) {
        setMsg({ ok: true, text: t("set.saved") });
        await data.reload();
      } else setMsg({ ok: false, text: r.data.error ?? t("err.save") });
    } catch {
      setMsg({ ok: false, text: t("common.down") });
    } finally {
      setBusy(false);
    }
  };

  const paint = async () => {
    setPainting(true);
    setMsg(null);
    try {
      const r = await arena("POST", "ai/portrait", { id: agent.id });
      if (r.status !== 200) setMsg({ ok: false, text: r.data.error ?? t("set.paintError") });
    } catch {
      setMsg({ ok: false, text: t("common.down") });
    } finally {
      setPainting(false);
      await data.reload();
    }
  };

  const remove = async () => {
    const r = await arena("POST", "bots/delete", { id: agent.id });
    if (r.status === 200) {
      await data.reload();
      onGone();
    } else setMsg({ ok: false, text: r.data.error ?? t("err.save") });
  };

  return (
    <>
      <form
        className="ab-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <LookFields cat={data.cat} limits={limits} d={d} set={setD} />
        <StyleFields cat={data.cat} limits={limits} d={d} set={setD} />
        <RulesField d={d} set={setD} note={changesVersion ? t("set.newVersion") : undefined} />
        <BrainField d={d} set={setD} keys={data.keys} />
        <ListedField d={d} set={setD} />
        {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
        {issue && <p className="dim small">{t(issue.key, issue.vars)}</p>}
        <div className="arena-actions">
          <button className="pbtn" disabled={busy || issue !== null}>
            {busy ? t("set.saving") : t("set.save")}
          </button>
        </div>
      </form>

      {ai?.portraitBotId === agent.id && (
        <div className="ag-block">
          <div className="eyebrow">{t("set.portrait")}</div>
          <p className="dim small">{t("set.paintHelp")}</p>
          <button className="pbtn ghost" disabled={painting} onClick={() => void paint()}>
            {painting ? t("set.painting") : t(agent.image ? "set.repaint" : "set.paint", { n: ai.portraitsLeft })}
          </button>
        </div>
      )}

      <div className="ag-block ag-danger">
        <div className="eyebrow">{t("set.danger")}</div>
        <p className="dim small">{t("set.deleteHelp", { name: agent.name })}</p>
        <input className="pinput" aria-label={t("set.deleteHelp", { name: agent.name })} placeholder={agent.name} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="arena-actions">
          <button className="pbtn danger" disabled={typed.trim().toLowerCase() !== agent.name.toLowerCase()} onClick={() => void remove()}>
            {t("set.delete")}
          </button>
        </div>
      </div>
    </>
  );
}
