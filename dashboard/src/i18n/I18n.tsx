// The language of the page: which one is chosen, how to look a string up, and how to change it. A choice the member makes is
// remembered in this browser; a language that comes from their account is used unless they have chosen otherwise here.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DICTS } from "./dicts";
import type { Key } from "./en";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales";
import { translate } from "./translate";

const STORE = "arena_locale";

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(STORE);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

interface Ctx {
  locale: Locale;
  t: (key: Key, vars?: Record<string, string | number>) => string;
  /** The member picked this language: remember it. */
  choose: (l: Locale) => void;
  /** Take the language from the member's account, unless they chose one in this browser. */
  adopt: (l: Locale) => void;
  /** True when the language was chosen in this browser. */
  chosen: boolean;
}

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => stored() ?? DEFAULT_LOCALE);
  const [chosen, setChosen] = useState<boolean>(() => stored() !== null);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const choose = useCallback((l: Locale) => {
    setLocale(l);
    setChosen(true);
    try {
      localStorage.setItem(STORE, l);
    } catch {
      /* private window: the choice lasts until the page is closed */
    }
  }, []);
  const adopt = useCallback((l: Locale) => setLocale((cur) => (stored() === null ? l : cur)), []);

  const value = useMemo<Ctx>(() => ({ locale, chosen, choose, adopt, t: (key, vars) => translate(DICTS, locale, key, vars) }), [locale, chosen, choose, adopt]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useI18n needs an I18nProvider");
  return c;
}
