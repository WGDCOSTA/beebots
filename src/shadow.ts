// J1 shadow execution. A challenger may answer the same decision contract, but this class has no order executor and
// returns no Action. Its only side effect is appending a challenger evaluation to the experiment ledger.
import type { BeeId } from "./config.js";
import type { Db } from "./db.js";
import { canonicalJson, distributionMetrics, fingerprint, type ExperimentRecord, type PolicyVersion } from "./experiments.js";
import type { Jev } from "./jev.js";
import type { Menu } from "./bees/types.js";

export interface ShadowInput {
  decisionId: number;
  bee: BeeId;
  ts: number;
  championPolicyId: string;
  stateHash: string;
  state: Record<string, unknown>;
  menu: Menu;
  instructionSuffix?: string;
}

export class ShadowRunner {
  private queue: Promise<void> = Promise.resolve();
  private failures: Error[] = [];

  constructor(
    private db: Db,
    private jev: Jev,
  ) {}

  /** Queue without delaying the real decision or its order. False means there is no compatible active experiment. */
  enqueue(input: ShadowInput): boolean {
    const experiment = this.db.experiments.activeFor(input.bee, input.championPolicyId);
    if (!experiment || experiment.kind !== "jev_contract") return false;
    const champion = this.db.experiments.getPolicy(experiment.championPolicyId);
    const challenger = this.db.experiments.getPolicy(experiment.challengerPolicyId);
    if (!champion || !challenger || !compatible(champion, challenger)) return false;
    this.queue = this.queue
      .then(() => this.evaluate(experiment, challenger, input))
      .catch((err: unknown) => {
        this.failures.push(err instanceof Error ? err : new Error(String(err)));
      });
    return true;
  }

  /** Tests and graceful shutdowns can wait until every queued shadow answer is durable. */
  async flush(): Promise<void> {
    await this.queue;
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  private async evaluate(experiment: ExperimentRecord, challenger: PolicyVersion, input: ShadowInput): Promise<void> {
    const criteria = challenger.descriptor.convictionCriteria;
    if (criteria.length < 2) throw new Error("challenger conviction rubric needs at least two criteria");
    const strategy = [challenger.descriptor.strategy, input.instructionSuffix].filter(Boolean).join(" ");
    const result = await this.jev.decide(
      {
        strategy,
        state: input.state,
        menu: input.menu,
        convictionLabels: criteria as unknown as readonly [string, string, string, string],
      },
      { model: challenger.descriptor.requestedModel },
    );
    const dist = result.ok ? distributionMetrics(result.probabilities) : null;
    this.db.experiments.recordEvaluation(input.decisionId, {
      ts: input.ts,
      experimentId: experiment.id,
      arm: "challenger",
      policyVersionId: challenger.id,
      method: `${challenger.descriptor.method.kind}:${challenger.descriptor.method.id}`,
      strategyId: challenger.descriptor.method.id,
      stateHash: input.stateHash,
      menuHash: fingerprint(input.menu, "menu_"),
      questionSchemaVersion: result.trace.questionSchemaVersion,
      requestedModel: result.trace.requestedModel,
      answeredModel: result.trace.answeredModel,
      questions: result.trace.questions,
      answers: result.trace.answers,
      metrics: {
        source: "shadow",
        jevStatus: result.ok ? "ok" : result.reason,
        actionConfidence: result.ok ? result.confidence : null,
        conviction: result.ok ? result.convictionRaw : null,
        latencyMs: result.latencyMs,
        inputTokens: result.ok ? result.inputTokens : null,
        costUsd: result.ok ? result.costUsd : 0,
        ...(dist ?? { entropy: null, margin: null, topProbability: null, options: Object.keys(input.menu).length }),
      },
    });
  }
}

/** J1 shadows prompt/model/rubric changes over the same executable method, risk policy and menu. */
function compatible(champion: PolicyVersion, challenger: PolicyVersion): boolean {
  return (
    champion.bee === challenger.bee &&
    canonicalJson(champion.descriptor.method) === canonicalJson(challenger.descriptor.method) &&
    canonicalJson(champion.descriptor.risk) === canonicalJson(challenger.descriptor.risk)
  );
}
