import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { KnowledgeGraph } from "../src/graph/graph.js";
import { beeNode } from "../src/graph/hive-mind.js";
import { buildScalpReport } from "../src/lab/scalp.js";
import { recordScalpResearch } from "../src/lab/scalpResearch.js";

describe("Degen scalp research ledger bridge", () => {
  it("records a rejected report once in both the ledger and brain graph", () => {
    const db = new Db(":memory:");
    const graph = new KnowledgeGraph(":memory:", () => 1234);
    graph.upsert("bee", "bee4", "Degen");
    const report = buildScalpReport([], undefined, {}, 1000);
    const oos = {
      trades: 42, signals: 60, gated: 3, missed: 15, fillRatePct: 70, winRatePct: 40,
      avgWinBps: 3, avgLossBps: -5, grossExpectancyBps: 1, feesBpsPerTrade: 4,
      netExpectancyBps: -3, profitFactor: 0.5, netTotalBps: -126, maxDrawdownBps: 140,
      tradesPerDay: 3, exits: { target: 10, stop: 20, time: 12, end: 0 },
    };
    report.datasets.push({ id: "BTC-USDT-SWAP 1m", bars: 20_000, days: 14, hash: "data-a" });
    report.results.push({ ruleId: "micro_breakout", dataset: "BTC-USDT-SWAP 1m", bars: 20_000, spanDays: 14, oos, folds: [], positiveFolds: 0, plateauPct: 0, bestAll: null, oosGrossBps: 1, edge: false, why: "fees ate the edge" });

    const id = recordScalpResearch({ ledger: db.experiments, graph, report, mode: "dry", brainModel: "gpt-test" });
    expect(db.experiments.get(id)).toMatchObject({ bee: "bee4", kind: "scalp_lab", status: "rolled_back", result: { edge: false } });
    expect(graph.node(`experiment:${id}`)?.props).toMatchObject({ ledgerId: id, edge: false });
    expect(graph.nodes("run")).toHaveLength(1);
    expect(graph.nodes("coin")[0]?.label).toBe("BTC");
    expect(graph.lessons(beeNode("bee4"))).toHaveLength(1);

    expect(recordScalpResearch({ ledger: db.experiments, graph, report, mode: "dry", brainModel: "gpt-test" })).toBe(id);
    expect(db.experiments.list("bee4")).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM experiment_outcomes WHERE experiment_id = ?").get(id)).toMatchObject({ n: 1 });
    expect(graph.lessons(beeNode("bee4"))).toHaveLength(1);
    graph.close();
    db.close();
  });
});
