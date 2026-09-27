// Bar-by-bar simulator for a skill's position series on historical candles. Paper only: it models taker fees,
// slippage, leverage, an optional ATR stop and perpetual funding, and never touches an exchange.
import type { Candle } from "../market/types.js";
import * as S from "./series.js";

export interface SimOpts {
  /** Taker fee per side (0.0005 = 5 bp, the engine's default). */
  feeRate: number;
  /** Adverse slippage per fill, in basis points. */
  slippageBps: number;
  /** Notional = equity x leverage at entry. The engine caps real bees at 2x. */
  leverage: number;
  /** Code-side stop in ATR(14) multiples from the entry; 0 = none. */
  stopAtr: number;
  /** Funding per 8 h settlement in % of notional, paid by longs and received by shorts (0.01 = OKX's usual base rate). */
  fundingPer8hPct: number;
  startEquity: number;
}

export const DEFAULT_SIM: SimOpts = { feeRate: 0.0005, slippageBps: 2, leverage: 1, stopAtr: 0, fundingPer8hPct: 0.01, startEquity: 1000 };

export interface Trade {
  side: 1 | -1;
  entryTs: number;
  exitTs: number;
  entryPx: number;
  exitPx: number;
  pnlUsd: number;
  retPct: number;
  bars: number;
  reason: "signal" | "stop" | "end";
}

export interface SimResult {
  equity: Float64Array;
  trades: Trade[];
  feesUsd: number;
  fundingUsd: number;
  barsInMarket: number;
}

const FUNDING_MS = 8 * 3_600_000;

/**
 * Run `sig` over bars [from, to). The target at bar i-1's close is filled at bar i's open. Everything before `from` is
 * warm-up (indicators only); a position is never carried in from before `from`.
 */
export function simulate(c: Candle[], sig: Int8Array, opts: Partial<SimOpts> = {}, from = 1, to = c.length): SimResult {
  const o = { ...DEFAULT_SIM, ...opts };
  const a = o.stopAtr > 0 ? S.atr(c, 14) : null;
  const slip = o.slippageBps / 10_000;
  const start = Math.max(1, from);
  const equity = new Float64Array(Math.max(0, to - start));
  const trades: Trade[] = [];
  let cash = o.startEquity;
  // Plain number: the fill closures change it, which TypeScript narrowing cannot see.
  let side: number = 0;
  let qty = 0;
  let entryPx = 0;
  let entryTs = 0;
  let entryBar = 0;
  let entryCash = 0;
  let stopPx = NaN;
  let blocked: 0 | 1 | -1 = 0;
  let feesUsd = 0;
  let fundingUsd = 0;
  let barsInMarket = 0;

  const fill = (px: number, dir: 1 | -1) => px * (1 + dir * slip);
  const close = (i: number, rawPx: number, reason: Trade["reason"]) => {
    const px = fill(rawPx, side === 1 ? -1 : 1);
    const fee = qty * px * o.feeRate;
    const pnl = qty * (px - entryPx) * side;
    cash += pnl - fee;
    feesUsd += fee;
    trades.push({ side: side as 1 | -1, entryTs, exitTs: c[i]!.ts, entryPx, exitPx: px, pnlUsd: cash - entryCash, retPct: ((cash - entryCash) / entryCash) * 100, bars: i - entryBar, reason });
    side = 0;
    qty = 0;
    stopPx = NaN;
  };
  const open = (i: number, dir: 1 | -1) => {
    if (cash <= 0) return;
    const px = fill(c[i]!.o, dir);
    entryCash = cash;
    qty = (cash * o.leverage) / px;
    const fee = qty * px * o.feeRate;
    cash -= fee;
    feesUsd += fee;
    side = dir;
    entryPx = px;
    entryTs = c[i]!.ts;
    entryBar = i;
    const atrPrev = a?.[i - 1];
    stopPx = a && atrPrev !== undefined && Number.isFinite(atrPrev) ? px - dir * o.stopAtr * atrPrev : NaN;
  };

  for (let i = start; i < to; i++) {
    const bar = c[i]!;
    let want = sig[i - 1]! as 0 | 1 | -1;
    if (blocked !== 0 && want !== blocked) blocked = 0;
    if (want === blocked && blocked !== 0) want = 0;

    if (side !== want) {
      if (side !== 0) close(i, bar.o, "signal");
      if (want !== 0) open(i, want as 1 | -1);
    }

    if (side !== 0 && Number.isFinite(stopPx)) {
      const hit = side === 1 ? bar.l <= stopPx : bar.h >= stopPx;
      if (hit) {
        const px = side === 1 ? Math.min(bar.o, stopPx) : Math.max(bar.o, stopPx);
        blocked = side as 1 | -1;
        close(i, px, "stop");
      }
    }

    if (side !== 0) {
      barsInMarket++;
      const prevTs = c[i - 1]!.ts;
      if (Math.floor(bar.ts / FUNDING_MS) !== Math.floor(prevTs / FUNDING_MS)) {
        const f = qty * bar.c * (o.fundingPer8hPct / 100) * side;
        cash -= f;
        fundingUsd += f;
      }
    }
    const upl = side !== 0 ? qty * (bar.c - entryPx) * side : 0;
    equity[i - start] = Math.max(0, cash + upl);
    if (cash + upl <= 0) {
      if (side !== 0) close(i, bar.c, "stop");
      equity.fill(0, i - start);
      break;
    }
  }
  if (side !== 0 && to - 1 >= start) close(to - 1, c[to - 1]!.c, "end");
  if (equity.length) equity[equity.length - 1] = Math.max(0, cash);
  return { equity, trades, feesUsd, fundingUsd, barsInMarket };
}

export interface Metrics {
  totalReturnPct: number;
  cagrPct: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
  calmar: number;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  expectancyPct: number;
  avgBars: number;
  exposurePct: number;
  feesPct: number;
  /** Buy-and-hold over the same window, for context. */
  benchmarkPct: number;
  bars: number;
}

export function metrics(r: SimResult, c: Candle[], from: number, to: number, startEquity = DEFAULT_SIM.startEquity): Metrics {
  const eq = r.equity;
  const n = eq.length;
  const bpy = S.barsPerYear(c);
  const rets: number[] = [];
  let prev = startEquity;
  let peak = startEquity;
  let maxDd = 0;
  for (let i = 0; i < n; i++) {
    const e = eq[i]!;
    rets.push(prev > 0 ? e / prev - 1 : 0);
    prev = e;
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
  }
  const end = n ? eq[n - 1]! : startEquity;
  const mean = rets.reduce((x, y) => x + y, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const down = Math.sqrt(rets.reduce((x, y) => x + Math.min(0, y) ** 2, 0) / Math.max(1, rets.length));
  const years = n / bpy;
  const cagr = years > 0 && end > 0 ? (end / startEquity) ** (1 / years) - 1 : -1;
  const wins = r.trades.filter((t) => t.pnlUsd > 0);
  const grossWin = wins.reduce((x, t) => x + t.pnlUsd, 0);
  const grossLoss = -r.trades.filter((t) => t.pnlUsd <= 0).reduce((x, t) => x + t.pnlUsd, 0);
  const s = Math.max(1, from);
  const bh = to - 1 > s ? (c[to - 1]!.c / c[s]!.o - 1) * 100 : 0;
  return {
    totalReturnPct: (end / startEquity - 1) * 100,
    cagrPct: cagr * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(bpy) : 0,
    sortino: down > 0 ? (mean / down) * Math.sqrt(bpy) : 0,
    maxDrawdownPct: maxDd * 100,
    calmar: maxDd > 0 ? cagr / maxDd : cagr > 0 ? 10 : 0,
    trades: r.trades.length,
    winRatePct: r.trades.length ? (wins.length / r.trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 10 : 0,
    expectancyPct: r.trades.length ? r.trades.reduce((x, t) => x + t.retPct, 0) / r.trades.length : 0,
    avgBars: r.trades.length ? r.trades.reduce((x, t) => x + t.bars, 0) / r.trades.length : 0,
    exposurePct: n ? (r.barsInMarket / n) * 100 : 0,
    feesPct: (r.feesUsd / startEquity) * 100,
    benchmarkPct: bh,
    bars: n,
  };
}

/**
 * One number to rank by. Risk-adjusted return first (Sharpe), then drawdown-aware return (Calmar, capped), then
 * trade quality (profit factor, capped). Too few trades means the result is mostly luck, so it is scaled down.
 */
export function score(m: Metrics, minTrades = 8): number {
  if (m.bars === 0) return -99;
  const calmar = Math.max(-3, Math.min(3, m.calmar));
  const pf = Math.max(0, Math.min(3, m.profitFactor)) - 1;
  const raw = 0.55 * m.sharpe + 0.3 * calmar + 0.15 * pf;
  const confidence = Math.min(1, m.trades / minTrades);
  // A skill that barely trades gets no credit for "not losing".
  return raw >= 0 ? raw * confidence : raw;
}
