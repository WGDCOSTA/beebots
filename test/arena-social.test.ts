import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Social, type AgentCard } from "../src/arena/social.js";

const T = Date.UTC(2026, 9, 3, 12);
const H = 3_600_000;
const card = (botId: string, userId: string, name = botId): AgentCard => ({ botId, userId, name, avatar: "scout", theme: "bunnies", handle: `bunny-${userId}`, image: false });
const fill = (id: number, coin: string, side: "buy" | "sell", pnl: number, ts = T) => ({ id, ts, coin, side, notionalUsd: 500, realisedUsd: pnl });
function world() {
  let t = T;
  const s = new Social(new DatabaseSync(":memory:"), () => t);
  return { s, at: (x: number) => (t = x) };
}

describe("the Warren feed", () => {
  it("starts quietly, then posts each closed trade with its result, results only", () => {
    const { s } = world();
    const a = card("b1", "u1", "Dip");
    expect(s.record(a, 1, [fill(1, "BTC", "sell", 9)], 0.5)).toBe(0); // the first look only remembers where it is
    expect(s.record(a, 1, [fill(1, "BTC", "sell", 9), fill(2, "ETH", "buy", -4)], 0.4)).toBe(1);
    const [p] = s.feed(null);
    expect(p).toMatchObject({ kind: "closed", agent: { name: "Dip", handle: "bunny-u1" }, data: { coin: "ETH", side: "short", pnlUsd: -4, pct: -0.8 } });
    expect(JSON.stringify(p)).not.toContain("userId"); // the member's account id never leaves the server
  });
  it("posts milestones once per version, and a new version once", () => {
    const { s } = world();
    const a = card("b1", "u1");
    s.record(a, 1, [], 0);
    s.record(a, 1, [], 6);
    s.record(a, 1, [], 7);
    s.record(a, 1, [], 11);
    expect(s.feed(null).map((p) => [p.kind, p.data.pct])).toEqual([["milestone", 10], ["milestone", 5]]);
    s.record(a, 2, [], 0);
    expect(s.feed(null)[0]).toMatchObject({ kind: "version", data: { version: 2 } });
  });
  it("pairs two members' agents that closed opposite sides of one coin lately, once a day", () => {
    const { s } = world();
    const a = card("b1", "u1", "Bull");
    const b = card("b2", "u2", "Bear");
    s.record(a, 1, [], 0);
    s.record(b, 1, [], 0);
    s.record(a, 1, [fill(1, "BTC", "sell", 12, T - H)], 1);
    s.record(b, 1, [fill(1, "BTC", "buy", -7, T)], -1);
    const r = s.feed(null).find((p) => p.kind === "rivalry")!;
    expect(r).toMatchObject({ agent: { name: "Bear" }, other: { name: "Bull" }, data: { coin: "BTC", side: "short", pnlUsd: -7, otherSide: "long", otherPnlUsd: 12 } });
    s.record(b, 1, [fill(1, "BTC", "buy", -7), fill(2, "BTC", "buy", 3, T)], -1);
    expect(s.feed(null).filter((p) => p.kind === "rivalry")).toHaveLength(1);
    // the same member's two agents are not rivals
    const c = card("b3", "u1", "Bull2");
    s.record(c, 1, [], 0);
    s.record(c, 1, [fill(1, "BTC", "buy", 1, T)], 0);
    expect(s.feed(null).filter((p) => p.kind === "rivalry")).toHaveLength(1);
  });
  it("follows, cheers, and filters to what a member follows", () => {
    const { s } = world();
    const a = card("b1", "u1");
    const b = card("b2", "u2");
    for (const x of [a, b]) {
      s.record(x, 1, [], 0);
      s.record(x, 1, [fill(1, "SOL", "sell", 2)], 0);
    }
    const id = s.feed(null, { bot: "b2" })[0]!.id;
    expect(s.react("u3", id, "carrot")).toMatchObject({ carrot: 1 });
    expect(s.react("u3", id, "carrot")).toMatchObject({ carrot: 0 }); // a second tap takes it back
    expect(s.react("u3", id, "nonsense")).toBeNull();
    s.react("u3", id, "fire");
    s.follow("u3", "b2", true);
    const mine = s.feed("u3", { following: true });
    expect(mine.map((p) => p.agent.botId)).toEqual(["b2"]);
    expect(mine[0]).toMatchObject({ mine: ["fire"], following: true, own: false, reactions: { fire: 1 } });
    expect(s.followers("b2")).toBe(1);
    expect(s.feed("u1", { following: true }).map((p) => p.agent.botId)).toEqual(["b1"]); // one's own agents are always there
  });
  it("forgets an agent and a member completely, and prunes old posts", () => {
    const { s, at } = world();
    const a = card("b1", "u1");
    const b = card("b2", "u2");
    for (const x of [a, b]) s.record(x, 1, [], 0);
    s.record(a, 1, [fill(1, "BTC", "sell", 5)], 0);
    s.record(b, 1, [fill(1, "BTC", "buy", -5)], 0);
    s.follow("u2", "b1", true);
    s.forgetBot("b1");
    expect(s.feed(null).some((p) => p.agent.botId === "b1" || p.other?.botId === "b1")).toBe(false);
    expect(s.followers("b1")).toBe(0);
    s.forgetUser("u2");
    expect(s.feed(null)).toEqual([]);
    expect(s.following("u2")).toEqual([]);
    const c = card("b3", "u3");
    s.record(c, 1, [], 0);
    s.record(c, 1, [fill(1, "BTC", "sell", 1, T)], 0);
    at(T + 31 * 24 * H);
    s.prune();
    expect(s.feed(null)).toEqual([]);
  });
});

// The runner turns a listed agent's paper fills into posts; an unlisted one posts nothing.
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

describe("the runner feeds the Warren", () => {
  it("records listed agents and skips unlisted ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "arena-social-run-"));
    const store = new ArenaStore(root);
    const u = store.createUser("a".repeat(32), "ana@example.com", 1);
    const llm: LlmClient = { brain: "openai", model: "f", async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> { return { data: ask.validate.parse({ choice: "HOLD_WINNER", confidence: 0.5, conviction: 1 }), brain: "openai", model: "f", inputTokens: 1, outputTokens: 1, latencyMs: 1 }; } };
    const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] } as unknown as MarketFeed;
    const social = new Social(store.dir, () => NOW);
    const runner = new ArenaRunner({ store, root, feed, decider: new LlmSystemOne(llm), now: () => NOW, social });
    const bots = new Bots(store.tenant(u.id), "free", () => NOW);
    const b = bots.create({ name: "Listed", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." } as never);
    await runner.update(u.id);
    runner.socialize();
    expect(social.cursor(b.id, 1).fillId).toBe(0);
    bots.update(b.id, { ...b, listed: false } as never);
    await runner.update(u.id);
    runner.socialize();
    runner.stopAll();
  });
});
