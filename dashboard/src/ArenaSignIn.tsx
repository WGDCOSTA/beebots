// Asking for the sign-in link, and the "check your inbox" state. The form answers the same for everyone, so it cannot reveal
// who has an account; accepting the terms happens after the link is opened, not here.
import { useEffect, useState } from "react";
import { arena } from "./arenaApi";
import { looksLikeEmail, resendIn } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

export function ArenaSignIn({ notice }: { notice?: string }) {
  const { t, locale } = useI18n();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (sentAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sentAt]);

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "auth/request", { email, locale });
      if (r.status === 200) {
        setNow(Date.now());
        setSentAt(Date.now());
      } else setError(r.status === 400 ? t("signin.badEmail") : t("common.down"));
    } catch {
      setError(t("common.down"));
    } finally {
      setBusy(false);
    }
  };

  if (sentAt !== null) {
    const wait = resendIn(sentAt, now);
    return (
      <div className="pcard login arena-card">
        <h2>{t("signin.inbox.title")}</h2>
        <p>{t("signin.inbox.body", { email: email.trim().toLowerCase() })}</p>
        <p className="dim small">{t("signin.inbox.hint")}</p>
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy || wait > 0} onClick={() => void send()}>
            {wait > 0 ? t("signin.resendIn", { s: wait }) : t("signin.resend")}
          </button>
          <button className="linkbtn" onClick={() => setSentAt(null)}>
            {t("signin.other")}
          </button>
        </div>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  return (
    <div className="pcard login arena-card">
      <h2>{t("signin.title")}</h2>
      <p className="dim">{t("signin.lead")}</p>
      {notice && <p className="bad">{notice}</p>}
      <form
        className="arena-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input id="arena-email" className="pinput" type="email" inputMode="email" autoComplete="email" placeholder={t("signin.placeholder")} aria-label={t("signin.placeholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="pbtn" disabled={busy || !looksLikeEmail(email)}>
          {busy ? t("signin.sending") : t("signin.send")}
        </button>
      </form>
      {error && <p className="bad">{error}</p>}
      <p className="dim small">{t("signin.paper")}</p>
    </div>
  );
}
