import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { fillOperator, LEGAL, OPERATOR_FIELDS } from "../dashboard/src/legalText.js";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth, SESSION_TTL_MS, TOKEN_TTL_MS } from "../src/arena/auth.js";
import { PLAN_PRICES, QUARANTINE_DAYS } from "../src/arena/plans.js";
import { ArenaStore, AUDIT_KEEP_DAYS, AUDIT_KEEP_DAYS_TOKENS, CONSENT_ITEMS } from "../src/arena/store.js";

const text = (id: keyof typeof LEGAL) => JSON.stringify(LEGAL[id]);
const all = Object.keys(LEGAL) as Array<keyof typeof LEGAL>;
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("the legal texts say what the Arena really does", () => {
  it("quote the retention periods the code uses", () => {
    expect(text("privacy")).toContain(`valid for ${TOKEN_TTL_MS / 60_000} minutes`);
    expect(text("privacy")).toContain(`${SESSION_TTL_MS / 86_400_000} days from your last visit`);
    expect(text("cookies")).toContain(`${SESSION_TTL_MS / 86_400_000} days from your last visit`);
    expect(text("privacy")).toContain(`The security log: ${AUDIT_KEEP_DAYS} days`);
    expect(text("privacy")).toContain(AUDIT_KEEP_DAYS_TOKENS === 1 ? "deleted one day after it expires" : "");
    expect(text("privacy")).toContain("Records of sign-in requests used to limit abuse (address and e-mail): 1 hour");
    // the 1 hour is the window the code uses for its rate limit records
    expect(src("src/arena/auth.ts")).toContain("t - 3_600_000");
  });
  it("name the cookie and the stored preferences the pages really use", () => {
    expect(text("cookies")).toContain("arena_session");
    expect(src("src/arena/api.ts")).toContain('const COOKIE = "arena_session"');
    expect(src("src/arena/api.ts")).toContain("HttpOnly; SameSite=Lax");
    expect(text("cookies")).toContain("arena_locale");
    expect(src("dashboard/src/i18n/I18n.tsx")).toContain('"arena_locale"');
    expect(text("cookies")).toContain("arena_checklist_hidden");
    expect(src("dashboard/src/ArenaHome.tsx")).toContain('"arena_checklist_hidden"');
  });
  it("do not mention a cookie or storage key the pages do not use", () => {
    const used = new Set<string>();
    for (const f of readFileSync(join(__dirname, "..", "dashboard/src/ArenaHome.tsx"), "utf8").matchAll(/"(arena_[a-z_]+)"/g)) used.add(f[1]!);
    for (const f of readFileSync(join(__dirname, "..", "dashboard/src/i18n/I18n.tsx"), "utf8").matchAll(/"(arena_[a-z_]+)"/g)) used.add(f[1]!);
    used.add("arena_session");
    for (const m of text("cookies").matchAll(/arena_[a-z_]+/g)) expect(used.has(m[0])).toBe(true);
    // and no analytics or advertising is claimed away while being present
    expect(src("dashboard/src/ArenaShell.tsx")).not.toMatch(/gtag|analytics|pixel/i);
  });
  it("quote the prices and the quarantine of the plans", () => {
    expect(text("terms")).toContain(`€${(PLAN_PRICES.pro.amount / 100).toFixed(2)} per month`);
    expect(text("terms")).toContain(`€${(PLAN_PRICES.premium.amount / 100).toFixed(2)} per month`);
    expect(text("terms")).toContain(`${QUARANTINE_DAYS} days`);
    expect(PLAN_PRICES.pro.currency).toBe("eur");
    expect(PLAN_PRICES.pro.interval).toBe("month");
  });
  it("say 18 or older, as the consent screen asks", () => {
    expect(CONSENT_ITEMS).toContain("age");
    expect(text("terms")).toContain("18 or older");
    expect(text("privacy")).toContain("18 or older");
  });
  it("name the companies that receive personal data, as the code uses them", () => {
    expect(text("privacy")).toContain("Stripe");
    expect(text("privacy")).toContain("Resend");
    expect(text("privacy")).toContain("OpenAI");
    expect(src("src/arena/main.ts")).toContain("ResendMailer");
    expect(src("src/arena/billing.ts")).toContain("api.stripe.com");
    expect(src("src/arena/vault.ts")).toContain("claude");
    for (const p of ["OpenAI", "Anthropic", "Z.ai", "Moonshot"]) expect(text("privacy")).toContain(p);
  });
  it("never claim that real trading is offered, and say plainly that it is not", () => {
    expect(text("risk")).toContain("does not trade real money");
    expect(text("terms")).toContain("Real orders are never sent to any exchange by the Arena");
    expect(src("src/arena/runner.ts")).toContain('DRY_RUN: "true"');
    for (const id of all) expect(text(id)).not.toMatch(/we will (trade|invest) for you/i);
  });
  it("say that features marked coming soon are not part of what a plan includes yet", () => {
    expect(text("terms")).toMatch(/coming soon/);
  });
});

describe("the texts are drafts and say so in the open", () => {
  it("keep every point for counsel visible in the text", () => {
    const open = all.flatMap((id) => [...text(id).matchAll(/\[[^\]]*(?:to confirm|to be filled in)[^\]]*\]/gi)].map((m) => m[0]));
    expect(open.length).toBeGreaterThan(5);
  });
  it("use only operator fields that exist", () => {
    for (const id of all) for (const m of text(id).matchAll(/\{\{operator\.(\w+)\}\}/g)) expect(OPERATOR_FIELDS).toContain(m[1]);
  });
  it("have a section list for every document, with a heading and a body each", () => {
    for (const id of all) {
      expect(LEGAL[id].sections.length).toBeGreaterThan(3);
      for (const s of LEGAL[id].sections) expect((s.p?.length ?? 0) + (s.li?.length ?? 0)).toBeGreaterThan(0);
    }
  });
  it("cover what a notice for this service has to cover", () => {
    const heads = (id: keyof typeof LEGAL) => LEGAL[id].sections.map((s) => s.h.toLowerCase()).join("|");
    for (const w of ["what we collect", "why we use it", "who receives it", "how long we keep it", "your rights", "children", "where it goes"]) expect(heads("privacy")).toContain(w);
    expect(text("privacy")).toContain("Data Protection Commission");
    for (const w of ["your account", "plans and payment", "responsibility", "law and disputes", "ending the agreement"]) expect(heads("terms")).toContain(w);
    expect(text("terms")).toContain("14 days");
    for (const w of ["it is a simulation", "past results", "ai models can be wrong"]) expect(heads("risk")).toContain(w);
  });
});

describe("filling in the operator's details", () => {
  it("replaces what is set and marks what is not, never hiding a gap", () => {
    const parts = fillOperator("By {{operator.name}}, VAT {{operator.vat}}.", { name: "Acme Ltd" });
    expect(parts.map((p) => p.text).join("")).toBe("By Acme Ltd, VAT [vat missing].");
    expect(parts.filter((p) => p.missing).map((p) => p.text)).toEqual(["[vat missing]"]);
    expect(fillOperator("x {{operator.name}}", { name: "   " })[1]).toEqual({ text: "[name missing]", missing: true });
    expect(fillOperator("no fields", {})).toEqual([{ text: "no fields", missing: false }]);
  });
});

describe("the operator endpoint and the forgetting of old records", () => {
  type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  async function get(api: ArenaApi, path: string) {
    const req = Object.assign(Readable.from([]), { method: "GET", url: path, headers: {}, socket: { remoteAddress: "9.9.9.9" } });
    let status = 0;
    let text = "";
    const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
    await api.handle(req as never, res as never, path);
    return { status, body: JSON.parse(text || "{}") as Json };
  }
  const mk = (op?: object) => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-legal-")));
    return { store, api: new ArenaApi(new ArenaAuth(store, { send: async () => {} }, { baseUrl: "https://x.test" }), store, { secureCookie: true, operator: op }) };
  };
  it("is public, empty until set, and the privacy address falls back to the main one", async () => {
    expect((await get(mk().api, "/arena/operator")).body).toEqual({ name: "", address: "", companyNo: "", vat: "", email: "", privacyEmail: "", reviewedOn: "" });
    const r = await get(mk({ name: "Acme Ltd", email: "hi@acme.test", reviewedOn: "2026-11-01" }).api, "/arena/operator");
    expect(r.body).toMatchObject({ name: "Acme Ltd", email: "hi@acme.test", privacyEmail: "hi@acme.test", reviewedOn: "2026-11-01" });
  });
  it("accepts only a real date as the day counsel signed off, so a draft is never labelled reviewed by accident", async () => {
    for (const bad of ["yes", "2026-1-1", "reviewed", ""]) expect((await get(mk({ reviewedOn: bad }).api, "/arena/operator")).body.reviewedOn).toBe("");
  });
  it("forgets expired sign-in links after a day, expired sessions, and the security log after a year", () => {
    const { store } = mk();
    const now = 400 * 86_400_000;
    const D = 86_400_000;
    store.dir.prepare("INSERT INTO login_tokens (hash, email, created_at, expires_at) VALUES ('old', 'a@b.co', ?, ?)").run(now - 3 * D, now - 3 * D + 900_000);
    store.dir.prepare("INSERT INTO login_tokens (hash, email, created_at, expires_at) VALUES ('fresh', 'c@d.co', ?, ?)").run(now - 1000, now + 900_000);
    store.dir.prepare("INSERT INTO login_tokens (hash, email, created_at, expires_at) VALUES ('justexpired', 'e@f.co', ?, ?)").run(now - 1000_000, now - 100_000);
    store.dir.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at, last_seen) VALUES ('s1', 'u', 1, ?, 1)").run(now - 10);
    store.dir.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at, last_seen) VALUES ('s2', 'u', 1, ?, 1)").run(now + 10);
    store.audit("u", "old event", now - 366 * D);
    store.audit("u", "recent event", now - 364 * D);
    store.purgeExpired(now);
    expect((store.dir.prepare("SELECT hash FROM login_tokens ORDER BY hash").all() as Array<{ hash: string }>).map((r) => r.hash)).toEqual(["fresh", "justexpired"]);
    expect((store.dir.prepare("SELECT hash FROM sessions").all() as Array<{ hash: string }>).map((r) => r.hash)).toEqual(["s2"]);
    expect((store.dir.prepare("SELECT event FROM audit").all() as Array<{ event: string }>).map((r) => r.event)).toEqual(["recent event"]);
  });
});
