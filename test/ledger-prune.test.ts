import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { POLICY_DESCRIPTOR_VERSION, type PolicyDescriptor } from "../src/experiments.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 13);
const descriptor = (strategy: string): PolicyDescriptor => ({
  version: POLICY_DESCRIPTOR_VERSION, bee: "bee1", mode: "dry", method: { kind: "style", id: "boozy", params: {} }, strategy, ownerRules: "",
  requestedModel: "jev-1.13.0", questionSchemaVersion: "action-conviction-v1", convictionCriteria: ["a", "b", "c", "d"], risk: { maxLeverage: 2 },
});
const count = (db: Db, t: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

function seed() {
  const db = new Db(":memory:");
  const champ = db.experiments.ensurePolicy(descriptor("champion"));
  const chall = db.experiments.ensurePolicy(descriptor("challenger"));
  const mk = (id: string) => db.experiments.create({ id, bee: "bee1", kind: "jev_contract", hypothesis: "h", primaryMetric: "action_brier", championPolicyId: champ.id, challengerPolicyId: chall.id });
  mk("exp_done");
  db.experiments.transition("exp_done", "shadow", { reason: "t" });
  db.experiments.transition("exp_done", "rolled_back", { reason: "t" });
  mk("exp_running");
  db.experiments.transition("exp_running", "shadow", { reason: "t" });
  const add = (ts: number, experimentId: string | null, settled: boolean) => {
    const id = db.insertDecision({
      bee: "bee1", ts, stateHash: "s", stateJson: "{}", menuJson: "{}", choice: "WAIT", probabilities: { WAIT: 1 }, confidence: 1, conviction: 1, latencyMs: 1,
      inputTokens: 1, jevCostUsd: 0, jevError: null, action: { kind: "none" }, vetoedBy: null, forcedBy: null, status: "WAIT",
      evaluation: { ts, experimentId, arm: experimentId ? "champion" : "baseline", policyVersionId: champ.id, method: "style:boozy", strategyId: "boozy", stateHash: "s", menuHash: "m",
        questionSchemaVersion: "action-conviction-v1", requestedModel: "jev-1.13.0", answeredModel: "jev-1.13.0", questions: {}, answers: null, metrics: {} },
    });
    db.experiments.recordOutcome({ experimentId, decisionId: id, policyVersionId: champ.id, ts: ts + 900_000, horizon: "15m", metric: "action_brier", value: 0.2 });
    db.raw.prepare("INSERT INTO decision_outcome_targets (decision_id, bee, created_ts, due_ts, horizon, candidates_json, settled_ts) VALUES (?,?,?,?,?,?,?)")
      .run(id, "bee1", ts, ts + 900_000, "15m", "[]", settled ? ts + 900_000 : null);
    return id;
  };
  return { db, add };
}

describe("experiment ledger retention", () => {
  it("drops old rows of finished experiments and of no experiment, keeps recent ones", () => {
    const { db, add } = seed();
    add(NOW - 10 * DAY, null, true);
    add(NOW - 9 * DAY, "exp_done", true);
    add(NOW - 2 * DAY, null, true);
    expect(db.experiments.prune(NOW - 7 * DAY, 1)).toEqual({ evaluations: 2, outcomes: 2, targets: 2 });
    expect([count(db, "decision_evaluations"), count(db, "experiment_outcomes"), count(db, "decision_outcome_targets")]).toEqual([1, 1, 1]);
    // Decisions themselves are untouched, and a second run finds nothing.
    expect(count(db, "decisions")).toBe(3);
    expect(db.experiments.prune(NOW - 7 * DAY)).toEqual({ evaluations: 0, outcomes: 0, targets: 0 });
  });

  it("keeps every row of an unfinished experiment, and what an unsettled target still needs", () => {
    const { db, add } = seed();
    add(NOW - 20 * DAY, "exp_running", true);
    const pending = add(NOW - 20 * DAY, null, false);
    expect(db.experiments.prune(NOW - 7 * DAY)).toEqual({ evaluations: 0, outcomes: 1, targets: 1 });
    // Only the old row with no experiment loses its outcome and settled target; the running experiment keeps its rows.
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM decision_evaluations WHERE experiment_id = 'exp_running'").get() as { n: number }).n).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM experiment_outcomes WHERE experiment_id = 'exp_running'").get() as { n: number }).n).toBe(1);
    // The unsettled target and its evaluation stay until it settles.
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM decision_outcome_targets WHERE decision_id = ? AND settled_ts IS NULL").get(pending) as { n: number }).n).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM decision_evaluations WHERE decision_id = ?").get(pending) as { n: number }).n).toBe(1);
  });
});
