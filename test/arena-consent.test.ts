import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { DEFAULT_LOCALE, isLocale, LOCALES, localeOr } from "../src/arena/locales.js";
import type { Mailer } from "../src/arena/mailer.js";
import { signInMail } from "../src/arena/mailText.js";
import { ArenaStore, CONSENT_ITEMS, CONSENT_VERSION } from "../src/arena/store.js";

class Inbox implements Mailer {
  sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(to: string, subject: string, text: string) {
    this.sent.push({ to, subject, text });
  }
}
const good = { name: "Fluffy", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." };

function world() {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-consent-")));
  const inbox = new Inbox();
  const clock = { t: 1_700_000_000_000 };
  const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test", now: () => clock.t });
  const api = new ArenaApi(auth, store, { secureCookie: true, now: () => clock.t });
  const login = async (email: string, locale?: string) => {
    await auth.requestLink(email, "1.1.1.1", locale);
    const v = auth.verify(inbox.sent.at(-1)!.text.match(/token=([\w-]+)/)![1])!;
    return { cookie: `arena_session=${v.session}`, user: v.user };
  };
  return { store, inbox, auth, api, login, clock };
}
async function call(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path);
  return { status, body: JSON.parse(text || "{}") as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("languages", () => {
  it("English plus five, English as the fallback", () => {
    expect(LOCALES).toEqual(["en", "pt-BR", "es", "fr", "de", "it"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(isLocale("de")).toBe(true);
    expect(isLocale("xx")).toBe(false);
    expect(isLocale(5)).toBe(false);
    expect(localeOr("fr")).toBe("fr");
    expect(localeOr("klingon")).toBe("en");
    expect(localeOr(undefined)).toBe("en");
  });

  it("the sign-in e-mail exists in every language and always carries the link and the 15 minutes", () => {
    const seen = new Set<string>();
    for (const l of LOCALES) {
      const m = signInMail(l, "https://x.test/#/arena/verify?token=abc");
      expect(m.text).toContain("https://x.test/#/arena/verify?token=abc");
      expect(m.text).toContain("15");
      seen.add(m.subject);
    }
    expect(seen.size).toBe(LOCALES.length); // six different subjects
  });

  it("the e-mail is sent in the language asked for, and English for anything unknown", async () => {
    const w = world();
    await w.auth.requestLink("ana@example.com", "1.1.1.1", "de");
    expect(w.inbox.sent[0]!.subject).toBe(signInMail("de", "x").subject);
    await w.auth.requestLink("bob@example.com", "1.1.1.2", "klingon");
    expect(w.inbox.sent[1]!.subject).toBe(signInMail("en", "x").subject);
    await w.auth.requestLink("cy@example.com", "1.1.1.3");
    expect(w.inbox.sent[2]!.subject).toBe(signInMail("en", "x").subject);
  });

  it("a member's language is stored, validated, and shown back", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    expect(w.store.userById(ana.user.id)!.locale).toBe("en");
    expect((await call(w.api, "POST", "/arena/account/locale", { locale: "pt-BR" }, ana.cookie)).body).toEqual({ locale: "pt-BR" });
    expect((await call(w.api, "GET", "/arena/me", undefined, ana.cookie)).body.user.locale).toBe("pt-BR");
    expect((await call(w.api, "POST", "/arena/account/locale", { locale: "xx" }, ana.cookie)).status).toBe(400);
    expect((await call(w.api, "POST", "/arena/account/locale", { locale: "de" })).status).toBe(401);
  });

  it("old directories get the language column", () => {
    const root = mkdtempSync(join(tmpdir(), "arena-loc-"));
    const s1 = new ArenaStore(root);
    s1.createUser("d".repeat(32), "d@example.com", 1);
    s1.dir.exec("ALTER TABLE users DROP COLUMN locale");
    s1.close();
    expect(new ArenaStore(root).userById("d".repeat(32))!.locale).toBe("en");
  });
});

describe("consent", () => {
  it("a new member has to accept, and accepting is recorded with the version and the time, nothing else", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    const me = await call(w.api, "GET", "/arena/me", undefined, ana.cookie);
    expect(me.body.consent).toEqual({ needed: true, version: CONSENT_VERSION, items: [...CONSENT_ITEMS] });
    const ok = await call(w.api, "POST", "/arena/account/consent", { terms: true, simulated: true, age: true }, ana.cookie);
    expect(ok.body).toEqual({ consent: { needed: false, version: CONSENT_VERSION } });
    const rows = w.store.dir.prepare("SELECT * FROM consents").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(CONSENT_ITEMS.length);
    expect(Object.keys(rows[0]!).sort()).toEqual(["item", "ts", "user_id", "version"]);
    expect((await call(w.api, "GET", "/arena/me", undefined, ana.cookie)).body.consent.needed).toBe(false);
  });

  it("a partial acceptance is no acceptance", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    for (const partial of [{}, { terms: true }, { terms: true, simulated: true }, { terms: true, simulated: true, age: "yes" }, { terms: true, simulated: false, age: true }]) {
      const r = await call(w.api, "POST", "/arena/account/consent", partial, ana.cookie);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("consent_incomplete");
    }
    expect(w.store.consentNeeded(ana.user.id)).toBe(true);
    expect((await call(w.api, "POST", "/arena/account/consent", { terms: true, simulated: true, age: true })).status).toBe(401);
  });

  it("nothing that creates or changes an agent works before acceptance", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    for (const [path, body] of [["/arena/bots/create", good], ["/arena/bots/update", { ...good, id: "x" }], ["/arena/bots/delete", { id: "x" }], ["/arena/bots/versions", { id: "x" }], ["/arena/ai/design", { description: "a calm agent that buys dips" }], ["/arena/ai/portrait", { id: "x" }]] as const) {
      const r = await call(w.api, "POST", path, body, ana.cookie);
      expect([path, r.status, r.body.code]).toEqual([path, 403, "consent_required"]);
    }
    expect((await call(w.api, "GET", "/arena/bots", undefined, ana.cookie)).status).toBe(200); // reading their own list is fine
    w.store.acceptConsent(ana.user.id, 1);
    expect((await call(w.api, "POST", "/arena/bots/create", good, ana.cookie)).status).toBe(200);
  });

  it("leaving is always possible: deleting the account needs no acceptance and removes the record", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    w.store.acceptConsent(ana.user.id, 1);
    const gone = await call(w.api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, ana.cookie);
    expect(gone.status).toBe(200);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM consents").get()).toEqual({ n: 0 });
    const bob = await login2(w);
    expect(bob).toBeTruthy();
  });

  it("a new version of the terms asks everyone again", () => {
    const w = world();
    const u = w.store.createUser("c".repeat(32), "c@example.com", 1);
    w.store.acceptConsent(u.id, 1);
    expect(w.store.consentNeeded(u.id)).toBe(false);
    w.store.dir.prepare("UPDATE consents SET version = 'older' WHERE user_id = ?").run(u.id);
    expect(w.store.consentNeeded(u.id)).toBe(true);
  });

  it("the sign-in form still answers the same for everyone (consent is asked after the link, not on the form)", async () => {
    const w = world();
    await w.login("ana@example.com");
    const known = await call(w.api, "POST", "/arena/auth/request", { email: "ana@example.com", locale: "fr" });
    const unknown = await call(w.api, "POST", "/arena/auth/request", { email: "new@example.com", locale: "fr" });
    expect(known).toEqual(unknown);
  });

  it("error text says agent, not bunny or bot", async () => {
    const w = world();
    const ana = await w.login("ana@example.com");
    w.store.acceptConsent(ana.user.id, 1);
    await call(w.api, "POST", "/arena/bots/create", good, ana.cookie);
    const second = await call(w.api, "POST", "/arena/bots/create", { ...good, name: "Another" }, ana.cookie);
    expect(second.body.error).toMatch(/one agent/);
    const missing = await call(w.api, "POST", "/arena/bots/delete", { id: "zzzzzzzzzzzz" }, ana.cookie);
    expect(missing.body.error).toBe("Agent not found.");
  });
});

async function login2(w: ReturnType<typeof world>) {
  return w.login("bob@example.com");
}
