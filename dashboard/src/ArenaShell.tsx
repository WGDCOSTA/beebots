// The Arena's own frame: its brand, its navigation and its footer. Nothing of the owner's dashboard (Live, Lab, Admin) appears here.
// Signed in: a bottom tab bar on a phone, a left sidebar on a wider screen. Signed out: a slim top bar with the way in.
import type { ReactNode } from "react";
import { useI18n } from "./i18n/I18n";
import { LOCALES, LOCALE_NAMES, type Locale } from "./i18n/locales";
import "./arena.css";

export type Tab = "home" | "board" | "new" | "me" | null;
/** in: signed in. out: a visitor. gate: signed in but not yet past the terms, so no navigation and no sign-in button. */
export type Mode = "in" | "out" | "gate";

const PATHS = {
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  board: "M8 4h8v5a4 4 0 0 1-8 0z M8 6H4v2a3 3 0 0 0 4 2.8 M16 6h4v2a3 3 0 0 1-4 2.8 M12 13v4 M8 21h8 M10 17h4",
  new: "M12 5v14 M5 12h14",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21a8 8 0 0 1 16 0",
};
const Icon = ({ name }: { name: keyof typeof PATHS }) => (
  <svg className="as-ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d={PATHS[name]} />
  </svg>
);

const ITEMS: Array<{ tab: Exclude<Tab, null>; href: string; key: "nav.home" | "nav.board" | "nav.new" | "nav.me" }> = [
  { tab: "home", href: "#/arena", key: "nav.home" },
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

export function ArenaShell({ tab, mode, onPickLocale, children }: { tab: Tab; mode: Mode; onPickLocale: (l: Locale) => void; children: ReactNode }) {
  const { t } = useI18n();
  const signedIn = mode === "in";
  return (
    <div className={`as ${mode}`}>
      <header className="as-top">
        <a className="as-brand" href="#/arena" aria-label="Arena">
          <span className="as-logo" aria-hidden="true" />
          <span className="as-word">
            beebots<em>arena</em>
          </span>
          <span className="as-live" aria-hidden="true">
            <i />
            LIVE
          </span>
        </a>
        <div className="as-top-end">
          {mode === "out" && (
            <a className="as-link" href="#/arena/ranking">
              {t("nav.board")}
            </a>
          )}
          <LanguagePicker onPick={onPickLocale} />
          {mode === "out" && (
            <a className="as-signin" href="#/arena" onClick={() => setTimeout(() => document.getElementById("arena-email")?.focus(), 50)}>
              {t("nav.signIn")}
            </a>
          )}
        </div>
      </header>
      <div className="as-frame">
        {signedIn && (
          <nav className="as-side" aria-label={t("nav.main")}>
            {ITEMS.map((i) => (
              <a key={i.tab} href={i.href} className={`${tab === i.tab ? "on" : ""} ${i.tab === "new" ? "cta" : ""}`} aria-current={tab === i.tab ? "page" : undefined}>
                <Icon name={i.tab} />
                {t(i.key)}
              </a>
            ))}
          </nav>
        )}
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
