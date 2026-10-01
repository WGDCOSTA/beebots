import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DICTS } from "../dashboard/src/i18n/dicts.js";
import { en } from "../dashboard/src/i18n/en.js";
import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, LOCALES } from "../dashboard/src/i18n/locales.js";
import { markersOf, missingKeys, translate } from "../dashboard/src/i18n/translate.js";
import { DEFAULT_LOCALE as SERVER_DEFAULT, LOCALES as SERVER_LOCALES } from "../src/arena/locales.js";

describe("the language list", () => {
  it("is English plus five, and the page and the server agree on it", () => {
    expect(LOCALES).toHaveLength(6);
    expect([...LOCALES]).toEqual([...SERVER_LOCALES]);
    expect(DEFAULT_LOCALE).toBe(SERVER_DEFAULT);
    expect(DEFAULT_LOCALE).toBe("en");
  });
  it("every language has a name in its own words and a dictionary", () => {
    for (const l of LOCALES) {
      expect(LOCALE_NAMES[l].length).toBeGreaterThan(1);
      expect(DICTS[l]).toBeTruthy();
    }
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("fr-CA")).toBe(false);
  });
});

describe("translate", () => {
  it("uses the language, then English, then the key", () => {
    expect(translate(DICTS, "de", "nav.home")).toBe("Start");
    expect(translate(DICTS, "en", "nav.home")).toBe("Home");
    const partial = { ...DICTS, fr: { "nav.home": "Accueil" } };
    expect(translate(partial, "fr", "nav.board")).toBe("Board"); // missing in French: English
    expect(translate(partial, "fr", "no.such.key")).toBe("no.such.key"); // missing everywhere: the key shows
  });
  it("fills {markers} and leaves unknown ones alone", () => {
    expect(translate(DICTS, "en", "signin.inbox.body", { email: "ana@example.com" })).toContain("ana@example.com");
    expect(translate(DICTS, "en", "signin.resendIn", { s: 12 })).toBe("Send again in 12s");
    expect(translate(DICTS, "en", "signin.resendIn")).toBe("Send again in {s}s");
  });
});

describe("the dictionaries", () => {
  const keys = Object.keys(en);
  for (const l of LOCALES.filter((x) => x !== "en")) {
    it(`${l}: only known keys, no empty strings, the same {markers} as English`, () => {
      for (const [k, v] of Object.entries(DICTS[l])) {
        expect(keys, `${l} has an unknown key ${k}`).toContain(k);
        expect(v.trim().length, `${l} ${k} is empty`).toBeGreaterThan(0);
        expect(markersOf(v), `${l} ${k} markers`).toEqual(markersOf(en[k as keyof typeof en]));
      }
    });
    it(`${l}: covers every step-1 string (nothing falls back to English)`, () => {
      expect(missingKeys(DICTS, l)).toEqual([]);
    });
    it(`${l}: says "agent" in its own word, never "bot" or "bunny", and is not a copy of English`, () => {
      const text = Object.values(DICTS[l]).join(" ");
      expect(text).not.toMatch(/\b(bot|bots|bunny|bunnies)\b/i);
      const same = Object.entries(DICTS[l]).filter(([k, v]) => v === en[k as keyof typeof en]).map(([k]) => k);
      // some words are the same everywhere (the brand, "Cookies", "Long", "Short", "Momentum", "Pro"); a real translation does not copy most of the file
      expect(same.length, `copied from English: ${same.join(", ")}`).toBeLessThan(20);
    });
  }
  it("English has no empty strings and uses the word agent", () => {
    for (const [k, v] of Object.entries(en)) expect(v.trim().length, k).toBeGreaterThan(0);
    expect(en["nav.new"]).toBe("New agent");
  });
});

describe("the code only asks for keys that exist", () => {
  const dir = join(__dirname, "..", "dashboard", "src");
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx") && /^Arena(Shell|Landing|SignIn|Consent|Legal|Me|Page|Plans|Ranking|Home|Agent|New|Fields|Parts|Decisions|Settings)\./.test(f));
  const used = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]!);
    for (const m of src.matchAll(/\bkey: "([\w.]+)"/g)) used.add(m[1]!);
  }
  // The pure model names keys as string literals (the page translates them): any literal there that is an English key is a use.
  const model = readFileSync(join(dir, "arenaModel.ts"), "utf8");
  for (const m of model.matchAll(/"([a-z]+(?:\.[\w]+)+)"/g)) if (m[1]! in en) used.add(m[1]!);
  // keys chosen by a condition or a lookup in the page
  for (const k of ["home.quotaFull1", "home.quotaFull", "home.loadError", "trade.buy", "trade.sell", "dec.ruleActed", "dec.ruleBlocked", "set.paint", "set.repaint", "new.tpl.steady", "new.tpl.breakout", "new.tpl.momentum", "plans.paid", "plans.paidDone"]) used.add(k);
  // keys built from a variable
  for (const s of ["start", "look", "style", "rules", "review"]) used.add(`new.step.${s}`);
  for (const s of ["performance", "decisions", "versions", "settings"]) used.add(`agent.tab.${s}`);
  for (const n of ["1", "2", "3"]) for (const p of ["t", "b"]) used.add(`landing.how${n}.${p}`);
  for (const i of ["terms", "sim", "age"]) used.add(`consent.${i}.t`);
  for (const i of ["terms", "sim"]) used.add(`consent.${i}.b`);
  for (const d of ["terms", "privacy", "risk", "cookies"]) used.add(`legal.${d}`);
  it("finds the keys in use", () => expect(used.size).toBeGreaterThan(40));
  it("every key the pages use is in English", () => {
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });
  it("every English key is used by some page (no dead strings)", () => {
    const dead = Object.keys(en).filter((k) => !used.has(k));
    expect(dead).toEqual([]);
  });
});
