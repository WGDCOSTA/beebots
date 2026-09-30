// Looking a string up: the member's language first, English if it is missing there, the key itself as a last resort (so a typo
// shows up on screen instead of as a blank). {name} markers are filled from the values given. No React, so it is tested from the root suite.
import type { Locale } from "./locales.js";

export type Dict = Record<string, string>;

export function translate(dicts: Record<Locale, Dict>, locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = dicts[locale][key] ?? dicts.en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : raw;
}

/** Keys of English that a language does not have yet (they fall back to English on screen). */
export const missingKeys = (dicts: Record<Locale, Dict>, locale: Locale): string[] => Object.keys(dicts.en).filter((k) => !(k in dicts[locale]));

/** The {markers} in a string, sorted, so a translation can be checked against English. */
export const markersOf = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
