import { describe, expect, it } from "vitest";
import { Db, type DecisionRow } from "../src/db.js";
import { OutcomeCollector } from "../src/outcomes.js";
import { POLICY_DESCRIPTOR_VERSION, type PolicyDescriptor } from "../src/experiments.js";
import { freshBee } from "../src/ledger.js";
import type { Menu } from "../src/bees/types.js";
import { coin, NOW, view } from "./fixtures.js";

const descriptor: PolicyDescriptor = {
  version: POLICY_DESCRIPTOR_VERSION,
  bee: "bee1",
  mode: "dry",
  method: { kind: "style", id: "bizzy", params: {} },
  strategy: "pick the best risk-adjusted move",
  ownerRules: "",
  requestedModel: "jev-1.13.0",
  questionSchemaVersion: "action-conviction-v1",
  convictionCriteria: ["weak", "fair", "strong", "overwhelming"],
  risk: { maxLeverage: 2 },
};

describe("decision outcome collector", () => {
  it("settles markout, regret and Brier once at the configured horizon", () => {
    const db = new Db(":memory:");
    const policy = db.experiments.ensurePolicy(descriptor, NOW);
    const instId = "BTC-USD_UM_XPERP-310404";
    const menu: Menu = {
      LONG_BTC: { desc: "long BTC", intent: { kind: "open", instId, side: "long", sizeFrac: 1, setup: "strict" } },
      WAIT: { desc: "stay flat", intent: { kind: "hold" } },
    };
    const decision: DecisionRow = {
      bee: "bee1",
      ts: NOW,
      stateHash: "state",
      stateJson: "{}",
      menuJson: JSON.stringify(menu),
      choice: "LONG_BTC",
      probabilities: { LONG_BTC: 0.8, WAIT: 0.2 },
      confidence: 0.8,
      conviction: 2,
      latencyMs: 10,
      inputTokens: 20,
      jevCostUsd: 0.001,
      jevError: null,
      action: { kind: "open", instId, side: "long", notionalUsd: 100 },
      vetoedBy: null,
      forcedBy: null,
      status: "LONG_BTC",
      evaluation: {
        ts: NOW,
        experimentId: null,
        arm: "baseline",
        policyVersionId: policy.id,
        method: "style:bizzy",
        strategyId: "bizzy",
        stateHash: "state",
        menuHash: "menu",
        questionSchemaVersion: "action-conviction-v1",
        requestedModel: "jev-1.13.0",
        answeredModel: "jev-1.13.0",
        questions: {},
        answers: { action: { choice: "LONG_BTC", probabilities: { LONG_BTC: 0.8, WAIT: 0.2 } } },
        metrics: {},
      },
    };
    const decisionId = db.insertDecision(decision);
    const collector = new OutcomeCollector(db, [{ name: "1h", ms: 60 * 60_000 }]);
    expect(collector.schedule({ decisionId, bee: "bee1", ts: NOW, menu, state: freshBee("bee1", 333, NOW), view: view([coin("BTC", {}, 100)]) })).toBe(1);
    expect(collector.settle(view([coin("BTC", {}, 110)]), NOW + 59 * 60_000)).toEqual({ targets: 0, outcomes: 0, deferred: 0 });
    expect(collector.settle(view([coin("BTC", {}, 110)]), NOW + 60 * 60_000)).toEqual({ targets: 1, outcomes: 3, deferred: 0 });

    const rows = db.raw.prepare("SELECT metric, value FROM experiment_outcomes ORDER BY metric").all() as unknown as Array<{ metric: string; value: number }>;
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({ action_brier: expect.closeTo(0.08, 10), chosen_markout_bps: expect.closeTo(1000, 8), regret_bps: 0 });
    expect(collector.settle(view([coin("BTC", {}, 120)]), NOW + 2 * 60 * 60_000)).toEqual({ targets: 0, outcomes: 0, deferred: 0 });
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM experiment_outcomes").get() as { n: number }).n).toBe(3);
    db.close();
  });
});
