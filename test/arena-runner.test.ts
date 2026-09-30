import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import { sharedFeed } from "../src/arena/feed.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import { BrainError, type JsonAnswer, type JsonAsk, type LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const rules = "Follow the trend on BTC and ETH, cut losses fast.";
const bot = (name: string, over: Record<string, unknown> = {}) => ({ name, theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC", "ETH"], rules, ...over });

/** BTC in a strong uptrend: breezy offers LONG_BTC. */
const btc = coin("BTC", { ret24hPct: 3 }, 100_000);
const market = view([{ ...btc, trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;

class FakeLlm implements LlmClient {
  readonly brain = "openai";
  readonly model = "fake-model";
  asked: JsonAsk<unknown>[] = [];
  pick: string | (() => never) = "LONG_BTC";
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    if (typeof this.pick !== "string") this.pick();
    return { data: ask.validate.parse({ choice: this.pick, confidence: 0.9, conviction: 3 }), brain: "openai", model: "fake-model", inputTokens: 500, outputTokens: 20, latencyMs: 5 };
  }
}

const live: ArenaRunner[] = [];
afterEach(() => {
  for (const r of live.splice(0)) r.stopAll();
});

function world(tier: "free" | "pro" = "free", over: { maxRunners?: number; dailyUsd?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "arena-run-"));
  const store = new ArenaStore(root);
  const ana = store.createUser("a".repeat(32), "ana@example.com", 1);
  if (tier === "pro") store.dir.prepare("UPDATE users SET tier = 'pro' WHERE id = ?").run(ana.id);
  const llm = new FakeLlm();
  const runner = new ArenaRunner({ store, root, feed: fakeFeed(), decider: new LlmSystemOne(llm), now: () => NOW, tickMs: 1000, ...over });
  live.push(runner);
  const bots = (id = ana.id, t: "free" | "pro" = tier) => new Bots(store.tenant(id), t, () => NOW);
  return { root, store, ana, llm, runner, bots: bots(), botsOf: bots };
}
const paperFiles = (root: string, uid: string) => (existsSync(join(root, "tenants", uid, "paper")) ? readdirSync(join(root, "tenants", uid, "paper")).filter((f) => f.endsWith(".sqlite")) : []);

describe("running a member's bunny on paper", () => {
  it("starts one engine per bot with the start money and a fresh book", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    expect(w.runner.running).toBe(1);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", equityUsd: 1000, startEquityUsd: 1000, pnlUsd: 0, position: null, decisions: 0 });
    expect(paperFiles(w.root, w.ana.id)).toEqual([`${b.id}-v1.sqlite`]);
  });

  it("decides with the platform model, opens a paper position, and reports it", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    const st = w.runner.status(w.ana.id, [b.id])[b.id]!;
    expect(w.llm.asked.length).toBeGreaterThan(0);
    const menu = JSON.parse(w.llm.asked[0]!.user) as { menu: Record<string, unknown>; strategy: string };
    expect(Object.keys(menu.menu)).toContain("LONG_BTC");
    expect(menu.strategy).toContain("Follow the trend"); // the member's own rules reach the model
    expect(st.decisions).toBeGreaterThan(0);
    expect(st.position).toMatchObject({ coin: "BTC", side: "long" });
    expect(st.last).toMatchObject({ choice: "LONG_BTC" });
    expect(st.spentUsd).toBeGreaterThan(0);
  });

  it("holds when the model fails or answers off the menu, and keeps running", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    w.llm.pick = () => {
      throw new BrainError("openai", 500, "down");
    };
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", position: null });
    w.llm.pick = "NOT_ON_THE_MENU";
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.position).toBeNull();
  });

  it("stops deciding once the bot's daily budget is spent", async () => {
    const w = world("free", { dailyUsd: 0.000001 });
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    const e = w.runner.engineOf(b.id)!;
    await e.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.capped).toBe(true);
    const asked = w.llm.asked.length;
    await e.tick();
    expect(w.llm.asked.length).toBe(asked);
  });

  it("a new version starts a fresh paper account and removes the old file", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.position).not.toBeNull();
    w.bots.update(b.id, bot("Fluffy", { rules: "A different plan, written out clearly." }));
    await w.runner.update(w.ana.id);
    expect(paperFiles(w.root, w.ana.id)).toEqual([`${b.id}-v2.sqlite`]);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", position: null, decisions: 0, equityUsd: 1000 });
  });

  it("a cosmetic edit keeps the running account", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    const before = w.runner.engineOf(b.id);
    w.bots.update(b.id, bot("Fluffy Two", { avatar: "hopper" }));
    await w.runner.update(w.ana.id);
    expect(w.runner.engineOf(b.id)).toBe(before);
  });

  it("deleting a bot stops its engine and removes its file; deleting the account stops everything", async () => {
    const w = world("pro");
    const one = w.bots.create(bot("One"));
    const two = w.bots.create(bot("Two"));
    await w.runner.update(w.ana.id);
    expect(w.runner.running).toBe(2);
    w.bots.remove(one.id);
    await w.runner.update(w.ana.id);
    expect(w.runner.running).toBe(1);
    expect(paperFiles(w.root, w.ana.id)).toEqual([`${two.id}-v1.sqlite`]);
    await w.runner.forget(w.ana.id);
    expect(w.runner.running).toBe(0);
    expect(paperFiles(w.root, w.ana.id)).toEqual([]);
  });

  it("waits its turn when the platform is full, then starts when a place frees up", async () => {
    const w = world("pro", { maxRunners: 1 });
    const one = w.bots.create(bot("One"));
    const two = w.bots.create(bot("Two"));
    await w.runner.update(w.ana.id);
    const st = w.runner.status(w.ana.id, [one.id, two.id]);
    expect([st[one.id]!.state, st[two.id]!.state]).toEqual(["running", "queued"]);
    w.bots.remove(one.id);
    await w.runner.update(w.ana.id);
    expect(w.runner.status(w.ana.id, [two.id])[two.id]!.state).toBe("running");
  });

  it("one member never sees another's bot status", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    const bob = w.store.createUser("b".repeat(32), "bob@example.com", 2);
    await w.runner.syncAll();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.state).toBe("running");
    expect(w.runner.status(bob.id, [b.id])[b.id]).toEqual({ state: "queued" });
  });

  it("syncAll starts every member's bots, and a removed account's bots stop", async () => {
    const w = world();
    const bob = w.store.createUser("b".repeat(32), "bob@example.com", 2);
    const a = w.bots.create(bot("Fluffy"));
    const b = w.botsOf(bob.id, "free").create(bot("Other"));
    await w.runner.syncAll();
    expect(w.runner.running).toBe(2);
    w.store.deleteUser(bob.id, NOW);
    await w.runner.update(bob.id);
    expect(w.runner.running).toBe(1);
    expect(w.runner.status(w.ana.id, [a.id])[a.id]!.state).toBe("running");
    expect(b.id).toBeTruthy();
  });
});

describe("the shared feed", () => {
  it("answers many refreshes with one call and keeps the gap between calls", async () => {
    let calls = 0;
    const real = { ...fakeFeed(), lastRefreshAt: 1, refresh: async () => void (await new Promise((r) => setTimeout(r, 20)), calls++), refreshTickers: async () => void calls++ } as unknown as MarketFeed;
    const f = sharedFeed(real, 15_000, 10_000);
    await Promise.all([f.refresh(1000), f.refresh(1000), f.refresh(1000)]);
    await f.refresh(5000); // inside the gap
    expect(calls).toBe(1);
    await f.refresh(20_000);
    expect(calls).toBe(2);
    await Promise.all([f.refreshTickers(), f.refreshTickers()]);
    expect(calls).toBe(3);
  });
});

describe("the decision adapter", () => {
  it("turns the model's answer into Jev's shape: probabilities that sum to one, conviction clamped", async () => {
    const llm = new FakeLlm();
    llm.pick = "B";
    const out = (await new LlmSystemOne(llm).systemOne({
      model: "x",
      state: { a: 1 },
      questions: { action: { type: "choice", instructions: "Pick.", criteria: { A: "a", B: "b", C: "c" } }, conviction: { type: "score", instructions: "?", criteria: ["weak", "strong"] } },
    } as never)) as unknown as { answers: { action: { choice: string; probabilities: Record<string, number> }; conviction: { score: number } }; usage: { input_tokens: number } };
    expect(out.answers.action.choice).toBe("B");
    expect(Object.values(out.answers.action.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(out.answers.conviction.score).toBe(1); // 3 clamped to the top level (index 1)
    expect(out.usage.input_tokens).toBe(520);
    expect((llm.asked[0]!.schema as { properties: { choice: { enum: string[] } } }).properties.choice.enum).toEqual(["A", "B", "C"]);
  });
});

// HTTP wiring
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import type { Mailer } from "../src/arena/mailer.js";

async function call(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path);
  return { status, body: JSON.parse(text || "{}") as Record<string, unknown> };
}

describe("HTTP wiring", () => {
  it("tells the runner about every change, stops a member's bots before deleting the account, and reports status", async () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-wire-")));
    const sent: string[] = [];
    const mailer: Mailer = { send: async (_t, _s, text) => void sent.push(text) };
    const auth = new ArenaAuth(store, mailer, { baseUrl: "https://x.test" });
    const log: string[] = [];
    const runner = {
      async update(id: string) {
        log.push(`update:${id === store.userByEmail("ana@example.com")?.id ? "ana" : "?"}`);
      },
      async forget() {
        log.push(`forget:userStillThere=${store.userByEmail("ana@example.com") !== null}`);
      },
      status: (_u: string, ids: string[]) => Object.fromEntries(ids.map((i) => [i, { state: "running" as const, equityUsd: 1003.5 }])),
    };
    const api = new ArenaApi(auth, store, { secureCookie: true, runner });
    await auth.requestLink("ana@example.com", "1.1.1.1");
    const cookie = `arena_session=${auth.verify(sent[0]!.match(/token=([\w-]+)/)![1])!.session}`;
    const made = await call(api, "POST", "/arena/bots/create", bot("Fluffy"), cookie);
    const id = (made.body.bot as { id: string }).id;
    await call(api, "POST", "/arena/bots/update", { ...bot("Fluffy"), id, rules: "A different plan, written out clearly." }, cookie);
    const list = await call(api, "GET", "/arena/bots", undefined, cookie);
    expect(list.body.runner).toEqual({ enabled: true, runs: { [id]: { state: "running", equityUsd: 1003.5 } } });
    await call(api, "POST", "/arena/bots/delete", { id }, cookie);
    await call(api, "POST", "/arena/account/delete", { confirm: "ana@example.com" }, cookie);
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toEqual(["update:ana", "update:ana", "update:ana", "forget:userStillThere=true"]);
  });

  it("says so when nothing runs the bots", async () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-wire-")));
    const sent: string[] = [];
    const auth = new ArenaAuth(store, { send: async (_t, _s, text) => void sent.push(text) }, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, store, { secureCookie: true });
    await auth.requestLink("ana@example.com", "1.1.1.1");
    const cookie = `arena_session=${auth.verify(sent[0]!.match(/token=([\w-]+)/)![1])!.session}`;
    expect((await call(api, "GET", "/arena/bots", undefined, cookie)).body.runner).toEqual({ enabled: false, runs: {} });
  });
});
