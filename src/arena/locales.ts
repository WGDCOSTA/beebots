// The languages the Arena speaks. English is the base and the fallback for anything not yet translated; the other five are
// drafted translations that a native speaker should review before launch. The dashboard keeps a twin of this list
// (dashboard/src/i18n/locales.ts) and a test keeps the two equal.
export const LOCALES = ["en", "pt-BR", "es", "fr", "de", "it"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** A locale from a wish, or English. */
export const localeOr = (v: unknown): Locale => (isLocale(v) ? v : DEFAULT_LOCALE);
