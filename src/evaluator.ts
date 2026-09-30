// J2 evidence gate. It may advance shadow -> canary, but it never selects a trading policy or touches execution.
import type { Db } from "./db.js";
import type { ExperimentRecord } from "./experiments.js";

export const EXPERIMENT_METRICS = ["action_brier", "regret_bps", "chosen_markout_bps"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];

export interface EvidenceGateConfig {
  horizon: "15m" | "1h" | "4h";
  minSamples: number;
  minImprovement: number;
  maxFailureRate: number;
  confidenceZ: number;
  minSampleSpacingMs: number;
  minRuntimeMs: number;
}

export interface ExperimentEvidence {
  experimentId: string;
  metric: string;
  horizon: string;
  eligible: boolean;
  reasons: string[];
  attempts: number;
  challengerAnswers: number;
  failureRate: number;
  rawPairs: number;
  independentSamples: number;
  meanImprovement: number | null;
  standardError: number | null;
  lowerConfidenceBound: number | null;
  gate: EvidenceGateConfig;
  evaluatedAt: number;
}

interface PairRow {
  ts: number;
  champion: number;
  challenger: number;
}

export function evidenceGateConfig(experiment: ExperimentRecord): EvidenceGateConfig {
  const raw = experiment.config.gate && typeof experiment.config.gate === "object" ? experiment.config.gate as Record<string, unknown> : {};
  const horizon = raw.horizon === "15m" || raw.horizon === "4h" ? raw.horizon : "1h";
  const spacingDefault = horizon === "15m" ? 15 * 60_000 : horizon === "4h" ? 4 * 60 * 60_000 : 60 * 60_000;
  const minSamples = boundedInt(raw.minSamples, 8, 500, 24);
  return {
    horizon,
    minSamples,
    minImprovement: boundedNumber(raw.minImprovement, 0, 10_000, experiment.primaryMetric === "action_brier" ? 0.01 : experiment.primaryMetric === "regret_bps" ? 2 : 2),
    maxFailureRate: boundedNumber(raw.maxFailureRate, 0, 0.5, 0.05),
    confidenceZ: boundedNumber(raw.confidenceZ, 1, 4, 1.96),
    minSampleSpacingMs: boundedInt(raw.minSampleSpacingMs, 60_000, 24 * 60 * 60_000, spacingDefault),
    minRuntimeMs: boundedInt(raw.minRuntimeMs, spacingDefault, 90 * 86_400_000, minSamples * spacingDefault),
  };
}

export class ExperimentEvaluator {
  constructor(private db: Db) {}

  evaluate(id: string, now = Date.now()): ExperimentEvidence {
    const experiment = this.db.experiments.get(id);
    if (!experiment) throw new Error(`no such experiment: ${id}`);
    const gate = evidenceGateConfig(experiment);
    const counts = this.db.raw
      .prepare(`SELECT
          SUM(CASE WHEN arm = 'champion' AND json_extract(metrics_json, '$.source') = 'jev' THEN 1 ELSE 0 END) AS attempts,
          SUM(CASE WHEN arm = 'challenger' AND json_extract(metrics_json, '$.jevStatus') = 'ok' THEN 1 ELSE 0 END) AS answers
        FROM decision_evaluations WHERE experiment_id = ?`)
      .get(id) as { attempts: number | null; answers: number | null };
    const attempts = counts.attempts ?? 0;
    const challengerAnswers = counts.answers ?? 0;
    const failureRate = attempts > 0 ? Math.max(0, 1 - challengerAnswers / attempts) : 1;
    const rows = this.db.raw
      .prepare(`SELECT d.ts, c.value AS champion, x.value AS challenger
        FROM experiment_outcomes c
        JOIN experiment_outcomes x
          ON x.experiment_id = c.experiment_id AND x.decision_id = c.decision_id
          AND x.horizon = c.horizon AND x.metric = c.metric
        JOIN decisions d ON d.id = c.decision_id
        WHERE c.experiment_id = ? AND c.policy_version_id = ? AND x.policy_version_id = ?
          AND c.horizon = ? AND c.metric = ?
        ORDER BY d.ts, d.id`)
      .all(id, experiment.championPolicyId, experiment.challengerPolicyId, gate.horizon, experiment.primaryMetric) as unknown as PairRow[];
    const spaced: PairRow[] = [];
    let last = -Infinity;
    for (const row of rows) {
      if (row.ts - last < gate.minSampleSpacingMs) continue;
      spaced.push(row);
      last = row.ts;
    }
    const lowerIsBetter = experiment.primaryMetric === "action_brier" || experiment.primaryMetric === "regret_bps";
    const improvements = spaced.map((r) => lowerIsBetter ? r.champion - r.challenger : r.challenger - r.champion);
    const mean = improvements.length ? average(improvements) : null;
    const standardError = improvements.length > 1 ? sampleStdDev(improvements, mean!) / Math.sqrt(improvements.length) : null;
    const lowerConfidenceBound = mean === null ? null : standardError === null ? mean : mean - gate.confidenceZ * standardError;
    const reasons: string[] = [];
    if (experiment.status !== "shadow") reasons.push(`status is ${experiment.status}, not shadow`);
    if (!EXPERIMENT_METRICS.includes(experiment.primaryMetric as ExperimentMetric)) reasons.push(`unsupported primary metric: ${experiment.primaryMetric}`);
    if (now - (experiment.startedAt ?? experiment.createdAt) < gate.minRuntimeMs) reasons.push(`runtime below ${duration(gate.minRuntimeMs)}`);
    if (spaced.length < gate.minSamples) reasons.push(`${spaced.length}/${gate.minSamples} independent samples`);
    if (failureRate > gate.maxFailureRate) reasons.push(`shadow failure rate ${(failureRate * 100).toFixed(1)}% > ${(gate.maxFailureRate * 100).toFixed(1)}%`);
    if (mean === null || mean < gate.minImprovement) reasons.push(`mean improvement ${mean?.toFixed(4) ?? "n/a"} < ${gate.minImprovement}`);
    if (lowerConfidenceBound === null || lowerConfidenceBound <= 0) reasons.push(`confidence lower bound ${lowerConfidenceBound?.toFixed(4) ?? "n/a"} is not positive`);
    return {
      experimentId: id,
      metric: experiment.primaryMetric,
      horizon: gate.horizon,
      eligible: reasons.length === 0,
      reasons,
      attempts,
      challengerAnswers,
      failureRate,
      rawPairs: rows.length,
      independentSamples: spaced.length,
      meanImprovement: mean,
      standardError,
      lowerConfidenceBound,
      gate,
      evaluatedAt: now,
    };
  }

  /** Automatic J2 transition. Canary remains shadow-only in the engine. */
  evaluateActive(now = Date.now()): Array<{ experiment: ExperimentRecord; evidence: ExperimentEvidence }> {
    const promoted: Array<{ experiment: ExperimentRecord; evidence: ExperimentEvidence }> = [];
    for (const experiment of this.db.experiments.list(undefined, 500).filter((x) => x.status === "shadow")) {
      const evidence = this.evaluate(experiment.id, now);
      if (!evidence.eligible) continue;
      const next = this.db.experiments.transition(experiment.id, "canary", {
        actor: "evidence-gate-v1",
        reason: `${evidence.independentSamples} independent ${evidence.horizon} samples; mean improvement ${evidence.meanImprovement!.toFixed(4)}; lower bound ${evidence.lowerConfidenceBound!.toFixed(4)}`,
        result: { evidence },
      });
      promoted.push({ experiment: next, evidence });
    }
    return promoted;
  }
}

const average = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

function sampleStdDev(xs: number[], mean: number): number {
  return Math.sqrt(xs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (xs.length - 1));
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function boundedInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(boundedNumber(value, min, max, fallback));
}

function duration(ms: number): string {
  return ms % 86_400_000 === 0 ? `${ms / 86_400_000}d` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : `${Math.ceil(ms / 60_000)}m`;
}
