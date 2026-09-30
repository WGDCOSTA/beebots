// "Me": the person, apart from the agents. Who they are, their public name, their language, signing out, and leaving.
import { useState } from "react";
import { arena, type Member } from "./arenaApi";
import { handleProblem, memberSince, TIER_LABEL } from "./arenaModel";
import { useI18n } from "./i18n/I18n";
import { LOCALES, LOCALE_NAMES, type Locale } from "./i18n/locales";

function PublicName({ me, onChange }: { me: Member; onChange: (handle: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(me.handle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = handleProblem(value);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena<{ handle?: string }>("POST", "account/handle", { handle: value });
      if (r.status === 200 && r.data.handle) {
        onChange(r.data.handle);
        setEditing(false);
      } else setError(r.data.error ?? "Could not change it.");
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="arena-handle">
      <div className="eyebrow">Public name</div>
      {!editing ? (
        <div className="arena-actions">
          <span className="mono strong">@{me.handle}</span>
          <button className="pbtn ghost small" onClick={() => setEditing(true)}>
            Change
          </button>
          <span className="dim small">This is what others see on the leaderboard, never your e-mail.</span>
        </div>
      ) : (
        <form
          className="arena-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className="pinput" value={value} maxLength={20} autoFocus onChange={(e) => setValue(e.target.value)} aria-label="Public name" />
          <button className="pbtn" disabled={busy || problem !== null} title={problem ?? undefined}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="pbtn ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}

export function ArenaMe({ me, onOut, onHandle, onPickLocale }: { me: Member; onOut: () => void; onHandle: (h: string) => void; onPickLocale: (l: Locale) => void }) {
  const { t, locale } = useI18n();
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const out = async () => {
    setBusy(true);
    try {
      await arena("POST", "auth/logout");
    } finally {
      onOut();
    }
  };
  const erase = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "account/delete", { confirm });
      if (r.status === 200) onOut();
      else setError(r.data.error ?? t("common.down"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="as-title">{t("me.title")}</h1>
      <div className="pcard arena-card">
        <div className="arena-who">
          <div>
            <div className="eyebrow">Signed in as</div>
            <div className="arena-email mono">{me.email}</div>
            <div className="dim small">{memberSince(me.createdAt)}</div>
          </div>
          <span className={`badge ${me.tier === "pro" ? "ok" : ""}`}>{TIER_LABEL[me.tier]}</span>
        </div>
        <PublicName me={me} onChange={onHandle} />
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy} onClick={() => void out()}>
            Sign out
          </button>
        </div>
      </div>

      <div className="pcard arena-card">
        <h3>{t("me.language")}</h3>
        <p className="dim small">{t("me.languageHelp")}</p>
        <div className="as-langlist" role="radiogroup" aria-label={t("me.language")}>
          {LOCALES.map((l) => (
            <label key={l} className={locale === l ? "on" : ""} lang={l}>
              <input type="radio" name="arena-lang" checked={locale === l} onChange={() => onPickLocale(l)} />
              {LOCALE_NAMES[l]}
            </label>
          ))}
        </div>
      </div>

      <div className="pcard arena-card arena-danger">
        <h3>Delete my account</h3>
        <p className="dim small">Removes your account, your sessions and your whole private database. This cannot be undone.</p>
        {!open ? (
          <button className="pbtn ghost small" onClick={() => setOpen(true)}>
            Delete my account…
          </button>
        ) : (
          <form
            className="arena-form"
            onSubmit={(e) => {
              e.preventDefault();
              void erase();
            }}
          >
            <input className="pinput" type="email" placeholder={`Type ${me.email} to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
            <button className="pbtn danger" disabled={busy || confirm.trim().toLowerCase() !== me.email}>
              {busy ? "Deleting…" : "Delete forever"}
            </button>
          </form>
        )}
        {error && <p className="bad">{error}</p>}
      </div>
    </>
  );
}
