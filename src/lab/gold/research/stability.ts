// Parameter stability (section 43): prefer plateaus to isolated peaks. A parameter set is only as good as its
// neighbours: if 17 is excellent and 16 and 18 are terrible, 17 is luck, not an edge.
import { DIM_BY_KEY, choiceKey, type Choice } from "./params.js";

export interface GridPoint {
  choice: Choice;
  score: number;
  trades: number;
}

export interface StabilityRow {
  choice: Choice;
  score: number;
  neighbours: number;
  neighbourMedian: number;
  neighbourMin: number;
  /** neighbourMedian / score (1 = the neighbours are as good; near 0 or negative = an isolated peak). */
  plateau: number;
  isolated: boolean;
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Points that differ from `c` by one step in exactly one dimension (steps follow each dimension's value order). */
export function neighbourKeys(c: Choice, dims: string[]): string[] {
  const out: string[] = [];
  for (const k of dims) {
    const vals = DIM_BY_KEY.get(k)!.values;
    const i = vals.indexOf(c[k] as never);
    for (const j of [i - 1, i + 1]) if (i >= 0 && j >= 0 && j < vals.length) out.push(choiceKey({ ...c, [k]: vals[j]! }));
  }
  return out;
}

/**
 * Score every point against its neighbours. `isolated` marks a positive point whose neighbours' median is under half
 * its score (or which has a losing neighbour worse than -half its score): it is rejected however high it ranks.
 */
export function stabilityRows(points: GridPoint[], dims: string[]): StabilityRow[] {
  const by = new Map(points.map((p) => [choiceKey(p.choice), p]));
  return points.map((p) => {
    const nb = neighbourKeys(p.choice, dims)
      .map((k) => by.get(k))
      .filter((x): x is GridPoint => !!x)
      .map((x) => x.score);
    const med = nb.length ? median(nb) : p.score;
    const min = nb.length ? Math.min(...nb) : p.score;
    const isolated = p.score > 0 && nb.length >= 2 && (med < 0.5 * p.score || min < -0.5 * p.score);
    return { choice: p.choice, score: p.score, neighbours: nb.length, neighbourMedian: med, neighbourMin: min, plateau: p.score > 0 ? med / p.score : 0, isolated };
  });
}

export interface StabilityReport {
  rows: StabilityRow[];
  /** Best raw point, and best point that is not an isolated peak. */
  best: StabilityRow | null;
  bestStable: StabilityRow | null;
  isolatedSharePct: number;
  /** Positive points whose neighbours are also positive, as % of positive points. */
  plateauSharePct: number;
}

export function parameterStability(points: GridPoint[], dims: string[]): StabilityReport {
  const rows = stabilityRows(points, dims).sort((a, b) => b.score - a.score);
  const positive = rows.filter((r) => r.score > 0);
  const stable = positive.filter((r) => !r.isolated && r.neighbourMedian > 0);
  return {
    rows,
    best: rows[0] ?? null,
    bestStable: rows.find((r) => r.score > 0 && !r.isolated && r.neighbourMedian > 0) ?? null,
    isolatedSharePct: positive.length ? (positive.filter((r) => r.isolated).length / positive.length) * 100 : 0,
    plateauSharePct: positive.length ? (stable.length / positive.length) * 100 : 0,
  };
}
