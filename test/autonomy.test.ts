import { describe, expect, it } from "vitest";
import { skillBrain, skillSignal } from "../src/bees/skill.js";
import type { BeeContext } from "../src/bees/types.js";
import { runCouncil, type CouncilBee } from "../src/brains/council.js";
import type { BrainId, JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { methodOptions, resolvePick } from "../src/brains/specialization.js";
import { KnowledgeGraph, nodeId } from "../src/graph/graph.js";
import { contextFor, ingestRanking, registerBees } from "../src/graph/hive-mind.js";
import { communities, confidenceOf, conflicts, consolidate, explain, godNodes, hiveReport, memories, path, query, subgraph } from "../src/graph/memory.js";
import { syntheticCandles } from "../src/lab/history.js";
import { BUILTIN_SKILLS } from "../src/lab/skills/index.js";
import { runTournament, type Ranking } from "../src/lab/tournament.js";
import type { Candle } from "../src/market/types.js";
import { freshBee } from "../src/ledger.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

const sma = BUILTIN_SKILLS.find((s) => s.id === "sma_cross")!;
/** Hourly candles drifting steadily up (dir 1) or down (-1): SMA cross is long, resp. short, at the end. */
const trend = (dir: 1 | -1, n = 120): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 100 * (1 + dir * 0.002 * i);
    return { ts: NOW - (n - i) * 3_600_000, o: c, h: c * 1.001, l: c * 0.999, c, volUsd: 1e6, confirmed: true };
  });

function ctxWith(candles: Record<string, Candle[]>, held?: string): BeeContext {
  const cfg = testConfig({ BEE_START_EQUITY_USD: "1000" });
  const v = view([coin("BTC", {}, 100), coin("SOL", {}, 100), coin("ETH", {}, 100)]);
  const b = freshBee("bee1", 1000, NOW - 3_600_000);
  if (held) b.position = position(v.stats.get(`${held}-USD_UM_XPERP-310404`)!, { riskUsd: 10 });
  return { bee: b, view: v, cfg, knobs: cfg.bees.boozy, now: NOW, uplR: held ? 0 : null, candles: (id) => candles[id.split("-")[0]!] ?? [] };
}

describe("a bee specialised in a lab skill", () => {
  const brain = skillBrain({ skill: sma, params: { fast: 5, slow: 20, shorts: 1 } });

  it("reads the skill's signal on the last closed bar", () => {
    expect(skillSignal({ skill: sma, params: { fast: 5, slow: 20, shorts: 1 } }, trend(1))).toBe(1);
    expect(skillSignal({ skill: sma, params: { fast: 5, slow: 20, shorts: 1 } }, trend(-1))).toBe(-1);
    expect(skillSignal({ skill: sma, params: {} }, trend(1, 10))).toBeNull(); // too little history
  });

  it("offers only the coins where the method signals, plus WAIT, and is never forced in", () => {
    const m = brain.menu(ctxWith({ BTC: trend(1), SOL: trend(-1), ETH: trend(1, 10) }));
    expect(Object.keys(m).sort()).toEqual(["SMA_CROSS_LONG_BTC", "SMA_CROSS_SHORT_SOL", "WAIT"]);
    expect(brain.forcedEntry(ctxWith({}))).toBeNull();
    expect(brain.neverForce).toBe(true);
    expect(brain.strategy).toContain("SMA crossover");
    expect(brain.id).toBe("skill");
  });

  it("exits when the method flips against the position", () => {
    expect(Object.keys(brain.menu(ctxWith({ BTC: trend(1) }, "BTC")))).toEqual(["HOLD"]);
    expect(Object.keys(brain.menu(ctxWith({ BTC: trend(-1) }, "BTC")))).toEqual(["HOLD", "EXIT"]);
  });
});

describe("choosing a specialisation", () => {
  let ranking: Ranking | null = null;
  const rank = () =>
    (ranking ??= runTournament(
      BUILTIN_SKILLS.filter((s) => ["buy_hold", "sma_cross", "donchian_turtle", "roc_momentum", "supertrend"].includes(s.id)),
      [{ id: "BTC-USDT-SWAP 1H", instId: "BTC-USDT-SWAP", bar: "1H", candles: syntheticCandles(11, 1500), source: "synthetic" }],
      { folds: 2, maxCombos: 3 },
    ));

  it("offers the market's styles and the lab's positive, stable skills; anything else is kept", () => {
    const opts = methodOptions({ market: "crypto", current: { kind: "own", id: "boozy" }, ranking: rank() });
    expect(opts.styles).toEqual(["bizzy", "breezy", "boozy", "degen"]);
    expect(opts.skills.every((s) => s.score > 0 && s.stabilityPct >= 40)).toBe(true);
    expect(methodOptions({ market: "stocks", current: { kind: "own", id: "macro" }, ranking: null }).styles).toEqual(["macro"]);
    expect(resolvePick({ kind: "style", id: "breezy", reason: "trend season" }, opts, 1)).toMatchObject({ kind: "style", id: "breezy" });
    expect(resolvePick({ kind: "style", id: "macro", reason: "" }, opts, 1)).toBeNull();
    expect(resolvePick({ kind: "skill", id: "nope", reason: "" }, opts, 1)).toBeNull();
    expect(resolvePick({ kind: "keep", id: "", reason: "" }, opts, 1)).toBeNull();
    if (opts.skills[0]) expect(resolvePick({ kind: "skill", id: opts.skills[0].id, reason: "edge" }, opts, 1)).toMatchObject({ kind: "skill", params: opts.skills[0].params });
  });

  it("the council stores the brain's pick, links it in the graph and writes the diary", async () => {
    const r = rank();
    const opts = methodOptions({ market: "crypto", current: { kind: "own", id: "boozy" }, ranking: r });
    const g = new KnowledgeGraph(":memory:");
    const bee: CouncilBee = { slot: "bee1", name: "Boozy", style: "boozy", rules: "", coins: [], brain: "openai", model: "x" };
    const top = r.results.find((s) => s.family !== "benchmark")!.skillId;
    const pick = opts.skills[0] ? { kind: "skill", id: opts.skills[0].id, reason: "best out of sample" } : { kind: "style", id: "breezy", reason: "trend" };
    const openai: LlmClient = {
      brain: "openai" as BrainId,
      model: "t",
      async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
        expect(JSON.parse(ask.user).methodOptions.styles).toContain("breezy");
        expect(ask.system).toContain("SPECIALISATION");
        const data = ask.validate.parse({ skills: [{ id: top, weight: 1, reason: "r" }], lessons: [], message: "", coins: [], specialization: pick });
        return { data, brain: "openai", model: "t", inputTokens: 1, outputTokens: 1, latencyMs: 1 };
      },
    };
    const res = await runCouncil({ graph: g, ranking: r, bees: [bee], clients: { openai } });
    expect(res.playbook.bees.bee1!.specialization).toMatchObject({ kind: pick.kind, id: pick.id });
    expect(g.out(nodeId("bee", "bee1"), "specialises_in").length).toBe(1);
    expect(contextFor(g, "bee1").specialization).not.toBeNull();
    expect(contextFor(g, "bee1").myLessons[0]).toMatch(/^Specialisation:/);
    // "keep" next round leaves it as it is.
    const keep: LlmClient = { ...openai, async json<T>(ask: JsonAsk<T>) { return { data: ask.validate.parse({ skills: [{ id: top, weight: 1, reason: "r" }], lessons: [], message: "", coins: [], specialization: { kind: "keep", id: "", reason: "" } }), brain: "openai", model: "t", inputTokens: 1, outputTokens: 1, latencyMs: 1 } as JsonAnswer<T>; } };
    const again = await runCouncil({ graph: g, ranking: r, bees: [bee], clients: { openai: keep }, previous: res.playbook });
    expect(again.playbook.bees.bee1!.specialization?.id).toBe(pick.id);
  });
});

describe("the engine adopts the method only when flat", () => {
  it("switches a flat bee to its chosen skill, never mid-position, and not again within the minimum hours", async () => {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([coin("BTC", { ret7dPct: 20 }, 100), coin("SOL", { ret7dPct: 10 }, 100)]);
    const candles: Record<string, Candle[]> = { BTC: trend(1), SOL: trend(-1) };
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: (id: string) => candles[id.split("-")[0]!] ?? [] } as never;
    type Req = { questions: { action: { instructions: string; criteria: Record<string, string> } } };
    const reqs: Req[] = [];
    const client = {
      async systemOne(req: unknown) {
        reqs.push(req as Req);
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    let want: { kind: "style" | "skill"; id: string; params?: Record<string, number> } | null = { kind: "skill", id: "sma_cross", params: { fast: 5, slow: 20, shorts: 1 } };
    const db = new Db(":memory:");
    let t = NOW;
    const engine = new Engine({
      cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => t }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate, () => t), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => t,
      specialization: (id) => (id === "bee3" ? want : null),
      skillById: (id) => BUILTIN_SKILLS.find((s) => s.id === id),
    });
    await engine.start();
    engine.stop();
    const b3 = engine.bees.bee3;
    b3.position = null; // flat
    await engine.tick();
    const snap = engine.snapshot().bees.find((b) => b.bee === "bee3")!;
    expect(snap.method).toMatchObject({ kind: "skill", id: "sma_cross", name: "SMA crossover" });
    const r = reqs.find((q) => Object.keys(q.questions.action.criteria).some((l) => l.startsWith("SMA_CROSS_")));
    expect(r).toBeDefined();
    expect(r!.questions.action.instructions).toContain("specialised in the SMA crossover method");
    expect(JSON.parse(db.getMeta("spec_bee3")!)).toMatchObject({ kind: "skill", id: "sma_cross" });

    // Within the minimum hours, a new choice waits.
    want = { kind: "style", id: "breezy" };
    t += 60_000;
    await engine.tick();
    expect(engine.snapshot().bees.find((b) => b.bee === "bee3")!.method).toMatchObject({ id: "sma_cross" });
    // Later, but holding a position: still waits.
    t += 7 * 3_600_000;
    b3.position = position(v.stats.get("BTC-USD_UM_XPERP-310404")!, { riskUsd: 10 });
    await engine.tick();
    expect(engine.snapshot().bees.find((b) => b.bee === "bee3")!.method).toMatchObject({ id: "sma_cross" });
    // Flat again: switches.
    engine.bees.bee3.position = null;
    t += 60_000;
    await engine.tick();
    expect(engine.snapshot().bees.find((b) => b.bee === "bee3")!.method).toMatchObject({ kind: "style", id: "breezy" });
  });
});

describe("graphify-style memory", () => {
  function hive() {
    const g = new KnowledgeGraph(":memory:");
    registerBees(g, [
      { slot: "bee1", name: "Bizzy", style: "bizzy", rules: "", coins: [], brain: "openai", model: "x" },
      { slot: "bee2", name: "Breezy", style: "breezy", rules: "", coins: [], brain: "claude", model: "y" },
    ]);
    const b1 = nodeId("bee", "bee1");
    const sol = g.upsert("coin", "SOL", "SOL");
    const btc = g.upsert("coin", "BTC", "BTC");
    const donch = g.upsert("skill", "donchian", "Donchian breakout", { family: "breakout" });
    g.link(b1, "adopts", donch, 0.8);
    g.link(donch, "performs_on", sol, 0.9);
    g.link(b1, "traded", sol, -12, { trades: 5, wins: 1 }, "set");
    g.link(nodeId("bee", "bee2"), "traded", btc, 20, { trades: 4, wins: 3 }, "set");
    for (let i = 0; i < 10; i++) g.learn(b1, `lesson ${i}: SOL breakouts fail on weekends`, [sol]);
    return { g, b1, sol, donch };
  }

  it("marks facts and inferences, finds communities and god nodes, and flags facts that disagree", () => {
    const { g, b1 } = hive();
    expect(confidenceOf({ rel: "traded" })).toBe("EXTRACTED");
    expect(confidenceOf({ rel: "adopts" })).toBe("INFERRED");
    const { byNode, list } = communities(g);
    expect(byNode.get(b1)).toBe(byNode.get(nodeId("coin", "SOL")));
    expect(list.length).toBeGreaterThan(0);
    expect(godNodes(g, 3).length).toBe(3);
    const c = conflicts(g);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ bee: "bee1", coin: "SOL", skill: "donchian", confidence: "AMBIGUOUS" });
  });

  it("recalls a scoped slice, a path, a node and a question", () => {
    const { g, b1 } = hive();
    const s = subgraph(g, [b1], { hops: 2, maxNodes: 5 });
    expect(s.nodes.length).toBeLessThanOrEqual(5);
    expect(s.nodes.some((n) => n.type === "lesson")).toBe(false);
    expect(s.edges.find((e) => e.rel === "traded")?.confidence).toBe("EXTRACTED");
    expect(path(g, "Bizzy", "Donchian breakout")).toEqual(["Bizzy -adopts-> Donchian breakout"]);
    expect(path(g, "Bizzy", "nothing")).toBeNull();
    expect(explain(g, "SOL")!.links.some((l) => l.rel === "<-traded" && l.confidence === "EXTRACTED")).toBe(true);
    expect(query(g, "what about SOL breakouts").focus).toContain(nodeId("coin", "SOL"));
  });

  it("folds older lessons into memories without losing them, and the context stays small", async () => {
    const { g, b1 } = hive();
    const folded = await consolidate(g, b1, { keepRecent: 4 });
    expect(folded).toBe(6);
    const mem = memories(g, b1);
    expect(mem).toHaveLength(1);
    expect(mem[0]!.lessons).toBe(6);
    // Duplicates merge in the digest; originals stay, marked.
    expect(g.nodes("lesson").filter((n) => n.props.consolidated).length).toBe(6);
    const ctx = contextFor(g, "bee1");
    expect(ctx.myLessons).toHaveLength(4);
    expect(ctx.memory).toHaveLength(1);
    expect(ctx.trust).toContain("EXTRACTED");
    expect(ctx.conflicts[0]).toContain("donchian");
    expect(ctx.graph.nodes.length).toBeLessThanOrEqual(20);
    // A brain can write the memory; if it fails, the rules digest steps in.
    g.learn(b1, "fresh lesson A");
    for (let i = 0; i < 6; i++) g.learn(b1, `x ${i}`);
    await consolidate(g, b1, { keepRecent: 2, summarize: async () => { throw new Error("down"); } });
    expect(memories(g, b1)[0]!.text.length).toBeGreaterThan(0);
    expect(await consolidate(g, b1, { keepRecent: 2 })).toBe(0);
  });

  it("writes a report with god nodes, communities, conflicts, specialisations and memories", async () => {
    const { g, b1, donch } = hive();
    g.link(b1, "specialises_in", donch, 1, { reason: "breakouts pay" });
    await consolidate(g, b1, { keepRecent: 2 });
    const r = hiveReport(g);
    for (const h of ["## God nodes", "## Communities", "## Surprising connections", "## Specialisations", "## Memories"]) expect(r).toContain(h);
    expect(r).toContain("Bizzy: Donchian breakout (breakouts pay)");
    expect(r).toContain("donchian scores 0.90 on SOL");
  });

  it("ingested lab runs are facts too", () => {
    const g = new KnowledgeGraph(":memory:");
    const r = runTournament(BUILTIN_SKILLS.filter((s) => s.id === "sma_cross"), [{ id: "ETH-USDT-SWAP 1H", instId: "ETH-USDT-SWAP", bar: "1H", candles: syntheticCandles(3, 800), source: "synthetic" }], { folds: 2, maxCombos: 2 });
    ingestRanking(g, r);
    expect(explain(g, "ETH")!.links.every((l) => l.confidence === "EXTRACTED")).toBe(true);
  });
});
