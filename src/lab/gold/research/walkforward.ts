// Walk-forward validation (section 40): TRAIN -> VALIDATE, rolled forward. Parameters are searched on the training
// window only (per strategy, coarse to fine), the winners are traded on the NEXT window they have never seen, and
// every window is reported, the losing ones included. A strategy whose search finds no stable positive region is not
// traded in the validation window: switching it off is the honest answer, not tuning until something shows.
import { runGold, type GoldData, type RunOpts } from "../sim.js";
import { TF_MS } from "../../resample.js";
import type { EngineConfig, GoldTrade, StrategyId, StrategyProfile } from "../types.js";
import { computeMetrics, runMetrics, type Metrics } from "./metrics.js";
import { coarseToFine, score, type SearchOpts } from "./optimizer.js";
import { applyChoice, type Choice } from "./params.js";

export interface WfOpts {
  trainMonths: number;
  validateMonths: number;
  stepMonths: number;
  /** Bars before a window that only warm indicators up (never traded). */
  warmupDays: number;
  search: Partial<SearchOpts>;
  minTrades: number;
  commit?: string;
}
export const DEFAULT_WF: WfOpts = { trainMonths: 36, validateMonths: 12, stepMonths: 12, warmupDays: 250, search: {}, minTrades: 30 };

export interface WfWindow {
  train: [number, number];
  validate: [number, number];
}

export function addMonths(ts: number, n: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
}

/** Rolling windows: train [s, s+T), validate [s+T, s+T+V), then s += step, while validation fits in the data. */
export function makeWindows(startTs: number, endTs: number, o: Pick<WfOpts, "trainMonths" | "validateMonths" | "stepMonths">): WfWindow[] {
  const out: WfWindow[] = [];
  for (let s = startTs; ; s = addMonths(s, o.stepMonths)) {
    const tE = addMonths(s, o.trainMonths);
    const vE = addMonths(tE, o.validateMonths);
    if (vE > endTs) break;
    out.push({ train: [s, tE], validate: [tE, vE] });
  }
  return out;
}

/** The bars in [from - warmup, to): the window plus what indicators need before it. Binary search: the series is sorted. */
export function sliceData(data: GoldData, from: number, to: number, warmupMs: number): GoldData {
  const b = data.base;
  const lb = (t: number) => {
    let lo = 0;
    let hi = b.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (b[m]!.ts < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return { base: b.slice(lb(from - warmupMs), lb(to)), baseTf: data.baseTf };
}

export interface WfWindowResult {
  index: number;
  train: [string, string];
  validate: [string, string];
  /** Chosen parameters per strategy; null = no stable positive region on the training window: not traded. */
  chosen: Record<string, Choice | null>;
  evaluations: number;
  trainMetrics: Metrics;
  validateMetrics: Metrics;
  validateTrades: GoldTrade[];
  positive: boolean;
}

export interface WfResult {
  windows: WfWindowResult[];
  oos: Metrics;
  positiveWindows: number;
  totalWindows: number;
  note: string;
}

export function walkForward(cfg: unknown, data: GoldData, profiles: StrategyProfile[], strategies: StrategyId[], o: Partial<WfOpts> = {}, engineOpts: Pick<RunOpts, "commit"> = {}): WfResult {
  const opts = { ...DEFAULT_WF, ...o };
  const initial = (cfg as Partial<EngineConfig>).account?.initial_balance ?? 10_000;
  const first = data.base[0]?.ts ?? 0;
  const last = (data.base[data.base.length - 1]?.ts ?? 0) + TF_MS[data.baseTf];
  const warm = opts.warmupDays * 86_400_000;
  const windows = makeWindows(first + warm, last, opts);
  const results: WfWindowResult[] = [];
  const allVal: GoldTrade[] = [];
  windows.forEach((w, index) => {
    const [tS, tE] = w.train;
    const [, vE] = w.validate;
    const trainData = sliceData(data, tS, tE, warm);
    const chosen: Record<string, Choice | null> = {};
    let evaluations = 0;
    for (const id of strategies) {
      const base = profiles.find((p) => p.id === id)!;
      const res = coarseToFine(
        (choice) => {
          const run = runGold(cfg, trainData, { profiles: [applyChoice(base, choice)], strategies: [id], from: tS, to: tE, ...engineOpts });
          const m = runMetrics(run).portfolio;
          return { score: score(m, opts.minTrades), trades: m.trades };
        },
        { minTrades: opts.minTrades, ...opts.search },
      );
      evaluations += res.evaluations;
      chosen[id] = res.best && res.best.score > 0 ? res.best.choice : null;
    }
    const picked = strategies.filter((id) => chosen[id] !== null);
    const tuned = picked.map((id) => applyChoice(profiles.find((p) => p.id === id)!, chosen[id]!));
    // What the chosen set did on the window it was tuned on (in-sample: for the record only) ...
    const trainRun = runGold(cfg, trainData, { profiles: tuned, strategies: picked, from: tS, to: tE, ...engineOpts });
    const trainMetrics = runMetrics(trainRun).portfolio;
    // ... and on the next window, which it has never seen. Only the past feeds the drawdown-aware weights.
    const valData = sliceData(data, tE, vE, warm);
    const valRun = runGold(cfg, valData, { profiles: tuned, strategies: picked, from: tE, to: vE, priorTrades: trainRun.trades, ...engineOpts });
    const validateMetrics = runMetrics(valRun).portfolio;
    allVal.push(...valRun.trades);
    results.push({
      index: index + 1,
      train: [new Date(tS).toISOString().slice(0, 10), new Date(tE).toISOString().slice(0, 10)],
      validate: [new Date(tE).toISOString().slice(0, 10), new Date(vE).toISOString().slice(0, 10)],
      chosen,
      evaluations,
      trainMetrics,
      validateMetrics,
      validateTrades: valRun.trades,
      positive: validateMetrics.netProfit > 0,
    });
  });
  const vStart = windows[0]?.validate[0] ?? first;
  const vEnd = windows[windows.length - 1]?.validate[1] ?? last;
  return {
    windows: results,
    oos: computeMetrics(allVal, initial, vStart, vEnd),
    positiveWindows: results.filter((r) => r.positive).length,
    totalWindows: results.length,
    note: "Every window is listed, profitable or not. The out-of-sample figures are the validation windows only.",
  };
}
