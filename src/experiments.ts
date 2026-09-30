// Durable experiment ledger and policy attribution.
//
// This module deliberately does not decide which policy wins. It records immutable policy definitions, experiment
// lifecycle events, per-decision Jev evaluations and later outcomes. Promotion remains an explicit state transition;
// the evaluator that earns that transition arrives in a later phase.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BeeId } from "./config.js";

export const POLICY_DESCRIPTOR_VERSION = 1 as const;

export type ExperimentStatus = "draft" | "shadow" | "canary" | "promoted" | "rolled_back" | "stopped";
export type ExperimentArm = "baseline" | "champion" | "challenger" | "canary";

export interface PolicyDescriptor {
  version: typeof POLICY_DESCRIPTOR_VERSION;
  bee: BeeId;
  mode: string;
  method: { kind: "style" | "skill"; id: string; params: Record<string, number> };
  strategy: string;
  ownerRules: string;
  requestedModel: string;
  questionSchemaVersion: string;
  convictionCriteria: readonly string[];
  risk: Record<string, unknown>;
}

export interface PolicyVersion {
  id: string;
  bee: BeeId;
  createdAt: number;
  descriptor: PolicyDescriptor;
}

export interface ExperimentRecord {
  id: string;
  bee: BeeId;
  kind: string;
  status: ExperimentStatus;
  hypothesis: string;
  primaryMetric: string;
  championPolicyId: string;
  challengerPolicyId: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  config: Record<string, unknown>;
  result: Record<string, unknown> | null;
}

export interface DecisionEvaluation {
  ts: number;
  experimentId: string | null;
  arm: ExperimentArm;
  policyVersionId: string;
  method: string;
  strategyId: string;
  stateHash: string;
  menuHash: string;
  questionSchemaVersion: string;
  requestedModel: string;
  answeredModel: string | null;
  questions: Record<string, unknown>;
  answers: Record<string, unknown> | null;
  metrics: Record<string, number | string | boolean | null>;
}

export interface DecisionOutcome {
  experimentId?: string | null;
  decisionId?: number | null;
  policyVersionId: string;
  ts: number;
  horizon: string;
  metric: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface ExperimentScore {
  horizon: string;
  metric: string;
  champion: { samples: number; mean: number } | null;
  challenger: { samples: number; mean: number } | null;
  /** Positive means the challenger is better, respecting whether the metric is minimised or maximised. */
  challengerImprovement: number | null;
}

/** Stable JSON for hashes: object key order never changes an identity. */
export function canonicalJson(value: unknown): string {
  const normal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normal);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normal(x)]));
    }
    return v;
  };
  return JSON.stringify(normal(value));
}

export function fingerprint(value: unknown, prefix = ""): string {
  const hash = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `${prefix}${hash.slice(0, 24)}`;
}

export function policyVersionId(descriptor: PolicyDescriptor): string {
  return fingerprint(descriptor, "pol_");
}

/** Distribution diagnostics used for calibration; no thresholds or trading behavior live here. */
export function distributionMetrics(probabilities: Record<string, number>): { entropy: number; margin: number; topProbability: number; options: number } {
  const ps = Object.values(probabilities).filter((p) => Number.isFinite(p) && p >= 0).sort((a, b) => b - a);
  const entropy = ps.reduce((sum, p) => (p > 0 ? sum - p * Math.log(p) : sum), 0);
  return {
    entropy: +entropy.toFixed(6),
    margin: +((ps[0] ?? 0) - (ps[1] ?? 0)).toFixed(6),
    topProbability: +(ps[0] ?? 0).toFixed(6),
    options: ps.length,
  };
}

const ALLOWED: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  draft: ["shadow", "stopped"],
  shadow: ["canary", "promoted", "rolled_back", "stopped"],
  canary: ["promoted", "rolled_back", "stopped"],
  promoted: ["rolled_back", "stopped"],
  rolled_back: [],
  stopped: [],
};

export class ExperimentLedger {
  constructor(
    private db: DatabaseSync,
    private now: () => number = Date.now,
  ) {}

  ensurePolicy(descriptor: PolicyDescriptor, at = this.now()): PolicyVersion {
    const id = policyVersionId(descriptor);
    this.db
      .prepare(`INSERT OR IGNORE INTO policy_versions
        (id, bee, created_ts, method, question_schema_version, requested_model, descriptor_json)
        VALUES (?,?,?,?,?,?,?)`)
      .run(id, descriptor.bee, at, `${descriptor.method.kind}:${descriptor.method.id}`, descriptor.questionSchemaVersion, descriptor.requestedModel, canonicalJson(descriptor));
    return this.getPolicy(id)!;
  }

  getPolicy(id: string): PolicyVersion | null {
    const row = this.db.prepare("SELECT id, bee, created_ts, descriptor_json FROM policy_versions WHERE id = ?").get(id) as PolicyDbRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      bee: row.bee as BeeId,
      createdAt: row.created_ts,
      descriptor: JSON.parse(row.descriptor_json) as PolicyDescriptor,
    };
  }

  listPolicies(bee?: BeeId, limit = 100): PolicyVersion[] {
    const rows = bee
      ? this.db.prepare("SELECT id, bee, created_ts, descriptor_json FROM policy_versions WHERE bee = ? ORDER BY created_ts DESC LIMIT ?").all(bee, limit)
      : this.db.prepare("SELECT id, bee, created_ts, descriptor_json FROM policy_versions ORDER BY created_ts DESC LIMIT ?").all(limit);
    return (rows as unknown as PolicyDbRow[]).map((row) => ({
      id: row.id,
      bee: row.bee as BeeId,
      createdAt: row.created_ts,
      descriptor: JSON.parse(row.descriptor_json) as PolicyDescriptor,
    }));
  }

  create(input: {
    id?: string;
    bee: BeeId;
    kind: string;
    hypothesis: string;
    primaryMetric: string;
    championPolicyId: string;
    challengerPolicyId: string;
    config?: Record<string, unknown>;
    actor?: string;
  }): ExperimentRecord {
    if (!input.hypothesis.trim()) throw new Error("experiment hypothesis is required");
    if (!input.primaryMetric.trim()) throw new Error("experiment primary metric is required");
    if (input.championPolicyId === input.challengerPolicyId) throw new Error("champion and challenger policies must differ");
    const champion = this.getPolicy(input.championPolicyId);
    const challenger = this.getPolicy(input.challengerPolicyId);
    if (!champion || !challenger) throw new Error("experiment policies must exist");
    if (champion.bee !== input.bee || challenger.bee !== input.bee) throw new Error("experiment policies must belong to its bee");
    const id = input.id ?? `exp_${randomUUID()}`;
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(`INSERT INTO experiments
          (id, bee, kind, status, hypothesis, primary_metric, champion_policy_id, challenger_policy_id,
           created_ts, updated_ts, started_ts, ended_ts, config_json, result_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(id, input.bee, input.kind, "draft", input.hypothesis.trim(), input.primaryMetric.trim(), input.championPolicyId, input.challengerPolicyId, at, at, null, null, JSON.stringify(input.config ?? {}));
      this.appendEvent(id, at, "created", input.actor ?? "system", { status: "draft" });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get(id)!;
  }

  transition(id: string, to: ExperimentStatus, input: { actor?: string; reason: string; result?: Record<string, unknown> }): ExperimentRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`no such experiment: ${id}`);
    if (!ALLOWED[cur.status].includes(to)) throw new Error(`invalid experiment transition: ${cur.status} -> ${to}`);
    if (!input.reason.trim()) throw new Error("experiment transition reason is required");
    if (to === "shadow" || to === "canary") {
      const other = this.db
        .prepare("SELECT id FROM experiments WHERE bee = ? AND id <> ? AND status IN ('shadow','canary') LIMIT 1")
        .get(cur.bee, id) as { id: string } | undefined;
      if (other) throw new Error(`bee already has an active experiment: ${other.id}`);
    }
    const at = this.now();
    const terminal = to === "promoted" || to === "rolled_back" || to === "stopped";
    const started = cur.startedAt ?? (to === "shadow" || to === "canary" ? at : null);
    const ended = terminal ? at : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE experiments SET status = ?, updated_ts = ?, started_ts = ?, ended_ts = ?, result_json = COALESCE(?, result_json) WHERE id = ?")
        .run(to, at, started, ended, input.result ? JSON.stringify(input.result) : null, id);
      this.appendEvent(id, at, "transition", input.actor ?? "system", { from: cur.status, to, reason: input.reason, ...(input.result ? { result: input.result } : {}) });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get(id)!;
  }

  recordEvaluation(decisionId: number, e: DecisionEvaluation): void {
    const decision = this.db.prepare("SELECT bee FROM decisions WHERE id = ?").get(decisionId) as { bee: string } | undefined;
    if (!decision) throw new Error(`no such decision: ${decisionId}`);
    const policy = this.getPolicy(e.policyVersionId);
    if (!policy) throw new Error(`no such policy: ${e.policyVersionId}`);
    if (policy.bee !== decision.bee) throw new Error("decision and policy bees differ");
    if (e.experimentId) {
      const experiment = this.get(e.experimentId);
      if (!experiment) throw new Error(`no such experiment: ${e.experimentId}`);
      if (experiment.bee !== decision.bee) throw new Error("decision and experiment bees differ");
      if (![experiment.championPolicyId, experiment.challengerPolicyId].includes(e.policyVersionId)) {
        throw new Error("decision policy is not an arm of its experiment");
      }
    } else if (e.arm !== "baseline") {
      throw new Error("an experiment arm requires an experiment id");
    }
    this.db
      .prepare(`INSERT INTO decision_evaluations
        (decision_id, experiment_id, arm, policy_version_id, ts, method, strategy_id, state_hash, menu_hash,
         question_schema_version, requested_model, answered_model, questions_json, answers_json, metrics_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(decisionId, e.experimentId, e.arm, e.policyVersionId, e.ts, e.method, e.strategyId, e.stateHash, e.menuHash, e.questionSchemaVersion, e.requestedModel, e.answeredModel, JSON.stringify(e.questions), e.answers ? JSON.stringify(e.answers) : null, JSON.stringify(e.metrics));
  }

  recordOutcome(o: DecisionOutcome): number {
    if (!Number.isFinite(o.value)) throw new Error("outcome value must be finite");
    if (!this.getPolicy(o.policyVersionId)) throw new Error(`no such policy: ${o.policyVersionId}`);
    if (o.experimentId) {
      const experiment = this.get(o.experimentId);
      if (!experiment) throw new Error(`no such experiment: ${o.experimentId}`);
      if (![experiment.championPolicyId, experiment.challengerPolicyId].includes(o.policyVersionId)) {
        throw new Error("outcome policy is not an arm of its experiment");
      }
    }
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO experiment_outcomes
        (experiment_id, decision_id, policy_version_id, ts, horizon, metric, value, metadata_json)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(o.experimentId ?? null, o.decisionId ?? null, o.policyVersionId, o.ts, o.horizon, o.metric, o.value, JSON.stringify(o.metadata ?? {}));
    return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : 0;
  }

  /** The sole running experiment whose champion is the policy making the real decision. */
  activeFor(bee: BeeId, championPolicyId: string): ExperimentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM experiments WHERE bee = ? AND champion_policy_id = ? AND status IN ('shadow','canary') ORDER BY updated_ts DESC LIMIT 1")
      .get(bee, championPolicyId) as ExperimentDbRow | undefined;
    return row ? fromRow(row) : null;
  }

  shadowSpendSince(ts: number): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(CAST(json_extract(metrics_json, '$.costUsd') AS REAL)), 0) AS spent FROM decision_evaluations WHERE arm = 'challenger' AND ts >= ?")
      .get(ts) as { spent: number };
    return row.spent;
  }

  scorecard(id: string): ExperimentScore[] {
    if (!this.get(id)) throw new Error(`no such experiment: ${id}`);
    const rows = this.db
      .prepare(`SELECT o.horizon, o.metric, e.arm, COUNT(*) AS samples, AVG(o.value) AS mean
        FROM experiment_outcomes o
        JOIN decision_evaluations e
          ON e.decision_id = o.decision_id AND e.policy_version_id = o.policy_version_id AND e.experiment_id = o.experiment_id
        WHERE o.experiment_id = ? AND e.arm IN ('champion','challenger')
        GROUP BY o.horizon, o.metric, e.arm
        ORDER BY o.horizon, o.metric, e.arm`)
      .all(id) as unknown as Array<{ horizon: string; metric: string; arm: "champion" | "challenger"; samples: number; mean: number }>;
    const grouped = new Map<string, ExperimentScore>();
    for (const row of rows) {
      const key = `${row.horizon}\u0000${row.metric}`;
      const score = grouped.get(key) ?? { horizon: row.horizon, metric: row.metric, champion: null, challenger: null, challengerImprovement: null };
      score[row.arm] = { samples: row.samples, mean: row.mean };
      grouped.set(key, score);
    }
    for (const score of grouped.values()) {
      if (!score.champion || !score.challenger) continue;
      const lowerIsBetter = score.metric === "action_brier" || score.metric === "regret_bps";
      score.challengerImprovement = lowerIsBetter
        ? score.champion.mean - score.challenger.mean
        : score.challenger.mean - score.champion.mean;
    }
    return [...grouped.values()];
  }

  get(id: string): ExperimentRecord | null {
    const r = this.db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as ExperimentDbRow | undefined;
    return r ? fromRow(r) : null;
  }

  list(bee?: BeeId, limit = 100): ExperimentRecord[] {
    const rows = bee
      ? this.db.prepare("SELECT * FROM experiments WHERE bee = ? ORDER BY created_ts DESC LIMIT ?").all(bee, limit)
      : this.db.prepare("SELECT * FROM experiments ORDER BY created_ts DESC LIMIT ?").all(limit);
    return (rows as unknown as ExperimentDbRow[]).map(fromRow);
  }

  events(id: string): Array<{ ts: number; type: string; actor: string; data: Record<string, unknown> }> {
    const rows = this.db.prepare("SELECT ts, type, actor, data_json FROM experiment_events WHERE experiment_id = ? ORDER BY id").all(id) as Array<{ ts: number; type: string; actor: string; data_json: string }>;
    return rows.map((r) => ({ ts: r.ts, type: r.type, actor: r.actor, data: JSON.parse(r.data_json) as Record<string, unknown> }));
  }

  private appendEvent(experimentId: string, ts: number, type: string, actor: string, data: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO experiment_events (experiment_id, ts, type, actor, data_json) VALUES (?,?,?,?,?)").run(experimentId, ts, type, actor, JSON.stringify(data));
  }
}

interface ExperimentDbRow {
  id: string;
  bee: string;
  kind: string;
  status: ExperimentStatus;
  hypothesis: string;
  primary_metric: string;
  champion_policy_id: string;
  challenger_policy_id: string;
  created_ts: number;
  updated_ts: number;
  started_ts: number | null;
  ended_ts: number | null;
  config_json: string;
  result_json: string | null;
}

interface PolicyDbRow {
  id: string;
  bee: string;
  created_ts: number;
  descriptor_json: string;
}

function fromRow(r: ExperimentDbRow): ExperimentRecord {
  return {
    id: r.id,
    bee: r.bee as BeeId,
    kind: r.kind,
    status: r.status,
    hypothesis: r.hypothesis,
    primaryMetric: r.primary_metric,
    championPolicyId: r.champion_policy_id,
    challengerPolicyId: r.challenger_policy_id,
    createdAt: r.created_ts,
    updatedAt: r.updated_ts,
    startedAt: r.started_ts,
    endedAt: r.ended_ts,
    config: JSON.parse(r.config_json) as Record<string, unknown>,
    result: r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
  };
}
