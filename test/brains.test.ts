import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Coach } from "../src/brains/coach.js";
import { candidatesFor, rulesPick, runCouncil, type CouncilBee } from "../src/brains/council.js";
import type { BrainId, JsonAsk, JsonAnswer, LlmClient } from "../src/brains/llm.js";
import { loadPlaybook, savePlaybook } from "../src/brains/playbook.js";
import { LabSignals } from "../src/brains/signals.js";
import { brainCreds, loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { KnowledgeGraph, nodeId } from "../src/graph/graph.js";
import { contextFor, ingestFills, ingestRanking } from "../src/graph/hive-mind.js";
import { syntheticCandles } from "../src/lab/history.js";
import { BUILTIN_SKILLS } from "../src/lab/skills/index.js";
import { runTournament, type Ranking } from "../src/lab/tournament.js";
import { redactString } from "../src/redact.js";

const BEES: CouncilBee[] = [
  { slot: "bee1", name: "Bizzy", style: "bizzy", rules: "", coins: [], brain: "openai", model: "gpt-test" },
  { slot: "bee2", name: "Breezy", style: "breezy", rules: "", coins: ["BTC", "ETH"], brain: "claude", model: "claude-test" },
  { slot: "bee3", name: "Boozy", style: "boozy", rules: "", coins: [], brain: "kimi", model: "kimi-test" },
];

let ranking: Ranking | null = null;
function smallRanking(): Ranking {
  ranking ??= runTournament(
    BUILTIN_SKILLS.filter((s) => ["buy_hold", "sma_cross", "donchian_turtle", "roc_momentum", "rsi_reversion", "supertrend"].includes(s.id)),
    [{ id: "BTC-USDT-SWAP 1H", instId: "BTC-USDT-SWAP", bar: "1H", candles: syntheticCandles(5, 1500), source: "synthetic" }],
    { folds: 2, maxCombos: 4 },
  );
  return ranking;
}

/** A brain that answers from a script and records what it was asked. */
class FakeBrain implements LlmClient {
  asked: Array<JsonAsk<unknown>> = [];
  constructor(
    readonly brain: BrainId,
    private reply: (ask: JsonAsk<unknown>) => unknown,
    readonly model = `${brain}-test`,
  ) {}
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    const data = ask.validate.parse(this.reply(ask as JsonAsk<unknown>));
    return { data, brain: this.brain, model: this.model, inputTokens: 10, outputTokens: 10, latencyMs: 1 };
  }
}

describe("knowledge graph", () => {
  it("merges props, accumulates evidence, and exports node-link JSON", () => {
    const g = new KnowledgeGraph(":memory:");
    const a = g.upsert("bee", "bee1", "Bizzy", { style: "bizzy" });
    const c = g.upsert("coin", "BTC", "BTC");
    g.upsert("bee", "bee1", "Bizzy", { mood: "hungry" });
    expect(g.node(a)!.props).toEqual({ style: "bizzy", mood: "hungry" });
    g.link(a, "traded", c, 5, { trades: 1 }, "add");
    g.link(a, "traded", c, -2, { trades: 2 }, "add");
    expect(g.edge(a, "traded", c)).toMatchObject({ weight: 3, count: 2, props: { trades: 2 } });
    const x = g.export();
    expect(x.nodes).toHaveLength(2);
    expect(x.links[0]).toMatchObject({ source: a, target: c, relation: "traded", weight: 3 });
  });

  it("bees talk through the hive: an inbox never shows your own messages", () => {
    const g = new KnowledgeGraph(":memory:");
    for (const b of BEES) g.upsert("bee", b.slot, b.name);
    g.post(nodeId("bee", "bee1"), "hive", "BTC trend is fading");
    g.post(nodeId("bee", "bee2"), nodeId("bee", "bee3"), "stop chasing memecoins");
    expect(g.inbox(nodeId("bee", "bee1")).map((m) => m.text)).toEqual([]);
    expect(g.inbox(nodeId("bee", "bee2")).map((m) => m.text)).toEqual(["BTC trend is fading"]);
    expect(g.inbox(nodeId("bee", "bee3")).map((m) => m.text).sort()).toEqual(["BTC trend is fading", "stop chasing memecoins"]);
  });

  it("ingests a lab run and closed trades, then builds a bee's context", () => {
    const g = new KnowledgeGraph(":memory:");
    ingestRanking(g, smallRanking());
    expect(g.nodes("skill").length).toBe(6);
    expect(g.in(nodeId("coin", "BTC"), "performs_on").length).toBe(6);

    const db = new Db(":memory:");
    const ins = db.raw.prepare("INSERT INTO fills (order_id, bee, ts, inst_id, side, contracts, px, notional_usd, fee_usd, realised_usd) VALUES (1,?,?,?,?,1,1,1,?,?)");
    ins.run("bee1", 100, "BTC-USD_UM_XPERP-310404", "sell", 0.1, 4);
    ins.run("bee1", 200, "BTC-USD_UM_XPERP-310404", "sell", 0.1, -1);
    ins.run("bee1", 300, "BTC-USD_UM_XPERP-310404", "buy", 0.1, 0);
    expect(ingestFills(g, db.raw, 0)).toBe(200);
    expect(ingestFills(g, db.raw, 200)).toBe(200);
    const ctx = contextFor(g, "bee1");
    expect(ctx.tradeRecord).toEqual([{ coin: "BTC", netUsd: 2.8, trades: 2, winRatePct: 50 }]);
  });
});

describe("council", () => {
  it("offers each bee the overall leaders plus its own family, never the benchmark", () => {
    const c = candidatesFor(smallRanking(), "boozy", 3);
    expect(c.some((s) => s.family === "benchmark")).toBe(false);
    expect(c.some((s) => s.family === "momentum")).toBe(true);
  });

  it("each brain picks for its bee, sees the previous bee's message, and unknown ids are dropped", async () => {
    const r = smallRanking();
    const g = new KnowledgeGraph(":memory:");
    const pick = (id: string, msg: string) => () => ({
      skills: [
        { id, weight: 0.8, reason: "robust" },
        { id: "made_up_skill", weight: 0.9, reason: "hallucinated" },
      ],
      lessons: [`${id} held up out of sample`],
      message: msg,
    });
    const top = candidatesFor(r, "bizzy")[0]!.skillId;
    const openai = new FakeBrain("openai", pick(top, "I take the leader"));
    const claude = new FakeBrain("claude", pick(top, "Then I diversify"));
    const kimi = new FakeBrain("kimi", () => {
      throw new Error("Moonshot is down");
    });
    const res = await runCouncil({ graph: g, ranking: r, bees: BEES, clients: { openai, claude, kimi } });

    expect(res.playbook.bees.bee1!.skills).toEqual([expect.objectContaining({ id: top, weight: 1 })]);
    expect(res.playbook.bees.bee1!.brain).toBe("openai");
    // Claude spoke second and read what ChatGPT told the hive.
    expect(JSON.parse(claude.asked[0]!.user).hive.inbox).toEqual([{ from: "Bizzy", text: "I take the leader" }]);
    // Kimi failed: its bee falls back to the rules pick instead of going without a plan.
    expect(res.playbook.bees.bee3!.brain).toBe("rules");
    expect(res.log.find((l) => l.bee === "bee3")!.error).toMatch(/Moonshot is down/);
    expect(g.out(nodeId("bee", "bee1"), "adopts").map((e) => e.dst)).toEqual([nodeId("skill", top)]);
    expect(g.out(nodeId("brain", "openai"), "recommends")).toHaveLength(1);
  });

  it("the rules pick prefers the bee's own family and only positive scores", () => {
    const r = smallRanking();
    const p = rulesPick(candidatesFor(r, "breezy"), "breezy");
    const ids = new Set(r.results.filter((s) => s.score > 0).map((s) => s.skillId));
    for (const s of p.skills) expect(ids.has(s.id)).toBe(true);
  });
});

describe("coach", () => {
  it("re-weights adopted skills from the bee's real results, and cannot add a new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-"));
    const path = join(dir, "playbook.json");
    savePlaybook(path, {
      version: 1,
      updatedAt: 1,
      rankingAt: 1,
      bees: {
        bee1: {
          brain: "openai",
          model: "gpt-test",
          skills: [
            { id: "sma_cross", params: { fast: 20, slow: 50 }, weight: 0.5, reason: "", score: 1 },
            { id: "supertrend", params: {}, weight: 0.5, reason: "", score: 1 },
          ],
          lessons: [],
          message: "",
          decidedAt: 1,
        },
      },
    });
    const g = new KnowledgeGraph(":memory:");
    const db = new Db(":memory:");
    const brain = new FakeBrain("openai", () => ({
      weights: [
        { id: "sma_cross", weight: 0.9 },
        { id: "supertrend", weight: 0 },
        { id: "sneaky_new", weight: 1 },
      ],
      lesson: "Crossovers whipsawed less than Supertrend this week.",
      message: "Anyone else seeing chop on ETH?",
    }));
    const coach = new Coach({ graph: g, db, clients: { openai: brain }, bees: BEES, playbookPath: path, intervalMin: 0, maxCallsPerDay: 1 });
    expect(await coach.reflect(BEES[0]!)).toBe(true);
    const pb = loadPlaybook(path)!;
    expect(pb.bees.bee1!.skills.map((s) => [s.id, s.weight])).toEqual([["sma_cross", 1]]);
    expect(pb.bees.bee1!.lessons[0]).toMatch(/whipsawed/);
    expect(g.lessons(nodeId("bee", "bee1"))).toHaveLength(1);
    // Daily cap of one call: the second review is skipped.
    expect(await coach.reflect(BEES[0]!)).toBe(false);
  });
});

describe("lab signals", () => {
  it("votes the weighted skill positions per coin, and caches per closed candle", () => {
    const skills = new Map(BUILTIN_SKILLS.map((s) => [s.id, s]));
    const pb = {
      version: 1 as const,
      updatedAt: 1,
      rankingAt: 1,
      bees: { bee1: { brain: "rules" as const, model: "rules", skills: [{ id: "buy_hold", params: {}, weight: 1, reason: "", score: 0 }], lessons: [], message: "", decidedAt: 1 } },
    };
    const sig = new LabSignals(skills, () => pb);
    const c = syntheticCandles(2, 200);
    expect(sig.votes("bee1", [{ instId: "BTC-X", coin: "BTC" }], () => c)).toEqual({ BTC: 1 });
    expect(sig.votes("bee2", [{ instId: "BTC-X", coin: "BTC" }], () => c)).toBeNull();
    expect(sig.votes("bee1", [{ instId: "BTC-X", coin: "BTC" }], () => c.slice(0, 10))).toBeNull();
  });
});

describe("brain keys", () => {
  const base = { OPENAI_BRAIN_MODEL: "gpt-x", CLAUDE_MODEL: "claude-opus-5", CLAUDE_EFFORT: "medium" as const, KIMI_MODEL: "kimi-x", KIMI_BASE_URL: "https://api.moonshot.ai/v1/" };
  it("environment wins over the Setup file; a brain without a key is left out", () => {
    const c = brainCreds({ ...base, ANTHROPIC_API_KEY: "sk-ant-env" }, { anthropicKey: "sk-ant-file", kimiKey: "sk-kimi-file" } as never);
    expect(c.claude!.apiKey).toBe("sk-ant-env");
    expect(c.kimi).toEqual({ apiKey: "sk-kimi-file", model: "kimi-x", baseUrl: "https://api.moonshot.ai/v1" });
    expect(c.openai).toBeUndefined();
  });

  it("loadConfig maps each bee to its brain", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), BEE2_BRAIN: "kimi", MOONSHOT_API_KEY: "sk-moon-1234567890" });
    expect(cfg.brains.slots).toEqual({ bee1: "openai", bee2: "kimi", bee3: "kimi" });
    expect(cfg.brains.creds.kimi?.apiKey).toBe("sk-moon-1234567890");
    expect(cfg.lab.signals).toBe(false);
  });

  it("LLM keys never reach a log line", () => {
    expect(redactString("failed with sk-ant-api03-abcdefghijklmnop123 and sk-proj-ABCDEFGHIJKLMNOP99")).not.toMatch(/sk-/);
  });
});

describe("engine: LAB_SIGNALS", () => {
  it("the lab vote reaches Jev's state and instructions; without it nothing changes", async () => {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { LAB_NOTE } = await import("../src/brains/signals.js");
    const { coin, NOW, testConfig, view } = await import("./fixtures.js");
    type Req = { state: Record<string, unknown>; questions: { action: { instructions: string } } };

    async function run(withLab: boolean) {
      const cfg = testConfig({ DRY_RUN: "true" });
      const v = view([coin("BTC", {}, 80000), coin("ETH", {}, 3000), coin("SOL", { ret7dPct: 20 }, 150)]);
      const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
      const reqs: Req[] = [];
      const client = {
        async systemOne(req: unknown) {
          reqs.push(req as Req);
          return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
        },
      };
      const db = new Db(":memory:");
      const engine = new Engine({
        cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW,
        ...(withLab ? { labVotes: () => ({ BTC: 0.5 }), labNote: LAB_NOTE } : {}),
      });
      await engine.start();
      engine.stop();
      reqs.length = 0;
      await engine.tick();
      return reqs;
    }

    const all = await run(true);
    expect(all.length).toBeGreaterThan(0);
    const lab = all.filter((r) => r.state.lab);
    expect(lab.length).toBeGreaterThan(0);
    expect(lab[0]!.state.lab).toEqual({ BTC: 0.5 });
    expect(lab[0]!.questions.action.instructions).toContain("state.lab");
    const plain = await run(false);
    expect(plain.some((r) => r.state.lab || r.questions.action.instructions.includes("state.lab"))).toBe(false);
  });
});

describe("brain settings from docker compose", () => {
  it("blank variables mean the defaults", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), BEE1_BRAIN: "", BEE2_BRAIN: " ", CLAUDE_EFFORT: "", CLAUDE_MODEL: "" });
    expect(cfg.brains.slots).toEqual({ bee1: "openai", bee2: "claude", bee3: "kimi" });
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), BEE1_BRAIN: "gemini" })).toThrow(/BEE1_BRAIN/);
  });
});
