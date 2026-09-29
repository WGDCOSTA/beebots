// One bunny's profile page data (bunnyProfile.ts): stats, per-coin record, decisions, lessons and the Warren's messages.
import { describe, expect, it } from "vitest";
import { bunnyProfile } from "../src/bunnyProfile.js";
import { Db } from "../src/db.js";
import { KnowledgeGraph } from "../src/graph/graph.js";
import { beeNode } from "../src/graph/hive-mind.js";

const NOW = 1_790_000_000_000;

function seed() {
  const db = new Db(":memory:");
  const graph = new KnowledgeGraph(":memory:");
  const dec = (bee: "bee1" | "bee2", ts: number, choice: string, confidence: number) =>
    db.insertDecision({ bee, ts, stateHash: null, stateJson: null, menuJson: null, choice, probabilities: null, confidence, conviction: 0.5, latencyMs: 800, inputTokens: 10, jevCostUsd: 0.001, jevError: null, action: { type: "hold" }, vetoedBy: null, forcedBy: null, status: "ok" } as never);
  const trade = (bee: "bee1" | "bee2", ts: number, inst: string, realised: number) => {
    const d = dec(bee, ts, "OPEN_LONG_X", 0.7);
    const open = db.insertOrder({ decisionId: d, bee, ts, clOrdId: `o${bee}${ts}`, instId: inst, side: "buy", contracts: 1, reduceOnly: false, purpose: "open" });
    db.insertFill({ orderId: open, bee, ts, instId: inst, side: "buy", contracts: 1, px: 100, notionalUsd: 100, feeUsd: 0.05, realisedUsd: 0 });
    const close = db.insertOrder({ decisionId: d, bee, ts: ts + 1000, clOrdId: `c${bee}${ts}`, instId: inst, side: "sell", contracts: 1, reduceOnly: true, purpose: "close" });
    db.insertFill({ orderId: close, bee, ts: ts + 1000, instId: inst, side: "sell", contracts: 1, px: 100 + realised, notionalUsd: 100 + realised, feeUsd: 0.05, realisedUsd: realised });
  };
  trade("bee1", NOW - 3 * 3_600_000, "SOL-USDT-SWAP", 4);
  trade("bee1", NOW - 2 * 3_600_000, "SOL-USDT-SWAP", -1);
  trade("bee1", NOW - 1 * 3_600_000, "BTC-USDT-SWAP", 2);
  trade("bee2", NOW - 1 * 3_600_000, "ETH-USDT-SWAP", 9);
  db.insertEquity("bee1", NOW - 2 * 86_400_000, 334, 334, 0);
  db.insertEquity("bee1", NOW - 60_000, 338, 338, 0);
  graph.upsert("bee", "bee1", "Honey");
  graph.upsert("bee", "bee2", "Galactus");
  const lesson = graph.upsert("lesson", "l1", "SOL fakes breakouts at night", { text: "SOL fakes breakouts at night", source: "coach" });
  graph.link(beeNode("bee1"), "learned", lesson);
  graph.post(beeNode("bee2"), "hive", "ETH trend is strong, I lean in.", { source: "council", brain: "claude" });
  graph.post(beeNode("bee1"), "hive", "Staying small on SOL.", { source: "coach", brain: "openai" });
  return { db, graph };
}

describe("bunnyProfile", () => {
  it("adds up one bunny's trades, coins, decisions, lessons and the Warren's messages", () => {
    const { db, graph } = seed();
    const p = bunnyProfile({ db, graph, playbook: () => null, slots: () => ["bee1", "bee2"], now: () => NOW }, "bee1") as any;
    expect(p.stats).toMatchObject({ trades: 3, wins: 2, losses: 1, winRatePct: 66.67, realisedUsd: 5, feesUsd: 0.3, profitFactor: 6, bestUsd: 4, worstUsd: -1, decisions: 3 });
    expect(p.coins.map((c: { coin: string }) => c.coin)).toEqual(["SOL", "BTC"]);
    expect(p.coins[0]).toMatchObject({ trades: 2, wins: 1, realisedUsd: 3, winRatePct: 50 });
    expect(p.equity.map((x: [number, number]) => x[1])).toEqual([334, 338]);
    expect(p.fills[0]).toMatchObject({ coin: "BTC", close: true, realisedUsd: 2, purpose: "close" });
    expect(p.learning.lessons[0]).toMatchObject({ text: "SOL fakes breakouts at night", source: "coach" });
    const mine = p.messages.find((m: { mine: boolean }) => m.mine);
    expect(mine).toMatchObject({ fromName: "Honey", toName: "the Warren", source: "coach" });
    expect(p.messages.find((m: { fromName: string }) => m.fromName === "Galactus")).toMatchObject({ mine: false, brain: "claude" });
    expect(p.daily.reduce((a: number, d: { trades: number }) => a + d.trades, 0)).toBe(3);
  });

  it("is null for a slot the engine does not run", () => {
    const { db, graph } = seed();
    expect(bunnyProfile({ db, graph, playbook: () => null, slots: () => ["bee1"] }, "bee7")).toBeNull();
  });
});

describe("equity bucketing", () => {
  it("groups equity into whole buckets (node:sqlite binds numbers as REAL, so plain ts / ? never grouped)", () => {
    const db = new Db(":memory:");
    const graph = new KnowledgeGraph(":memory:");
    const t0 = Date.now() - 86_400_000;
    for (let i = 0; i < 2000; i++) db.insertEquity("bee1", t0 + i * 40_000, 333 + i / 100, 333, 0);
    const series = db.equitySeries(t0, 100).bee1!;
    expect(series.length).toBeLessThanOrEqual(110);
    const p = bunnyProfile({ db, graph, playbook: () => null, slots: () => ["bee1"] }, "bee1", 1) as { equity: unknown[] };
    expect(p.equity.length).toBeLessThanOrEqual(410);
    expect(p.equity.length).toBeGreaterThan(50);
  });
});
