// Monte Carlo on a run's trades (section 42): reshuffle their order and perturb what a live account would perturb.
// Perturbations: trade order, spread (an extra cost), slippage on entry and exit, entry and exit price noise, missed
// trades, latency (an extra adverse fill on entry) and parameter noise (re-runs the engine with jittered profiles; slow,
// so it is separate). Every draw is seeded: same seed, same answer.
import { rng } from "../../history.js";
import { drawdowns } from "./metrics.js";
import type { ContractSpec, GoldTrade } from "../types.js";

export interface McOpts {
  runs: number;
  seed: number;
  initial: number;
  years: number;
  /** Extra spread per trade (price units): mean of an exponential draw. 0 = none. */
  extraSpread: number;
  /** Extra slippage (price units) on each of entry and exit: mean of an exponential draw. */
  slippage: number;
  /** Gaussian noise (price units, sigma) on entry and exit prices. */
  priceNoise: number;
  /** Probability that a trade is missed (a rejected order, an outage). */
  missProb: number;
  /** Latency: mean extra adverse move on entry (price units). */
  latency: number;
  /** Equity at or below this fraction of the start counts as ruin. */
  ruinFraction: number;
  contract: Pick<ContractSpec, "tick_size" | "tick_value">;
}
export const DEFAULT_MC: Omit<McOpts, "initial" | "years" | "contract"> = { runs: 1000, seed: 1, extraSpread: 0.1, slippage: 0.05, priceNoise: 0.05, missProb: 0.03, latency: 0.05, ruinFraction: 0.5 };

export interface McResult {
  runs: number;
  tradesPerRun: number;
  medianCagrPct: number;
  medianMaxDrawdownPct: number;
  p95MaxDrawdownPct: number;
  medianNetProfit: number;
  probabilityOfLossPct: number;
  probabilityOfRuinPct: number;
  worst: { netProfit: number; maxDrawdownPct: number; sequence: number[] };
  /** Percentiles of final equity. */
  finalEquity: { p5: number; p50: number; p95: number };
}

const quantile = (s: number[], q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : 0);

export function monteCarlo(trades: GoldTrade[], o: McOpts): McResult {
  if (!trades.length) {
    return { runs: 0, tradesPerRun: 0, medianCagrPct: 0, medianMaxDrawdownPct: 0, p95MaxDrawdownPct: 0, medianNetProfit: 0, probabilityOfLossPct: 0, probabilityOfRuinPct: 0, worst: { netProfit: 0, maxDrawdownPct: 0, sequence: [] }, finalEquity: { p5: o.initial, p50: o.initial, p95: o.initial } };
  }
  const r = rng(o.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const expo = (mean: number) => (mean > 0 ? -mean * Math.log(1 - r()) : 0);
  const perPrice = (lots: number, d: number) => lots * (d / o.contract.tick_size) * o.contract.tick_value;
  const finals: number[] = [];
  const dds: number[] = [];
  const nets: number[] = [];
  const cagrs: number[] = [];
  let worst = { netProfit: Infinity, maxDrawdownPct: 0, sequence: [] as number[] };
  let ruin = 0;
  let loss = 0;
  for (let k = 0; k < o.runs; k++) {
    // resample the trades with replacement, then perturb each one
    const seq: number[] = [];
    for (let i = 0; i < trades.length; i++) {
      const t = trades[Math.floor(r() * trades.length)]!;
      if (r() < o.missProb) continue;
      // Costs are adverse whichever the side: fold them into the price move the trade earned.
      // Costs only hurt; price noise is symmetric (independent draws on entry and exit add in quadrature).
      const adverse = expo(o.extraSpread) + expo(o.slippage) * 2 + expo(o.latency) - gauss() * o.priceNoise * Math.SQRT2;
      const pricePnl = t.pnlPrice - adverse;
      seq.push(perPrice(t.lots, pricePnl) - t.commission - t.swap);
    }
    let eq = o.initial;
    const curve = [eq];
    for (const p of seq) curve.push((eq += p));
    const dd = drawdowns(curve).max;
    finals.push(eq);
    dds.push(dd);
    nets.push(eq - o.initial);
    cagrs.push(o.years > 0 && eq > 0 ? ((eq / o.initial) ** (1 / o.years) - 1) * 100 : -100);
    if (eq < o.initial) loss++;
    if (Math.min(...curve) <= o.initial * o.ruinFraction) ruin++;
    if (eq - o.initial < worst.netProfit) worst = { netProfit: eq - o.initial, maxDrawdownPct: dd, sequence: seq };
  }
  const fs = [...finals].sort((a, b) => a - b);
  const dsorted = [...dds].sort((a, b) => a - b);
  const cs = [...cagrs].sort((a, b) => a - b);
  const ns = [...nets].sort((a, b) => a - b);
  return {
    runs: o.runs,
    tradesPerRun: trades.length,
    medianCagrPct: quantile(cs, 0.5),
    medianMaxDrawdownPct: quantile(dsorted, 0.5),
    p95MaxDrawdownPct: quantile(dsorted, 0.95),
    medianNetProfit: quantile(ns, 0.5),
    probabilityOfLossPct: (loss / o.runs) * 100,
    probabilityOfRuinPct: (ruin / o.runs) * 100,
    worst,
    finalEquity: { p5: quantile(fs, 0.05), p50: quantile(fs, 0.5), p95: quantile(fs, 0.95) },
  };
}
