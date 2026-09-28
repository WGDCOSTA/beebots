import { describe, expect, it } from "vitest";
import { reviewWatchlist } from "../src/brains/coach.js";
import { runCouncil, type CouncilBee } from "../src/brains/council.js";
import type { BrainId, JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { PlaybookSchema } from "../src/brains/playbook.js";
import { combineCoins } from "../src/brains/survival.js";
import {
  candidateCoins,
  coinEvidence,
  effectiveWatchlist,
  normaliseWatchlist,
  rulesWatchlist,
  watchlistSize,
  type CoinInfo,
  type WatchItem,
} from "../src/brains/watchlist.js";
import { KnowledgeGraph, nodeId } from "../src/graph/graph.js";
import { syntheticCandles } from "../src/lab/history.js";
import { BUILTIN_SKILLS } from "../src/lab/skills/index.js";
import { runTournament, type Ranking } from "../src/lab/tournament.js";

const info = (coin: string, volM: number): CoinInfo => ({ coin, vol24hUsd: volM * 1e6, ret7dPct: 1, spreadBp: 2, atrPct: 1 });
const UNIVERSE = [info("BTC", 900), info("ETH", 500), info("SOL", 300), info("DOGE", 100), info("PEPE", 50)];
const item = (coin: string, probation = false): WatchItem => ({ coin, reason: "r", probation });

let ranking: Ranking | null = null;
function smallRanking(): Ranking {
  ranking ??= runTournament(
    BUILTIN_SKILLS.filter((s) => ["buy_hold", "sma_cross", "donchian_turtle", "roc_momentum"].includes(s.id)),
    [
      { id: "SOL-USDT-SWAP 1H", instId: "SOL-USDT-SWAP", bar: "1H", candles: syntheticCandles(7, 1200), source: "synthetic" },
      { id: "DOGE-USDT-SWAP 1H", instId: "DOGE-USDT-SWAP", bar: "1H", candles: syntheticCandles(8, 1200), source: "synthetic" },
    ],
    { folds: 2, maxCombos: 3 },
  );
  return ranking;
}

class FakeBrain implements LlmClient {
  asked: Array<JsonAsk<unknown>> = [];
  constructor(
    readonly brain: BrainId,
    private reply: (ask: JsonAsk<unknown>) => unknown,
    readonly model = `${brain}-test`,
  ) {}
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    return { data: ask.validate.parse(this.reply(ask as JsonAsk<unknown>)), brain: this.brain, model: this.model, inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

describe("watchlist candidates and limits", () => {
  it("owner coins are a hard limit, then the style's coins, else liquidity + lab + record", () => {
    const base = { universe: UNIVERSE, ranking: smallRanking(), traded: ["arb"] };
    expect(candidateCoins({ ...base, style: "boozy", ownerCoins: ["sol", "BTC"] })).toEqual(["SOL", "BTC"]);
    expect(candidateCoins({ ...base, style: "breezy", ownerCoins: [] })).toEqual(["BTC", "ETH"]);
    expect(candidateCoins({ ...base, style: "bizzy", ownerCoins: [] })).toEqual(["BTC", "ETH", "SOL", "HYPE"]);
    const any = candidateCoins({ ...base, style: "boozy", ownerCoins: [], limit: 3 });
    expect(any).toEqual(["BTC", "ETH", "SOL", "DOGE", "ARB"]);
  });

  it("a macro bee's candidates are only stocks or commodities of its market", () => {
    const universe = [...UNIVERSE, info("XAU", 50), info("NVDA", 5), info("CL", 20)];
    expect(candidateCoins({ universe, ranking: null, traded: ["SOL", "XAG"], style: "boozy", ownerCoins: [], market: "commodities" })).toEqual(["XAU", "CL", "XAG"]);
    expect(candidateCoins({ universe, ranking: null, traded: [], style: "breezy", ownerCoins: [], market: "stocks" })).toEqual(["NVDA"]);
    const picks = [item("XAU"), item("BTC")];
    expect(effectiveWatchlist({ enabled: true, picks, style: "boozy", ownerCoins: [], tier: null, liquid: [], market: "commodities" })).toEqual({ coins: ["XAU"], probation: [] });
  });

  it("size grows with the level and shrinks to 3 in danger", () => {
    expect(watchlistSize(0, "healthy")).toBe(3);
    expect(watchlistSize(3, "thriving")).toBe(6);
    expect(watchlistSize(9, null)).toBe(8);
    expect(watchlistSize(5, "danger")).toBe(3);
  });

  it("evidence carries lab scores per coin, the bee's record and liquidity", () => {
    const ev = coinEvidence({ candidates: ["SOL", "BTC"], ranking: smallRanking(), adoptedSkills: ["sma_cross"], record: [{ coin: "BTC", netUsd: -3, trades: 2, winRatePct: 0 }], universe: UNIVERSE });
    expect(ev[0]!.lab?.bestSkill).toBeTruthy();
    expect(ev[0]!.lab?.adoptedScore).not.toBeNull();
    expect(ev[1]).toMatchObject({ lab: null, record: { netUsd: -3, trades: 2 }, live: { volMusd: 900 } });
    const rules = rulesWatchlist(ev, 1, 1);
    expect(rules).toHaveLength(1);
  });

  it("a brain's pick keeps only candidates, once, up to the size", () => {
    const w = normaliseWatchlist([{ coin: "sol-usdt-swap", reason: "a" }, { coin: "SOL", reason: "dup" }, { coin: "XYZ", reason: "no" }, { coin: "btc", reason: "b" }, { coin: "ETH", reason: "c" }], ["BTC", "ETH", "SOL"], 2, 5);
    expect(w.map((x) => x.coin)).toEqual(["SOL", "BTC"]);
    expect(w[0]).toMatchObject({ probation: false, addedAt: 5 });
  });

  it("the engine applies owner coins, style and the survival tier; null falls back to the style", () => {
    const liquid = ["BTC", "ETH", "SOL", "DOGE"];
    const picks = [item("SOL"), item("PEPE", true), item("BTC")];
    const base = { enabled: true, picks, style: "boozy", ownerCoins: [] as string[], tier: "healthy" as const, liquid };
    expect(effectiveWatchlist(base)).toEqual({ coins: ["SOL", "PEPE", "BTC"], probation: ["PEPE"] });
    expect(effectiveWatchlist({ ...base, enabled: false })).toBeNull();
    expect(effectiveWatchlist({ ...base, picks: [] })).toBeNull();
    expect(effectiveWatchlist({ ...base, ownerCoins: ["BTC"] })).toEqual({ coins: ["BTC"], probation: [] });
    expect(effectiveWatchlist({ ...base, style: "breezy" })).toEqual({ coins: ["BTC"], probation: [] });
    expect(effectiveWatchlist({ ...base, style: "breezy", picks: [item("SOL")] })).toBeNull();
    // In danger: only liquid coins, nothing on probation.
    expect(effectiveWatchlist({ ...base, tier: "danger", liquid: ["BTC", "SOL"] })).toEqual({ coins: ["SOL", "BTC"], probation: [] });
  });
});

describe("brains choose coins", () => {
  it("the council stores each bee's coins in the playbook and the graph, with a rules fallback", async () => {
    const g = new KnowledgeGraph(":memory:");
    const bees: CouncilBee[] = [
      { slot: "bee1", name: "Boozy", style: "boozy", rules: "", coins: [], brain: "openai", model: "x" },
      { slot: "bee2", name: "Breezy", style: "breezy", rules: "", coins: [], brain: "claude", model: "x" },
    ];
    const r = smallRanking();
    const top = r.results.find((s) => s.family !== "benchmark")!.skillId;
    const openai = new FakeBrain("openai", () => ({
      skills: [{ id: top, weight: 1, reason: "robust" }],
      lessons: [],
      message: "hi",
      coins: [{ coin: "SOL", reason: "lab score on SOL" }, { coin: "NOPE", reason: "not a candidate" }, { coin: "DOGE", reason: "liquid" }],
    }));
    const res = await runCouncil({ graph: g, ranking: r, bees, clients: { openai }, universe: UNIVERSE, watchSize: (s) => (s === "bee1" ? 2 : 3) });
    const pb = PlaybookSchema.parse(res.playbook);
    expect(pb.bees.bee1!.watchlist!.map((w) => w.coin)).toEqual(["SOL", "DOGE"]);
    expect(res.log[0]!.coins).toEqual(["SOL", "DOGE"]);
    const user = JSON.parse(openai.asked[0]!.user) as { coinCandidates: Array<{ coin: string }>; watchlistSize: number };
    expect(user.watchlistSize).toBe(2);
    expect(user.coinCandidates.map((c) => c.coin)).toContain("SOL");
    expect(openai.asked[0]!.system).toContain("WATCHLIST");
    // No brain for bee2: rules pick among Breezy's coins.
    expect(pb.bees.bee2!.watchlist!.every((w) => ["BTC", "ETH"].includes(w.coin))).toBe(true);
    expect(g.out(nodeId("bee", "bee1"), "watches", 10).map((e) => e.dst)).toEqual(expect.arrayContaining([nodeId("coin", "SOL"), nodeId("coin", "DOGE")]));

    // Watchlist off: the previous one is kept, the brain is not asked about coins.
    const again = await runCouncil({ graph: g, ranking: r, bees: bees.slice(0, 1), clients: { openai }, previous: res.playbook, pickCoins: false });
    expect(again.playbook.bees.bee1!.watchlist!.map((w) => w.coin)).toEqual(["SOL", "DOGE"]);
    expect(JSON.parse(openai.asked[1]!.user).coinCandidates).toBeUndefined();
  });

  it("the coach drops coins (never the last), adds one on probation, and clears probation on the next review", () => {
    const cur = [item("SOL"), item("BTC")];
    const a = reviewWatchlist(cur, { drop: ["BTC"], add: ["PEPE", "DOGE"], reason: "new momentum" }, ["SOL", "BTC", "PEPE", "DOGE"], 3, 9);
    expect(a).toEqual([item("SOL"), { coin: "PEPE", reason: "new momentum", probation: true, addedAt: 9 }]);
    const b = reviewWatchlist(a, { drop: [], add: [], reason: "" }, ["SOL", "PEPE"], 3, 10);
    expect(b.map((w) => w.probation)).toEqual([false, false]);
    expect(reviewWatchlist(cur, { drop: ["SOL", "BTC"], add: [], reason: "" }, [], 3, 1).map((w) => w.coin)).toEqual(["SOL"]);
    // Not a candidate, or no room: nothing added.
    expect(reviewWatchlist(cur, { drop: [], add: ["XYZ"], reason: "" }, ["SOL", "BTC"], 3, 1)).toHaveLength(2);
    expect(reviewWatchlist(cur, { drop: [], add: ["DOGE"], reason: "" }, ["DOGE"], 2, 1)).toHaveLength(2);
  });

  it("the survival council combines votes and, in danger, favours liquid coins", () => {
    const picks = [
      [{ coin: "PEPE", reason: "a" }, { coin: "SOL", reason: "b" }],
      [{ coin: "PEPE", reason: "c" }, { coin: "BTC", reason: "d" }],
    ];
    const cands = ["BTC", "SOL", "PEPE"];
    expect(combineCoins(picks, cands, 3, false, ["BTC", "SOL"], 1)[0]!.coin).toBe("PEPE");
    const danger = combineCoins(picks, cands, 2, true, ["BTC", "SOL"], 1);
    expect(danger.map((w) => w.coin).sort()).toEqual(["BTC", "SOL"]);
  });
});

describe("engine with a watchlist", () => {
  async function run(watch: WatchItem[] | null, choice = "NOT_ON_MENU") {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const { coin, NOW, testConfig, view } = await import("./fixtures.js");
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([coin("BTC", {}, 80000), coin("ETH", {}, 3000), coin("SOL", { ret7dPct: 20 }, 150)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    type Req = { state: Record<string, unknown>; questions: { action: { instructions: string; criteria: Record<string, string> } } };
    const reqs: Req[] = [];
    const client = {
      async systemOne(req: unknown) {
        reqs.push(req as Req);
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 0.9 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const engine = new Engine({
      cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW,
      watchlist: (id) => (id === "bee3" ? watch : null),
    });
    await engine.start();
    engine.stop();
    await engine.tick();
    return { reqs, engine };
  }

  it("offers Jev only the watchlist's coins and says why", async () => {
    const { reqs, engine } = await run([item("ETH"), item("BTC")]);
    const boozy = reqs.find((r) => Object.keys(r.questions.action.criteria).some((k) => k.startsWith("APE_")))!;
    expect(Object.keys(boozy.questions.action.criteria).sort()).toEqual(["APE_BTC", "APE_ETH"]);
    expect(boozy.questions.action.instructions).toContain("Watchlist chosen by this bee's AI brains");
    const w = engine.snapshot().bees.find((b) => b.bee === "bee3")!.watchlist!;
    expect(w).toMatchObject({ coins: ["ETH", "BTC"], probation: [] });
    // The dashboard's Watchlists view shows each coin with the brains' reason.
    expect(w.items.map((i) => [i.coin, i.reason, i.probation])).toEqual([
      ["ETH", item("ETH").reason, false],
      ["BTC", item("BTC").reason, false],
    ]);
    const plain = await run(null);
    expect(Object.keys(plain.reqs.find((r) => Object.keys(r.questions.action.criteria).some((k) => k.startsWith("APE_")))!.questions.action.criteria)).toContain("APE_SOL");
  });

  it("a coin on probation trades at half size", async () => {
    const full = await run([item("ETH"), item("BTC")], "APE_ETH");
    const half = await run([item("ETH", true), item("BTC")], "APE_ETH");
    const a = full.engine.bees.bee3.position;
    const b = half.engine.bees.bee3.position;
    expect(a?.instId.startsWith("ETH-")).toBe(true);
    expect(b?.instId).toBe(a!.instId);
    expect(b!.contracts / a!.contracts).toBeGreaterThan(0.4);
    expect(b!.contracts / a!.contracts).toBeLessThan(0.6);
  });
});
