import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseStyle, marketLines } from "../src/arena/autonomy.js";
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import { Leaderboard } from "../src/arena/ranking.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const base = { theme: "bunnies", avatar: "scout", rules: "Trade whatever the market offers, protect capital first." };
const auto = (name: string, extra: Record<string, unknown> = {}) => ({ ...base, name, mode: "autonomous", ...extra });
const fixed = (name: string) => ({ ...base, name, style: "breezy", coins: ["BTC"] });

const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;

/** Answers the style question with `style`, and the move question with the first LONG on the menu. */
class Llm implements LlmClient {
  readonly brain = "openai";
  readonly model = "fake";
  styleCalls = 0;
  moveCalls = 0;
  style = "breezy";
  failStyle = false;
  lastStyleAsk: Record<string, unknown> | null = null;
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    if (ask.name === "style_choice") {
      this.styleCalls++;
      this.lastStyleAsk = JSON.parse(ask.user) as Record<string, unknown>;
      if (this.failStyle) throw new Error("down");
      return { data: ask.validate.parse({ style: this.style, reason: "BTC is trending, so follow it." }), brain: "openai", model: "fake", inputTokens: 400, outputTokens: 30, latencyMs: 1 };
    }
    this.moveCalls++;
    const labels = Object.keys((JSON.parse(ask.user) as { menu: Record<string, unknown> }).menu);
    return { data: ask.validate.parse({ choice: labels.find((l) => l.startsWith("LONG")) ?? labels[0], confidence: 0.9, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 500, outputTokens: 20, latencyMs: 1 };
  }
}

describe("the autonomous mode: plan and shape", () => {
  function member(tier: "free" | "pro" | "premium") {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-auto-")));
    const u = store.createUser("a".repeat(32), "ana@example.com", 1);
    store.setTier(u.id, tier);
    return { store, u, bots: new Bots(store.tenant(u.id), tier, () => 1000) };
  }
  it("is for Premium only", () => {
    expect(() => member("free").bots.create(auto("Free One"))).toThrow(/Premium/);
    expect(() => member("pro").bots.create(auto("Pro One"))).toThrow(/Premium/);
    expect(member("premium").bots.create(auto("Prem One"))).toMatchObject({ mode: "autonomous", style: "boozy", coins: [], version: 1 });
  });
  it("needs no style and no coins, ignores any it is given, but still needs its guidance", () => {
    const { bots } = member("premium");
    expect(bots.create(auto("Zed", { style: "breezy", coins: ["BTC", "ETH"] }))).toMatchObject({ style: "boozy", coins: [] });
    expect(() => bots.create(auto("Zee", { rules: "short" }))).toThrow(/Rules/);
  });
  it("never changes mode afterwards: a request to turn a fixed agent autonomous is ignored", () => {
    const { bots } = member("premium");
    const f = bots.create(fixed("Plain"));
    expect(bots.update(f.id, { ...fixed("Plain"), mode: "autonomous" })).toMatchObject({ mode: "fixed", style: "breezy", coins: ["BTC"] });
    const a = bots.create(auto("Free Spirit"));
    expect(bots.update(a.id, { ...auto("Free Spirit"), mode: "fixed", style: "breezy", coins: ["BTC"] })).toMatchObject({ mode: "autonomous", style: "boozy", coins: [], version: 1 });
  });
  it("is quarantined when the plan stops allowing it, and comes back when it does", () => {
    const { store, u, bots } = member("premium");
    const a = bots.create(auto("Free Spirit"));
    const f = bots.create(fixed("Plain"));
    store.setTier(u.id, "pro");
    const pro = new Bots(store.tenant(u.id), "pro", () => 2000);
    expect(pro.reconcile(2000).quarantined).toEqual([a.id]);
    expect(pro.find(f.id).state).toBe("running");
    store.setTier(u.id, "premium");
    const prem = new Bots(store.tenant(u.id), "premium", () => 3000);
    expect(prem.reconcile(3000).restored).toEqual([a.id]);
  });
});

describe("asking the model for a style", () => {
  it("sends a short market summary and the guidance, and returns the model's own words", async () => {
    const llm = new Llm();
    const c = await chooseStyle(llm, { rules: "careful", current: null, market: marketLines(market) });
    expect(c).toMatchObject({ style: "breezy", reason: "BTC is trending, so follow it." });
    expect(llm.lastStyleAsk).toMatchObject({ ownerGuidance: "careful", currentStyle: null });
    expect((llm.lastStyleAsk!.market as string[])[0]).toMatch(/^BTC: 24h 3\.0%/);
  });
  it("refuses a style that does not exist", async () => {
    const llm = new Llm();
    llm.style = "scalp";
    await expect(chooseStyle(llm, { rules: "x", current: null, market: [] })).rejects.toThrow();
  });
});

describe("the runner and an autonomous agent", () => {
  const live: ArenaRunner[] = [];
  afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));
  function world(over: { llm?: Llm | null; dailyUsd?: number } = {}) {
    const root = mkdtempSync(join(tmpdir(), "arena-auto-run-"));
    const store = new ArenaStore(root);
    const ana = store.createUser("a".repeat(32), "ana@example.com", 1);
    store.setTier(ana.id, "premium");
    const llm = over.llm === undefined ? new Llm() : over.llm;
    const clock = { t: NOW };
    const leaderboard = new Leaderboard(store.dir, () => clock.t);
    const runner = new ArenaRunner({ store, root, feed: fakeFeed(), decider: new LlmSystemOne(llm ?? new Llm()), llm: llm ?? undefined, now: () => clock.t, tickMs: 1000, leaderboard, dailyUsd: over.dailyUsd ?? 0.5, styleReviewHours: 6 });
    live.push(runner);
    return { store, ana, llm, clock, leaderboard, runner, bots: new Bots(store.tenant(ana.id), "premium", () => NOW) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("asks its model for a style at the start, records it with the model's words, and shows it", async () => {
    const w = world();
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    expect(w.llm!.styleCalls).toBe(1);
    const log = w.runner.styleLog(w.ana.id, w.bots.find(b.id));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ style: "breezy", reason: "BTC is trending, so follow it.", changed: true });
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", style: "breezy" });
  });
  it("the engine really adopts the style the model chose, only while the agent is flat", async () => {
    const w = world();
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    await w.runner.engineOf(b.id)!.tick();
    const file = join((w.store as unknown as { root: string }).root, "tenants", w.ana.id, "paper", `${b.id}-v1.sqlite`);
    const events = () => new DatabaseSync(file, { readOnly: true }).prepare("SELECT json FROM events WHERE type = 'status'").all().map((r) => JSON.parse(String((r as { json: string }).json)) as { event?: string; method?: string });
    expect(events().filter((e) => e.event === "specialization").map((e) => e.method)).toEqual(["style breezy"]);
    // it now holds a position: a new choice waits until it is flat again
    w.llm!.style = "bizzy";
    w.clock.t = NOW + 7 * 3_600_000;
    await w.runner.review(b.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(events().filter((e) => e.event === "specialization")).toHaveLength(1);
  });
  it("trades, and a style call is paid from the agent's own daily spend", async () => {
    const w = await world();
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    await w.runner.engineOf(b.id)!.tick();
    expect(w.llm!.moveCalls).toBeGreaterThan(0);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.spentUsd).toBeGreaterThan(0);
  });
  it("asks again only after the review time, and not while paused", async () => {
    const w = world();
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    await w.runner.review(b.id);
    expect(w.llm!.styleCalls).toBe(1);
    w.clock.t = NOW + 7 * 3_600_000;
    w.bots.setState(b.id, "paused");
    await w.runner.update(w.ana.id);
    await w.runner.review(b.id);
    expect(w.llm!.styleCalls).toBe(1);
    w.bots.setState(b.id, "running");
    await w.runner.update(w.ana.id);
    w.llm!.style = "bizzy";
    await w.runner.review(b.id);
    expect(w.llm!.styleCalls).toBe(2);
    expect(w.runner.styleLog(w.ana.id, w.bots.find(b.id))[0]).toMatchObject({ style: "bizzy", changed: true });
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.style).toBe("bizzy");
  });
  it("keeps its style when the model fails, and keeps trading", async () => {
    const w = world();
    w.llm!.failStyle = true;
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    expect(w.runner.styleLog(w.ana.id, w.bots.find(b.id))).toHaveLength(0);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]).toMatchObject({ state: "running", style: null });
  });
  it("skips the style call near its daily ceiling, so decisions are not starved", async () => {
    const w = world({ dailyUsd: 0.0001 });
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await w.runner.engineOf(b.id)!.tick();
    w.clock.t = NOW + 7 * 3_600_000;
    const before = w.llm!.styleCalls;
    await w.runner.review(b.id);
    expect(w.llm!.styleCalls).toBe(before);
  });
  it("is not asked for a style at all when the platform has no model for it (it keeps Momentum)", async () => {
    const w = world({ llm: null });
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    expect(w.runner.styleLog(w.ana.id, w.bots.find(b.id))).toHaveLength(0);
    expect(w.runner.status(w.ana.id, [b.id])[b.id]!.state).toBe("running");
  });
  it("ranks in its own league, named for its plan", async () => {
    const w = world();
    const b = w.bots.create(auto("Free Spirit"));
    await w.runner.update(w.ana.id);
    await settle();
    await w.runner.engineOf(b.id)!.tick();
    w.runner.sample(NOW);
    const row = w.store.dir.prepare("SELECT style, tier FROM lb_bots WHERE bot_id = ?").get(b.id) as { style: string; tier: string };
    expect(row).toEqual({ style: "autonomous", tier: "premium" });
  });
  it("a style that is stopped or kept private stays off the public board", async () => {
    const w = world();
    const b = w.bots.create(auto("Quiet One", { listed: false }));
    await w.runner.update(w.ana.id);
    await settle();
    w.runner.sample(NOW);
    expect(w.store.dir.prepare("SELECT COUNT(*) AS n FROM lb_bots WHERE bot_id = ?").get(b.id)).toEqual({ n: 0 });
  });
});
