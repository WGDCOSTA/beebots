// Coarse-to-fine search (section 51): (1) a broad structural scan, (2) drop unstable regions, (3) a fine search inside
// the stable plateau. Walk-forward, Monte Carlo and paper trading come after, in their own modules. The search is
// generic over an evaluation function so it can be tested without a simulator.
import type { Metrics } from "./metrics.js";
import { DIM_BY_KEY, choiceKey, type Choice } from "./params.js";
import { parameterStability, type GridPoint, type StabilityReport } from "./stability.js";

/** One number to rank a run by: edge per trade times the square root of how often it happened, cut by drawdown. */
export function score(m: Metrics, minTrades: number): number {
  if (m.trades < minTrades) return -1 - (minTrades - m.trades) / Math.max(1, minTrades);
  return m.expectancyR * Math.sqrt(m.trades) * (1 - Math.min(0.9, m.maxDrawdownPct / 100));
}

export interface SearchOpts {
  dims: string[];
  /** Cap on the coarse grid (an even sample is taken above it). */
  maxCoarse: number;
  /** How many fine-search points around the best stable point. */
  maxFine: number;
  minTrades: number;
}
export const DEFAULT_SEARCH: SearchOpts = { dims: ["arm", "sl", "tp", "fake"], maxCoarse: 96, maxFine: 48, minTrades: 30 };

function grid(dims: string[]): Choice[] {
  let combos: Choice[] = [{}];
  for (const k of dims) {
    const vals = DIM_BY_KEY.get(k)!.values;
    combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  }
  return combos;
}
const sample = <T>(a: T[], n: number): T[] => (a.length <= n ? a : Array.from({ length: n }, (_, i) => a[Math.floor((i * a.length) / n)]!));

export interface SearchResult {
  coarse: GridPoint[];
  fine: GridPoint[];
  stability: StabilityReport;
  /** The stable best after the fine search, or the coarse stable best; null when nothing positive and stable exists. */
  best: GridPoint | null;
  evaluations: number;
}

export function coarseToFine(evaluate: (c: Choice) => { score: number; trades: number }, o: Partial<SearchOpts> = {}): SearchResult {
  const opts = { ...DEFAULT_SEARCH, ...o };
  let evaluations = 0;
  const cache = new Map<string, GridPoint>();
  const ev = (c: Choice): GridPoint => {
    const k = choiceKey(c);
    let p = cache.get(k);
    if (!p) {
      const r = evaluate(c);
      evaluations++;
      cache.set(k, (p = { choice: c, score: r.score, trades: r.trades }));
    }
    return p;
  };
  // Phase 1: broad scan
  const coarse = sample(grid(opts.dims), opts.maxCoarse).map(ev);
  // Phase 2: remove unstable regions
  const st1 = parameterStability(coarse, opts.dims);
  const seedRow = st1.bestStable;
  if (!seedRow) return { coarse, fine: [], stability: st1, best: null, evaluations };
  const seed = cache.get(choiceKey(seedRow.choice))!;
  // Phase 3: fine search inside the plateau: refine numeric dimensions between the seed's value and its neighbours
  const fineDims = opts.dims.filter((k) => DIM_BY_KEY.get(k)!.refinable);
  const around = (k: string): Array<number | string> => {
    const vals = DIM_BY_KEY.get(k)!.values as number[];
    const i = vals.indexOf(seed.choice[k] as number);
    const v = vals[i] as number;
    const out = [v];
    if (i > 0) out.push((v + vals[i - 1]!) / 2);
    if (i < vals.length - 1) out.push((v + vals[i + 1]!) / 2);
    return out.map((x) => Math.round(x * 1000) / 1000);
  };
  let combos: Choice[] = [{ ...seed.choice }];
  for (const k of fineDims) combos = combos.flatMap((c) => around(k).map((v) => ({ ...c, [k]: v })));
  const fine = sample(combos, opts.maxFine).map(ev);
  const fineBest = [seed, ...fine].filter((p) => p.trades >= opts.minTrades).sort((a, b) => b.score - a.score)[0] ?? seed;
  // A fine point must not be a lone spike inside its own neighbourhood: its neighbours' median has to be positive too.
  const fs = fine.map((f) => f.score).sort((a, b) => a - b);
  const fineMedian = fs.length ? fs[Math.floor(fs.length / 2)]! : 0;
  const best = fineBest.score > 0 && fineMedian > 0 ? fineBest : seed;
  return { coarse, fine, stability: st1, best, evaluations };
}
