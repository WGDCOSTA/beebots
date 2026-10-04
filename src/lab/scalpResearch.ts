// Bridges the native 1-minute scalper lab into J0's experiment ledger and the Degen's long-term graph memory.
// A passing result is only a paper candidate: the separate scalp gate and normal risk controls still decide whether
// any order may be proposed.
import type { BeeId } from "../config.js";
import { fingerprint, POLICY_DESCRIPTOR_VERSION, type ExperimentLedger, type PolicyDescriptor } from "../experiments.js";
import { beeNode } from "../graph/hive-mind.js";
import type { KnowledgeGraph } from "../graph/graph.js";
import type { ScalpReport } from "./scalp.js";

export interface ScalpResearchDeps {
  ledger: ExperimentLedger;
  graph: KnowledgeGraph;
  report: ScalpReport;
  mode: string;
  brainModel: string;
  bee?: BeeId;
}

export function recordScalpResearch(d: ScalpResearchDeps): string {
  const bee = d.bee ?? "bee4";
  const runId = fingerprint(d.report, "scalp_");
  const experimentId = `exp_${runId}`;
  const common = {
    version: POLICY_DESCRIPTOR_VERSION,
    bee,
    mode: d.mode,
    ownerRules: "Native scalp research cannot bypass the evidence gate, points, health, death, or hard risk caps.",
    requestedModel: "deterministic-scalp-lab-v1",
    questionSchemaVersion: "scalp-walk-forward-v1",
    convictionCriteria: ["real data", "positive net expectancy", "enough OOS trades", "profitable folds", "parameter plateau"],
    risk: { costs: d.report.costs, thresholds: d.report.opts },
  } satisfies Omit<PolicyDescriptor, "method" | "strategy">;
  const champion = d.ledger.ensurePolicy({
    ...common,
    method: { kind: "style", id: "degen_evidence_gate", params: {} },
    strategy: "Wait when no fresh, real, out-of-sample scalp edge survives costs.",
  }, d.report.createdAt);
  const challenger = d.ledger.ensurePolicy({
    ...common,
    method: { kind: "skill", id: runId, params: {} },
    strategy: `Paper scalp candidates ${[...new Set(d.report.results.map((r) => r.ruleId))].join(", ")} on the selected rotating universe.`,
  }, d.report.createdAt);
  const best = d.report.results.reduce((value, r) => Math.max(value, r.oos.netExpectancyBps), Number.NEGATIVE_INFINITY);
  const concise = d.report.results.map((r) => ({
    dataset: r.dataset,
    ruleId: r.ruleId,
    netBps: r.oos.netExpectancyBps,
    trades: r.oos.trades,
    positiveFolds: r.positiveFolds,
    folds: r.folds.length,
    plateauPct: r.plateauPct,
    edge: r.edge,
    why: r.why,
  }));
  const experiment = d.ledger.recordOffline({
    id: experimentId,
    bee,
    kind: "scalp_lab",
    hypothesis: "At least one native short-horizon rule keeps a robust positive expectancy after realistic execution costs.",
    primaryMetric: "net_bps",
    championPolicyId: champion.id,
    challengerPolicyId: challenger.id,
    status: d.report.verdict.edge && d.report.source === "real" ? "promoted" : "rolled_back",
    config: { source: d.report.source, datasets: d.report.datasets, costs: d.report.costs, thresholds: d.report.opts, memoryBrainModel: d.brainModel },
    result: { edge: d.report.verdict.edge, bestNetBps: Number.isFinite(best) ? best : null, passing: d.report.verdict.passing, results: concise, note: d.report.verdict.note },
    reason: d.report.verdict.edge && d.report.source === "real" ? "paper candidate passed the offline evidence gate" : "candidate did not pass the offline evidence gate",
    actor: "degen-autolab",
    at: d.report.createdAt,
  });

  // A completed callback can be replayed after a process crash without duplicating memories or measurements.
  if (d.graph.node(`experiment:${experiment.id}`)) return experiment.id;
  for (const r of d.report.results) d.ledger.recordOutcome({
    experimentId: experiment.id,
    policyVersionId: challenger.id,
    ts: d.report.createdAt,
    horizon: "walk_forward_1m",
    metric: "net_bps",
    value: r.oos.netExpectancyBps,
    metadata: { dataset: r.dataset, ruleId: r.ruleId, trades: r.oos.trades, edge: r.edge },
  });

  const beeId = beeNode(bee);
  const experimentNode = d.graph.upsert("experiment", experiment.id, `Degen scalp lab ${new Date(d.report.createdAt).toISOString()}`, {
    ledgerId: experiment.id, status: experiment.status, edge: d.report.verdict.edge, source: d.report.source, bestNetBps: Number.isFinite(best) ? best : null,
  });
  d.graph.link(beeId, "tested", experimentNode, d.report.verdict.edge ? 1 : 0, { ledgerId: experiment.id }, "set");
  const skills: string[] = [];
  for (const r of d.report.results) {
    const skill = d.graph.upsert("skill", `native-scalp-${r.ruleId}`, r.ruleId, { family: "scalp", native: true });
    const coin = r.dataset.split(/[-\s]/)[0]!.toUpperCase();
    const coinNode = d.graph.upsert("coin", coin, coin);
    const resultNode = d.graph.upsert("run", `${experiment.id}-${fingerprint({ dataset: r.dataset, ruleId: r.ruleId })}`, `${coin} / ${r.ruleId}`, {
      experimentId: experiment.id, dataset: r.dataset, ruleId: r.ruleId, netBps: r.oos.netExpectancyBps,
      trades: r.oos.trades, positiveFolds: r.positiveFolds, folds: r.folds.length, plateauPct: r.plateauPct, edge: r.edge,
    });
    skills.push(skill);
    d.graph.link(experimentNode, "measured", resultNode, r.oos.netExpectancyBps, { edge: r.edge }, "set");
    d.graph.link(resultNode, "tested_skill", skill);
    d.graph.link(resultNode, "on", coinNode);
  }
  d.graph.learn(beeId,
    d.report.verdict.edge
      ? `Scalp research ${runId}: paper edge found after costs; only the passing instrument/rule pairs may enter the gated paper executor.`
      : `Scalp research ${runId}: no robust edge after costs; keep waiting and rotate to the next instruments. Best result ${Number.isFinite(best) ? best.toFixed(2) : "n/a"} bp/trade.`,
    [experimentNode, ...new Set(skills)], { brain: d.brainModel, source: "autonomous scalp lab", kind: "experiment", ledgerId: experiment.id });
  return experiment.id;
}
