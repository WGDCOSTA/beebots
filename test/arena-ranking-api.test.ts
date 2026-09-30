import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import type { Mailer } from "../src/arena/mailer.js";
import { Leaderboard } from "../src/arena/ranking.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { DAY_MS } from "../src/arena/score.js";
import { ArenaStore } from "../src/arena/store.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const MON = Date.UTC(2026, 8, 28);
const STEP = 600_000;
const bot = (name: string, over: Record<string, unknown> = {}) => ({ name, theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC", "ETH"], rules: "Follow the trend on BTC and ETH, cut losses fast.", ...over });

const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;
const llm: LlmClient = {
  brain: "openai",
  model: "fake",
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    return { data: ask.validate.parse({ choice: "LONG_BTC", confidence: 0.9, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 500, outputTokens: 20, latencyMs: 5 };
  },
};

const live: ArenaRunner[] = [];
afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));

describe("the runner samples listed bots for the ranking", () => {
  function world() {
    const root = mkdtempSync(join(tmpdir(), "arena-rs-"));
    const store = new ArenaStore(root);
    const ana = store.createUser("a".repeat(32), "ana@example.com", 1);
    const clock = { t: NOW };
    const leaderboard = new Leaderboard(store.dir, () => clock.t);
    const runner = new ArenaRunner({ store, root, feed: fakeFeed(), decider: new LlmSystemOne(llm), now: () => clock.t, tickMs: 1000, leaderboard });
    live.push(runner);
    return { store, ana, clock, leaderboard, runner, bots: new Bots(store.tenant(ana.id), "free", () => NOW) };
  }

  it("records equity and orders with the public name, never the e-mail", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    w.runner.sample(NOW);
    w.runner.sample(NOW + STEP);
    const pts = w.store.dir.prepare("SELECT * FROM lb_points").all() as Array<{ bot_id: string; equity: number; orders: number }>;
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ bot_id: b.id });
    expect(pts[0]!.orders).toBeGreaterThan(0);
    const listing = w.store.dir.prepare("SELECT * FROM lb_bots").get() as Record<string, unknown>;
    expect(listing).toMatchObject({ name: "Fluffy", handle: w.ana.handle, tier: "free", style: "breezy" });
    expect(JSON.stringify(listing)).not.toContain("ana@example.com");
  });

  it("skips a bot its owner did not list, and removes one that is unlisted later", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy", { listed: false }));
    expect(b.listed).toBe(false);
    await w.runner.update(w.ana.id);
    w.runner.sample(NOW);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM lb_points").get()).toEqual({ n: 0 });
    w.bots.update(b.id, bot("Fluffy", { listed: true }));
    await w.runner.update(w.ana.id);
    w.runner.sample(NOW);
    expect(w.leaderboard.listedBots(w.ana.id)).toEqual([b.id]);
    w.bots.update(b.id, bot("Fluffy", { listed: false }));
    await w.runner.update(w.ana.id);
    expect(w.leaderboard.listedBots(w.ana.id)).toEqual([]);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM lb_points").get()).toEqual({ n: 0 });
  });

  it("a cosmetic edit shows its new name; a new version starts a new entry; forgetting removes everything", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    w.runner.sample(NOW);
    w.bots.update(b.id, bot("Fluffy Two", { avatar: "hopper" }));
    await w.runner.update(w.ana.id);
    w.runner.sample(NOW + STEP);
    expect(w.leaderboard.standings().rows[0]).toMatchObject({ name: "Fluffy Two", avatar: "hopper", version: 1 });
    w.bots.update(b.id, bot("Fluffy Two", { rules: "A different plan, written out clearly." }));
    await w.runner.update(w.ana.id);
    w.runner.sample(NOW + 2 * STEP);
    expect(w.leaderboard.standings().rows[0]).toMatchObject({ version: 2 });
    await w.runner.forget(w.ana.id);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM lb_bots").get()).toEqual({ n: 0 });
  });
});

// HTTP
class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}
interface Json {
  rows: Array<{ name: string; rank: number | null; mine: boolean; handle: string }>;
  season: { id: string; current: boolean };
  minimums: { minDays: number; minTrades: number };
  user: { handle: string };
  bot: { id: string };
  handle: string;
  enabled: boolean;
}
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const [pathname] = path.split("?");
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, pathname!);
  return { status, body: JSON.parse(text || "{}") as Json, text };
}

describe("HTTP: the public leaderboard", () => {
  function setup() {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-lbhttp-")));
    const inbox = new Inbox();
    const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test" });
    const clock = { t: MON + 5 * DAY_MS };
    const leaderboard = new Leaderboard(store.dir, () => clock.t);
    const api = new ArenaApi(auth, store, { secureCookie: true, leaderboard, now: () => clock.t });
    const login = async (email: string) => {
      await auth.requestLink(email, "1.1.1.1");
      const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
      return { cookie: `arena_session=${v.session}`, user: v.user };
    };
    const seed = (userId: string, handle: string, botId: string, name: string, slope: number) => {
      const l = { botId, userId, handle, name, theme: "bunnies", avatar: "scout", style: "breezy", tier: "free", version: 1 };
      const n = Math.floor((4 * DAY_MS) / STEP);
      for (let i = 0; i < n; i++) leaderboard.record(l, 1000 + (i / n) * slope, Math.min(10, i), MON + i * STEP);
    };
    return { store, api, login, seed, leaderboard, clock };
  }

  it("anyone can read it, and it shows only what is meant to be public", async () => {
    const s = setup();
    const ana = await s.login("ana@example.com");
    const bob = await s.login("bob@example.com");
    s.seed(ana.user.id, ana.user.handle, "aaaaaaaaaaaa", "Fluffy", 100);
    s.seed(bob.user.id, bob.user.handle, "bbbbbbbbbbbb", "Nibbles", 40);
    const r = await http(s.api, "GET", "/arena/leaderboard");
    expect(r.status).toBe(200);
    expect(r.body.rows.map((x) => [x.name, x.rank])).toEqual([["Fluffy", 1], ["Nibbles", 2]]);
    expect(r.text).not.toContain("@example.com");
    expect(r.text).not.toContain("rules");
    expect(r.text).not.toContain("userId");
    expect(r.text).not.toContain("user_id");
    expect(r.body.rows.every((x) => x.mine === false)).toBe(true);
    expect(r.body.season).toMatchObject({ id: "2026-W40", current: true });
    expect(r.body.minimums).toMatchObject({ minDays: 3, minTrades: 3 });
  });

  it("marks the signed-in member's own bots, and filters by league", async () => {
    const s = setup();
    const ana = await s.login("ana@example.com");
    const bob = await s.login("bob@example.com");
    s.seed(ana.user.id, ana.user.handle, "aaaaaaaaaaaa", "Fluffy", 100);
    s.seed(bob.user.id, bob.user.handle, "bbbbbbbbbbbb", "Nibbles", 40);
    const mine = await http(s.api, "GET", "/arena/leaderboard", undefined, ana.cookie);
    expect(mine.body.rows.map((x) => [x.name, x.mine])).toEqual([["Fluffy", true], ["Nibbles", false]]);
    expect((await http(s.api, "GET", "/arena/leaderboard?league=pro:boozy")).body.rows).toEqual([]);
    expect((await http(s.api, "GET", "/arena/leaderboard?league=free:breezy")).body.rows).toHaveLength(2);
    expect((await http(s.api, "GET", "/arena/leaderboard?season=../../etc")).status).toBe(200); // a bad season id falls back to the current one
  });

  it("a public name can be changed, is checked, and shows on the board at once", async () => {
    const s = setup();
    const ana = await s.login("ana@example.com");
    const bob = await s.login("bob@example.com");
    s.seed(ana.user.id, ana.user.handle, "aaaaaaaaaaaa", "Fluffy", 100);
    expect((await http(s.api, "POST", "/arena/account/handle", { handle: "fast-ana" })).status).toBe(401);
    expect((await http(s.api, "POST", "/arena/account/handle", { handle: "x" }, ana.cookie)).status).toBe(400);
    expect((await http(s.api, "POST", "/arena/account/handle", { handle: "admin" }, ana.cookie)).status).toBe(400);
    expect((await http(s.api, "POST", "/arena/account/handle", { handle: "fast-ana" }, ana.cookie)).body).toEqual({ handle: "fast-ana" });
    expect((await http(s.api, "POST", "/arena/account/handle", { handle: "Fast-Ana" }, bob.cookie)).status).toBe(400); // taken
    expect((await http(s.api, "GET", "/arena/leaderboard")).body.rows[0]!.handle).toBe("fast-ana");
    expect((await http(s.api, "GET", "/arena/me", undefined, ana.cookie)).body.user.handle).toBe("fast-ana");
  });

  it("taking a bot off the board, deleting it or the account, removes it at once", async () => {
    const s = setup();
    const ana = await s.login("ana@example.com");
    const made = await http(s.api, "POST", "/arena/bots/create", bot("Fluffy"), ana.cookie);
    const id = made.body.bot.id;
    s.seed(ana.user.id, ana.user.handle, id, "Fluffy", 100);
    expect((await http(s.api, "GET", "/arena/leaderboard")).body.rows).toHaveLength(1);
    await http(s.api, "POST", "/arena/bots/update", { ...bot("Fluffy"), id, listed: false }, ana.cookie);
    s.leaderboard.standings(); // cached view is cleared by remove()
    expect((await http(s.api, "GET", "/arena/leaderboard")).body.rows).toHaveLength(0);
    s.seed(ana.user.id, ana.user.handle, id, "Fluffy", 100);
    await http(s.api, "POST", "/arena/bots/delete", { id }, ana.cookie);
    expect((await http(s.api, "GET", "/arena/leaderboard")).body.rows).toHaveLength(0);
  });

  it("says so when there is no leaderboard", async () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-lbhttp-")));
    const auth = new ArenaAuth(store, new Inbox(), { baseUrl: "https://x.test" });
    expect((await http(new ArenaApi(auth, store, { secureCookie: true }), "GET", "/arena/leaderboard")).body).toEqual({ enabled: false });
  });
});
