// #/arena and everything under it: the Arena's pages. It is its own service (/arena/*), separate from the owner's engine and admin
// panel, and it has its own frame (ArenaShell): nothing on these pages can reach the owner's side, and it cannot reach a member's data.
//   #/arena            home (the member's agents), or the landing page when signed out
//   #/arena/new        the create wizard (the centre button)
//   #/arena/agent/<id> one agent: performance, decisions, versions, settings
//   #/arena/ranking    the leaderboard, public
//   #/arena/me         account, plan, public name, language
//   #/arena/skills     the member's skills (rule sets an agent can trade by)
//   #/arena/plans      the plans and what they cost (payment is on Stripe's own page)
//   #/arena/legal/<x>  terms, privacy, risk, cookies (drafts until counsel signs them off)
//   #/arena/verify?token=...  the page the e-mailed link opens
import { useCallback, useEffect, useRef, useState } from "react";
import { ArenaAgent } from "./ArenaAgent";
import { ArenaConsent } from "./ArenaConsent";
import { ArenaHome } from "./ArenaHome";
import { ArenaLanding } from "./ArenaLanding";
import { ArenaLegal } from "./ArenaLegal";
import { ArenaMe } from "./ArenaMe";
import { ArenaNew } from "./ArenaNew";
import { ArenaPlans } from "./ArenaPlans";
import { ArenaSkills } from "./ArenaSkills";
import { useArenaData } from "./ArenaParts";
import { ArenaRanking } from "./ArenaRanking";
import { ArenaLive } from "./ArenaLive";
import { ArenaShell, type Mode, type Tab } from "./ArenaShell";
import { arena, type BillingView, type ConsentState, type Limits, type Member } from "./arenaApi";
import { arenaView, type ArenaView } from "./arenaModel";
import { I18nProvider, useI18n } from "./i18n/I18n";
import type { Locale } from "./i18n/locales";

export type { Limits } from "./arenaApi";

// A sign-in link works once, and React's StrictMode runs effects twice in development: remember what was already spent.
const spent = new Set<string>();

/** The signed-in screens that work on the member's agents: home, the create wizard, and one agent's page. */
function ArenaApp({ view, limits, days }: { view: ArenaView; limits: Limits; days: number }) {
  const { t } = useI18n();
  const { data, error } = useArenaData();
  const go = (hash: string) => {
    location.hash = hash;
  };
  if (error && !data)
    return (
      <div className="pcard arena-card">
        <p className="bad">{t(error === "down" ? "common.down" : "home.loadError")}</p>
      </div>
    );
  if (!data) return <div className="pcard arena-card dim">{t("common.loading")}</div>;
  if (view.kind === "new") return <ArenaNew data={data} limits={limits} onDone={(id) => go(`#/arena/agent/${id}`)} onCancel={() => go("#/arena")} />;
  if (view.kind === "skills") return <ArenaSkills data={data} />;
  if (view.kind === "agent") return <ArenaAgent data={data} limits={limits} days={days} id={view.id} onGone={() => go("#/arena")} />;
  return <ArenaHome data={data} limits={limits} days={days} />;
}

function Arena() {
  const { t, choose, adopt } = useI18n();
  const [view, setView] = useState(() => arenaView(location.hash));
  const [me, setMe] = useState<Member | null | "loading">("loading");
  const [limits, setLimits] = useState<Limits | null>(null);
  const [consent, setConsent] = useState<ConsentState | null>(null);
  const [billing, setBilling] = useState<BillingView | null>(null);
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
      const r = await arena<{ user?: Member; limits?: Limits; consent?: ConsentState; billing?: BillingView }>("GET", "me");
      setDown(false);
      if (r.data.limits) setLimits(r.data.limits);
      setConsent(r.data.consent ?? null);
      setBilling(r.data.billing ?? null);
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
  const tab: Tab = view.kind === "live" ? "live" : view.kind === "ranking" ? "board" : view.kind === "me" || view.kind === "plans" ? "me" : view.kind === "skills" ? "home" : view.kind === "new" ? "new" : view.kind === "home" || view.kind === "agent" ? "home" : null;
  const signOut = () => {
    setNotice("");
    setMe(null);
    setConsent(null);
    history.replaceState(null, "", "#/arena");
    setView({ kind: "home" });
  };

  let body: React.ReactNode;
  if (view.kind === "legal") body = <ArenaLegal doc={view.doc} />;
  else if (view.kind === "live") body = <ArenaLive id={view.id} />;
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
  else if (view.kind === "plans") body = <ArenaPlans me={member} paid={view.paid} onChanged={() => void load()} />;
  else if (view.kind === "me") body = <ArenaMe me={member} billing={billing} onOut={signOut} onHandle={(handle) => setMe({ ...member, handle })} onPickLocale={pickLocale} />;
  else if (!limits) body = <div className="pcard arena-card dim">{t("common.loading")}</div>;
  else body = <ArenaApp view={view} limits={limits} days={billing?.quarantineDays ?? 10} />;

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
