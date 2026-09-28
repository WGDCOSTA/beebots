// Performance metrics for a gold run, portfolio-wide and per strategy (section 44), plus the breakout-quality features
// (section 45) and strategy attribution (section 46). No aggregate-only reporting: every number can be split by S1..S9.
import type { GoldRun, GoldTrade, StrategyId } from "../types.js";

export interface Metrics {
  trades: number;
  netProfit: number;
  netProfitPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  avgDrawdownPct: number;
  profitFactor: number;
  /** Mean P&L per trade, cash and in R. */
  expectancy: number;
  expectancyR: number;
  winRatePct: number;
  avgWin: number;
  avgLoss: number;
  payoff: number;
  sharpe: number;
  sortino: number;
  calmar: number;
  /** Sum of trade durations over the tested period, and the share of time with at least one position open. */
  exposurePct: number;
  timeInMarketPct: number;
  long: { trades: number; pnl: number; winRatePct: number };
  short: { trades: number; pnl: number; winRatePct: number };
  monthly: Record<string, number>;
  annual: Record<string, number>;
  maxLosingStreak: number;
  maxWinningStreak: number;
  /** Adverse and favourable excursion, in multiples of the initial risk. */
  maeR: { mean: number; median: number; p90: number };
  mfeR: { mean: number; median: number; p90: number };
  years: number;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const mean = (a: number[]) => (a.length ? sum(a) / a.length : 0);
const pct = (a: number[], q: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const stat = (a: number[]) => ({ mean: mean(a), median: pct(a, 0.5), p90: pct(a, 0.9) });

/** Longest run of wins (pnl > 0) and of losses (pnl < 0); a flat trade ends both. */
export function streaks(pnls: number[]): { win: number; loss: number } {
  let w = 0;
  let l = 0;
  let bw = 0;
  let bl = 0;
  for (const p of pnls) {
    if (p > 0) {
      w++;
      l = 0;
    } else if (p < 0) {
      l++;
      w = 0;
    } else w = l = 0;
    bw = Math.max(bw, w);
    bl = Math.max(bl, l);
  }
  return { win: bw, loss: bl };
}

/** Max and mean drawdown (%) of an equity series, peak-to-trough. */
export function drawdowns(eq: number[]): { max: number; avg: number } {
  let peak = -Infinity;
  let max = 0;
  let acc = 0;
  for (const e of eq) {
    peak = Math.max(peak, e);
    const dd = peak > 0 ? ((peak - e) / peak) * 100 : 0;
    max = Math.max(max, dd);
    acc += dd;
  }
  return { max, avg: eq.length ? acc / eq.length : 0 };
}

/** Union length of [start, end] intervals. */
function unionMs(iv: Array<[number, number]>): number {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = NaN;
  let curE = NaN;
  for (const [a, b] of s) {
    if (Number.isNaN(curS)) [curS, curE] = [a, b];
    else if (a <= curE) curE = Math.max(curE, b);
    else {
      total += curE - curS;
      [curS, curE] = [a, b];
    }
  }
  return Number.isNaN(curS) ? total : total + (curE - curS);
}

const ym = (ts: number) => new Date(ts).toISOString().slice(0, 7);
const yr = (ts: number) => new Date(ts).toISOString().slice(0, 4);

/** Group an equity series [ts, equity] by a key and return the % change of each group's last value over the previous. */
function periodReturns(eq: Array<[number, number]>, initial: number, key: (ts: number) => string): Record<string, number> {
  const last = new Map<string, number>();
  for (const [ts, e] of eq) last.set(key(ts), e);
  const out: Record<string, number> = {};
  let prev = initial;
  for (const [k, e] of last) {
    out[k] = prev > 0 ? (e / prev - 1) * 100 : 0;
    prev = e;
  }
  return out;
}

/**
 * Metrics for a set of trades over [startTs, endTs]. With `equity` (daily marks) the drawdown, Sharpe and returns use
 * it; without it (a single strategy's slice) a curve is built from that slice's closed trades.
 */
export function computeMetrics(trades: GoldTrade[], initial: number, startTs: number, endTs: number, equity?: Array<[number, number]>): Metrics {
  const pnls = trades.map((t) => t.pnl);
  const net = sum(pnls);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const gw = sum(wins.map((t) => t.pnl));
  const gl = -sum(losses.map((t) => t.pnl));
  const curve: Array<[number, number]> = equity?.length
    ? [[startTs, initial], ...equity]
    : (() => {
        let b = initial;
        return [[startTs, initial] as [number, number], ...[...trades].sort((a, b2) => a.exitTs - b2.exitTs).map((t) => [t.exitTs, (b += t.pnl)] as [number, number])];
      })();
  const eqVals = curve.map((c) => c[1]);
  const dd = drawdowns(eqVals);
  const spanMs = Math.max(1, endTs - startTs);
  const years = spanMs / (365.25 * 86_400_000);
  const end = eqVals[eqVals.length - 1] ?? initial;
  const cagr = years > 0 && end > 0 ? ((end / initial) ** (1 / years) - 1) * 100 : end <= 0 ? -100 : 0;
  // daily returns from the curve (one point per rollover), annualised by how many points a year it really has
  const rets: number[] = [];
  for (let i = 1; i < eqVals.length; i++) rets.push(eqVals[i - 1]! > 0 ? eqVals[i]! / eqVals[i - 1]! - 1 : 0);
  const perYear = years > 0 ? rets.length / years : 252;
  const m = mean(rets);
  const sd = Math.sqrt(sum(rets.map((r) => (r - m) ** 2)) / Math.max(1, rets.length - 1));
  const down = Math.sqrt(sum(rets.map((r) => Math.min(0, r) ** 2)) / Math.max(1, rets.length));
  const st = streaks(pnls);
  const longs = trades.filter((t) => t.side === "BUY");
  const shorts = trades.filter((t) => t.side === "SELL");
  const split = (a: GoldTrade[]) => ({ trades: a.length, pnl: sum(a.map((t) => t.pnl)), winRatePct: a.length ? (a.filter((t) => t.pnl > 0).length / a.length) * 100 : 0 });
  const mdd = dd.max;
  return {
    trades: trades.length,
    netProfit: net,
    netProfitPct: (net / initial) * 100,
    cagrPct: cagr,
    maxDrawdownPct: mdd,
    avgDrawdownPct: dd.avg,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    expectancy: mean(pnls),
    expectancyR: mean(trades.map((t) => t.r)),
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    avgWin: mean(wins.map((t) => t.pnl)),
    avgLoss: mean(losses.map((t) => t.pnl)),
    payoff: losses.length && wins.length ? mean(wins.map((t) => t.pnl)) / Math.abs(mean(losses.map((t) => t.pnl))) : 0,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(perYear) : 0,
    sortino: down > 0 ? (m / down) * Math.sqrt(perYear) : 0,
    calmar: mdd > 0 ? cagr / mdd : cagr > 0 ? Infinity : 0,
    exposurePct: (sum(trades.map((t) => t.exitTs - t.entryTs)) / spanMs) * 100,
    timeInMarketPct: (unionMs(trades.map((t) => [t.entryTs, t.exitTs])) / spanMs) * 100,
    long: split(longs),
    short: split(shorts),
    monthly: periodReturns(curve, initial, ym),
    annual: periodReturns(curve, initial, yr),
    maxLosingStreak: st.loss,
    maxWinningStreak: st.win,
    maeR: stat(trades.map((t) => t.quality.maeR)),
    mfeR: stat(trades.map((t) => t.quality.mfeR)),
    years,
  };
}

export interface RunMetrics {
  portfolio: Metrics;
  perStrategy: Record<string, Metrics>;
  /** Share of the portfolio's net profit each strategy produced (attribution). */
  attribution: Record<string, { pnl: number; sharePct: number; trades: number }>;
}

export function runMetrics(run: GoldRun): RunMetrics {
  const initial = run.cfg.account.initial_balance;
  const start = run.equity[0]?.[0] ?? run.trades[0]?.entryTs ?? 0;
  const end = run.equity[run.equity.length - 1]?.[0] ?? run.trades[run.trades.length - 1]?.exitTs ?? start + 1;
  const portfolio = computeMetrics(run.trades, initial, start, end, run.equity);
  const perStrategy: Record<string, Metrics> = {};
  const attribution: RunMetrics["attribution"] = {};
  const total = portfolio.netProfit;
  for (const p of run.profiles) {
    const ts = run.trades.filter((t) => t.strategy === p.id);
    perStrategy[p.id] = computeMetrics(ts, initial, start, end);
    const pnl = sum(ts.map((t) => t.pnl));
    attribution[p.id] = { pnl, sharePct: total !== 0 ? (pnl / Math.abs(total)) * 100 : 0, trades: ts.length };
  }
  return { portfolio, perStrategy, attribution };
}

/** Exit-reason mix (how trades end) and a few breakout-quality slices, for finding which breakouts carry edge. */
export function qualityBreakdown(trades: GoldTrade[]) {
  const reasons: Record<string, { n: number; pnl: number }> = {};
  for (const t of trades) {
    const r = (reasons[t.exitReason] ??= { n: 0, pnl: 0 });
    r.n++;
    r.pnl += t.pnl;
  }
  const bucket = (f: (t: GoldTrade) => number, edges: number[]) =>
    edges.slice(0, -1).map((lo, i) => {
      const hi = edges[i + 1]!;
      const ts = trades.filter((t) => f(t) >= lo && f(t) < hi);
      return { range: `${lo}..${hi === Infinity ? "+" : hi}`, n: ts.length, expectancyR: ts.length ? mean(ts.map((t) => t.r)) : 0 };
    });
  const byFake = ["off", "passed", "failed"].map((k) => {
    const ts = trades.filter((t) => t.quality.fakeBreakout === k);
    return { fakeBreakout: k, n: ts.length, expectancyR: ts.length ? mean(ts.map((t) => t.r)) : 0 };
  });
  return {
    exits: reasons,
    byLevelAge: bucket((t) => t.quality.levelAgeBars, [0, 10, 30, 60, Infinity]),
    byTouches: bucket((t) => t.quality.touches, [0, 1, 2, 4, Infinity]),
    byArmDistanceAtr: bucket((t) => (t.quality.atrAtEntry > 0 ? t.quality.armDistance / t.quality.atrAtEntry : 0), [0, 1, 2, 4, Infinity]),
    bySpreadAtr: bucket((t) => (t.quality.atrAtEntry > 0 ? t.quality.spreadAtEntry / t.quality.atrAtEntry : 0), [0, 0.02, 0.05, 0.1, Infinity]),
    byFake,
  };
}

export type { StrategyId };
