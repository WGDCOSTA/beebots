// #/arena and everything under it: the Arena's pages. It is its own service (/arena/*), separate from the owner's engine and admin
// panel, and it has its own frame (ArenaShell): nothing on these pages can reach the owner's side, and it cannot reach a member's data.
//   #/arena            home (the member's agents), or the landing page when signed out
//   #/arena/new        home with the create form open (the centre button)
//   #/arena/ranking    the leaderboard, public
//   #/arena/me         account, public name, language
//   #/arena/legal/<x>  terms, privacy, risk, cookies (drafts until counsel signs them off)
//   #/arena/verify?token=...  the page the e-mailed link opens
import { useCallback, useEffect, useRef, useState } from "react";
import { ArenaBots } from "./ArenaBots";
import { ArenaConsent } from "./ArenaConsent";
import { ArenaLanding } from "./ArenaLanding";
import { ArenaLegal } from "./ArenaLegal";
import { ArenaMe } from "./ArenaMe";
import { ArenaRanking } from "./ArenaRanking";
import { ArenaShell, type Mode, type Tab } from "./ArenaShell";
import { arena, type ConsentState, type Limits, type Member } from "./arenaApi";
import { arenaView } from "./arenaModel";
import { I18nProvider, useI18n } from "./i18n/I18n";
import type { Locale } from "./i18n/locales";

export type { Limits } from "./arenaApi";

// A sign-in link works once, and React's StrictMode runs effects twice in development: remember what was already spent.
const spent = new Set<string>();

function Arena() {
  const { t, choose, adopt } = useI18n();
  const [view, setView] = useState(() => arenaView(location.hash));
  const [me, setMe] = useState<Member | null | "loading">("loading");
  const [limits, setLimits] = useState<Limits | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [notice, setNotice] = useState("");
  const [down, setDown] = useState(false);
  const verifying = useRef(false);

  useEffect(() => {
    const on = () => setView(arenaView(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await arena<{ user?: Member; limits?: Limits; consent?: ConsentState }>("GET", "me");
      setDown(false);
      if (r.data.limits) setLimits(r.data.limits);
      setConsent(r.data.consent ?? null);
      if (r.status === 200 && r.data.user) {
        setMe(r.data.user);
        adopt(r.data.user.locale);
      } else setMe(null);
    } catch {
      setDown(true);
      setMe(null);
    }
  }, [adopt]);

  useEffect(() => {
    if (view.kind === "verify") {
      const token = view.token;
      if (spent.has(token) || verifying.current) return;
      spent.add(token);
      verifying.current = true;
      void (async () => {
        try {
          const r = await arena<{ user?: Member }>("POST", "auth/verify", { token });
          if (r.status === 200 && r.data.user) void load();
          else {
            setNotice(t("signin.badLink"));
            setMe(null);
          }
        } catch {
          setDown(true);
          setMe(null);
        } finally {
          verifying.current = false;
          // The token is spent either way: take it out of the address bar and the history.
          history.replaceState(null, "", "#/arena");
          setView({ kind: "home" });
        }
      })();
    } else void load();
  }, [view, load]);

  const pickLocale = (l: Locale) => {
    choose(l);
    if (me && me !== "loading") void arena("POST", "account/locale", { locale: l }).catch(() => {});
  };

  const member = me !== "loading" && me !== null ? me : null;
  const gated = !!member && !!consent?.needed;
  const mode: Mode = member ? (gated ? "gate" : "in") : "out";
  const tab: Tab = view.kind === "ranking" ? "board" : view.kind === "me" ? "me" : view.kind === "new" ? "new" : view.kind === "home" ? "home" : null;
  const signOut = () => {
    setNotice("");
    setMe(null);
    setConsent(null);
    history.replaceState(null, "", "#/arena");
    setView({ kind: "home" });
  };

  // The create form was opened by the centre button and is now done or cancelled: go back to plain home.
  const closeNew = useCallback(() => {
    if (location.hash.startsWith("#/arena/new")) {
      history.replaceState(null, "", "#/arena");
      setView({ kind: "home" });
    }
  }, []);

  let body: React.ReactNode;
  if (view.kind === "legal") body = <ArenaLegal doc={view.doc} />;
  else if (view.kind === "ranking")
    body = (
      <>
        <h1 className="as-title">{t("nav.board")}</h1>
        <ArenaRanking />
      </>
    );
  else if (me === "loading" || (view.kind === "verify" && me === null && !notice)) body = <div className="pcard arena-card dim">{view.kind === "verify" ? t("common.signingIn") : t("common.loading")}</div>;
  else if (down)
    body = (
      <div className="pcard arena-card">
        <p className="bad">{t("common.down")}</p>
        <button className="pbtn ghost" onClick={() => void load()}>
          {t("common.tryAgain")}
        </button>
      </div>
    );
  else if (!member) body = <ArenaLanding notice={notice} />;
  else if (gated) body = <ArenaConsent email={member.email} onDone={() => void load()} onSignOut={() => void arena("POST", "auth/logout").finally(signOut)} />;
  else if (view.kind === "me") body = <ArenaMe me={member} onOut={signOut} onHandle={(handle) => setMe({ ...member, handle })} onPickLocale={pickLocale} />;
  else if (!limits) body = <div className="pcard arena-card dim">{t("common.loading")}</div>;
  else body = <ArenaBots limits={limits} openNew={view.kind === "new"} onCloseNew={closeNew} />;

  return (
    <ArenaShell tab={tab} mode={mode} onPickLocale={pickLocale}>
      {body}
    </ArenaShell>
  );
}

export function ArenaPage() {
  return (
    <I18nProvider>
      <Arena />
    </I18nProvider>
  );
}
