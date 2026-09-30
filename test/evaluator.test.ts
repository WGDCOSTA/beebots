import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { ExperimentEvaluator } from "../src/evaluator.js";
import { POLICY_DESCRIPTOR_VERSION, type PolicyDescriptor } from "../src/experiments.js";

const descriptor = (strategy: string): PolicyDescriptor => ({
  version: POLICY_DESCRIPTOR_VERSION,
  bee: "bee1",
  mode: "dry",
  method: { kind: "style", id: "bizzy", params: {} },
  strategy,
  ownerRules: "",
  requestedModel: "jev-1.13.0",
  questionSchemaVersion: "action-conviction-v1",
  convictionCriteria: ["weak", "fair", "strong", "overwhelming"],
  risk: { maxLeverage: 2 },
});

describe("experiment evidence gate", () => {
  it("uses spaced paired evidence and advances only shadow to a shadow-only canary", () => {
    const db = new Db(":memory:");
    const champion = db.experiments.ensurePolicy(descriptor("champion"));
    const challenger = db.experiments.ensurePolicy(descriptor("challenger"));
    const experiment = db.experiments.create({
      id: "exp_gate",
      bee: "bee1",
      kind: "jev_contract",
      hypothesis: "challenger has lower Brier score",
      primaryMetric: "action_brier",
      championPolicyId: champion.id,
      challengerPolicyId: challenger.id,
      config: { gate: { horizon: "15m", minSamples: 8, minImprovement: 0.05, maxFailureRate: 0.05 } },
    });
    const shadow = db.experiments.transition(experiment.id, "shadow", { reason: "test" });
    const start = shadow.startedAt!;
    for (let i = 0; i < 8; i++) {
      const ts = start + i * 15 * 60_000;
      const decisionId = db.insertDecision({
        bee: "bee1", ts, stateHash: `s${i}`, stateJson: "{}", menuJson: "{}", choice: "WAIT", probabilities: { WAIT: 1 },
        confidence: 1, conviction: 1, latencyMs: 1, inputTokens: 1, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
        evaluation: {
          ts, experimentId: experiment.id, arm: "champion", policyVersionId: champion.id, method: "style:bizzy", strategyId: "bizzy",
          stateHash: `s${i}`, menuHash: "m", questionSchemaVersion: "action-conviction-v1", requestedModel: "jev-1.13.0", answeredModel: "jev-1.13.0",
          questions: {}, answers: { action: { choice: "WAIT", probabilities: { WAIT: 1 } } }, metrics: { source: "jev" },
        },
      });
      db.experiments.recordEvaluation(decisionId, {
        ts, experimentId: experiment.id, arm: "challenger", policyVersionId: challenger.id, method: "style:bizzy", strategyId: "bizzy",
        stateHash: `s${i}`, menuHash: "m", questionSchemaVersion: "action-conviction-v1", requestedModel: "jev-1.13.0", answeredModel: "jev-1.13.0",
        questions: {}, answers: { action: { choice: "WAIT", probabilities: { WAIT: 1 } } }, metrics: { source: "shadow", jevStatus: "ok" },
      });
      db.experiments.recordOutcome({ experimentId: experiment.id, decisionId, policyVersionId: champion.id, ts: ts + 15 * 60_000, horizon: "15m", metric: "action_brier", value: 0.3 });
      db.experiments.recordOutcome({ experimentId: experiment.id, decisionId, policyVersionId: challenger.id, ts: ts + 15 * 60_000, horizon: "15m", metric: "action_brier", value: 0.1 });
    }
    const evaluator = new ExperimentEvaluator(db);
    const at = start + 8 * 15 * 60_000;
    expect(evaluator.evaluate(experiment.id, at)).toMatchObject({ eligible: true, rawPairs: 8, independentSamples: 8, meanImprovement: expect.closeTo(0.2, 10), lowerConfidenceBound: expect.closeTo(0.2, 10) });
    expect(evaluator.evaluateActive(at)).toHaveLength(1);
    expect(db.experiments.get(experiment.id)?.status).toBe("canary");
    expect(evaluator.evaluateActive(at + 1)).toEqual([]);
    db.close();
  });
});
