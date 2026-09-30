// Owner-facing J2 control plane. It creates Jev-contract challengers and exposes evidence, but cannot promote to live.
import type { BeeId } from "./config.js";
import type { Db } from "./db.js";
import { ExperimentEvaluator, type ExperimentMetric } from "./evaluator.js";
import type { ExperimentStatus } from "./experiments.js";

export interface CreateExperimentInput {
  bee: BeeId;
  championPolicyId: string;
  hypothesis: string;
  primaryMetric: ExperimentMetric;
  challenger: {
    strategy?: string;
    requestedModel?: string;
    convictionCriteria?: [string, string, string, string];
  };
  gate: {
    horizon: "15m" | "1h" | "4h";
    minSamples: number;
    minImprovement: number;
    maxFailureRate: number;
  };
}

export class ExperimentControl {
  readonly evaluator: ExperimentEvaluator;

  constructor(
    private db: Db,
    private shadowEnabled: boolean,
  ) {
    this.evaluator = new ExperimentEvaluator(db);
  }

  state() {
    return {
      shadowEnabled: this.shadowEnabled,
      canExecuteChallenger: false,
      policies: this.db.experiments.listPolicies(undefined, 100).map((p) => ({
        id: p.id,
        bee: p.bee,
        createdAt: p.createdAt,
        method: p.descriptor.method,
        strategy: p.descriptor.strategy,
        requestedModel: p.descriptor.requestedModel,
        convictionCriteria: p.descriptor.convictionCriteria,
        questionSchemaVersion: p.descriptor.questionSchemaVersion,
      })),
      experiments: this.db.experiments.list(undefined, 100).map((experiment) => ({
        ...experiment,
        evidence: this.evaluator.evaluate(experiment.id),
        scorecard: this.db.experiments.scorecard(experiment.id),
        events: this.db.experiments.events(experiment.id),
      })),
    };
  }

  create(input: CreateExperimentInput) {
    const champion = this.db.experiments.getPolicy(input.championPolicyId);
    if (!champion) throw new Error("Champion policy does not exist.");
    if (champion.bee !== input.bee) throw new Error("Champion policy belongs to another bunny.");
    const challenger = this.db.experiments.ensurePolicy({
      ...champion.descriptor,
      strategy: input.challenger.strategy ?? champion.descriptor.strategy,
      requestedModel: input.challenger.requestedModel ?? champion.descriptor.requestedModel,
      convictionCriteria: input.challenger.convictionCriteria ?? champion.descriptor.convictionCriteria,
    });
    if (challenger.id === champion.id) throw new Error("The challenger must change the prompt, model or conviction rubric.");
    return this.db.experiments.create({
      bee: input.bee,
      kind: "jev_contract",
      hypothesis: input.hypothesis,
      primaryMetric: input.primaryMetric,
      championPolicyId: champion.id,
      challengerPolicyId: challenger.id,
      config: { gate: input.gate, safety: { challengerExecution: false, createdBy: "owner" } },
      actor: "owner",
    });
  }

  act(id: string, action: "start_shadow" | "stop" | "rollback") {
    const experiment = this.db.experiments.get(id);
    if (!experiment) throw new Error("Experiment does not exist.");
    let to: ExperimentStatus;
    let reason: string;
    if (action === "start_shadow") {
      if (!this.shadowEnabled) throw new Error("Shadow calls are disabled. Set JEV_SHADOW_ENABLED=true and restart first.");
      if (experiment.status !== "draft") throw new Error("Only a draft can start shadow evaluation.");
      to = "shadow";
      reason = "owner started shadow evaluation";
    } else if (action === "rollback") {
      if (experiment.status !== "shadow" && experiment.status !== "canary") throw new Error("Only a running experiment can be rolled back.");
      to = "rolled_back";
      reason = "owner rolled the experiment back";
    } else {
      if (experiment.status !== "draft" && experiment.status !== "shadow" && experiment.status !== "canary") throw new Error("Experiment is already terminal.");
      to = "stopped";
      reason = "owner stopped the experiment";
    }
    return this.db.experiments.transition(id, to, { actor: "owner", reason });
  }
}
