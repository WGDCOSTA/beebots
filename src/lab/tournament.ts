// The tournament: every skill, every parameter set, every dataset, simulated with anchored walk-forward so the ranking
// rewards what held up on data the parameters were NOT picked on. For each fold the best parameters on the training
// window (everything before the fold) are frozen and run on the fold; only those out-of-sample runs count.
import type { Dataset } from "./history.js";
import { DEFAULT_SIM, metrics, score, simulate, type Metrics, type SimOpts } from "./backtest.js";
import { expandGrid, paramKey, type Params, type Skill } from "./skills/types.js";

export interface TournamentOpts {
  sim: SimOpts;
  /** Walk-forward folds over the test region. */
  folds: number;
  /** Share of each dataset used for out-of-sample folds (the rest is the first training window). */
  testFrac: number;
  /** Bars skipped at the start so every indicator is warm. */
  warmup: number;
  /** Parameter sets tried per skill. */
  maxCombos: number;
  /** Trades below this scale a score down (see backtest.score). */
  minTrades: number;
}

export const DEFAULT_TOURNAMENT: TournamentOpts = { sim: DEFAULT_SIM, folds: 3, testFrac: 0.5, warmup: 250, maxCombos: 48, minTrades: 6 };

export interface FoldResult {
  dataset: string;
  fold: number;
  params: Params;
  isScore: number;
  oos: Metrics;
  oosScore: number;
}

export interface SkillResult {
  rank: number;
  skillId: string;
  name: string;
  family: Skill["family"];
  source: string;
  description: string;
  /** Parameters picked most often across folds and datasets (ties: better out-of-sample score). */
  params: Params;
  /** The ranking number: mean out-of-sample score, weighted by how consistently it was positive. */
  score: number;
  oos: {
    scoreMean: number;
    /** Mean over datasets of the compounded out-of-sample return. */
    returnPct: number;
    benchmarkPct: number;
    sharpe: number;
    /** Mean System Quality Number over folds (Backtrader's SQN). */
    sqn: number;
    maxDrawdownPct: number;
    trades: number;
    winRatePct: number;
    profitFactor: number;
  };
  isScoreMean: number;
  /** Share of out-of-sample folds with a positive return. */
  stabilityPct: number;
  /** In-sample minus out-of-sample score: large = the parameters were fitted to noise. */
  overfitGap: number;
  folds: FoldResult[];
}

export interface Ranking {
  createdAt: number;
  datasets: Array<{ id: string; bars: number; from: number; to: number; source: string }>;
  opts: TournamentOpts;
  results: SkillResult[];
  errors: string[];
}

interface Window {
  from: number;
  to: number;
}

export function walkForwardWindows(n: number, o: Pick<TournamentOpts, "folds" | "testFrac" | "warmup">): Array<{ train: Window; test: Window }> {
  const warm = Math.min(o.warmup, Math.floor(n * 0.2));
  const testStart = Math.max(warm + 50, Math.floor(n * (1 - o.testFrac)));
  const size = Math.floor((n - testStart) / o.folds);
  if (size < 20) return [];
  return Array.from({ length: o.folds }, (_, f) => {
    const from = testStart + f * size;
    const to = f === o.folds - 1 ? n : from + size;
    return { train: { from: warm, to: from }, test: { from, to } };
  });
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stopFor(skill: Skill, p: Params, sim: SimOpts): number {
  if (typeof skill.stopAtr === "string") return p[skill.stopAtr] ?? sim.stopAtr;
  return skill.stopAtr ?? sim.stopAtr;
}

/** Run one skill through every dataset's walk-forward. */
export function evaluateSkill(skill: Skill, datasets: Dataset[], opts: TournamentOpts = DEFAULT_TOURNAMENT): Omit<SkillResult, "rank"> {
  const combos = expandGrid(skill, opts.maxCombos);
  const folds: FoldResult[] = [];
  const perDatasetReturn: number[] = [];
  const perDatasetBench: number[] = [];

  for (const ds of datasets) {
    const c = ds.candles;
    const windows = walkForwardWindows(c.length, opts);
    if (!windows.length) continue;
    const sigs = combos.map((p) => ({ p, sig: skill.signal(c, p), stop: stopFor(skill, p, opts.sim) }));
    let compounded = 1;
    windows.forEach((w, f) => {
      let best = sigs[0]!;
      let bestScore = -Infinity;
      for (const s of sigs) {
        const r = simulate(c, s.sig, { ...opts.sim, stopAtr: s.stop, exits: skill.exits }, w.train.from, w.train.to);
        const sc = score(metrics(r, c, w.train.from, w.train.to, opts.sim.startEquity), opts.minTrades);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      const r = simulate(c, best.sig, { ...opts.sim, stopAtr: best.stop, exits: skill.exits }, w.test.from, w.test.to);
      const m = metrics(r, c, w.test.from, w.test.to, opts.sim.startEquity);
      compounded *= 1 + m.totalReturnPct / 100;
      folds.push({ dataset: ds.id, fold: f, params: best.p, isScore: bestScore, oos: m, oosScore: score(m, opts.minTrades) });
    });
    perDatasetReturn.push((compounded - 1) * 100);
    const t = windows[0]!.test.from;
    perDatasetBench.push((c[c.length - 1]!.c / c[t]!.o - 1) * 100);
  }

  // Consensus parameters: the set picked most often, ties broken by its mean out-of-sample score.
  const tally = new Map<string, { p: Params; n: number; s: number[] }>();
  for (const f of folds) {
    const k = paramKey(f.params);
    const e = tally.get(k) ?? { p: f.params, n: 0, s: [] };
    e.n++;
    e.s.push(f.oosScore);
    tally.set(k, e);
  }
  const consensus = [...tally.values()].sort((a, b) => b.n - a.n || mean(b.s) - mean(a.s))[0]?.p ?? skill.defaults;

  const oosScores = folds.map((f) => f.oosScore);
  const stability = folds.length ? folds.filter((f) => f.oos.totalReturnPct > 0).length / folds.length : 0;
  const scoreMean = mean(oosScores);
  return {
    skillId: skill.id,
    name: skill.name,
    family: skill.family,
    source: skill.source,
    description: skill.description,
    params: consensus,
    score: folds.length ? (scoreMean >= 0 ? scoreMean * (0.5 + 0.5 * stability) : scoreMean * (1.5 - 0.5 * stability)) : -99,
    oos: {
      scoreMean,
      returnPct: mean(perDatasetReturn),
      benchmarkPct: mean(perDatasetBench),
      sharpe: mean(folds.map((f) => f.oos.sharpe)),
      sqn: mean(folds.filter((f) => f.oos.trades > 1).map((f) => f.oos.sqn)),
      maxDrawdownPct: Math.max(0, ...folds.map((f) => f.oos.maxDrawdownPct)),
      trades: folds.reduce((a, f) => a + f.oos.trades, 0),
      winRatePct: mean(folds.filter((f) => f.oos.trades > 0).map((f) => f.oos.winRatePct)),
      profitFactor: mean(folds.filter((f) => f.oos.trades > 0).map((f) => Math.min(10, f.oos.profitFactor))),
    },
    isScoreMean: mean(folds.map((f) => f.isScore)),
    stabilityPct: stability * 100,
    overfitGap: mean(folds.map((f) => f.isScore)) - scoreMean,
    folds,
  };
}

/** Simulate every skill, then rank. `onProgress` is called after each skill (for the CLI). */
export function runTournament(
  skills: Skill[],
  datasets: Dataset[],
  opts: Partial<TournamentOpts> = {},
  onProgress?: (done: number, total: number, skill: Skill) => void,
): Ranking {
  const o: TournamentOpts = { ...DEFAULT_TOURNAMENT, ...opts, sim: { ...DEFAULT_TOURNAMENT.sim, ...opts.sim } };
  const errors: string[] = [];
  const results: Array<Omit<SkillResult, "rank">> = [];
  skills.forEach((s, i) => {
    try {
      results.push(evaluateSkill(s, datasets, o));
    } catch (err) {
      errors.push(`${s.id}: ${(err as Error).message}`);
    }
    onProgress?.(i + 1, skills.length, s);
  });
  results.sort((a, b) => b.score - a.score);
  return {
    createdAt: Date.now(),
    datasets: datasets.map((d) => ({ id: d.id, bars: d.candles.length, from: d.candles[0]?.ts ?? 0, to: d.candles[d.candles.length - 1]?.ts ?? 0, source: d.source })),
    opts: o,
    results: results.map((r, i) => ({ ...r, rank: i + 1 })),
    errors,
  };
}

/** A compact table for the terminal and for LLM prompts (no fold detail). */
export function rankingTable(r: Ranking, top = 20): string {
  const rows = r.results.slice(0, top).map((s) =>
    [
      String(s.rank).padStart(2),
      s.skillId.padEnd(24),
      s.family.padEnd(14),
      s.score.toFixed(2).padStart(6),
      `${s.oos.returnPct.toFixed(1)}%`.padStart(8),
      `${s.oos.benchmarkPct.toFixed(1)}%`.padStart(8),
      s.oos.sharpe.toFixed(2).padStart(6),
      (s.oos.sqn ?? 0).toFixed(2).padStart(5),
      `${s.oos.maxDrawdownPct.toFixed(1)}%`.padStart(7),
      String(s.oos.trades).padStart(5),
      `${s.stabilityPct.toFixed(0)}%`.padStart(5),
      s.overfitGap.toFixed(2).padStart(6),
      paramKey(s.params),
    ].join(" "),
  );
  return ["rk skill                    family          score   oosRet   b&hRet sharpe   sqn   maxDD  trds  stab  ovfit params", ...rows].join("\n");
}
