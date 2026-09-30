// The one screen a new member must pass: the terms, the simulated-money notice and the age line, each its own box, all unticked.
// The server records the version and the time, and refuses everything else until this is done. The texts they point to are drafts.
import { useState } from "react";
import { arena } from "./arenaApi";
import { useI18n } from "./i18n/I18n";

const ITEMS = ["terms", "sim", "age"] as const;

export function ArenaConsent({ email, onDone, onSignOut }: { email: string; onDone: () => void; onSignOut: () => void }) {
  const { t } = useI18n();
  const [ticked, setTicked] = useState<Record<(typeof ITEMS)[number], boolean>>({ terms: false, sim: false, age: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const all = ITEMS.every((i) => ticked[i]);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "account/consent", { terms: ticked.terms, simulated: ticked.sim, age: ticked.age });
      if (r.status === 200) onDone();
      else setError(t("consent.error"));
    } catch {
      setError(t("consent.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pcard arena-card as-consent" style={{ maxWidth: 560 }}>
      <h2>{t("consent.title")}</h2>
      <p className="dim">{t("consent.lead", { email })}</p>
      {ITEMS.map((i) => (
        <label className="row" key={i}>
          <input type="checkbox" checked={ticked[i]} onChange={(e) => setTicked({ ...ticked, [i]: e.target.checked })} />
          <span>
            <strong>{t(`consent.${i}.t` as const)}</strong>
            {i !== "age" && <span className="dim small" style={{ display: "block" }}>{t(`consent.${i}.b` as const)}</span>}
          </span>
        </label>
      ))}
      <p className="small">
        <a href="#/arena/legal/terms" target="_blank" rel="noopener noreferrer">{t("legal.terms")}</a> · <a href="#/arena/legal/privacy" target="_blank" rel="noopener noreferrer">{t("legal.privacy")}</a>
      </p>
      {error && <p className="bad">{error}</p>}
      <div className="arena-actions">
        <button className="pbtn" disabled={!all || busy} onClick={() => void save()}>
          {busy ? t("consent.saving") : t("consent.continue")}
        </button>
        <button className="linkbtn" onClick={onSignOut}>
          {t("consent.signOut")}
        </button>
      </div>
      <p className="dim small">{t("consent.cookie")}</p>
    </div>
  );
}
