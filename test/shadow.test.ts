import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { Jev } from "../src/jev.js";
import { POLICY_DESCRIPTOR_VERSION, type PolicyDescriptor } from "../src/experiments.js";
import { ShadowRunner } from "../src/shadow.js";
import type { Menu } from "../src/bees/types.js";
import { NOW } from "./fixtures.js";

const descriptor = (strategy: string, model = "jev-1.13.0"): PolicyDescriptor => ({
  version: POLICY_DESCRIPTOR_VERSION,
  bee: "bee1",
  mode: "dry",
  method: { kind: "style", id: "bizzy", params: {} },
  strategy,
  ownerRules: "",
  requestedModel: model,
  questionSchemaVersion: "action-conviction-v1",
  convictionCriteria: ["weak", "fair", "strong", "overwhelming"],
  risk: { maxLeverage: 2 },
});

describe("Jev shadow runner", () => {
  it("records a challenger answer without creating an order", async () => {
    const db = new Db(":memory:");
    const champion = db.experiments.ensurePolicy(descriptor("champion prompt"), NOW);
    const challenger = db.experiments.ensurePolicy(descriptor("challenger prompt", "jev-shadow"), NOW);
    const experiment = db.experiments.create({
      id: "exp_shadow",
      bee: "bee1",
      kind: "jev_contract",
      hypothesis: "the challenger prompt is better calibrated",
      primaryMetric: "action_brier",
      championPolicyId: champion.id,
      challengerPolicyId: challenger.id,
    });
    db.experiments.transition(experiment.id, "shadow", { reason: "ready" });
    const menu: Menu = {
      OPEN: { desc: "open", intent: { kind: "open", instId: "BTC-SWAP", side: "long", sizeFrac: 1, setup: "strict" } },
      WAIT: { desc: "wait", intent: { kind: "hold" } },
    };
    const decisionId = db.insertDecision({
      bee: "bee1", ts: NOW, stateHash: "state", stateJson: "{}", menuJson: JSON.stringify(menu), choice: "WAIT",
      probabilities: { OPEN: 0.4, WAIT: 0.6 }, confidence: 0.6, conviction: 1, latencyMs: 1, inputTokens: 1,
      jevCostUsd: 0.001, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
      evaluation: {
        ts: NOW, experimentId: experiment.id, arm: "champion", policyVersionId: champion.id, method: "style:bizzy", strategyId: "bizzy",
        stateHash: "state", menuHash: "menu", questionSchemaVersion: "action-conviction-v1", requestedModel: "jev-1.13.0",
        answeredModel: "jev-1.13.0", questions: {}, answers: { action: { choice: "WAIT", probabilities: { OPEN: 0.4, WAIT: 0.6 } } }, metrics: {},
      },
    });
    const requested: string[] = [];
    const client = {
      async systemOne(req: unknown) {
        const request = req as { model: string };
        requested.push(request.model);
        return {
          model: request.model,
          usage: { input_tokens: 50, output_tokens: 0 },
          answers: {
            action: { type: "choice", choice: "OPEN", confidence: 0.7, probabilities: { OPEN: 0.7, WAIT: 0.3 } },
            conviction: { type: "score", score: 2, confidence: 0.8, legend: {}, probabilities: {} },
          },
        } as never;
      },
    };
    const shadow = new ShadowRunner(db, new Jev({ apiKey: "test", model: "fallback", timeoutMs: 1000, dailyUsdCap: 1, usdPerMTok: 1, client }));
    expect(shadow.enqueue({ decisionId, bee: "bee1", ts: NOW, championPolicyId: champion.id, stateHash: "state", state: { px: 100 }, menu })).toBe(true);
    await shadow.flush();

    expect(requested).toEqual(["jev-shadow"]);
    const evaluations = db.raw.prepare("SELECT arm, policy_version_id AS policy FROM decision_evaluations ORDER BY id").all();
    expect(evaluations).toEqual([{ arm: "champion", policy: champion.id }, { arm: "challenger", policy: challenger.id }]);
    db.experiments.recordOutcome({ experimentId: experiment.id, decisionId, policyVersionId: champion.id, ts: NOW + 60_000, horizon: "1h", metric: "action_brier", value: 0.3 });
    db.experiments.recordOutcome({ experimentId: experiment.id, decisionId, policyVersionId: challenger.id, ts: NOW + 60_000, horizon: "1h", metric: "action_brier", value: 0.2 });
    expect(db.experiments.scorecard(experiment.id)).toEqual([
      { horizon: "1h", metric: "action_brier", champion: { samples: 1, mean: 0.3 }, challenger: { samples: 1, mean: 0.2 }, challengerImprovement: expect.closeTo(0.1, 10) },
    ]);
    expect(db.experiments.shadowSpendSince(NOW - 1)).toBeCloseTo(0.00005, 10);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n).toBe(0);
    db.close();
  });
});
