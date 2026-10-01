import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
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
import { ArenaStore } from "../src/arena/store.js";
import { TEMPLATES } from "../src/arena/templates.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const bot = (name: string, over: Record<string, unknown> = {}) => ({ name, theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC", "ETH"], rules: "Follow the trend on BTC and ETH, cut losses fast.", ...over });
const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;

/** Picks LONG_BTC when the menu has it, otherwise holds: so a second tick answers on the menu it was really given. */
class Llm implements LlmClient {
  readonly brain = "openai";
  readonly model = "fake";
  asked = 0;
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked++;
    const labels = Object.keys((JSON.parse(ask.user) as { menu: Record<string, unknown> }).menu);
    const choice = labels.includes("LONG_BTC") ? "LONG_BTC" : labels.includes("HOLD_WINNER") ? "HOLD_WINNER" : labels[0]!;
    return { data: ask.validate.parse({ choice, confidence: 0.9, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 500, outputTokens: 20, latencyMs: 5 };
  }
}

const live: ArenaRunner[] = [];
afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));

function world(tier: "free" | "pro" = "free") {
  const root = mkdtempSync(join(tmpdir(), "arena-life-"));
  const store = new ArenaStore(root);
  const ana = store.createUser("a".repeat(32), "ana@example.com", 1);
  if (tier === "pro") store.dir.prepare("UPDATE users SET tier = 'pro' WHERE id = ?").run(ana.id);
  const llm = new Llm();
  const leaderboard = new Leaderboard(store.dir, () => NOW);
  const runner = new ArenaRunner({ store, root, feed: fakeFeed(), decider: new LlmSystemOne(llm), now: () => NOW, tickMs: 1000, leaderboard });
  live.push(runner);
  return { root, store, ana, llm, leaderboard, runner, bots: new Bots(store.tenant(ana.id), tier, () => NOW) };
}

describe("Bots: states", () => {
  it("starts running; pause, resume and stop follow the rules; a stopped agent only starts again", () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    expect(b.state).toBe("running");
    expect(w.bots.setState(b.id, "paused").state).toBe("paused");
    expect(() => w.bots.setState(b.id, "paused")).toThrow(/already paused/);
    expect(w.bots.setState(b.id, "running").state).toBe("running");
    expect(w.bots.setState(b.id, "stopped").state).toBe("stopped");
    expect(() => w.bots.setState(b.id, "running")).toThrow(/Start it again/);
    expect(() => w.bots.setState(b.id, "paused")).toThrow(/stopped/);
    const again = w.bots.startAgain(b.id);
    expect(again).toMatchObject({ state: "running", version: 2 });
    expect(w.bots.versions(b.id).map((v) => v.version)).toEqual([2, 1]);
    expect(() => w.bots.startAgain(b.id)).toThrow(/Only a stopped/);
  });

  it("pause all and resume all touch only the agents in the right state", () => {
    const w = world("pro");
    const a = w.bots.create(bot("One"));
    const b = w.bots.create(bot("Two"));
    w.bots.setState(b.id, "stopped");
    expect(w.bots.setAll("paused")).toBe(1);
    expect(w.bots.find(a.id).state).toBe("paused");
    expect(w.bots.find(b.id).state).toBe("stopped");
    expect(w.bots.setAll("running")).toBe(1);
    expect(w.bots.find(a.id).state).toBe("running");
  });
});

describe("the runner: pause and stop", () => {
  it("a paused agent that is flat opens nothing and does not ask the model", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    w.bots.setState(b.id, "paused");
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.llm.asked).toBe(0);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "paused", position: null, orders: 0 });
  });

  it("pausing an agent with a position keeps the position, and resuming lets it decide again", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.position).toMatchObject({ coin: "BTC" });
    const asked = w.llm.asked;
    w.bots.setState(b.id, "paused");
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    const st = w.runner.status(w.ana.id, [b.id])[b.id]!;
    expect(st.state).toBe("paused");
    expect(st.position).toMatchObject({ coin: "BTC" }); // still under its stop
    expect(w.llm.asked).toBe(asked);
    w.bots.setState(b.id, "running");
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.state).toBe("running");
    expect(w.llm.asked).toBeGreaterThan(asked);
  });

  it("stop closes the position, ends the run, keeps the record and takes the agent off the board", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    w.runner.sample(NOW);
    expect(w.leaderboard.listedBots(w.ana.id)).toContain(b.id);
    w.bots.setState(b.id, "stopped");
    await w.runner.update(w.ana.id);
    expect(w.runner.running).toBe(0); // flat, so the run ended
    const st = w.runner.status(w.ana.id, [b.id])[b.id]!;
    expect(st).toMatchObject({ state: "stopped", position: null });
    expect(w.leaderboard.listedBots(w.ana.id)).not.toContain(b.id);
    expect(existsSync(join(w.root, "tenants", w.ana.id, "paper", `${b.id}-v1.sqlite`))).toBe(true);
    await w.runner.update(w.ana.id); // and it is not started again behind the member's back
    expect(w.runner.running).toBe(0);
    const ins = w.runner.insights(w.ana.id, w.bots.find(b.id))!;
    expect(ins.trades.length).toBeGreaterThanOrEqual(2); // the open and the close
    expect(ins.trades[0]).toMatchObject({ side: "sell" });
  });

  it("starting again is a fresh paper account under a new version", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    w.bots.setState(b.id, "stopped");
    await w.runner.update(w.ana.id);
    w.bots.startAgain(b.id);
    await w.runner.update(w.ana.id);
    expect(w.runner.running).toBe(1);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", equityUsd: 1000, orders: 0 });
    expect(existsSync(join(w.root, "tenants", w.ana.id, "paper", `${b.id}-v2.sqlite`))).toBe(true);
  });
});

describe("the runner: what the agent page shows", () => {
  it("decisions carry facts: what it saw, the odds, what it did", async () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    const ins = w.runner.insights(w.ana.id, w.bots.find(b.id))!;
    const d = ins.decisions.at(-1)!;
    expect(d.choice).toBe("LONG_BTC");
    expect(d.did).toMatchObject({ kind: "open", coin: "BTC", side: "long" });
    expect(d.odds[0]).toMatchObject({ label: "LONG_BTC" });
    expect(d.saw.cols.length).toBeGreaterThan(0);
    expect(Object.keys(d.saw.coins)).toContain("BTC");
    expect(ins.equity.length).toBeGreaterThan(0);
  });

  it("is null before anything has run", () => {
    const w = world();
    const b = w.bots.create(bot("Fluffy"));
    expect(w.runner.insights(w.ana.id, b)).toBeNull();
  });
});

class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _subject: string, text: string) {
    this.sent.push(text);
  }
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const [pathname] = path.split("?");
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, pathname!);
  return { status, body: JSON.parse(text || "{}") as Json };
}

describe("HTTP: state, insights, templates", () => {
  async function setup() {
    const w = world();
    const inbox = new Inbox();
    const auth = new ArenaAuth(w.store, inbox, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, w.store, { secureCookie: true, runner: w.runner, leaderboard: w.leaderboard, now: () => NOW });
    await auth.requestLink("ana@example.com", "1.1.1.1");
    const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
    w.store.acceptConsent(v.user.id, 1);
    // The world's runner serves the user that the world made; sign in as that user.
    return { ...w, api, cookie: `arena_session=${v.session}`, uid: v.user.id };
  }

  it("lists starter templates that are valid agents", async () => {
    const w = await setup();
    const r = await http(w.api, "GET", "/arena/templates");
    expect(r.status).toBe(200);
    expect(r.body.templates).toHaveLength(3);
    const bots = new Bots(w.store.tenant(w.uid), "pro", () => NOW);
    for (const t of TEMPLATES) {
      const { id, kind, pro, ...input } = t; // eslint-disable-line @typescript-eslint/no-unused-vars
      expect(() => bots.create(input)).not.toThrow();
      for (const x of bots.list()) bots.remove(x.id);
    }
    // The Free plan can use every template whose style it has.
    expect(TEMPLATES.filter((t) => !t.pro).every((t) => ["breezy", "bizzy"].includes(t.style))).toBe(true);
  });

  it("pause, resume, stop and start again over HTTP, and the insights of the agent", async () => {
    const w = await setup();
    const made = await http(w.api, "POST", "/arena/bots/create", bot("Fluffy"), w.cookie);
    expect(made.status).toBe(200);
    const id = made.body.bot.id as string;
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "pause" }, w.cookie)).body.bot.state).toBe("paused");
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "pause" }, w.cookie)).status).toBe(409);
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "dance" }, w.cookie)).status).toBe(400);
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "resume" }, w.cookie)).body.bot.state).toBe("running");
    await w.runner.engineOf(id)!.tick();
    const ins = await http(w.api, "GET", `/arena/bots/insights?id=${id}`, undefined, w.cookie);
    expect(ins.status).toBe(200);
    expect(ins.body.insights.decisions.length).toBeGreaterThan(0);
    expect((await http(w.api, "POST", "/arena/bots/state-all", { to: "pause" }, w.cookie)).body.changed).toBe(1);
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "stop" }, w.cookie)).body.bot.state).toBe("stopped");
    const list = await http(w.api, "GET", "/arena/bots", undefined, w.cookie);
    expect(list.body.runner.runs[id]).toMatchObject({ state: "stopped" });
    expect((await http(w.api, "POST", "/arena/bots/state", { id, to: "again" }, w.cookie)).body.bot).toMatchObject({ state: "running", version: 2 });
  });

  it("another member's agent cannot be reached, and signed-out calls are refused", async () => {
    const w = await setup();
    expect((await http(w.api, "GET", "/arena/bots/insights?id=abc")).status).toBe(401);
    expect((await http(w.api, "POST", "/arena/bots/state", { id: "abc", to: "pause" })).status).toBe(401);
    expect((await http(w.api, "GET", "/arena/bots/insights?id=abc", undefined, w.cookie)).status).toBe(404);
  });
});
