import type { Candle } from "../../market/types.js";

/** What kind of edge a skill trades. Each official bee style has a natural family (see lab/playbook.ts). */
export const FAMILIES = ["trend", "breakout", "momentum", "mean_reversion", "hybrid", "benchmark"] as const;
export type Family = (typeof FAMILIES)[number];

export type Params = Record<string, number>;

/**
 * Exits in Freqtrade's terms (fractions of the entry price, 0.04 = 4%):
 * - roi: [minutes since entry, take-profit] pairs; the pair with the largest minutes reached applies ("minimal_roi");
 * - stoploss: a negative fraction, e.g. -0.1 closes at 10% against the entry;
 * - trailing: once the best price is `offset` in profit, the stop follows it at `positive` behind.
 */
export interface Exits {
  roi?: Array<[number, number]>;
  stoploss?: number;
  trailing?: { positive: number; offset: number };
}

/**
 * A trading skill: a rule that turns candles into a target position per bar. `signal(c, p)[i]` is the position
 * (+1 long, -1 short, 0 flat) wanted at the CLOSE of bar i; the simulator fills it at the next bar's open, so a skill
 * can never trade on a price it has not seen.
 */
export interface Skill {
  id: string;
  name: string;
  family: Family;
  description: string;
  defaults: Params;
  /** Values tried by the tournament. Keys missing here keep their default. */
  grid: Record<string, number[]>;
  /** Code-side stop in ATR(14) multiples; 0/undefined = the skill's own exit only. May be a param name. */
  stopAtr?: number | string;
  /** Freqtrade-style exits on top of the signal: time-based take profit, a fixed stop, a trailing stop. */
  exits?: Exits;
  /** Where the skill came from: "builtin", or the file it was imported from. */
  source: string;
  signal(c: Candle[], p: Params): Int8Array;
  /** Parameter combinations that make no sense (e.g. fast >= slow). */
  valid?(p: Params): boolean;
}

/**
 * Turn entry/exit conditions into a position series. At each bar: an open position exits on its exit rule (or flips
 * on the opposite entry); a flat one enters long or short. `null` for a side means the skill does not trade it.
 */
export function positions(
  n: number,
  rules: {
    longEntry?: (i: number) => boolean;
    longExit?: (i: number) => boolean;
    shortEntry?: (i: number) => boolean;
    shortExit?: (i: number) => boolean;
  },
): Int8Array {
  const out = new Int8Array(n);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const le = rules.longEntry?.(i) ?? false;
    const se = rules.shortEntry?.(i) ?? false;
    if (pos === 1) {
      if (se) pos = -1;
      else if (rules.longExit?.(i)) pos = 0;
    } else if (pos === -1) {
      if (le) pos = 1;
      else if (rules.shortExit?.(i)) pos = 0;
    } else if (le && !se) pos = 1;
    else if (se && !le) pos = -1;
    out[i] = pos;
  }
  return out;
}

/** Every combination of a grid (defaults fill missing keys), capped by an even sample so big grids stay bounded. */
export function expandGrid(skill: Skill, maxCombos = 48): Params[] {
  const keys = Object.keys(skill.grid);
  let combos: Params[] = [{ ...skill.defaults }];
  for (const k of keys) {
    const next: Params[] = [];
    for (const base of combos) for (const v of skill.grid[k]!) next.push({ ...base, [k]: v });
    combos = next;
  }
  combos = combos.filter((p) => skill.valid?.(p) ?? true);
  if (combos.length <= maxCombos) return combos;
  const step = combos.length / maxCombos;
  return Array.from({ length: maxCombos }, (_, i) => combos[Math.floor(i * step)]!);
}

export const paramKey = (p: Params) =>
  Object.keys(p)
    .sort()
    .map((k) => `${k}=${p[k]}`)
    .join(",");
