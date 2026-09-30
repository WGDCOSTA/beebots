// J1 outcome collection. Decisions are scored later from market prices; this module never executes an action.
import type { BeeId } from "./config.js";
import type { Db } from "./db.js";
import type { BeeState, Intent, Menu, Position } from "./bees/types.js";
import type { MarketView } from "./market/types.js";

export interface OutcomeHorizon {
  name: string;
  ms: number;
}

export const DEFAULT_OUTCOME_HORIZONS: readonly OutcomeHorizon[] = [
  { name: "15m", ms: 15 * 60_000 },
  { name: "1h", ms: 60 * 60_000 },
  { name: "4h", ms: 4 * 60 * 60_000 },
];

export interface OutcomeExposure {
  instId: string;
  direction: -1 | 1;
  weight: number;
  referencePrice: number;
}

export interface OutcomeCandidate {
  label: string;
  exposures: OutcomeExposure[];
}

interface TargetRow {
  id: number;
  decision_id: number;
  due_ts: number;
  horizon: string;
  candidates_json: string;
}

interface EvaluationRow {
  experiment_id: string | null;
  arm: string;
  policy_version_id: string;
  answers_json: string | null;
}

/** Turn each menu option into a counterfactual directional portfolio at the decision-time mids. */
export function outcomeCandidates(menu: Menu, bee: BeeState, view: MarketView): OutcomeCandidate[] {
  const exposure = (p: Position, weight = 1): OutcomeExposure | null => {
    const px = view.tickers.get(p.instId)?.mid;
    if (!(px && px > 0)) return null;
    return { instId: p.instId, direction: p.side === "long" ? 1 : -1, weight, referencePrice: px };
  };
  const main = bee.position ? exposure(bee.position) : null;
  const legs = (bee.legs ?? []).map((p) => exposure(p)).filter((x): x is OutcomeExposure => x !== null);
  const current = [...(main ? [main] : []), ...legs];
  const fresh = (instId: string, side: "long" | "short", weight: number): OutcomeExposure | null => {
    const px = view.tickers.get(instId)?.mid;
    return px && px > 0 ? { instId, direction: side === "long" ? 1 : -1, weight: Math.max(0.0001, weight), referencePrice: px } : null;
  };
  const forIntent = (intent: Intent): OutcomeExposure[] | null => {
    switch (intent.kind) {
      case "hold":
        return current;
      case "open": {
        const x = fresh(intent.instId, intent.side, intent.sizeFrac);
        return x ? [x] : null;
      }
      case "switch": {
        const x = fresh(intent.instId, intent.side, intent.sizeFrac);
        return x ? [x, ...legs] : null;
      }
      case "close":
        return legs;
      case "add":
        return main ? [main, { ...main, weight: Math.max(0.0001, intent.sizeFrac) }, ...legs] : null;
      case "trim":
        return main ? [{ ...main, weight: Math.max(0, 1 - intent.fraction) }, ...legs] : null;
      case "leg_open": {
        const x = fresh(intent.instId, intent.side, intent.sizeFrac);
        return x ? [...current, x] : null;
      }
      case "leg_close":
        return current.filter((x) => x.instId !== intent.instId);
    }
  };

  return Object.entries(menu).flatMap(([label, option]) => {
    const exposures = forIntent(option.intent);
    return exposures === null ? [] : [{ label, exposures: exposures.filter((x) => x.weight > 0) }];
  });
}

export class OutcomeCollector {
  constructor(
    private db: Db,
    private horizons: readonly OutcomeHorizon[] = DEFAULT_OUTCOME_HORIZONS,
  ) {}

  schedule(input: { decisionId: number; bee: BeeId; ts: number; menu: Menu; state: BeeState; view: MarketView }): number {
    const candidates = outcomeCandidates(input.menu, input.state, input.view);
    if (candidates.length < 2 || !candidates.some((c) => c.exposures.length > 0)) return 0;
    const json = JSON.stringify(candidates);
    let inserted = 0;
    const stmt = this.db.raw.prepare(`INSERT OR IGNORE INTO decision_outcome_targets
      (decision_id, bee, created_ts, due_ts, horizon, candidates_json, settled_ts)
      VALUES (?,?,?,?,?,?,NULL)`);
    for (const h of this.horizons) inserted += Number(stmt.run(input.decisionId, input.bee, input.ts, input.ts + h.ms, h.name, json).changes);
    return inserted;
  }

  /** Settle due targets idempotently. Missing markets are retried for up to 24 hours. */
  settle(view: MarketView, now: number, limit = 500): { targets: number; outcomes: number; deferred: number } {
    const rows = this.db.raw
      .prepare("SELECT id, decision_id, due_ts, horizon, candidates_json FROM decision_outcome_targets WHERE settled_ts IS NULL AND due_ts <= ? ORDER BY due_ts, id LIMIT ?")
      .all(now, limit) as unknown as TargetRow[];
    let targets = 0;
    let outcomes = 0;
    let deferred = 0;
    for (const row of rows) {
      const candidates = JSON.parse(row.candidates_json) as OutcomeCandidate[];
      const utilities = new Map<string, number>();
      for (const candidate of candidates) {
        let weighted = 0;
        let weights = 0;
        let complete = true;
        for (const x of candidate.exposures) {
          const px = view.tickers.get(x.instId)?.mid;
          if (!(px && px > 0)) {
            complete = false;
            break;
          }
          weighted += x.weight * x.direction * ((px / x.referencePrice) - 1) * 10_000;
          weights += x.weight;
        }
        if (complete) utilities.set(candidate.label, weights > 0 ? weighted / weights : 0);
      }
      if (utilities.size < 2) {
        if (now - row.due_ts < 24 * 60 * 60_000) {
          deferred++;
          continue;
        }
        this.db.raw.prepare("UPDATE decision_outcome_targets SET settled_ts = ? WHERE id = ? AND settled_ts IS NULL").run(now, row.id);
        targets++;
        continue;
      }

      const evaluations = this.db.raw
        .prepare("SELECT experiment_id, arm, policy_version_id, answers_json FROM decision_evaluations WHERE decision_id = ? ORDER BY id")
        .all(row.decision_id) as unknown as EvaluationRow[];
      const best = Math.max(...utilities.values());
      const bestLabels = [...utilities].filter(([, value]) => Math.abs(value - best) < 1e-9).map(([label]) => label);
      this.db.raw.exec("BEGIN IMMEDIATE");
      try {
        for (const evaluation of evaluations) {
          const action = actionAnswer(evaluation.answers_json);
          if (!action) continue;
          const probabilities = normalise(action.probabilities, utilities);
          const chosen = utilities.get(action.choice);
          const metadata = {
            arm: evaluation.arm,
            bestLabels,
            bestMarkoutBps: best,
            choicesScored: utilities.size,
            dueTs: row.due_ts,
            settledTs: now,
            settlementLagMs: now - row.due_ts,
            utilityBps: Object.fromEntries(utilities),
          };
          if (chosen !== undefined) {
            outcomes += this.db.experiments.recordOutcome({
              experimentId: evaluation.experiment_id,
              decisionId: row.decision_id,
              policyVersionId: evaluation.policy_version_id,
              ts: now,
              horizon: row.horizon,
              metric: "chosen_markout_bps",
              value: chosen,
              metadata,
            }) > 0 ? 1 : 0;
            outcomes += this.db.experiments.recordOutcome({
              experimentId: evaluation.experiment_id,
              decisionId: row.decision_id,
              policyVersionId: evaluation.policy_version_id,
              ts: now,
              horizon: row.horizon,
              metric: "regret_bps",
              value: best - chosen,
              metadata,
            }) > 0 ? 1 : 0;
          }
          if (probabilities) {
            const target = 1 / bestLabels.length;
            let brier = 0;
            for (const label of utilities.keys()) {
              const expected = bestLabels.includes(label) ? target : 0;
              brier += ((probabilities[label] ?? 0) - expected) ** 2;
            }
            outcomes += this.db.experiments.recordOutcome({
              experimentId: evaluation.experiment_id,
              decisionId: row.decision_id,
              policyVersionId: evaluation.policy_version_id,
              ts: now,
              horizon: row.horizon,
              metric: "action_brier",
              value: brier,
              metadata,
            }) > 0 ? 1 : 0;
          }
        }
        this.db.raw.prepare("UPDATE decision_outcome_targets SET settled_ts = ? WHERE id = ? AND settled_ts IS NULL").run(now, row.id);
        this.db.raw.exec("COMMIT");
        targets++;
      } catch (err) {
        this.db.raw.exec("ROLLBACK");
        throw err;
      }
    }
    return { targets, outcomes, deferred };
  }
}

function actionAnswer(json: string | null): { choice: string; probabilities: Record<string, number> } | null {
  if (!json) return null;
  const parsed = JSON.parse(json) as { action?: { choice?: unknown; probabilities?: unknown } };
  if (typeof parsed.action?.choice !== "string" || !parsed.action.probabilities || typeof parsed.action.probabilities !== "object") return null;
  return { choice: parsed.action.choice, probabilities: parsed.action.probabilities as Record<string, number> };
}

function normalise(probabilities: Record<string, number>, choices: Map<string, number>): Record<string, number> | null {
  const valid = [...choices.keys()].map((label) => [label, probabilities[label] ?? 0] as const).filter(([, p]) => Number.isFinite(p) && p >= 0);
  const total = valid.reduce((sum, [, p]) => sum + p, 0);
  return total > 0 ? Object.fromEntries(valid.map(([label, p]) => [label, p / total])) : null;
}
