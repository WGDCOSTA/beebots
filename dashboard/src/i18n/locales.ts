// The languages of the Arena pages. English is the base and the fallback; the other five are drafted translations a native
// speaker should review before launch. The server keeps a twin of this list (src/arena/locales.ts); a test keeps them equal.
export const LOCALES = ["en", "pt-BR", "es", "fr", "de", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** Each language in its own words, for the picker. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "pt-BR": "Português (Brasil)", es: "Español", fr: "Français", de: "Deutsch", it: "Italiano" };

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);
