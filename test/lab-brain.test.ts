import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AutoLab } from "../src/autolab.js";
import { LabBrain, type LabBrainOpts } from "../src/brains/labBrain.js";
import type { CouncilBee } from "../src/brains/council.js";
import type { JsonAsk, LlmClient } from "../src/brains/llm.js";
import { KnowledgeGraph } from "../src/graph/graph.js";
import { CoinBook } from "../src/lab/coinBook.js";
import { BAR_MS, syntheticCandles } from "../src/lab/history.js";
import { buildScalpReport, scalpGate, scalpRule, type ScalpReport } from "../src/lab/scalp.js";
import { parseScalpSpec, scalpRuleFromSpec } from "../src/lab/scalpDsl.js";
import type { Candle } from "../src/market/types.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12);
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "coinbook-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC = {
  id: "rsi_snap",
  name: "RSI snap",
  description: "Fade RSI(7) extremes",
  params: { lo: { default: 20, grid: [15, 25] } },
  trade: { targetAtr: { default: 1, grid: [0.8, 1.4] }, stopAtr: { default: 1.6 }, holdBars: { default: 12 } },
  long: { entry: [{ left: "rsi(7)", op: "<", right: "$lo" }] },
};

const bar = (c: number, i: number): Candle => ({ ts: T0 + i * 60_000, o: c, h: c + 0.1, l: c - 0.1, c, volUsd: 1000 }) as Candle;

describe("scalp DSL", () => {
  it("compiles a written rule into a lab rule with trade knobs and a grid", () => {
    const p = parseScalpSpec(SPEC);
    if (!p.ok) throw new Error(p.error);
    const r = scalpRuleFromSpec(p.spec);
    expect(r.defaults).toMatchObject({ lo: 20, targetAtr: 1, stopAtr: 1.6, holdBars: 12, costGateMult: 3 });
    expect(r.grid).toEqual({ lo: [15, 25], targetAtr: [0.8, 1.4] });
  });

  it("fires on the bar the conditions become true, not on every bar they hold", () => {
    const r = scalpRuleFromSpec({ id: "x_up", name: "x", description: "", params: {}, trade: {}, long: { entry: [{ left: "close", op: ">", right: 10 }] } } as never);
    const c = [9, 11, 12, 13, 9, 11].map(bar);
    expect([...r.signal(c, r.defaults)]).toEqual([0, 1, 0, 0, 0, 1]);
  });

  it("refuses what could hurt: a cost gate under 2x, out-of-bounds exits, unknown indicators, huge grids", () => {
    expect(parseScalpSpec({ ...SPEC, trade: { costGateMult: { default: 1 } } }).ok).toBe(false);
    expect(parseScalpSpec({ ...SPEC, trade: { stopAtr: { default: 50 } } }).ok).toBe(false);
    expect(parseScalpSpec({ ...SPEC, params: { targetAtr: { default: 1 } } }).ok).toBe(false);
    expect(parseScalpSpec({ ...SPEC, long: { entry: [{ left: "magic(3)", op: "<", right: 1 }] } }).ok).toBe(false);
    expect(parseScalpSpec({ ...SPEC, extra: 1 }).ok).toBe(false);
    const big = Object.fromEntries(["a", "b", "c", "d", "e"].map((k) => [k, { default: 1, grid: [1, 2, 3, 4] }]));
    expect(parseScalpSpec({ ...SPEC, params: big }).ok).toBe(false);
  });

  it("is tested by the walk-forward lab per coin, like a built-in rule", () => {
    const c = syntheticCandles(7, 1200, BAR_MS["1m"]);
    const parsed = parseScalpSpec(SPEC);
    if (!parsed.ok) throw new Error(parsed.error);
    const r = scalpRuleFromSpec(parsed.spec);
    const report = buildScalpReport([{ id: "SYN1 1m", candles: c, synthetic: true }], () => [r], { folds: 2, maxCombos: 4 });
    expect(report.results.map((x) => x.ruleId)).toEqual(["rsi_snap"]);
    expect(report.verdict.edge).toBe(false); // synthetic never opens the gate
  });
});

// A lab report as the CLI writes it, reduced to what the book reads.
function report(at: number, rows: Array<{ coin: string; ruleId: string; edge: boolean; netBps: number }>, source: "real" | "synthetic" = "real"): ScalpReport {
  const results = rows.map((r) => ({ dataset: `${r.coin}-USDT-SWAP 1m`, ruleId: r.ruleId, bars: 20000, spanDays: 14, oos: { trades: 120, netExpectancyBps: r.netBps }, folds: [{ fold: 1, params: { n: 20 } }], positiveFolds: r.edge ? 3 : 1, plateauPct: r.edge ? 40 : 5, bestAll: null, oosGrossBps: 1, edge: r.edge, why: r.edge ? "passed" : "fees eat it" }));
  const passing = rows.filter((r) => r.edge).map((r) => ({ dataset: `${r.coin}-USDT-SWAP 1m`, ruleId: r.ruleId, params: { n: 20 }, netBps: r.netBps, trades: 120 }));
  return { createdAt: at, costs: { makerFee: 0.0002, takerFee: 0.0005, slippageBps: 1, halfSpreadBps: 0.5, throughBps: 0.5 }, opts: {}, source, datasets: [], results, verdict: { edge: passing.length > 0, passing, note: "" } } as unknown as ScalpReport;
}

describe("coin book", () => {
  it("files proposals per coin, dedupes identical rules and renames a different one under a taken id", () => {
    const b = new CoinBook(tmp(), () => T0);
    expect(b.propose({ coin: "btc", ruleId: "micro_breakout", source: "manual", reason: "try it" }).ruleId).toBe("micro_breakout");
    const a = b.propose({ coin: "BTC", spec: SPEC, source: "lab-brain", reason: "fees eat the small target" });
    expect(a.ruleId).toBe("rsi_snap");
    expect(b.propose({ coin: "ETH", spec: SPEC, source: "bunny:bee4", reason: "same idea" }).ruleId).toBe("rsi_snap");
    expect(b.propose({ coin: "ETH", spec: { ...SPEC, trade: { targetAtr: { default: 2 } } }, source: "lab-brain", reason: "wider" }).ruleId).toBe("rsi_snap_v2");
    expect(() => b.propose({ coin: "BTC", spec: { ...SPEC, trade: { costGateMult: { default: 1 } } }, source: "lab-brain", reason: "x" })).toThrow(/not valid/);
    expect(scalpRule("rsi_snap")?.name).toBe("RSI snap"); // the live scalper finds written rules
    expect(b.testPlan("BTC").map((r) => r.id)).toEqual(["micro_breakout", "stretch_revert", "rsi_snap"]);
    expect(b.priorityCoins()).toEqual(["BTC", "ETH"]);
  });

  it("validates on an edge, retires after three misses, and queues again after the time out", () => {
    let now = T0;
    const b = new CoinBook(tmp(), () => now);
    b.propose({ coin: "BTC", spec: SPEC, source: "lab-brain", reason: "x" });
    b.applyReport(report(T0, [{ coin: "BTC", ruleId: "rsi_snap", edge: true, netBps: 1.2 }]));
    expect(b.candidates("BTC").find((c) => c.ruleId === "rsi_snap")?.status).toBe("validated");
    for (let i = 1; i <= 3; i++) b.applyReport(report(T0 + i * DAY, [{ coin: "BTC", ruleId: "rsi_snap", edge: false, netBps: -2 }]));
    const c = b.candidates("BTC").find((x) => x.ruleId === "rsi_snap")!;
    expect(c.status).toBe("retired");
    expect(b.testPlan("BTC").map((r) => r.id)).not.toContain("rsi_snap");
    now = T0 + 20 * DAY;
    b.refresh();
    expect(b.candidates("BTC").find((x) => x.ruleId === "rsi_snap")?.status).toBe("queued");
  });

  it("applies a report once (a restart backfill does not double-count) and ignores synthetic runs", () => {
    const b = new CoinBook(tmp(), () => T0);
    const r = report(T0, [{ coin: "SOL", ruleId: "micro_breakout", edge: false, netBps: -1 }]);
    expect(b.applyReport(r)).toBe(1);
    expect(b.applyReport(r)).toBe(0);
    expect(b.applyReport(report(T0 + DAY, [{ coin: "SOL", ruleId: "micro_breakout", edge: false, netBps: -1 }], "synthetic"))).toBe(0);
    expect(b.candidates("SOL")[0]!.fails).toBe(1);
  });

  it("demotes a validated rule that keeps losing live, after enough trades", () => {
    const b = new CoinBook(tmp(), () => T0);
    b.applyReport(report(T0, [{ coin: "ETH", ruleId: "micro_breakout", edge: true, netBps: 1 }]));
    for (let i = 0; i < 11; i++) b.recordLive({ coin: "ETH", ruleId: "micro_breakout", netUsd: -0.05, notionalUsd: 100 });
    expect(b.candidates("ETH")[0]!.status).toBe("validated");
    b.recordLive({ coin: "ETH", ruleId: "micro_breakout", netUsd: -0.05, notionalUsd: 100 });
    expect(b.candidates("ETH")[0]!.status).toBe("demoted");
  });

  it("filters the live gate: blocked and retired out, fresh validations from earlier batches in", () => {
    const b = new CoinBook(tmp(), () => T0);
    b.applyReport(report(T0 - DAY, [{ coin: "ADA", ruleId: "stretch_revert", edge: true, netBps: 0.9 }]));
    const latest = report(T0, [{ coin: "BTC", ruleId: "micro_breakout", edge: true, netBps: 1.5 }, { coin: "ETH", ruleId: "micro_breakout", edge: true, netBps: 1.1 }]);
    b.applyReport(latest);
    b.manual("block", "ETH", "micro_breakout", "too thin");
    const g = b.gate(scalpGate(latest, T0), T0);
    expect(g.open).toBe(true);
    expect(g.rules.map((r) => `${r.coin}:${r.ruleId}`).sort()).toEqual(["ADA:stretch_revert", "BTC:micro_breakout"]);
    // Stale evidence is not kept.
    expect(b.gate(scalpGate(null, T0 + 30 * DAY), T0 + 30 * DAY).open).toBe(false);
  });

  it("keeps the owner's rules the owner's: brains cannot retire them, blocked rules cannot be re-proposed", () => {
    const b = new CoinBook(tmp(), () => T0);
    b.propose({ coin: "BTC", ruleId: "micro_breakout", source: "manual", reason: "mine" });
    expect(() => b.retire("BTC", "micro_breakout", "lab-brain", "dead")).toThrow(/owner/);
    b.manual("block", "BTC", "stretch_revert");
    expect(() => b.propose({ coin: "BTC", ruleId: "stretch_revert", source: "lab-brain", reason: "x" })).toThrow(/blocked/);
    expect(b.testPlan("BTC").map((r) => r.id)).toEqual(["micro_breakout"]);
  });

  it("persists across restarts", () => {
    const d = tmp();
    new CoinBook(d, () => T0).propose({ coin: "BTC", spec: SPEC, source: "lab-brain", reason: "x" });
    const again = new CoinBook(d, () => T0);
    expect(again.candidates("BTC")[0]!.ruleId).toBe("rsi_snap");
    expect(again.view(false).rules.find((r) => r.id === "rsi_snap")).not.toHaveProperty("spec");
    expect(again.view(true).rules.find((r) => r.id === "rsi_snap")).toHaveProperty("spec");
  });
});

class FakeLlm implements LlmClient {
  readonly brain = "openai" as const;
  readonly model = "gpt-test";
  asks: Array<JsonAsk<unknown>> = [];
  constructor(private answer: (name: string) => unknown) {}
  async json<T>(ask: JsonAsk<T>) {
    this.asks.push(ask as JsonAsk<unknown>);
    const data = ask.validate.parse(this.answer(ask.name));
    return { data, brain: this.brain, model: this.model, inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

describe("lab brain", () => {
  const bee = { slot: "bee4", name: "Degen", style: "degen", coins: ["SOL"], brain: "claude" } as unknown as CouncilBee;
  const setup = (gpt: FakeLlm | null, bunny: FakeLlm | null, extra: Partial<LabBrainOpts> = {}) => {
    const d = tmp();
    const book = new CoinBook(d, () => T0);
    const graph = new KnowledgeGraph(":memory:", () => T0);
    let requested = 0;
    const lb = new LabBrain({
      book, graph, brain: () => gpt, bunnyBrain: () => bunny, bees: () => [bee], report: () => report(T0, [{ coin: "SOL", ruleId: "micro_breakout", edge: false, netBps: -0.4 }]),
      ranking: () => null, universe: () => [{ coin: "SOL" }], livePnl: () => [], blockers: () => ({ top: [] }), requestLab: () => (requested++, true),
      path: join(d, "lab-brain.json"), intervalMin: 360, maxCallsPerDay: 4, now: () => T0, ...extra,
    });
    return { lb, book, graph, requested: () => requested };
  };

  it("studies the dossier, files rules, retires dead ones, names focus coins, then a bunny proposes", async () => {
    const gpt = new FakeLlm(() => ({
      summary: "SOL breakouts have a small gross edge that fees eat: widen the target.",
      findings: [{ coin: "SOL", text: "gross +1 bp, net -0.4 bp" }],
      proposals: [
        { coin: "SOL", ruleId: "", specJson: JSON.stringify({ ...SPEC, id: "wide_snap", trade: { targetAtr: { default: 2 } } }), reason: "wider target" },
        { coin: "SOL", ruleId: "", specJson: "{not json", reason: "broken" },
        { coin: "*", ruleId: "stretch_revert", specJson: "", reason: "sweep" },
      ],
      retire: [{ coin: "SOL", ruleId: "micro_breakout", reason: "dead" }],
      focus: ["sol", "BTC", "bad coin!"],
    }));
    const bunny = new FakeLlm(() => ({ note: "I saw RSI snaps work on SOL", proposals: [{ coin: "SOL", ruleId: "", specJson: JSON.stringify(SPEC), reason: "my trades" }] }));
    const s = setup(gpt, bunny);
    s.book.applyReport(report(T0 - DAY, [{ coin: "SOL", ruleId: "micro_breakout", edge: false, netBps: -0.4 }]));
    const st = await s.lb.study("manual");
    expect(st.applied.map((a) => [a.ruleId, a.action, a.source])).toEqual([
      ["wide_snap", "proposed", "lab-brain"],
      [null, "rejected", "lab-brain"],
      ["stretch_revert", "proposed", "lab-brain"],
      ["micro_breakout", "retired", "lab-brain"],
      ["rsi_snap", "proposed", "bunny:bee4"],
    ]);
    expect(st.focus).toEqual(["SOL", "BTC"]);
    expect(s.lb.focus()).toEqual(["SOL", "BTC"]);
    expect(st.labRequested).toBe(true);
    expect(s.requested()).toBe(1);
    // The study saw everything: the book, the lab report, the bunnies' memory, the DSL guide.
    const user = JSON.parse(gpt.asks[0]!.user) as Record<string, unknown>;
    expect(Object.keys(user)).toEqual(expect.arrayContaining(["book", "scalpLab", "bunnies", "livePnl", "crew", "previousStudies"]));
    expect(gpt.asks[0]!.system).toContain("crosses_above");
    expect(s.lb.status().callsToday).toBe(2);
    expect(s.graph.lessons("run:lab-brain", 1)[0]?.text).toMatch(/widen the target/);
  });

  it("stops at the daily budget and without a brain; never runs two studies at once", async () => {
    const gpt = new FakeLlm(() => ({ summary: "nothing", findings: [], proposals: [], retire: [], focus: [] }));
    const s = setup(gpt, null, { maxCallsPerDay: 1 });
    await s.lb.study();
    await expect(s.lb.study()).rejects.toThrow(/calls for today/);
    await expect(setup(null, null).lb.study()).rejects.toThrow(/no lab brain/);
  });

  it("studies when due: on start, then every interval", async () => {
    let now = T0;
    const gpt = new FakeLlm(() => ({ summary: "s", findings: [], proposals: [], retire: [], focus: [] }));
    const s = setup(gpt, null, { now: () => now });
    expect((await s.lb.due())?.trigger).toBe("startup");
    expect(await s.lb.due()).toBeNull();
    now += 7 * 3_600_000;
    expect((await s.lb.due())?.trigger).toBe("scheduled");
  });
});

describe("autolab request", () => {
  it("makes the scalp job due sooner, at most once per gap", async () => {
    const meta = new Map<string, string>();
    const db = { getMeta: (k: string) => meta.get(k) ?? null, setMeta: (k: string, v: string) => void meta.set(k, v) };
    const ran: string[][] = [];
    const lab = new AutoLab({ db, intervalHours: 0, scalpIntervalHours: 24, startDelayMin: 5, instruments: [], scalpCoins: ["BTC-USDT-SWAP"], scalpEnabled: true, run: async (a) => void ran.push([...a]), now: () => T0 });
    expect(await lab.runDue(T0)).toEqual(["scalp"]);
    expect(await lab.runDue(T0 + 3_600_000)).toEqual([]);
    expect(lab.request("scalp", 6, T0 + 2 * 3_600_000)).toBe(true);
    expect(lab.request("scalp", 6, T0 + 3 * 3_600_000)).toBe(false);
    expect(await lab.runDue(T0 + 2 * 3_600_000)).toEqual(["scalp"]);
  });
});
