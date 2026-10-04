import { describe, expect, it } from "vitest";
import { Db, type DecisionRow } from "../src/db.js";
import { canonicalJson, distributionMetrics, ExperimentLedger, POLICY_DESCRIPTOR_VERSION, policyVersionId, type PolicyDescriptor } from "../src/experiments.js";

const descriptor = (method = "bizzy"): PolicyDescriptor => ({
  version: POLICY_DESCRIPTOR_VERSION,
  bee: "bee1",
  mode: "dry",
  method: { kind: "style", id: method, params: {} },
  strategy: `trade with ${method}`,
  ownerRules: "",
  requestedModel: "jev-1.13.0",
  questionSchemaVersion: "action-conviction-v1",
  convictionCriteria: ["weak", "fair", "strong", "overwhelming"],
  risk: { maxLeverage: 2, dailyLossStopPct: 8 },
});

describe("experiment ledger", () => {
  it("uses canonical, deterministic policy identities", () => {
    const a = descriptor();
    const b = { ...a, risk: { dailyLossStopPct: 8, maxLeverage: 2 } };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(policyVersionId(a)).toBe(policyVersionId(b));
    expect(policyVersionId(a)).not.toBe(policyVersionId(descriptor("breezy")));
  });

  it("records an auditable lifecycle and rejects invalid transitions", () => {
    const db = new Db(":memory:");
    let now = 1000;
    const ledger = new ExperimentLedger(db.raw, () => now);
    const champion = ledger.ensurePolicy(descriptor("bizzy"), now);
    const challenger = ledger.ensurePolicy(descriptor("breezy"), now);
    const created = ledger.create({
      id: "exp_test",
      bee: "bee1",
      kind: "jev_contract",
      hypothesis: "structured criteria improve calibration",
      primaryMetric: "multiclass_brier",
      championPolicyId: champion.id,
      challengerPolicyId: challenger.id,
      actor: "test",
    });
    expect(created.status).toBe("draft");
    now = 2000;
    expect(ledger.transition(created.id, "shadow", { actor: "test", reason: "ready for replay" })).toMatchObject({ status: "shadow", startedAt: 2000 });
    now = 3000;
    expect(ledger.transition(created.id, "canary", { actor: "evaluator", reason: "shadow threshold passed" }).status).toBe("canary");
    now = 4000;
    expect(ledger.transition(created.id, "promoted", { actor: "evaluator", reason: "canary passed", result: { brierDelta: -0.08 } })).toMatchObject({ status: "promoted", endedAt: 4000, result: { brierDelta: -0.08 } });
    expect(ledger.events(created.id).map((e) => e.type)).toEqual(["created", "transition", "transition", "transition"]);
    expect(() => ledger.transition(created.id, "shadow", { reason: "cannot go backwards" })).toThrow(/invalid experiment transition/);
    db.close();
  });

  it("writes decision attribution atomically beside the decision", () => {
    const db = new Db(":memory:");
    const policy = db.experiments.ensurePolicy(descriptor(), 1000);
    const decision = {
      bee: "bee1",
      ts: 1100,
      stateHash: "state-a",
      stateJson: "{}",
      menuJson: "{}",
      choice: "WAIT",
      probabilities: { WAIT: 0.8, OPEN: 0.2 },
      confidence: 0.7,
      conviction: 1.2,
      latencyMs: 12,
      inputTokens: 20,
      jevCostUsd: 0.0001,
      jevError: null,
      action: { kind: "none" },
      vetoedBy: null,
      forcedBy: null,
      status: "WAIT",
      evaluation: {
        ts: 1100,
        experimentId: null,
        arm: "baseline",
        policyVersionId: policy.id,
        method: "style:bizzy",
        strategyId: "bizzy",
        stateHash: "state-a",
        menuHash: "menu-a",
        questionSchemaVersion: "action-conviction-v1",
        requestedModel: "jev-1.13.0",
        answeredModel: "jev-1.13.0",
        questions: { action: { type: "choice" } },
        answers: { action: { choice: "WAIT" } },
        metrics: { entropy: 0.5, margin: 0.6 },
      },
    } satisfies DecisionRow;
    const decisionId = db.insertDecision(decision);
    const row = db.raw.prepare("SELECT * FROM decision_evaluations WHERE decision_id = ?").get(decisionId) as Record<string, unknown>;
    expect(row).toMatchObject({ policy_version_id: policy.id, arm: "baseline", answered_model: "jev-1.13.0" });
    expect(JSON.parse(String(row.answers_json))).toMatchObject({ action: { choice: "WAIT" } });

    expect(() => db.insertDecision({
      ...decision,
      ts: 1200,
      evaluation: { ...decision.evaluation, ts: 1200, policyVersionId: "pol_missing" },
    })).toThrow(/no such policy/);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM decisions").get()).toMatchObject({ n: 1 });
    db.close();
  });

  it("derives entropy and winner margin from the full distribution", () => {
    expect(distributionMetrics({ A: 0.7, B: 0.2, C: 0.1 })).toMatchObject({ margin: 0.5, topProbability: 0.7, options: 3 });
  });

  it("records a completed offline experiment atomically and idempotently", () => {
    const db = new Db(":memory:");
    const ledger = new ExperimentLedger(db.raw, () => 5000);
    const champion = ledger.ensurePolicy(descriptor("degen_wait"));
    const challenger = ledger.ensurePolicy(descriptor("scalp_candidate"));
    const input = {
      id: "exp_scalp_report_a",
      bee: "bee1" as const,
      kind: "scalp_lab",
      hypothesis: "the candidate keeps positive net expectancy after costs",
      primaryMetric: "net_bps",
      championPolicyId: champion.id,
      challengerPolicyId: challenger.id,
      status: "rolled_back" as const,
      result: { edge: false, bestNetBps: -2.1 },
      reason: "no out-of-sample edge",
    };
    expect(ledger.recordOffline(input)).toMatchObject({ status: "rolled_back", startedAt: 5000, endedAt: 5000 });
    expect(ledger.recordOffline(input).id).toBe(input.id);
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.events(input.id).map((event) => event.data.to)).toEqual([undefined, "shadow", "rolled_back"]);
    const outcome = { experimentId: input.id, policyVersionId: challenger.id, ts: 5000, horizon: "walk_forward_1m", metric: "net_bps", value: -2.1, metadata: { dataset: "BTC", ruleId: "micro" } };
    expect(ledger.recordOutcome(outcome)).toBeGreaterThan(0);
    expect(ledger.recordOutcome(outcome)).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM experiment_outcomes WHERE experiment_id = ?").get(input.id)).toMatchObject({ n: 1 });
    db.close();
  });
});
