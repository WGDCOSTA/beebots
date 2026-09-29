import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CouncilBee } from "../src/brains/council.js";
import type { BrainId, JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { loadPlaybook, savePlaybook } from "../src/brains/playbook.js";
import { SurvivalCouncil, trySkill } from "../src/brains/survival.js";
import type { BeeState } from "../src/bees/types.js";
import { loadConfig, type BeeId } from "../src/config.js";
import { Evolution, levelFor, perksFor, tierFor, type EvolutionEvent, type EvolutionOpts } from "../src/evolution.js";
import { KnowledgeGraph, nodeId } from "../src/graph/graph.js";
import { freshBee } from "../src/ledger.js";
import { syntheticCandles } from "../src/lab/history.js";
import type { Settings } from "../src/settings.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 12);
const OPTS: EvolutionOpts = { survival: true, rewards: true, dangerPct: 80, criticalPct: 60, deathPct: 40, maxLimitBoost: 0.5, boostLimits: true, startEquityUsd: 1000 };

const bee = (id: BeeId, equity: number, cap: BeeState["cap"] = null): [BeeId, BeeState] => {
  const b = freshBee(id, 1000, T0);
  b.equityUsd = equity;
  b.cap = cap;
  return [id, b];
};

describe("survival tiers", () => {
  it("health maps to tiers, and a retired bee is dead", () => {
    expect(tierFor(120, false, OPTS)).toBe("thriving");
    expect(tierFor(95, false, OPTS)).toBe("healthy");
    expect(tierFor(75, false, OPTS)).toBe("danger");
    expect(tierFor(50, false, OPTS)).toBe("critical");
    expect(tierFor(40, false, OPTS)).toBe("dead");
    expect(tierFor(99, true, OPTS)).toBe("dead");
  });

  it("a bee in trouble trades smaller, tells Jev, and each tier change is an event", () => {
    const events: EvolutionEvent[] = [];
    const evo = new Evolution(OPTS, {}, (e) => events.push(e));
    evo.tick([bee("bee1", 1000)], T0);
    expect(evo.sizeFactor("bee1")).toBe(1);
    evo.tick([bee("bee1", 700)], T0 + 1000);
    expect(evo.sizeFactor("bee1")).toBe(0.6);
    evo.tick([bee("bee1", 500)], T0 + 2000);
    expect(evo.sizeFactor("bee1")).toBe(0.35);
    expect(evo.state("bee1")).toEqual({ health: 50, tier: "critical", deathAt: 40 });
    evo.tick([bee("bee1", 390, "retired")], T0 + 3000);
    expect(events.filter((e) => e.kind === "tier").map((e) => (e as { to: string }).to)).toEqual(["danger", "critical", "dead"]);
    expect(evo.bees.bee1.deaths).toBe(1);
  });

  it("survival mode off: no size cut, nothing in Jev's state", () => {
    const evo = new Evolution({ ...OPTS, survival: false });
    evo.tick([bee("bee1", 500)], T0);
    expect(evo.sizeFactor("bee1")).toBe(1);
    expect(evo.state("bee1")).toBeNull();
  });
});

describe("rewards", () => {
  it("scores each UTC day: gains, half-rate losses, a survival point, the day's best bunny bonus", () => {
    const events: EvolutionEvent[] = [];
    const evo = new Evolution(OPTS, {}, (e) => events.push(e));
    evo.tick([bee("bee1", 1000), bee("bee2", 1000)], T0);
    evo.tick([bee("bee1", 1050), bee("bee2", 980)], T0 + DAY);
    expect(evo.bees.bee1.points).toBe(50 + 1 + 5);
    expect(evo.bees.bee2.points).toBe(0);
    expect(evo.bees.bee1.history[0]).toMatchObject({ day: "2026-09-01", pnlPct: 5, bonus: "best bunny of the day" });
    expect(evo.bees.bee1.level).toBe(1);
    expect(events.some((e) => e.kind === "level" && e.bee === "bee1" && e.to === 1)).toBe(true);
  });

  it("levels unlock prizes, and limit boosts respect the mode", () => {
    expect(levelFor(0)).toBe(0);
    expect(levelFor(150)).toBe(2);
    expect(levelFor(10_000)).toBe(5);
    expect(perksFor(0, OPTS)).toMatchObject({ canAuthorSkills: false, extraBrains: 0, limitBoost: 0 });
    expect(perksFor(3, OPTS)).toMatchObject({ skillSlots: 6, canAuthorSkills: true, extraBrains: 1, limitBoost: 0.3 });
    expect(perksFor(5, OPTS).limitBoost).toBe(0.5);
    expect(perksFor(5, { ...OPTS, boostLimits: false })).toMatchObject({ limitBoost: 0, extraTrades: 0, canAuthorSkills: true });
    expect(perksFor(5, { ...OPTS, rewards: false }).canAuthorSkills).toBe(false);
  });

  it("revival keeps half the points and resets health", () => {
    const evo = new Evolution(OPTS, { bee1: { points: 101, level: 1, deaths: 1, tier: "dead", health: 38, peakEquityUsd: 1200, dayKey: "2026-09-01", dayStartEquityUsd: 400, skillsAuthored: 0, history: [], lastCouncilAt: 0 } });
    evo.revive("bee1", 1000, T0);
    expect(evo.bees.bee1).toMatchObject({ points: 50, level: 1, tier: "healthy", health: 100 });
  });
});

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

const GOOD_SKILL = JSON.stringify({
  id: "calm_trend",
  name: "Calm trend",
  family: "trend",
  params: { fast: { default: 20, grid: [10, 20] } },
  long: { entry: [{ left: "ema($fast)", op: ">", right: "ema(100)" }], exit: [{ left: "ema($fast)", op: "<", right: "ema(100)" }] },
});

describe("survival council", () => {
  function setup(tier: "danger" | "healthy", level = 0) {
    const dir = mkdtempSync(join(tmpdir(), "survival-"));
    const playbookPath = join(dir, "playbook.json");
    savePlaybook(playbookPath, { version: 1, updatedAt: 1, rankingAt: 1, bees: { bee1: { brain: "openai", model: "x", skills: [{ id: "sma_cross", params: {}, weight: 1, reason: "", score: 0.5 }], lessons: [], message: "", decidedAt: 1 } } });
    const evo = new Evolution(OPTS);
    evo.tick([bee("bee1", tier === "danger" ? 700 : 1000)], T0);
    evo.bees.bee1.level = level;
    const graph = new KnowledgeGraph(":memory:");
    graph.upsert("bee", "bee1", "Zippy");
    const pick = (id: string, w: number, skill = "") => () => ({ skills: [{ id, weight: w, reason: "robust" }], newSkillJson: skill, lesson: `keep ${id}`, message: "hold on" });
    const openai = new FakeBrain("openai", pick("sma_cross", 1, GOOD_SKILL));
    const claude = new FakeBrain("claude", pick("sma_cross", 0.5, "{not json"));
    const kimi = new FakeBrain("kimi", pick("made_up", 1));
    const registered: string[] = [];
    const drafts: Array<{ id: string; accepted: boolean; real: boolean }> = [];
    const council = new SurvivalCouncil({
      graph,
      evolution: evo,
      clients: { openai, claude, kimi },
      playbookPath,
      learnedDir: join(dir, "learned"),
      historyDir: join(dir, "history"),
      ranking: () => null,
      onNewSkill: (s) => registered.push(s.id),
      onDraft: (d) => drafts.push({ id: d.id, accepted: d.accepted, real: d.real }),
      maxCallsPerDay: 10,
      now: () => T0,
    });
    const b: CouncilBee = { slot: "bee1", name: "Zippy", style: "bizzy", rules: "", coins: ["BTC"], brain: "openai", model: "x" };
    return { council, b, openai, claude, kimi, graph, evo, dir, playbookPath, registered, drafts };
  }

  it("in danger, every brain sits in, each sees the others, and they write skills that are backtested first", async () => {
    const h = setup("danger");
    expect(h.council.brainsFor(h.b, "danger")).toEqual(["openai", "claude", "kimi"]);
    const out = await h.council.convene(h.b, "survival");
    expect(out!.brains).toEqual(["openai", "claude", "kimi"]);
    // Claude answered second and saw ChatGPT's advice; Kimi saw both.
    expect(JSON.parse(h.claude.asked[0]!.user).teammates).toHaveLength(1);
    expect(JSON.parse(h.kimi.asked[0]!.user).teammates).toHaveLength(2);
    expect(h.openai.asked[0]!.system).toMatch(/You MAY write one new skill/);
    // The invented skill id is dropped; the bad JSON skill is rejected; the good one is judged on its backtest.
    expect(out!.skills.some((s) => s.id === "made_up")).toBe(false);
    const bad = out!.newSkills.find((n) => n.why.includes("not valid JSON"));
    expect(bad?.accepted).toBe(false);
    const good = out!.newSkills.find((n) => n.id.startsWith("bee1_calm_trend"));
    expect(good).toBeDefined();
    if (good!.accepted) {
      expect(readdirSync(join(h.dir, "learned"))).toContain(`${good!.id}.json`);
      expect(h.registered).toContain(good!.id);
      expect(h.graph.out(nodeId("bee", "bee1"), "authored")).toHaveLength(1);
    }
    // Every skill that compiled is handed to the workshop, accepted or not; broken JSON never is. No cached history: synthetic.
    expect(h.drafts).toEqual([{ id: good!.id, accepted: good!.accepted, real: false }]);
    const pb = loadPlaybook(h.playbookPath)!;
    expect(pb.bees.bee1!.brain).toBe("ensemble");
    expect(pb.bees.bee1!.model).toBe("openai-test + claude-test + kimi-test");
    expect(h.graph.out(nodeId("brain", "claude"), "rescued")).toHaveLength(1);
    // Cooldown: a second survival council right away is skipped.
    expect(await h.council.convene(h.b, "survival")).toBeNull();
  });

  it("a healthy level-0 bee gets only its own brain and may not write skills", async () => {
    const h = setup("healthy", 0);
    expect(h.council.brainsFor(h.b, "healthy")).toEqual(["openai"]);
    await h.council.convene(h.b, "manual");
    expect(h.openai.asked[0]!.system).toMatch(/has not earned the right/);
    expect(h.claude.asked).toHaveLength(0);
  });

  it("a level-3 bee earns one extra brain", () => {
    const h = setup("healthy", 3);
    expect(h.council.brainsFor(h.b, "healthy")).toEqual(["openai", "claude"]);
  });

  it("a written skill is namespaced by its author and judged out of sample", () => {
    const data = [{ id: "SYN 1H", instId: "SYN", bar: "1H" as const, candles: syntheticCandles(3, 2000), source: "synthetic" as const }];
    const t = trySkill(GOOD_SKILL, "bee2", data);
    expect(t.result).not.toBeNull();
    expect(t.why).toMatch(/score .* stability/);
    if (t.skill) expect(t.skill.id).toBe("bee2_calm_trend");
    expect(trySkill(JSON.stringify({ id: "x", name: "x", family: "trend", long: { entry: [{ left: "nope(1)", op: ">", right: 1 }], exit: [{ left: "close", op: ">", right: 1 }] } }), "bee2", data).why).toMatch(/unknown indicator/);
  });
});

describe("extra bees", () => {
  const settings = (n: number, brain?: "claude"): Settings => ({
    version: 1,
    jevKey: "jev-key-12345678",
    acceptedRiskAt: 1,
    createdAt: 1,
    bees: Array.from({ length: n }, (_, i) => ({ name: `Bee ${i}`, style: "boozy" as const, tagline: "", rules: "", coins: [], image: false, ...(i >= 3 && brain ? { brain } : {}) })),
  });

  it("the engine runs every bee in the Setup file, extras with the brain picked for them", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20) }, settings(5, "claude"));
    expect(cfg.beeIds).toEqual(["bee1", "bee2", "bee3", "bee4", "bee5"]);
    expect(cfg.brains.slots.bee4).toBe("claude");
    expect(cfg.slots.bee5.name).toBe("Bee 4");
  });

  it("outside paper, an extra bee without exchange keys sits out instead of blocking the engine", () => {
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "k".repeat(20), DRY_RUN: "false", MODE: "demo" };
    for (const b of ["BEE1", "BEE2", "BEE3", "BEE4"]) for (const k of ["KEY", "SECRET", "PASSPHRASE"]) env[`${b}_OKX_DEMO_API_${k}`] = "x".repeat(12);
    const cfg = loadConfig(env, settings(5));
    expect(cfg.beeIds).toEqual(["bee1", "bee2", "bee3", "bee4"]);
    expect(cfg.skippedBees).toEqual(["bee5"]);
  });

  it("survival lines always sit above the death line, in order; limit boosts are off with real money", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), SURVIVAL_CRITICAL_PCT: "30" }).evolution).toMatchObject({ criticalPct: 41, dangerPct: 80 });
    expect(loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), BEE_RETIRE_AT_PCT: "85" }).evolution).toMatchObject({ criticalPct: 86, dangerPct: 87 });
    expect(loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), DRY_RUN: "false", MODE: "live", LIVE_ACK: "I-ACCEPT-REAL-MONEY-RISK", ...Object.fromEntries(["BEE1", "BEE2", "BEE3"].flatMap((b) => ["KEY", "SECRET", "PASSPHRASE"].map((k) => [`${b}_OKX_API_${k}`, "x".repeat(12)]))) }).evolution.boostLimits).toBe(false);
  });
});

describe("files", () => {
  it("the learned skill file is plain JSON a lab run can import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "learned-"));
    const { skillRegistry } = await import("../src/lab/skills/index.js");
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "learned"));
    writeFileSync(join(dir, "learned", "bee1_calm_trend.json"), JSON.stringify({ ...JSON.parse(GOOD_SKILL), id: "bee1_calm_trend" }));
    const r = skillRegistry([join(dir, "learned")]);
    expect(r.errors).toEqual([]);
    expect(r.skills.some((s) => s.id === "bee1_calm_trend")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "learned", "bee1_calm_trend.json"), "utf8")).id).toBe("bee1_calm_trend");
  });
});

describe("engine with survival, rewards and an extra bee", () => {
  it("runs bee4, tells Jev about survival, shrinks size in danger, boosts limits by level, and revives the dead", async () => {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const { coin, NOW, view } = await import("./fixtures.js");
    const s: Settings = {
      version: 1, jevKey: "jev-key-12345678", acceptedRiskAt: 1, createdAt: 1,
      bees: ["A", "B", "C", "D"].map((n) => ({ name: `Bee ${n}`, style: "boozy" as const, tagline: "", rules: "", coins: [], image: false })),
    };
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), BEE_START_EQUITY_USD: "1000" }, s);
    const v = view([coin("BTC", {}, 80000), coin("SOL", { ret7dPct: 20, ret24hPct: 8 }, 150)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    const reqs: Array<{ state: Record<string, unknown>; questions: { action: { instructions: string } } }> = [];
    const client = {
      async systemOne(req: unknown) {
        reqs.push(req as never);
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const evolution = new Evolution({ ...OPTS, startEquityUsd: 1000, deathPct: cfg.risk.retireAtPct });
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW, evolution });
    await engine.start();
    engine.stop();
    expect(Object.keys(engine.bees)).toEqual(["bee1", "bee2", "bee3", "bee4"]);

    await engine.tick();
    evolution.bees.bee1.level = 5;
    engine.bees.bee4.cashUsd = 700;
    engine.bees.bee4.equityUsd = 700;
    reqs.length = 0;
    await engine.tick();
    expect(evolution.bees.bee4?.tier).toBe("danger");
    const survivalReq = reqs.find((r) => (r.state.survival as { tier?: string } | undefined)?.tier === "danger");
    expect(survivalReq).toBeDefined();
    expect(survivalReq!.questions.action.instructions).toContain("state.survival");
    const snap = engine.snapshot();
    const b1 = snap.bees.find((b) => b.bee === "bee1")!;
    const b2 = snap.bees.find((b) => b.bee === "bee2")!;
    // Level 5: +50% max position (still capped by leverage x equity).
    expect(b1.maxNotionalUsd).toBeGreaterThan(b2.maxNotionalUsd);
    expect(snap.evolution!.board.length).toBe(4);

    engine.bees.bee4.cap = "retired";
    engine.bees.bee4.equityUsd = 390;
    engine.bees.bee4.cashUsd = 390;
    await engine.tick();
    expect(evolution.bees.bee4?.tier).toBe("dead");
    engine.respawn("bee4");
    expect(engine.bees.bee4).toMatchObject({ equityUsd: 1000, cap: null });
    expect(evolution.bees.bee4?.tier).toBe("healthy");
    expect(JSON.parse(db.getMeta("evolution")!).bee4.deaths).toBe(1);
  });
});
