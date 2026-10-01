// "Me": the person, apart from the agents. Who they are, their public name, their language, signing out, and leaving.
import { useState } from "react";
import { arena, type BillingView, type Member } from "./arenaApi";
import { handleIssue, TIER_LABEL } from "./arenaModel";
import { useI18n } from "./i18n/I18n";
import { LOCALES, LOCALE_NAMES, type Locale } from "./i18n/locales";

function PublicName({ me, onChange }: { me: Member; onChange: (handle: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(me.handle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = handleIssue(value);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena<{ handle?: string }>("POST", "account/handle", { handle: value });
      if (r.status === 200 && r.data.handle) {
        onChange(r.data.handle);
        setEditing(false);
      } else setError(r.data.error ?? t("me.handleError"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="arena-handle">
      <div className="eyebrow">{t("me.publicName")}</div>
      {!editing ? (
        <div className="arena-actions">
          <span className="mono strong">@{me.handle}</span>
          <button className="pbtn ghost small" onClick={() => setEditing(true)}>
            {t("me.change")}
          </button>
          <span className="dim small">{t("me.publicNameHelp")}</span>
        </div>
      ) : (
        <form
          className="arena-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input className="pinput" value={value} maxLength={20} autoFocus onChange={(e) => setValue(e.target.value)} aria-label={t("me.publicName")} />
          <button className="pbtn" disabled={busy || problem !== null} title={problem ? t(problem) : undefined}>
            {busy ? t("me.saving") : t("me.save")}
          </button>
          <button type="button" className="pbtn ghost" onClick={() => setEditing(false)}>
            {t("common.cancel")}
          </button>
        </form>
      )}
      {error && <p className="bad">{error}</p>}
    </div>
  );
}

export function ArenaMe({ me, billing, onOut, onHandle, onPickLocale }: { me: Member; billing: BillingView | null; onOut: () => void; onHandle: (h: string) => void; onPickLocale: (l: Locale) => void }) {
  const { t, locale } = useI18n();
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [billError, setBillError] = useState("");

  const manage = async () => {
    setBillError("");
    try {
      const r = await arena<{ url?: string }>("POST", "billing/portal", {});
      if (r.status === 200 && r.data.url) window.location.assign(r.data.url);
      else setBillError(r.data.error ?? t("me.billingError"));
    } catch {
      setBillError(t("me.billingError"));
    }
  };

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
            <div className="eyebrow">{t("me.signedInAs")}</div>
            <div className="arena-email mono">{me.email}</div>
            <div className="dim small">{t("me.since", { date: new Date(me.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) })}</div>
          </div>
          <span className={`badge ${me.tier !== "free" ? "ok" : ""}`}>{TIER_LABEL[me.tier]}</span>
        </div>
        <PublicName me={me} onChange={onHandle} />
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy} onClick={() => void out()}>
            {t("me.signOut")}
          </button>
        </div>
      </div>

      <div className="pcard arena-card">
        <div className="arena-who">
          <div>
            <div className="eyebrow">{t("me.plan")}</div>
            <strong>{TIER_LABEL[me.tier]}</strong>
            {billing?.periodEnd && me.tier !== "free" && <div className="dim small">{t("me.periodEnd", { date: new Date(billing.periodEnd).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) })}</div>}
          </div>
        </div>
        <div className="arena-actions">
          <a className="pbtn ghost" href="#/arena/plans">
            {t("me.seePlans")}
          </a>
          {billing?.canManage && (
            <button className="pbtn ghost" onClick={() => void manage()}>
              {t("plans.manage")}
            </button>
          )}
        </div>
        {billError && <p className="bad">{billError}</p>}
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
        <h3>{t("me.deleteTitle")}</h3>
        <p className="dim small">{t("me.deleteHelp")}</p>
        {!open ? (
          <button className="pbtn ghost small" onClick={() => setOpen(true)}>
            {t("me.deleteOpen")}
          </button>
        ) : (
          <form
            className="arena-form"
            onSubmit={(e) => {
              e.preventDefault();
              void erase();
            }}
          >
            <input className="pinput" type="email" placeholder={t("me.deleteConfirm", { email: me.email })} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
            <button className="pbtn danger" disabled={busy || confirm.trim().toLowerCase() !== me.email}>
              {busy ? t("me.deleting") : t("me.deleteGo")}
            </button>
          </form>
        )}
        {error && <p className="bad">{error}</p>}
      </div>
    </>
  );
}
