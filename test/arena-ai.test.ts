import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AI_CREDITS, AiError, MemberAi, type AiService } from "../src/arena/ai.js";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Bots, styleCoinProblem } from "../src/arena/bots.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaStore } from "../src/arena/store.js";
import type { BeeDesign } from "../src/openai.js";

const design = (over: Partial<BeeDesign> = {}): BeeDesign => ({ name: "Sleepy Quant", tagline: "the sleepy dip hunter", rules: "Buy small dips in BTC and ETH, stay flat when unsure.", coins: ["BTC", "ETH"], baseStyle: "breezy", look: "a sleepy bunny in a nightcap", ...over });

class FakeAi implements AiService {
  designs = 0;
  paints = 0;
  next: BeeDesign | Error = design();
  fail = false;
  async design(): Promise<BeeDesign> {
    this.designs++;
    if (this.fail) throw new Error("provider down");
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
  async paint(): Promise<Buffer> {
    this.paints++;
    if (this.fail) throw new Error("provider down");
    return Buffer.from("fake-jpeg");
  }
}

function setup(tier: "free" | "pro" = "free", ai: AiService | null = new FakeAi(), dailyLimit = 100) {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-ai-")));
  const u = store.createUser("a".repeat(32), "ana@example.com", 1);
  const t = Date.UTC(2026, 8, 30, 12);
  const member = new MemberAi(store.tenant(u.id), tier, ai, { now: () => t, dailyLimit, today: (d, a) => store.aiToday(d, a) });
  const bots = new Bots(store.tenant(u.id), tier, () => t);
  return { store, u, member, bots, ai: ai as FakeAi };
}
const rejects = async (p: Promise<unknown>, status: number) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AiError);
    expect((e as AiError).status).toBe(status);
    return (e as AiError).message;
  }
  throw new Error("did not reject");
};
const form = { theme: "bunnies", avatar: "scout" };

describe("free AI design for the first bot", () => {
  it("is off when the platform has no key", async () => {
    const s = setup("free", null);
    expect(s.member.status()).toMatchObject({ enabled: false, canDesign: false });
    await rejects(s.member.design("a calm bunny that buys dips"), 503);
  });

  it("turns a sentence into a full draft, ready to review", async () => {
    const s = setup();
    const d = await s.member.design("a calm bunny that buys dips");
    expect(d).toMatchObject({ name: "Sleepy Quant", tagline: "the sleepy dip hunter", style: "breezy", coins: ["BTC", "ETH"], look: "a sleepy bunny in a nightcap" });
    // the draft passes the same validation as a hand-made bunny
    expect(s.bots.create({ ...form, ...d }).name).toBe("Sleepy Quant");
  });

  it("checks the description", async () => {
    const s = setup();
    await rejects(s.member.design("short"), 400);
    await rejects(s.member.design("x".repeat(401)), 400);
    await rejects(s.member.design(42), 400);
    expect(s.ai.designs).toBe(0);
  });

  it("gives three tries for life, and only before the first bunny exists", async () => {
    const s = setup();
    for (let i = 0; i < AI_CREDITS.designs; i++) await s.member.design("a calm bunny that buys dips");
    expect(await rejects(s.member.design("a calm bunny that buys dips"), 403)).toMatch(/free AI tries/);
    const t = setup();
    t.bots.create({ ...form, name: "Mine", style: "breezy", coins: ["BTC"], rules: "Trade carefully always." });
    expect(await rejects(t.member.design("a calm bunny that buys dips"), 403)).toMatch(/first agent/);
  });

  it("deleting the first bunny does not bring the free design back", async () => {
    const s = setup();
    const b = s.bots.create({ ...form, name: "Mine", style: "breezy", coins: ["BTC"], rules: "Trade carefully always." });
    s.bots.remove(b.id);
    expect(s.member.status()).toMatchObject({ canDesign: false, portraitBotId: null });
    await rejects(s.member.design("a calm bunny that buys dips"), 403);
  });

  it("a provider failure costs the platform's budget but not the member's try", async () => {
    const s = setup();
    s.ai.fail = true;
    await rejects(s.member.design("a calm bunny that buys dips"), 502);
    expect(s.member.status().designsLeft).toBe(AI_CREDITS.designs);
    expect(s.store.aiToday("2026-09-30")).toBe(1);
  });

  it("stops at the platform's daily budget", async () => {
    const s = setup("free", new FakeAi(), 2);
    await s.member.design("a calm bunny that buys dips");
    await s.member.design("a calm bunny that buys dips");
    expect(await rejects(s.member.design("a calm bunny that buys dips"), 503)).toMatch(/limit for today/);
  });

  it("refuses the official names and unknown coins with a message, and counts the try", async () => {
    const s = setup();
    s.ai.next = design({ name: "Bizzy Bunny" });
    expect(await rejects(s.member.design("a calm bunny that buys dips"), 422)).toMatch(/official/);
    expect(s.member.status().designsLeft).toBe(AI_CREDITS.designs - 1);
    s.ai.next = design({ coins: ["NOTACOIN"] });
    await rejects(s.member.design("a calm bunny that buys dips"), 422);
  });

  it("fits the design to the Free plan and says so", async () => {
    const s = setup();
    s.ai.next = design({ baseStyle: "boozy", coins: ["SOL", "HYPE"] });
    expect(await s.member.design("a bunny that chases momentum")).toMatchObject({ style: "bizzy", coins: ["SOL", "HYPE"] });
    const t = setup();
    t.ai.next = design({ baseStyle: "boozy", coins: ["XRP", "DOGE"] });
    const d = await t.member.design("a bunny that chases momentum");
    expect(d.style).toBe("breezy");
    expect(d.coins).toEqual(["BTC"]);
    expect(d.note).toMatch(/Free plan/);
    expect(t.bots.create({ ...form, ...d }).style).toBe("breezy");
    const p = setup("pro");
    p.ai.next = design({ baseStyle: "boozy", coins: ["XRP", "DOGE"] });
    expect(await p.member.design("a bunny that chases momentum")).toMatchObject({ style: "boozy", coins: ["XRP", "DOGE"] });
  });
});

describe("style and coins", () => {
  it("a style that cannot trade the coins is refused with the reason", () => {
    expect(styleCoinProblem("breezy", ["BTC", "SOL"])).toMatch(/BTC, ETH/);
    expect(styleCoinProblem("bizzy", ["SOL", "HYPE"])).toBeNull();
    expect(styleCoinProblem("boozy", ["XRP"])).toBeNull();
    const s = setup();
    expect(() => s.bots.create({ ...form, name: "Mismatch", style: "breezy", coins: ["BTC", "SOL"], rules: "Trade carefully always." })).toThrow(/only trades/);
  });

  it("tagline and look are stored as in the admin panel", () => {
    const s = setup();
    const b = s.bots.create({ ...form, name: "Mine", style: "breezy", coins: ["BTC"], rules: "Trade carefully always.", tagline: "  sleepy   hunter ", look: "a bunny   in a hat" });
    expect(b).toMatchObject({ tagline: "the sleepy hunter", look: "a bunny in a hat", image: false });
  });
});

describe("the portrait", () => {
  const mk = () => {
    const s = setup();
    const b = s.bots.create({ ...form, name: "Mine", style: "breezy", coins: ["BTC"], rules: "Trade carefully always.", look: "a sleepy bunny" });
    return { ...s, b };
  };

  it("is painted for the first bunny, kept privately, and then a try is spent", async () => {
    const s = mk();
    expect(s.member.status().portraitBotId).toBe(s.b.id);
    const jpg = await s.member.paint(s.b);
    s.store.savePortrait(s.u.id, s.b.id, jpg);
    s.bots.setImage(s.b.id, true);
    expect(s.bots.find(s.b.id).image).toBe(true);
    expect(s.store.readPortrait(s.u.id, s.b.id)?.toString()).toBe("fake-jpeg");
    expect(s.member.status().portraitsLeft).toBe(AI_CREDITS.portraits - 1);
  });

  it("is not free for a second bunny, and runs out after two", async () => {
    const s = setup("pro");
    const one = s.bots.create({ ...form, name: "One", style: "breezy", coins: ["BTC"], rules: "Trade carefully always." });
    const two = s.bots.create({ ...form, name: "Two", style: "breezy", coins: ["BTC"], rules: "Trade carefully always." });
    await rejects(s.member.paint(two), 403);
    await s.member.paint(one);
    await s.member.paint(one);
    expect(await rejects(s.member.paint(one), 403)).toMatch(/used your free portraits/);
  });

  it("a failure does not spend the member's try", async () => {
    const s = mk();
    s.ai.fail = true;
    await rejects(s.member.paint(s.b), 502);
    expect(s.member.status().portraitsLeft).toBe(AI_CREDITS.portraits);
  });

  it("portrait paths cannot be chosen by a caller", () => {
    const s = mk();
    for (const bad of ["../x", "..", "", "zz", "0".repeat(12) + "/"]) expect(() => s.store.readPortrait(s.u.id, bad)).toThrow();
    expect(() => s.store.readPortrait("f".repeat(32), "0".repeat(12))).toThrow();
  });
});

describe("old databases", () => {
  it("get the new bot columns without losing rows", () => {
    const root = mkdtempSync(join(tmpdir(), "arena-mig-"));
    const store = new ArenaStore(root);
    const u = store.createUser("c".repeat(32), "old@example.com", 1);
    const old = new DatabaseSync(join(root, "tenants", `${u.id}.db`));
    old.exec("CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, avatar TEXT NOT NULL, style TEXT NOT NULL, coins TEXT NOT NULL, rules TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    old.prepare("INSERT INTO bots VALUES ('aaaaaaaaaaaa', 'Old', 'bunnies', 'scout', 'breezy', '[\"BTC\"]', 'Trade carefully always.', 1, 1)").run();
    old.close();
    const bots = new Bots(store.tenant(u.id), "free");
    expect(bots.list()[0]).toMatchObject({ name: "Old", tagline: "", look: "", image: false });
  });
});

// HTTP
class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  let type = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number, h?: Record<string, string>) => void ((status = s), (type = h?.["content-type"] ?? "")), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path);
  return { status, type, text, body: type.includes("json") ? (JSON.parse(text || "{}") as Record<string, unknown>) : {} };
}

describe("HTTP", () => {
  it("design, create, paint, serve the portrait to its owner only, and clean up", async () => {
    const root = mkdtempSync(join(tmpdir(), "arena-aihttp-"));
    const store = new ArenaStore(root);
    const inbox = new Inbox();
    const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, store, { secureCookie: true, ai: new FakeAi() });
    const login = async (email: string) => {
      await auth.requestLink(email, "1.1.1.1");
      const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
      store.acceptConsent(v.user.id, 1);
      return `arena_session=${v.session}`;
    };
    const ana = await login("ana@example.com");
    const bob = await login("bob@example.com");
    expect((await http(api, "GET", "/arena/ai/status")).status).toBe(401);
    expect((await http(api, "GET", "/arena/ai/status", undefined, ana)).body).toMatchObject({ enabled: true, canDesign: true, designsLeft: 3 });
    const d = await http(api, "POST", "/arena/ai/design", { description: "a calm bunny that buys dips" }, ana);
    expect(d.status).toBe(200);
    const draft = d.body.draft as Record<string, unknown>;
    const made = await http(api, "POST", "/arena/bots/create", { ...form, ...draft }, ana);
    expect(made.status).toBe(200);
    const id = (made.body.bot as { id: string }).id;
    const painted = await http(api, "POST", "/arena/ai/portrait", { id }, ana);
    expect(painted.status).toBe(200);
    expect((painted.body.bot as { image: boolean }).image).toBe(true);
    const img = await http(api, "GET", `/arena/bot-image/${id}`, undefined, ana);
    expect([img.status, img.type, img.text]).toEqual([200, "image/jpeg", "fake-jpeg"]);
    expect((await http(api, "GET", `/arena/bot-image/${id}`, undefined, bob)).status).toBe(404);
    expect((await http(api, "GET", `/arena/bot-image/${id}`)).status).toBe(401);
    expect((await http(api, "POST", "/arena/ai/portrait", { id }, bob)).status).toBe(404);
    const u = auth.user(ana.split("=")[1])!;
    expect((await http(api, "POST", "/arena/bots/delete", { id }, ana)).status).toBe(200);
    expect(store.readPortrait(u.id, id)).toBeNull();
    // account deletion removes the member's folder too
    store.savePortrait(u.id, "0".repeat(12), Buffer.from("x"));
    store.deleteUser(u.id, 1);
    expect(() => store.readPortrait(u.id, "0".repeat(12))).toThrow();
    expect(existsSync(join(root, "tenants", u.id))).toBe(false);
  });
});
