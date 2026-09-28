// The search space (section 50): what may be optimised, expressed as choices on top of each profile's own defaults so
// one space serves all nine strategies. Distances scale by a multiplier; structural counts and modes are absolute.
// Nothing else is searched: no unrelated indicators, no weekday rules, no date filters, no per-trade exceptions.
import type { StrategyProfile } from "../types.js";

export type Choice = Record<string, number | string>;

export interface Dim {
  key: string;
  label: string;
  values: Array<number | string>;
  /** Numeric dimensions can be refined between two neighbouring values. */
  refinable: boolean;
  apply(p: StrategyProfile, v: number | string): StrategyProfile;
}

const clone = (p: StrategyProfile): StrategyProfile => structuredClone(p);
const mult = (f: (p: StrategyProfile, m: number) => void) => (p: StrategyProfile, v: number | string) => {
  const q = clone(p);
  f(q, Number(v));
  return q;
};

export const DIMS: Dim[] = [
  { key: "left", label: "swing left bars", values: [2, 3, 4, 5], refinable: false, apply: mult((p, v) => void (p.structure.left_bars = v)) },
  { key: "right", label: "swing right bars", values: [2, 3, 4, 5, 6], refinable: false, apply: mult((p, v) => void (p.structure.right_bars = v)) },
  { key: "lookback", label: "lookback (x)", values: [0.5, 1, 1.5], refinable: true, apply: mult((p, m) => void (p.structure.max_lookback_bars = Math.max(10, Math.round(p.structure.max_lookback_bars * m)))) },
  { key: "arm", label: "arm distance (x)", values: [0.5, 0.75, 1, 1.5], refinable: true, apply: mult((p, m) => void (p.entry.min_arm_distance *= m)) },
  { key: "offset", label: "entry offset (x)", values: [0.5, 1, 1.5, 2], refinable: true, apply: mult((p, m) => void (p.entry.breakout_offset *= m)) },
  { key: "sl", label: "stop loss (x)", values: [0.6, 0.8, 1, 1.3, 1.6], refinable: true, apply: mult((p, m) => void (p.stop_loss.base_distance *= m)) },
  { key: "tp", label: "take profit (x)", values: [0.6, 0.8, 1, 1.3, 1.6], refinable: true, apply: mult((p, m) => void (p.take_profit.base_distance *= m)) },
  {
    key: "be",
    label: "break-even (x)",
    values: [0.6, 1, 1.5],
    refinable: true,
    apply: mult((p, m) => {
      p.break_even.trigger_distance *= m;
      p.break_even.lock_distance *= m;
    }),
  },
  {
    key: "trail",
    label: "classic trailing (x)",
    values: [0.6, 1, 1.5],
    refinable: true,
    apply: mult((p, m) => {
      p.trailing.trigger_distance *= m;
      p.trailing.distance *= m;
    }),
  },
  { key: "structOffset", label: "structure trailing offset (x)", values: [0.5, 1, 2], refinable: true, apply: mult((p, m) => void (p.structure_trailing.offset *= m)) },
  {
    key: "fake",
    label: "fake-breakout mode",
    values: ["OFF", "LOW", "MEDIUM", "HIGH"],
    refinable: false,
    apply: (p, v) => {
      const q = clone(p);
      if (v === "OFF") q.fake_breakout.enabled = false;
      else {
        q.fake_breakout.enabled = true;
        q.fake_breakout.mode = v as "LOW" | "MEDIUM" | "HIGH";
        delete q.fake_breakout.checks;
      }
      return q;
    },
  },
  {
    key: "norm",
    label: "normalisation",
    values: ["NONE", "PRICE_RATIO", "ATR", "HYBRID"],
    refinable: false,
    apply: (p, v) => {
      const q = clone(p);
      q.normalization = { ...(q.normalization ?? {}), mode: v as "NONE" | "PRICE_RATIO" | "ATR" | "HYBRID" };
      return q;
    },
  },
  { key: "weight", label: "risk weight (x)", values: [0.5, 0.75, 1], refinable: true, apply: mult((p, m) => void (p.risk.weight = Math.min(1, p.risk.weight * m))) },
];

export const DIM_BY_KEY = new Map(DIMS.map((d) => [d.key, d]));

/** The profile with a choice applied (dimensions absent from the choice keep the profile's own values). */
export function applyChoice(p: StrategyProfile, choice: Choice): StrategyProfile {
  let q = p;
  for (const [k, v] of Object.entries(choice)) q = DIM_BY_KEY.get(k)!.apply(q, v);
  return q;
}

export const choiceKey = (c: Choice) =>
  Object.keys(c)
    .sort()
    .map((k) => `${k}=${c[k]}`)
    .join(",");
