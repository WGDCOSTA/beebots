// The Arena's own frame: its brand, its navigation and its footer. Nothing of the owner's dashboard (Live, Lab, Admin) appears here.
// Signed in: a bottom tab bar on a phone, a left sidebar on a wider screen. Signed out: a slim top bar with the way in.
import { useEffect, useState, type ReactNode } from "react";
import { seasonEndsSay } from "./arenaModel";
import { MarketGroup } from "./Header";
import type { SystemInfo } from "./types";
import { useI18n } from "./i18n/I18n";
import { LOCALES, LOCALE_NAMES, type Locale } from "./i18n/locales";
import "./arena.css";

export type Tab = "home" | "live" | "board" | "new" | "me" | null;
/** in: signed in. out: a visitor. gate: signed in but not yet past the terms, so no navigation and no sign-in button. */
export type Mode = "in" | "out" | "gate";

const PATHS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  live: "M3 17l5-6 4 3 5-7 4 4 M12 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2",
  board: "M8 4h8v5a4 4 0 0 1-8 0z M8 6H4v2a3 3 0 0 0 4 2.8 M16 6h4v2a3 3 0 0 1-4 2.8 M12 13v4 M8 21h8 M10 17h4",
  new: "M12 5v14 M5 12h14",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0",
};
const Icon = ({ name }: { name: keyof typeof PATHS }) => (
  <svg className="as-ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

const ITEMS: Array<{ tab: Exclude<Tab, null>; href: string; key: "nav.home" | "nav.live" | "nav.board" | "nav.new" | "nav.me" }> = [
  { tab: "home", href: "#/arena", key: "nav.home" },
  { tab: "live", href: "#/arena/live", key: "nav.live" },
  { tab: "board", href: "#/arena/ranking", key: "nav.board" },
  { tab: "new", href: "#/arena/new", key: "nav.new" },
  { tab: "me", href: "#/arena/me", key: "nav.me" },
];

export function LanguagePicker({ onPick }: { onPick: (l: Locale) => void }) {
  const { t, locale } = useI18n();
  return (
    <label className="as-lang">
      <span className="as-sr">{t("nav.language")}</span>
      <select value={locale} onChange={(e) => onPick(e.target.value as Locale)} aria-label={t("nav.language")}>
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** What the public board says right now, for the header's counters and the system bar (read every 30 s, like a live feed). */
interface Pulse {
  agents: number;
  ranked: number;
  leagues: number;
  season: string;
  end: number;
  days: number;
  trades: number;
}
function usePulse(): Pulse | null {
  const [p, setP] = useState<Pulse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetch("/arena/leaderboard", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ season?: { id: string; end: number }; leagues?: unknown[]; minimums?: { minDays: number; minTrades: number }; rows?: Array<{ rank: number | null }> }>)
        .then((b) => {
          if (!alive || !b.season) return;
          const rows = b.rows ?? [];
          setP({ agents: rows.length, ranked: rows.filter((r) => r.rank !== null).length, leagues: b.leagues?.length ?? 0, season: b.season.id, end: b.season.end, days: b.minimums?.minDays ?? 3, trades: b.minimums?.minTrades ?? 3 });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return p;
}

/** The whole market's mood from the live engine's public snapshot (CoinMarketCap), for the same MARKET group as the live site. */
function useMarket(): SystemInfo["cmc"] | null {
  const [cmc, setCmc] = useState<SystemInfo["cmc"] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void fetch("/snapshot", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<{ system?: SystemInfo }>) : null))
        .then((j) => alive && setCmc(j?.system?.cmc ?? null))
        .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return cmc;
}

/** The UTC clock of the live site's header. */
function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Counter({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="counter">
      <div className="eyebrow">{label}</div>
      <div className={`counter-value num ${tone ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

export function ArenaShell({ tab, mode, onPickLocale, children }: { tab: Tab; mode: Mode; onPickLocale: (l: Locale) => void; children: ReactNode }) {
  const { t } = useI18n();
  const signedIn = mode === "in";
  const pulse = usePulse();
  const cmc = useMarket();
  const ends = pulse ? seasonEndsSay(pulse.end, Date.now()) : null;
  return (
    <div className={`as ${mode}`}>
      {/* The live site's header, piece for piece: the mark and its mode line, counters, the live dot and the UTC clock. */}
      <header className="top as-head">
        <div className="brand">
          <div className="brand-row">
            <a className="logo" href="#/arena" aria-label="beebots arena">
              beebots<span> arena</span>
            </a>
          </div>
          <div className="brand-sub">
            <span className="mode mode-dry">{t("shell.paper").toUpperCase()}</span>
            <span className="dim">{t("shell.sub", { season: pulse?.season ?? "–" })}</span>
          </div>
        </div>
        <div className="counters as-counters">
          <Counter label={t("shell.agents")} value={pulse ? String(pulse.agents) : "–"} sub={t("shell.agentsSub")} />
          <Counter label={t("shell.ranked")} value={pulse ? String(pulse.ranked) : "–"} sub={pulse ? t("shell.rankedSub", { days: pulse.days, trades: pulse.trades }) : undefined} />
          <Counter label={t("shell.season")} value={pulse?.season ?? "–"} sub={ends ? t(ends.key, "vars" in ends ? ends.vars : undefined) : undefined} />
          <Counter label={t("shell.leagues")} value={pulse ? String(pulse.leagues) : "–"} sub={t("shell.leaguesSub")} />
        </div>
        <div className="top-right as-top-end">
          <div className="conn">
            <span className="conn-dot on" />
            <span>{t("shell.live")}</span>
            <Clock />
          </div>
          {mode === "out" && (
            <>
              <a className="as-link" href="#/arena/live">
                {t("nav.live")}
              </a>
              <a className="as-link" href="#/arena/ranking">
                {t("nav.board")}
              </a>
            </>
          )}
          <LanguagePicker onPick={onPickLocale} />
          {mode === "out" && (
            <a className="as-signin" href="#/arena" onClick={() => setTimeout(() => document.getElementById("arena-email")?.focus(), 50)}>
              {t("nav.signIn")}
            </a>
          )}
        </div>
      </header>
      {pulse && (
        <div className="sysbar num as-sys" role="status">
          <span className="sys-group">
            <span className="sys-key">{t("shell.sys.season")}</span>
            <span className="sys-val">{pulse.season}</span>
            {ends && <span className="sys-val">{t(ends.key, "vars" in ends ? ends.vars : undefined)}</span>}
          </span>
          <span className="sys-group">
            <span className="sys-key">{t("shell.sys.rules")}</span>
            <span className="sys-val">{t("shell.sys.rulesVal", { days: pulse.days, trades: pulse.trades })}</span>
          </span>
          {cmc ? (
            <MarketGroup cmc={cmc} />
          ) : (
            <span className="sys-group">
              <span className="sys-key">{t("shell.sys.market")}</span>
              <span className="sys-val up">● {t("shell.sys.marketVal")}</span>
            </span>
          )}
        </div>
      )}
      {signedIn && (
        // The live site's view tabs, in place of a side bar.
        <nav className="viewtabs as-viewtabs" aria-label={t("nav.main")}>
          {ITEMS.map((i) => (
            <a key={i.tab} href={i.href} className={`viewtab ${tab === i.tab ? "on" : ""}`} aria-current={tab === i.tab ? "page" : undefined}>
              <Icon name={i.tab} />
              {t(i.key)}
            </a>
          ))}
        </nav>
      )}
      <div className="as-frame">
        <main className="as-main">{children}</main>
      </div>
      <footer className="as-foot">
        <a href="#/arena/legal/terms">{t("footer.terms")}</a>
        <a href="#/arena/legal/privacy">{t("footer.privacy")}</a>
        <a href="#/arena/legal/risk">{t("footer.risk")}</a>
        <a href="#/arena/legal/cookies">{t("footer.cookies")}</a>
      </footer>
      {signedIn && (
        <nav className="as-tabs" aria-label={t("nav.main")}>
          {ITEMS.map((i) => (
            <a key={i.tab} href={i.href} className={`${tab === i.tab ? "on" : ""} ${i.tab === "new" ? "plus" : ""}`} aria-current={tab === i.tab ? "page" : undefined}>
              <span className="as-ico">
                <Icon name={i.tab} />
              </span>
              {t(i.key)}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}
