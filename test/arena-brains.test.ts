import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bots, LIMITS, PLATFORM } from "../src/arena/bots.js";
import { EnsembleSystemOne, LlmSystemOne } from "../src/arena/decider.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import { Vault } from "../src/arena/vault.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const base = { theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." };
const input = (name: string, extra: Record<string, unknown> = {}) => ({ ...base, name, ...extra });
const K = (n: number) => n.toString(16).padStart(12, "0");

/** A brain that always answers `pick(labels)`, with a confidence. */
function brain(pick: (labels: string[]) => string, confidence = 0.8, fail = false): LlmClient & { asked: number } {
  return {
    brain: "openai",
    model: "fake",
    asked: 0,
    async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
      this.asked++;
      if (fail) throw new Error("down");
      const labels = Object.keys((JSON.parse(ask.user) as { menu: Record<string, unknown> }).menu);
      return { data: ask.validate.parse({ choice: pick(labels), confidence, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 100, outputTokens: 10, latencyMs: 1 };
    },
  };
}
const long = (l: string[]) => l.find((x) => x.startsWith("LONG")) ?? l[0]!;
const hold = (l: string[]) => l.find((x) => x.startsWith("HOLD")) ?? l.find((x) => x.startsWith("SHORT")) ?? l[0]!;
const short = (l: string[]) => l.find((x) => x.startsWith("SHORT")) ?? l[0]!;

const req = (menu: Record<string, string | null>) => ({ state: {}, questions: { action: { instructions: "x", criteria: menu }, conviction: { criteria: ["a", "b", "c", "d"] } } }) as never;
const asEnsemble = (...llms: LlmClient[]) => new EnsembleSystemOne(llms.map((l, i) => ({ sys: new LlmSystemOne(l, `m${i}`), label: `m${i}` })));
const ask = async (e: EnsembleSystemOne, menu: Record<string, string | null>) => (await e.systemOne(req(menu))) as unknown as { model: string; usage: { input_tokens: number }; answers: { action: { choice: string; confidence: number; probabilities: Record<string, number> }; conviction: { score: number } } };

describe("several brains deciding together", () => {
  const menu = { LONG_BTC: null, SHORT_BTC: null, HOLD_WINNER: null };
  it("the move most brains chose wins, and the odds are the share of all brains", async () => {
    const r = await ask(asEnsemble(brain(long), brain(long), brain(short)), menu);
    expect(r.answers.action.choice).toBe("LONG_BTC");
    expect(r.answers.action.confidence).toBeCloseTo(2 / 3);
    expect(r.answers.action.probabilities).toMatchObject({ LONG_BTC: 2 / 3, SHORT_BTC: 1 / 3, HOLD_WINNER: 0 });
    expect(r.model).toBe("ensemble:3/3");
    expect(r.usage.input_tokens).toBe(330); // every brain's tokens are paid for
  });
  it("a unanimous vote has odds of 1", async () => {
    const r = await ask(asEnsemble(brain(long), brain(long)), menu);
    expect(r.answers.action).toMatchObject({ choice: "LONG_BTC", confidence: 1 });
  });
  it("a tie goes to HOLD when HOLD is among the tied moves, else to the higher mean confidence", async () => {
    expect((await ask(asEnsemble(brain(long, 0.99), brain(hold, 0.5)), menu)).answers.action.choice).toBe("HOLD_WINNER");
    expect((await ask(asEnsemble(brain(long, 0.6), brain(short, 0.9)), menu)).answers.action.choice).toBe("SHORT_BTC");
  });
  it("a brain that fails abstains: it lowers the winner's share instead of being ignored", async () => {
    const r = await ask(asEnsemble(brain(long), brain(long, 0.8, true), brain(long, 0.8, true)), menu);
    expect(r.answers.action).toMatchObject({ choice: "LONG_BTC" });
    expect(r.answers.action.confidence).toBeCloseTo(1 / 3);
    expect(r.model).toBe("ensemble:1/3");
  });
  it("fails, so the engine holds, when every brain fails", async () => {
    await expect(ask(asEnsemble(brain(long, 0.8, true), brain(long, 0.8, true)), menu)).rejects.toThrow();
  });
  it("drops an answer that is not on the menu", async () => {
    const r = await ask(asEnsemble(brain(() => "MADE_UP"), brain(long)), { LONG_BTC: null, HOLD_WINNER: null });
    expect(r.answers.action).toMatchObject({ choice: "LONG_BTC" });
  });
});

describe("how many brains a plan allows", () => {
  function member(tier: "free" | "pro" | "premium") {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-brains-")));
    const u = store.createUser("a".repeat(32), "ana@example.com", 1);
    store.setTier(u.id, tier);
    return { store, u, bots: new Bots(store.tenant(u.id), tier, () => 1000) };
  }
  it("is 1, 3 and 6", () => {
    expect([LIMITS.free.brains, LIMITS.pro.brains, LIMITS.premium.brains]).toEqual([1, 3, 6]);
  });
  it("defaults to the platform's model, and the older single-key field still works", () => {
    expect(member("free").bots.create(input("One"))).toMatchObject({ brains: [PLATFORM], brainKey: null });
    expect(member("free").bots.create(input("Two", { brainKey: K(1) }))).toMatchObject({ brains: [K(1)], brainKey: K(1) });
  });
  it("refuses more brains than the plan has, duplicates count once, and an empty or malformed list", () => {
    expect(() => member("free").bots.create(input("Aa", { brains: [PLATFORM, K(1)] }))).toThrow(/one model/);
    const pro = member("pro").bots;
    expect(() => pro.create(input("Aa", { brains: [PLATFORM, K(1), K(2), K(3)] }))).toThrow(/up to 3/);
    expect(pro.create(input("Bee", { brains: [PLATFORM, K(1), K(1), K(2)] })).brains).toEqual([PLATFORM, K(1), K(2)]);
    for (const bad of [[], "x", ["nope"], [42]]) expect(() => pro.create(input("Cee", { brains: bad }))).toThrow();
    expect(member("premium").bots.create(input("Dee", { brains: [PLATFORM, K(1), K(2), K(3), K(4), K(5)] })).brains).toHaveLength(6);
  });
  it("a different set of brains is a new version; the same set, or none sent, is not", () => {
    const { bots } = member("pro");
    const a = bots.create(input("Voter", { brains: [PLATFORM, K(1)] }));
    expect(bots.update(a.id, input("Voter"))).toMatchObject({ version: 1, brains: [PLATFORM, K(1)] });
    expect(bots.update(a.id, input("Voter", { brains: [PLATFORM, K(1)] })).version).toBe(1);
    expect(bots.update(a.id, input("Voter", { brains: [K(1), PLATFORM] })).version).toBe(2); // the order is part of what it is
    expect(bots.update(a.id, input("Voter", { brains: [PLATFORM] }))).toMatchObject({ version: 3, brains: [PLATFORM] });
  });
  it("an agent with more brains than the plan allows goes into quarantine on a downgrade, and comes back on an upgrade", () => {
    const { store, u, bots } = member("premium");
    const a = bots.create(input("Big Vote", { brains: [PLATFORM, K(1), K(2), K(3), K(4)] }));
    const b = bots.create(input("Small Vote", { brains: [PLATFORM, K(1)] }));
    store.setTier(u.id, "pro");
    const pro = new Bots(store.tenant(u.id), "pro", () => 2000);
    expect(pro.reconcile(2000).quarantined).toEqual([a.id]);
    expect(pro.find(b.id).state).toBe("running");
    store.setTier(u.id, "premium");
    expect(new Bots(store.tenant(u.id), "premium", () => 3000).reconcile(3000).restored).toEqual([a.id]);
  });
});

describe("the runner and an agent with several brains", () => {
  const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
  const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;
  const live: ArenaRunner[] = [];
  afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));

  function world(brains: Record<string, LlmClient>, platform: LlmClient) {
    const root = mkdtempSync(join(tmpdir(), "arena-brains-run-"));
    const store = new ArenaStore(root);
    const u = store.createUser("a".repeat(32), "ana@example.com", 1);
    store.setTier(u.id, "pro");
    const vault = new Vault("a".repeat(64), async () => {}, (_p, secret) => brains[secret]!);
    const keys = vault.for(store.tenant(u.id), u.id, () => NOW);
    const runner = new ArenaRunner({ store, root, feed: fakeFeed(), decider: new LlmSystemOne(platform), now: () => NOW, tickMs: 1000, vault, dailyUsd: 0.5 });
    live.push(runner);
    return { store, u, keys, runner, bots: new Bots(store.tenant(u.id), "pro", () => NOW) };
  }
  const secretOf = (n: number) => `sk-test-brain-number-${n}-0000`;

  it("asks every brain, trades on the vote, and the decision shows the share of brains", async () => {
    const platform = brain(long);
    const own1 = brain(long);
    const own2 = brain(short);
    const w = world({ [secretOf(1)]: own1, [secretOf(2)]: own2 }, platform);
    const k1 = await w.keys.add({ provider: "openai", label: "One", secret: secretOf(1) });
    const k2 = await w.keys.add({ provider: "zai", label: "Two", secret: secretOf(2) });
    const b = w.bots.create(input("Voter", { brains: [PLATFORM, k1.id, k2.id] }));
    await w.runner.update(w.u.id);
    await w.runner.engineOf(b.id)!.tick();
    expect([platform.asked, own1.asked, own2.asked].every((n) => n > 0)).toBe(true);
    expect(w.runner.status(w.u.id, [b.id])[b.id]).toMatchObject({ state: "running", position: { coin: "BTC" } });
    const d = w.runner.insights(w.u.id, w.bots.find(b.id))!.decisions.at(-1)!;
    expect(d.choice).toBe("LONG_BTC");
    expect(d.odds[0]!.p).toBeCloseTo(2 / 3);
  });
  it("sums the ceilings: the platform's small one plus each own key's", async () => {
    const w = world({ [secretOf(1)]: brain(long) }, brain(long));
    const k = await w.keys.add({ provider: "openai", label: "One", secret: secretOf(1), dailyUsd: 3 });
    const b = w.bots.create(input("Voter", { brains: [PLATFORM, k.id] }));
    await w.runner.update(w.u.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.u.id, [b.id])[b.id]!.spentUsd).toBeGreaterThan(0);
    expect(w.runner.status(w.u.id, [b.id])[b.id]!.capped).toBe(false); // 3.5 USD, not the platform's 0.5
  });
  it("does not start when one of its keys is gone, and never leaves that brain out quietly", async () => {
    const platform = brain(long);
    const w = world({ [secretOf(1)]: brain(long) }, platform);
    const k = await w.keys.add({ provider: "openai", label: "One", secret: secretOf(1) });
    const b = w.bots.create(input("Voter", { brains: [PLATFORM, k.id] }));
    w.keys.remove(k.id);
    await w.runner.update(w.u.id);
    expect(w.runner.running).toBe(0);
    expect(w.runner.status(w.u.id, [b.id])[b.id]!.state).toBe("error");
    expect(platform.asked).toBe(0);
  });
});
