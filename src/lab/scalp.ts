// The scalper's lab (phase 1): does a short-horizon rule survive its own costs?
//
// A scalp aims at a few basis points, and a round trip costs about as much: the taker fee alone is 10 bp in and out.
// So this simulator is built around costs, not signals. It models
//   - maker entries as a resting limit that fills only when price trades THROUGH it (a queue-position haircut, so the
//     fill rate and the adverse selection are visible instead of assumed away),
//   - target exits as maker limits, stops and time exits as taker market orders with slippage and half a spread,
//   - a cost gate: a trade is skipped when its target is under `costGateMult` x its own round-trip cost.
// Bars are ordered pessimistically: inside one bar the stop is checked before the target, and a maker entry never
// takes its target on its own fill bar.
//
// Rules are the same code the live scalp brain runs (bees/scalp.ts), so a lab verdict describes what would trade.
// Everything here is paper: public history in, numbers out. No exchange account, no orders.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle } from "../market/types.js";
import { dataHash } from "./hash.js";
import * as S from "./series.js";
import type { Params } from "./skills/types.js";

export interface CostModel {
  /** Per side, as a fraction of notional (0.0002 = 2 bp). Check your own OKX fee tier. */
  makerFee: number;
  takerFee: number;
  /** Adverse slippage on taker fills, in basis points. */
  slippageBps: number;
  /** Half the bid-ask spread in basis points, paid on taker fills (makers do not pay it). */
  halfSpreadBps: number;
  /** A resting limit fills only when price trades through it by this many bp. */
  throughBps: number;
}
export const DEFAULT_COSTS: CostModel = { makerFee: 0.0002, takerFee: 0.0005, slippageBps: 1, halfSpreadBps: 0.5, throughBps: 0.5 };

export interface ScalpRule {
  id: string;
  name: string;
  description: string;
  defaults: Params;
  /** Values tried per key; missing keys keep their default. */
  grid: Record<string, number[]>;
  /** Entry desire at the CLOSE of bar i: +1 long, -1 short, 0 none. Causal: uses bars 0..i only. */
  signal(c: Candle[], p: Params): Int8Array;
  valid?(p: Params): boolean;
}

/** The trade-management half of a parameter set (the signal half is the rule's own). */
export interface TradeParams {
  /** Target and stop, in ATR(14) multiples of the entry bar. */
  targetAtr: number;
  stopAtr: number;
  /** Time stop: bars after the fill. */
  holdBars: number;
  /** Bars a resting entry waits for its fill. */
  waitBars: number;
  /** 1 = entry as a maker limit at the close (minus `entryOffsetBps`), 0 = taker at the next open. */
  makerEntry: number;
  /** 1 = target is a resting maker limit, 0 = taker when touched. */
  makerTarget: number;
  entryOffsetBps: number;
  /** Skip trades whose target is under this multiple of the round-trip cost (0 = no gate). */
  costGateMult: number;
  /** ATR(14) as bp of price must sit in this band (dead and wild markets are skipped). */
  minAtrBps: number;
  maxAtrBps: number;
  cooldownBars: number;
}
export const TRADE_DEFAULTS: TradeParams = { targetAtr: 1.2, stopAtr: 1.2, holdBars: 15, waitBars: 2, makerEntry: 1, makerTarget: 1, entryOffsetBps: 0, costGateMult: 3, minAtrBps: 0, maxAtrBps: 1e9, cooldownBars: 0 };

export const tradeParams = (p: Params): TradeParams => {
  const out = { ...TRADE_DEFAULTS };
  for (const k of Object.keys(TRADE_DEFAULTS) as Array<keyof TradeParams>) if (p[k] !== undefined) out[k] = p[k]!;
  return out;
};

/** Estimated round-trip cost in bp of notional for a given execution style (fees + taker slippage and spread). */
export function roundTripCostBps(c: CostModel, makerEntry: boolean, makerTarget: boolean): number {
  const taker = (c.takerFee * 1e4) + c.slippageBps + c.halfSpreadBps;
  const maker = c.makerFee * 1e4;
  // A stop is always taker, but most exits are targets or time exits; budget one taker leg unless both legs are takers.
  return (makerEntry ? maker : taker) + (makerTarget ? maker : taker);
}

/** The cost gate the live scalper applies too: is the target worth its own round trip? */
export function passesCostGate(targetBps: number, costs: CostModel, tp: Pick<TradeParams, "makerEntry" | "makerTarget" | "costGateMult">): boolean {
  return tp.costGateMult <= 0 || targetBps >= tp.costGateMult * roundTripCostBps(costs, tp.makerEntry > 0, tp.makerTarget > 0);
}

export interface ScalpTrade {
  side: 1 | -1;
  signalBar: number;
  entryTs: number;
  exitTs: number;
  entryPx: number;
  exitPx: number;
  /** Price move net of slippage and spread, before fees. */
  grossBps: number;
  feeBps: number;
  netBps: number;
  bars: number;
  reason: "target" | "stop" | "time" | "end";
  makerEntry: boolean;
  makerExit: boolean;
}

export interface ScalpSim {
  trades: ScalpTrade[];
  signals: number;
  /** Signals turned away by the cost gate or the ATR band. */
  gated: number;
  /** Resting entries that never got their fill. */
  missed: number;
}

/** Run the entry desires `sig` over bars [from, to): one position at a time, no leverage effects (results are in bp). */
export function simulateScalp(c: Candle[], sig: Int8Array, tp: TradeParams, costs: CostModel = DEFAULT_COSTS, from = 15, to = c.length): ScalpSim {
  const atr = S.atr(c, 14);
  const slip = (costs.slippageBps + costs.halfSpreadBps) / 1e4;
  const through = costs.throughBps / 1e4;
  const trades: ScalpTrade[] = [];
  let signals = 0;
  let gated = 0;
  let missed = 0;
  const last = Math.min(to, c.length) - 1;
  let i = Math.max(from, 15);
  while (i < last) {
    const d = sig[i] as 0 | 1 | -1;
    if (d === 0) {
      i++;
      continue;
    }
    signals++;
    const a = atr[i]!;
    const px = c[i]!.c;
    const atrBps = Number.isFinite(a) && px > 0 ? (a / px) * 1e4 : NaN;
    if (!(atrBps >= tp.minAtrBps && atrBps <= tp.maxAtrBps) || !passesCostGate(tp.targetAtr * atrBps, costs, tp)) {
      gated++;
      i++;
      continue;
    }

    // ---- entry ----
    let fillIdx = -1;
    let fillPx = NaN;
    const makerEntry = tp.makerEntry > 0;
    if (makerEntry) {
      const limit = px * (1 - d * (tp.entryOffsetBps / 1e4));
      for (let j = i + 1; j <= Math.min(last, i + Math.max(1, tp.waitBars)); j++) {
        const b = c[j]!;
        const hit = d === 1 ? b.l <= limit * (1 - through) : b.h >= limit * (1 + through);
        if (hit) {
          fillIdx = j;
          fillPx = limit;
          break;
        }
      }
      if (fillIdx < 0) {
        missed++;
        i++;
        continue;
      }
    } else {
      fillIdx = i + 1;
      fillPx = c[fillIdx]!.o * (1 + d * slip);
    }

    // ---- management ----
    const dist = (tp.targetAtr * atrBps) / 1e4;
    const stopDist = (tp.stopAtr * atrBps) / 1e4;
    const target = fillPx * (1 + d * dist);
    const stop = fillPx * (1 - d * stopDist);
    const makerTarget = tp.makerTarget > 0;
    const lastBar = Math.min(last, fillIdx + Math.max(1, tp.holdBars));
    let exitIdx = lastBar;
    let exitPx = NaN;
    let reason: ScalpTrade["reason"] = lastBar === last && lastBar < fillIdx + tp.holdBars ? "end" : "time";
    let makerExit = false;
    for (let k = fillIdx; k <= lastBar; k++) {
      const b = c[k]!;
      // Stop first (worst case). A gap through the stop fills at the open.
      const stopHit = d === 1 ? b.l <= stop : b.h >= stop;
      if (stopHit) {
        const raw = d === 1 ? Math.min(b.o, stop) : Math.max(b.o, stop);
        exitPx = raw * (1 - d * slip);
        exitIdx = k;
        reason = "stop";
        break;
      }
      // A maker entry gives no view of what came first inside its own bar: no target on the fill bar.
      const canTarget = !(makerEntry && k === fillIdx);
      if (canTarget) {
        if (makerTarget) {
          const hit = d === 1 ? b.h >= target * (1 + through) : b.l <= target * (1 - through);
          if (hit) {
            exitPx = target;
            exitIdx = k;
            reason = "target";
            makerExit = true;
            break;
          }
        } else if (d === 1 ? b.h >= target : b.l <= target) {
          exitPx = target * (1 - d * slip);
          exitIdx = k;
          reason = "target";
          break;
        }
      }
    }
    if (!Number.isFinite(exitPx)) {
      exitIdx = lastBar;
      exitPx = c[exitIdx]!.c * (1 - d * slip);
    }
    const grossBps = ((d * (exitPx - fillPx)) / fillPx) * 1e4;
    const feeBps = ((makerEntry ? costs.makerFee : costs.takerFee) + (makerExit ? costs.makerFee : costs.takerFee)) * 1e4;
    trades.push({
      side: d,
      signalBar: i,
      entryTs: c[fillIdx]!.ts,
      exitTs: c[exitIdx]!.ts,
      entryPx: fillPx,
      exitPx,
      grossBps,
      feeBps,
      netBps: grossBps - feeBps,
      bars: exitIdx - fillIdx,
      reason,
      makerEntry,
      makerExit,
    });
    i = Math.max(exitIdx, i) + 1 + Math.max(0, tp.cooldownBars);
  }
  return { trades, signals, gated, missed };
}

// ---------- statistics ----------

export interface ScalpStats {
  trades: number;
  signals: number;
  gated: number;
  missed: number;
  /** Filled entries as % of the signals that passed the gate. */
  fillRatePct: number;
  winRatePct: number;
  avgWinBps: number;
  avgLossBps: number;
  /** Mean price move per trade after slippage and spread, before fees. This is the most the fees can be. */
  grossExpectancyBps: number;
  feesBpsPerTrade: number;
  netExpectancyBps: number;
  profitFactor: number;
  netTotalBps: number;
  maxDrawdownBps: number;
  tradesPerDay: number;
  exits: Record<ScalpTrade["reason"], number>;
}

export function scalpStats(s: ScalpSim, spanDays: number): ScalpStats {
  const t = s.trades;
  const n = t.length;
  const sum = (f: (x: ScalpTrade) => number) => t.reduce((a, x) => a + f(x), 0);
  const wins = t.filter((x) => x.netBps > 0);
  const losses = t.filter((x) => x.netBps <= 0);
  const gw = wins.reduce((a, x) => a + x.netBps, 0);
  const gl = -losses.reduce((a, x) => a + x.netBps, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const x of t) {
    eq += x.netBps;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const exits = { target: 0, stop: 0, time: 0, end: 0 };
  for (const x of t) exits[x.reason]++;
  const tried = s.signals - s.gated;
  return {
    trades: n,
    signals: s.signals,
    gated: s.gated,
    missed: s.missed,
    fillRatePct: tried > 0 ? (n / tried) * 100 : 0,
    winRatePct: n ? (wins.length / n) * 100 : 0,
    avgWinBps: wins.length ? gw / wins.length : 0,
    avgLossBps: losses.length ? -gl / losses.length : 0,
    grossExpectancyBps: n ? sum((x) => x.grossBps) / n : 0,
    feesBpsPerTrade: n ? sum((x) => x.feeBps) / n : 0,
    netExpectancyBps: n ? sum((x) => x.netBps) / n : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0,
    netTotalBps: sum((x) => x.netBps),
    maxDrawdownBps: dd,
    tradesPerDay: spanDays > 0 ? n / spanDays : 0,
    exits,
  };
}

// ---------- rules ----------

const closesOf = (c: Candle[]) => Float64Array.from(c, (x) => x.c);

/** Close breaks the prior N-bar channel with volume behind it, in the direction of the 100-bar EMA (if `trend`). */
export const microBreakout: ScalpRule = {
  id: "micro_breakout",
  name: "Micro breakout",
  description: "A 1-minute close beyond the prior N-bar range, on above-average volume: ride the continuation for a fraction of an ATR.",
  defaults: { n: 20, volMult: 1.2, trend: 1, targetAtr: 1.2, stopAtr: 1.2, holdBars: 15, makerEntry: 1 },
  grid: { n: [15, 30, 60], volMult: [0, 1.5], targetAtr: [1, 1.6], stopAtr: [1, 1.6], holdBars: [10, 25], makerEntry: [1, 0] },
  signal(c, p) {
    const n = Math.max(3, Math.round(p.n ?? 20));
    const hh = S.priorHigh(c, n);
    const ll = S.priorLow(c, n);
    const vol = Float64Array.from(c, (x) => x.volUsd);
    const vAvg = S.sma(vol, 20);
    const trendEma = p.trend ? S.ema(closesOf(c), 100) : null;
    const out = new Int8Array(c.length);
    for (let i = Math.max(n, 20); i < c.length; i++) {
      const x = c[i]!;
      if (p.volMult && !(x.volUsd >= p.volMult * vAvg[i]!)) continue;
      const te = trendEma?.[i];
      if (x.c > hh[i]! && (!trendEma || (te !== undefined && Number.isFinite(te) && x.c > te))) out[i] = 1;
      else if (x.c < ll[i]! && (!trendEma || (te !== undefined && Number.isFinite(te) && x.c < te))) out[i] = -1;
    }
    return out;
  },
};

/** Price stretched N-sigma from its mean with RSI at an extreme: fade it back toward the mean. */
export const stretchRevert: ScalpRule = {
  id: "stretch_revert",
  name: "Stretch and revert",
  description: "A 1-minute close far from its rolling mean with RSI(7) at an extreme: fade the stretch for a fraction of an ATR.",
  defaults: { n: 30, zEntry: 2.5, rsiLow: 25, targetAtr: 1, stopAtr: 1.6, holdBars: 12, makerEntry: 1 },
  grid: { n: [20, 40], zEntry: [2, 2.5, 3], rsiLow: [20, 30], targetAtr: [0.8, 1.2], stopAtr: [1.5, 2.2], holdBars: [10, 20], makerEntry: [1, 0] },
  signal(c, p) {
    const n = Math.max(5, Math.round(p.n ?? 30));
    const z = S.zscore(closesOf(c), n);
    const r = S.rsi(closesOf(c), 7);
    const out = new Int8Array(c.length);
    for (let i = n; i < c.length; i++) {
      const zi = z[i]!;
      const ri = r[i]!;
      if (!Number.isFinite(zi) || !Number.isFinite(ri)) continue;
      if (zi <= -p.zEntry! && ri <= p.rsiLow!) out[i] = 1;
      else if (zi >= p.zEntry! && ri >= 100 - p.rsiLow!) out[i] = -1;
    }
    return out;
  },
};

export const SCALP_RULES: ScalpRule[] = [microBreakout, stretchRevert];
/** Rules written as data (lab/scalpDsl.ts) that the coin book (lab/coinBook.ts) keeps; the live scalper finds them here. */
const written = new Map<string, ScalpRule>();
export function registerScalpRules(rules: ScalpRule[]): void {
  written.clear();
  for (const r of rules) if (!SCALP_RULES.some((b) => b.id === r.id)) written.set(r.id, r);
}
export const scalpRule = (id: string): ScalpRule | undefined => SCALP_RULES.find((r) => r.id === id) ?? written.get(id);

/** Every combination of a rule's grid (defaults fill the rest), sampled evenly down to `max`. */
export function expandScalpGrid(rule: ScalpRule, max = 96): Params[] {
  let combos: Params[] = [{ ...rule.defaults }];
  for (const k of Object.keys(rule.grid)) {
    const next: Params[] = [];
    for (const base of combos) for (const v of rule.grid[k]!) next.push({ ...base, [k]: v });
    combos = next;
  }
  combos = combos.filter((p) => rule.valid?.(p) ?? true);
  if (combos.length <= max) return combos;
  const step = combos.length / max;
  return Array.from({ length: max }, (_, i) => combos[Math.floor(i * step)]!);
}

// ---------- walk-forward evaluation ----------

export interface ScalpEvalOpts {
  costs: CostModel;
  folds: number;
  /** Fewest trades a training window needs before its best parameters count. */
  minTrainTrades: number;
  /** Verdict thresholds on the out-of-sample trades. */
  minTrades: number;
  minNetBps: number;
  minPositiveFoldsPct: number;
  /** Share of the grid that must be net positive on all data (a plateau, not a lone peak). */
  minPlateauPct: number;
  maxCombos: number;
}
export const DEFAULT_EVAL: ScalpEvalOpts = { costs: DEFAULT_COSTS, folds: 4, minTrainTrades: 30, minTrades: 80, minNetBps: 0.5, minPositiveFoldsPct: 60, minPlateauPct: 25, maxCombos: 96 };

export interface FoldResult {
  fold: number;
  params: Params;
  train: ScalpStats;
  test: ScalpStats;
}

export interface RuleResult {
  ruleId: string;
  dataset: string;
  bars: number;
  spanDays: number;
  oos: ScalpStats;
  folds: FoldResult[];
  positiveFolds: number;
  /** % of grid combos with a positive net expectancy over all the data (and enough trades). */
  plateauPct: number;
  /** Best parameters on all the data (for the record: the verdict rests on the walk-forward, not on this). */
  bestAll: { params: Params; stats: ScalpStats } | null;
  /** Same OOS run with every fee and cost at zero: is there any gross edge at all? */
  oosGrossBps: number;
  edge: boolean;
  why: string;
}

const spanDaysOf = (c: Candle[], a: number, b: number) => Math.max(0, ((c[Math.min(b, c.length) - 1]?.ts ?? 0) - (c[a]?.ts ?? 0)) / 86_400_000);
const trainScore = (s: ScalpStats) => s.netExpectancyBps * Math.sqrt(Math.max(0, s.trades));

export function evaluateScalpRule(rule: ScalpRule, c: Candle[], dataset: string, o: Partial<ScalpEvalOpts> = {}): RuleResult {
  const opts = { ...DEFAULT_EVAL, ...o };
  const n = c.length;
  const warm = 120;
  const combos = expandScalpGrid(rule, opts.maxCombos);
  // Signals depend on the rule's own parameters only: compute once per distinct signal set.
  const sigCache = new Map<string, Int8Array>();
  const sigKey = (p: Params) => JSON.stringify(Object.keys(rule.defaults).filter((k) => !(k in TRADE_DEFAULTS)).sort().map((k) => [k, p[k]]));
  const sigOf = (p: Params) => {
    const k = sigKey(p);
    let s = sigCache.get(k);
    if (!s) sigCache.set(k, (s = rule.signal(c, p)));
    return s;
  };
  const run = (p: Params, a: number, b: number, costs = opts.costs) => {
    const sim = simulateScalp(c, sigOf(p), tradeParams(p), costs, a, b);
    return { sim, stats: scalpStats(sim, spanDaysOf(c, a, b)) };
  };

  const result: RuleResult = { ruleId: rule.id, dataset, bars: n, spanDays: spanDaysOf(c, 0, n), oos: scalpStats({ trades: [], signals: 0, gated: 0, missed: 0 }, 0), folds: [], positiveFolds: 0, plateauPct: 0, bestAll: null, oosGrossBps: 0, edge: false, why: "" };
  if (n < warm + 400) {
    result.why = `only ${n} bars: too little history to test`;
    return result;
  }

  // Plateau: how much of the grid is net positive on everything (looked at, never selected on, for the verdict).
  let positive = 0;
  let counted = 0;
  for (const p of combos) {
    const { stats } = run(p, warm, n);
    if (stats.trades >= opts.minTrainTrades) {
      counted++;
      if (stats.netExpectancyBps > 0) positive++;
      if (!result.bestAll || trainScore(stats) > trainScore(result.bestAll.stats)) result.bestAll = { params: p, stats };
    }
  }
  result.plateauPct = counted ? (positive / counted) * 100 : 0;

  // Expanding-window walk-forward: pick on the past, judge on the next chunk.
  const chunk = Math.floor((n - warm) / (opts.folds + 1));
  const oosTrades: ScalpTrade[] = [];
  const grossTrades: ScalpTrade[] = [];
  let sigs = 0;
  let gated = 0;
  let missed = 0;
  const free: CostModel = { makerFee: 0, takerFee: 0, slippageBps: 0, halfSpreadBps: 0, throughBps: opts.costs.throughBps };
  for (let f = 0; f < opts.folds; f++) {
    const trainEnd = warm + chunk * (f + 1);
    const testEnd = f === opts.folds - 1 ? n : trainEnd + chunk;
    let best: { p: Params; s: ScalpStats } | null = null;
    for (const p of combos) {
      const { stats } = run(p, warm, trainEnd);
      if (stats.trades >= opts.minTrainTrades && (!best || trainScore(stats) > trainScore(best.s))) best = { p, s: stats };
    }
    if (!best) continue;
    const test = run(best.p, trainEnd, testEnd);
    oosTrades.push(...test.sim.trades);
    grossTrades.push(...run(best.p, trainEnd, testEnd, free).sim.trades);
    sigs += test.sim.signals;
    gated += test.sim.gated;
    missed += test.sim.missed;
    result.folds.push({ fold: f + 1, params: best.p, train: best.s, test: test.stats });
    if (test.stats.trades >= 5 && test.stats.netExpectancyBps > 0) result.positiveFolds++;
  }
  const oosDays = result.folds.reduce((a, f, i) => a + spanDaysOf(c, warm + chunk * (i + 1), i === opts.folds - 1 ? n : warm + chunk * (i + 2)), 0);
  result.oos = scalpStats({ trades: oosTrades, signals: sigs, gated, missed }, oosDays);
  result.oosGrossBps = grossTrades.length ? grossTrades.reduce((a, t) => a + t.grossBps, 0) / grossTrades.length : 0;

  const fp = result.folds.length ? (result.positiveFolds / result.folds.length) * 100 : 0;
  const fails: string[] = [];
  if (result.oos.trades < opts.minTrades) fails.push(`only ${result.oos.trades} out-of-sample trades (need ${opts.minTrades})`);
  if (result.oos.netExpectancyBps < opts.minNetBps) fails.push(`net expectancy ${result.oos.netExpectancyBps.toFixed(2)} bp/trade after costs (need ${opts.minNetBps})`);
  if (fp < opts.minPositiveFoldsPct) fails.push(`${result.positiveFolds}/${result.folds.length} folds profitable (need ${opts.minPositiveFoldsPct}%)`);
  if (result.plateauPct < opts.minPlateauPct) fails.push(`only ${result.plateauPct.toFixed(0)}% of the grid is net positive (need ${opts.minPlateauPct}%): an isolated peak`);
  result.edge = fails.length === 0;
  result.why = result.edge
    ? `net ${result.oos.netExpectancyBps.toFixed(2)} bp/trade over ${result.oos.trades} out-of-sample trades, ${result.positiveFolds}/${result.folds.length} folds profitable, ${result.plateauPct.toFixed(0)}% of the grid positive`
    : fails.join("; ");
  return result;
}

// ---------- the report the live scalper is gated on ----------

export interface ScalpReport {
  createdAt: number;
  costs: CostModel;
  opts: ScalpEvalOpts;
  /** "synthetic" data can exercise the lab but never opens the gate. */
  source: "real" | "synthetic";
  datasets: Array<{ id: string; bars: number; days: number; hash: string }>;
  results: RuleResult[];
  /** Instruments (dataset ids) with at least one rule that passed, and the best of those rules per instrument. */
  verdict: { edge: boolean; passing: Array<{ dataset: string; ruleId: string; params: Params; netBps: number; trades: number }>; note: string };
}

/** `rules` may differ per dataset: the coin book plans which rules each coin is tested with. */
export function buildScalpReport(sets: Array<{ id: string; candles: Candle[]; synthetic?: boolean }>, rules: ScalpRule[] | ((datasetId: string) => ScalpRule[]) = SCALP_RULES, o: Partial<ScalpEvalOpts> = {}, now = Date.now()): ScalpReport {
  const opts = { ...DEFAULT_EVAL, ...o };
  const results: RuleResult[] = [];
  for (const d of sets) for (const r of typeof rules === "function" ? rules(d.id) : rules) results.push(evaluateScalpRule(r, d.candles, d.id, opts));
  const synthetic = sets.length > 0 && sets.every((d) => d.synthetic);
  const passing = results
    .filter((r) => r.edge && r.oos.trades > 0)
    .map((r) => ({ dataset: r.dataset, ruleId: r.ruleId, params: r.folds[r.folds.length - 1]?.params ?? r.bestAll?.params ?? {}, netBps: r.oos.netExpectancyBps, trades: r.oos.trades }))
    .sort((a, b) => b.netBps - a.netBps);
  const edge = passing.length > 0 && !synthetic;
  return {
    createdAt: now,
    costs: opts.costs,
    opts,
    source: synthetic ? "synthetic" : "real",
    datasets: sets.map((d) => ({ id: d.id, bars: d.candles.length, days: spanDaysOf(d.candles, 0, d.candles.length), hash: dataHash(d.candles) })),
    results,
    verdict: {
      edge,
      passing: synthetic ? [] : passing,
      note: synthetic
        ? "Synthetic data only: it can exercise the lab but proves nothing about a market, so the gate stays closed."
        : edge
          ? "At least one rule kept a positive expectancy after costs, out of sample. The gate for the live scalper is open for those instruments; demo trading must confirm it (paper fills for limit orders are optimistic)."
          : "No rule kept a positive expectancy after costs out of sample. The scalper stays off: fees and spread eat the edge at this horizon.",
    },
  };
}

export function scalpReportMarkdown(r: ScalpReport): string {
  const f = (x: number, d = 2) => x.toFixed(d);
  const lines = [
    `# Scalper lab report`,
    ``,
    `Run ${new Date(r.createdAt).toISOString()}. Data: ${r.source}. Datasets: ${r.datasets.map((d) => `${d.id} (${d.bars} bars, ${f(d.days, 1)} days, ${d.hash})`).join(", ")}.`,
    `Costs: maker ${r.costs.makerFee * 1e4} bp, taker ${r.costs.takerFee * 1e4} bp per side, slippage ${r.costs.slippageBps} bp and half spread ${r.costs.halfSpreadBps} bp on taker fills, limits fill only when price trades ${r.costs.throughBps} bp through them.`,
    `Walk-forward: ${r.opts.folds} expanding folds; parameters are picked on the past and judged on the next chunk.`,
    ``,
    `**Verdict: ${r.verdict.edge ? "EDGE FOUND" : "NO EDGE"}.** ${r.verdict.note}`,
    ``,
    `| dataset | rule | OOS trades | fill % | win % | gross bp | fees bp | net bp | PF | max DD bp | folds + | plateau | edge |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...r.results.map(
      (x) =>
        `| ${x.dataset} | ${x.ruleId} | ${x.oos.trades} | ${f(x.oos.fillRatePct, 0)} | ${f(x.oos.winRatePct, 0)} | ${f(x.oos.grossExpectancyBps)} | ${f(x.oos.feesBpsPerTrade)} | ${f(x.oos.netExpectancyBps)} | ${f(x.oos.profitFactor)} | ${f(x.oos.maxDrawdownBps, 0)} | ${x.positiveFolds}/${x.folds.length} | ${f(x.plateauPct, 0)}% | ${x.edge ? "yes" : "no"} |`,
    ),
    ``,
    `Why, per run:`,
    ...r.results.map((x) => `- ${x.dataset} / ${x.ruleId}: ${x.why}`),
    ``,
    `Paper simulation on past data. Past results do not predict future ones. Not financial advice.`,
  ];
  return lines.join("\n") + "\n";
}

// ---------- the gate: the live scalper only runs on what the lab found ----------

export const scalpReportPath = (labDir: string) => join(labDir, "scalp-report.json");

export function saveScalpReport(labDir: string, r: ScalpReport): string {
  mkdirSync(labDir, { recursive: true });
  writeFileSync(scalpReportPath(labDir), JSON.stringify(r));
  writeFileSync(join(labDir, "scalp-report.md"), scalpReportMarkdown(r));
  return scalpReportPath(labDir);
}

export function loadScalpReport(labDir: string): ScalpReport | null {
  try {
    return existsSync(scalpReportPath(labDir)) ? (JSON.parse(readFileSync(scalpReportPath(labDir), "utf8")) as ScalpReport) : null;
  } catch {
    return null;
  }
}

export interface ScalpGate {
  open: boolean;
  reason: string;
  /** Per coin: the rule and parameters that passed, best first. Empty while the gate is closed. */
  rules: Array<{ coin: string; ruleId: string; params: Params; netBps: number; trades: number }>;
  costs: CostModel | null;
  ageDays: number | null;
}

/** "BTC-USDT-SWAP 1m" -> "BTC" */
export const coinOfSet = (id: string) => id.split(/[-\s]/)[0]!.toUpperCase();

/**
 * Whether the lab's latest report lets the live scalper trade: real data (never synthetic), an edge found, and fresh
 * (a market changes; the evidence expires after `maxAgeDays`).
 */
export function scalpGate(report: ScalpReport | null, now = Date.now(), maxAgeDays = 14): ScalpGate {
  const closed = (reason: string, r: ScalpReport | null = report): ScalpGate => ({ open: false, reason, rules: [], costs: r?.costs ?? null, ageDays: r ? (now - r.createdAt) / 86_400_000 : null });
  if (!report) return closed("no scalper lab report yet: run `pnpm lab scalp` on real 1-minute history");
  const ageDays = (now - report.createdAt) / 86_400_000;
  if (report.source !== "real") return closed("the last lab report used synthetic data");
  if (!report.verdict.edge) return closed(`the lab found no edge after costs (${report.verdict.note})`);
  if (ageDays > maxAgeDays) return closed(`the lab report is ${ageDays.toFixed(0)} days old (max ${maxAgeDays}): rerun \`pnpm lab scalp\``);
  return {
    open: true,
    reason: `lab edge on ${[...new Set(report.verdict.passing.map((p) => coinOfSet(p.dataset)))].join(", ")}`,
    rules: report.verdict.passing.map((p) => ({ coin: coinOfSet(p.dataset), ruleId: p.ruleId, params: p.params, netBps: p.netBps, trades: p.trades })),
    costs: report.costs,
    ageDays,
  };
}
