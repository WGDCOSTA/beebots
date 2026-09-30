import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { BotError, Bots, LIMITS } from "../src/arena/bots.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaStore } from "../src/arena/store.js";
import { THEMES } from "../src/arena/themes.js";

const good = { name: "Fluffy Quant", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC", "eth"], rules: "Trade carefully, cut losses early." };

function member(tier: "free" | "pro" = "free", email = "ana@example.com") {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-bots-")));
  const u = store.createUser("a".repeat(32), email, 1);
  if (tier === "pro") store.dir.prepare("UPDATE users SET tier = 'pro' WHERE id = ?").run(u.id);
  return { store, u, bots: new Bots(store.tenant(u.id), tier, () => 1000) };
}
const fails = (fn: () => unknown, status?: number) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BotError);
    if (status) expect((e as BotError).status).toBe(status);
    return (e as BotError).message;
  }
  throw new Error("did not throw");
};

describe("themes", () => {
  it("every theme has avatars with unique ids and no real-person or known-IP names", () => {
    for (const t of THEMES) {
      expect(t.avatars.length).toBeGreaterThan(0);
      expect(new Set(t.avatars.map((a) => a.id)).size).toBe(t.avatars.length);
    }
    const all = JSON.stringify(THEMES).toLowerCase();
    for (const banned of ["batman", "superman", "spider", "mario", "pikachu", "trump", "musk", "pepe", "doge"]) expect(all).not.toContain(banned);
  });
});

describe("creating a bot", () => {
  it("stores a clean bot with version 1", () => {
    const { bots } = member();
    const b = bots.create({ ...good, name: "  Fluffy   Quant " });
    expect(b).toMatchObject({ name: "Fluffy Quant", coins: ["BTC", "ETH"], version: 1, style: "breezy" });
    expect(bots.list()).toHaveLength(1);
  });

  it("Free has one bot; Pro has more", () => {
    const f = member("free").bots;
    f.create(good);
    expect(fails(() => f.create({ ...good, name: "Second" }), 403)).toMatch(/one agent/);
    const p = member("pro").bots;
    for (let i = 0; i < LIMITS.pro.bots; i++) p.create({ ...good, name: `Bot ${i}a` });
    fails(() => p.create({ ...good, name: "One too many" }), 403);
  });

  it("gates styles, coins and theme packs by plan", () => {
    const f = member("free").bots;
    fails(() => f.create({ ...good, style: "boozy" }), 403);
    fails(() => f.create({ ...good, coins: ["BTC", "ETH", "SOL", "HYPE"] }), 403);
    fails(() => f.create({ ...good, theme: "zombies", avatar: "walker" }), 403);
    const p = member("pro").bots;
    expect(p.create({ ...good, style: "boozy", theme: "zombies", avatar: "walker", coins: ["BTC", "ETH", "SOL", "HYPE", "XRP"] }).style).toBe("boozy");
  });

  it("rejects bad input", () => {
    const { bots } = member("pro");
    for (const bad of [
      { name: "" },
      { name: "x" },
      { name: "a".repeat(25) },
      { name: "<script>" },
      { theme: "nope" },
      { avatar: "walker" },
      { style: "yolo" },
      { coins: [] },
      { coins: ["BTC", "SCAM"] },
      { coins: "BTC" },
      { rules: "short" },
      { rules: "x".repeat(501) },
    ])
      fails(() => bots.create({ ...good, ...bad }), 400);
  });

  it("refuses the Warren's own names and duplicates, case-insensitively", () => {
    const { bots } = member("pro");
    expect(fails(() => bots.create({ ...good, name: "Bizzy Bunny" }))).toMatch(/official agents/);
    bots.create(good);
    expect(fails(() => bots.create({ ...good, name: "fluffy quant" }))).toMatch(/already/);
  });
});

describe("editing and deleting", () => {
  it("rules, style or coins make a new version; cosmetics do not", () => {
    const { bots } = member("pro");
    const b = bots.create(good);
    expect(bots.update(b.id, { ...good, name: "Renamed", avatar: "hopper" }).version).toBe(1);
    const v2 = bots.update(b.id, { ...good, name: "Renamed", rules: "Trade carefully, cut losses even earlier." });
    expect(v2.version).toBe(2);
    expect(bots.versions(b.id).map((v) => v.version)).toEqual([2, 1]);
    expect(bots.versions(b.id)[1]!.rules).toBe(good.rules);
    expect(bots.update(b.id, { ...good, name: "Renamed", coins: ["ETH"], rules: v2.rules }).version).toBe(3);
  });

  it("a bot may keep its own name on edit", () => {
    const { bots } = member();
    const b = bots.create(good);
    expect(bots.update(b.id, good).name).toBe("Fluffy Quant");
  });

  it("deleting frees the slot and removes the history", () => {
    const { bots } = member();
    const b = bots.create(good);
    bots.remove(b.id);
    expect(bots.list()).toEqual([]);
    fails(() => bots.versions(b.id), 404);
    expect(bots.create(good).version).toBe(1);
  });

  it("unknown ids are a 404", () => {
    const { bots } = member();
    fails(() => bots.update("nope", good), 404);
    fails(() => bots.remove(undefined), 404);
  });
});

describe("isolation", () => {
  it("one member's bots are invisible to another", () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-iso-")));
    const ana = store.createUser("a".repeat(32), "ana@example.com", 1);
    const bob = store.createUser("b".repeat(32), "bob@example.com", 1);
    const a = new Bots(store.tenant(ana.id), "free");
    const b = new Bots(store.tenant(bob.id), "free");
    const mine = a.create(good);
    expect(b.list()).toEqual([]);
    fails(() => b.update(mine.id, good), 404);
    fails(() => b.remove(mine.id), 404);
    b.create(good);
    expect(a.list()).toHaveLength(1);
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
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = t) });
  await api.handle(req as never, res as never, path);
  return { status, body: JSON.parse(text || "{}") as Record<string, unknown> };
}

describe("HTTP", () => {
  it("needs a session, then creates, lists, edits and deletes", async () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-http-")));
    const inbox = new Inbox();
    const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, store, { secureCookie: true });
    expect((await http(api, "GET", "/arena/bots")).status).toBe(401);
    expect((await http(api, "POST", "/arena/bots/create", good)).status).toBe(401);
    const cat = await http(api, "GET", "/arena/catalogue");
    expect(cat.status).toBe(200);
    expect((cat.body.themes as unknown[]).length).toBe(THEMES.length);

    await auth.requestLink("ana@example.com", "1.1.1.1");
    const verified = auth.verify(inbox.sent[0]!.match(/token=([\w-]+)/)![1])!;
    store.acceptConsent(verified.user.id, 1);
    const session = verified.session;
    const cookie = `arena_session=${session}`;
    const made = await http(api, "POST", "/arena/bots/create", good, cookie);
    expect(made.status).toBe(200);
    const id = (made.body.bot as { id: string }).id;
    expect(((await http(api, "GET", "/arena/bots", undefined, cookie)).body.bots as unknown[]).length).toBe(1);
    expect((await http(api, "POST", "/arena/bots/create", { ...good, name: "Another" }, cookie)).status).toBe(403);
    expect((await http(api, "POST", "/arena/bots/update", { ...good, id, rules: "A different plan, written clearly." }, cookie)).body).toMatchObject({ bot: { version: 2 } });
    expect((await http(api, "POST", "/arena/bots/versions", { id }, cookie)).body.versions).toHaveLength(2);
    expect((await http(api, "POST", "/arena/bots/delete", { id }, cookie)).status).toBe(200);
    expect(((await http(api, "GET", "/arena/bots", undefined, cookie)).body.bots as unknown[]).length).toBe(0);
    // a member cannot raise their own plan through the API
    expect((await http(api, "POST", "/arena/bots/create", { ...good, tier: "pro", style: "boozy" }, cookie)).status).toBe(403);
    expect(store.userById(auth.user(session)!.id)!.tier).toBe("free");
  });
});
