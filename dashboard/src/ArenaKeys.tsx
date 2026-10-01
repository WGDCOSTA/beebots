// "Your own model keys": the member's OpenAI, Claude, Z.ai or Kimi key, so an agent thinks with their model and the
// member pays the provider directly. The secret is typed once, encrypted on the server and never shown again (only the
// last four characters). The platform sets no ceiling on a member's own key; the member may set one.
import { useCallback, useEffect, useState } from "react";
import { arena } from "./arenaApi";
import { PROVIDER_LABEL } from "./arenaModel";
import type { KeysState } from "./ArenaParts";
import { useI18n } from "./i18n/I18n";

export function ArenaKeys() {
  const { t } = useI18n();
  const [state, setState] = useState<KeysState>({ open: false, max: 5, providers: [], keys: [] });
  const reload = useCallback(async () => {
    try {
      const r = await arena<KeysState>("GET", "keys");
      if (r.status === 200) setState(r.data);
    } catch {
      /* the card keeps what it has */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const [provider, setProvider] = useState("openai");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [model, setModel] = useState("");
  const [ceiling, setCeiling] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const def = state.providers.find((p) => p.id === provider)?.model ?? "";

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await arena("POST", "keys/add", { provider, label, secret, model, dailyUsd: ceiling === "" ? undefined : Number(ceiling) });
      if (r.status === 200) {
        setSecret("");
        setLabel("");
        setModel("");
        setCeiling("");
        setMsg({ ok: true, text: t("keys.added") });
        await reload();
      } else setMsg({ ok: false, text: r.data.error ?? t("err.save") });
    } catch {
      setMsg({ ok: false, text: t("common.down") });
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    setMsg(null);
    const r = await arena("POST", "keys/delete", { id });
    if (r.status === 200) await reload();
    else setMsg({ ok: false, text: r.data.error ?? t("err.save") });
  };

  return (
    <div className="pcard arena-card">
      <h3>{t("keys.title")}</h3>
      <p className="dim small">{t("keys.help")}</p>
      {!state.open ? (
        <p className="dim">{t("keys.closed")}</p>
      ) : (
        <>
          {state.keys.length === 0 ? (
            <p className="dim small">{t("keys.empty")}</p>
          ) : (
            <ul className="ky-list">
              {state.keys.map((k) => (
                <li key={k.id}>
                  <div>
                    <strong>{k.label}</strong> <span className="dim small">{PROVIDER_LABEL[k.provider] ?? k.provider} · {k.model} · {t("keys.endsIn", { last4: k.last4 })}{k.dailyUsd !== null ? ` · $${k.dailyUsd}/d` : ""}</span>
                  </div>
                  <button className="pbtn ghost small" onClick={() => void remove(k.id)}>
                    {t("keys.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {state.keys.length < state.max ? (
            <form
              className="ab-form"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <label className="eyebrow" htmlFor="ky-provider">
                {t("keys.provider")}
              </label>
              <select id="ky-provider" className="pinput" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {state.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PROVIDER_LABEL[p.id] ?? p.id}
                  </option>
                ))}
              </select>
              <label className="eyebrow" htmlFor="ky-label">
                {t("keys.label")}
              </label>
              <input id="ky-label" className="pinput" maxLength={40} placeholder={t("keys.labelPh")} value={label} onChange={(e) => setLabel(e.target.value)} />
              <label className="eyebrow" htmlFor="ky-secret">
                {t("keys.secret")}
              </label>
              <input id="ky-secret" className="pinput" type="password" autoComplete="new-password" spellCheck={false} maxLength={400} value={secret} onChange={(e) => setSecret(e.target.value)} />
              <label className="eyebrow" htmlFor="ky-model">
                {t("keys.model")} <span className="dim">({t("field.optional")})</span>
              </label>
              <input id="ky-model" className="pinput" maxLength={60} placeholder={def} value={model} onChange={(e) => setModel(e.target.value)} />
              <label className="eyebrow" htmlFor="ky-ceiling">
                {t("keys.ceiling")}
              </label>
              <input id="ky-ceiling" className="pinput" inputMode="decimal" maxLength={8} value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
              <p className="dim small">{t("keys.ceilingHelp")}</p>
              {msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
              <div className="arena-actions">
                <button className="pbtn" disabled={busy || secret.trim().length < 12 || label.trim() === ""}>
                  {busy ? t("keys.adding") : t("keys.add")}
                </button>
              </div>
            </form>
          ) : (
            <p className="dim small">{t("keys.max", { n: state.max })}</p>
          )}
          {state.keys.length >= state.max && msg && <p className={msg.ok ? "good" : "bad"}>{msg.text}</p>}
        </>
      )}
    </div>
  );
}
