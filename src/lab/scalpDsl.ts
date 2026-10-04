// Scalp rules written as data, so the lab's brain, a bunny or the owner can add a new 1-minute rule without code. Same
// condition language as the skill DSL (lab/skills/dsl.ts): entries only; the exit is the scalper's own (target, stop and
// time stop in ATR multiples, maker or taker), and the lab's cost gate always applies. A rule written here proves
// nothing: it only ever trades after the walk-forward lab passed it on real data (lab/scalp.ts scalpGate).
//
//   {
//     "id": "vwap_snap", "name": "Snap back", "description": "Fade a 3-sigma stretch with RSI(7) at an extreme.",
//     "params": { "z": { "default": 2.5, "grid": [2, 2.5, 3] }, "zlo": { "default": -2.5, "grid": [-2, -2.5, -3] } },
//     "trade": { "targetAtr": { "default": 1, "grid": [0.8, 1.2] }, "stopAtr": { "default": 1.6 }, "holdBars": { "default": 12 } },
//     "long":  { "entry": [ { "left": "zscore(30)", "op": "<", "right": "$zlo" } ] },
//     "short": { "entry": [ { "left": "zscore(30)", "op": ">", "right": "$z" } ] }
//   }
import { z } from "zod";
import type { Candle } from "../market/types.js";
import { TRADE_DEFAULTS, type ScalpRule, type TradeParams } from "./scalp.js";
import { compileConds, Cond } from "./skills/dsl.js";
import type { Params } from "./skills/types.js";

/** The trade-management knobs a written rule may set, and their sane bounds (the cost gate can never drop under 2x). */
export const TRADE_BOUNDS: Record<keyof TradeParams, [number, number]> = {
  targetAtr: [0.3, 5],
  stopAtr: [0.3, 5],
  holdBars: [2, 240],
  waitBars: [1, 10],
  makerEntry: [0, 1],
  makerTarget: [0, 1],
  entryOffsetBps: [0, 20],
  costGateMult: [2, 10],
  minAtrBps: [0, 500],
  maxAtrBps: [1, 5000],
  cooldownBars: [0, 120],
};

const Knob = z.object({ default: z.number().finite(), grid: z.array(z.number().finite()).min(1).max(4).optional() }).strict();
const Side = z.object({ entry: z.array(Cond).min(1).max(8) }).strict();

export const ScalpSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{2,40}$/, "lowercase letters, digits and _ only"),
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(400).default(""),
    params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/), Knob).default({}),
    trade: z.object(Object.fromEntries(Object.keys(TRADE_BOUNDS).map((k) => [k, Knob.optional()])) as Record<keyof TradeParams, z.ZodOptional<typeof Knob>>).strict().default({}),
    long: Side.optional(),
    short: Side.optional(),
  })
  .strict()
  .refine((s) => s.long || s.short, "a rule needs a long side, a short side, or both")
  .superRefine((s, ctx) => {
    for (const [k, v] of Object.entries(s.trade) as Array<[keyof TradeParams, z.infer<typeof Knob> | undefined]>) {
      if (!v) continue;
      const [lo, hi] = TRADE_BOUNDS[k];
      for (const x of [v.default, ...(v.grid ?? [])]) if (x < lo || x > hi) ctx.addIssue({ code: "custom", path: ["trade", k], message: `${k} must be between ${lo} and ${hi}` });
    }
    for (const k of Object.keys(s.params)) if (k in TRADE_BOUNDS) ctx.addIssue({ code: "custom", path: ["params", k], message: `${k} is a trade knob: set it under "trade"` });
    const combos = [...Object.values(s.params), ...Object.values(s.trade)].reduce((n, v) => n * (v?.grid?.length ?? 1), 1);
    if (combos > 512) ctx.addIssue({ code: "custom", path: ["params"], message: `the grid has ${combos} combinations (max 512)` });
  });
export type ScalpSpec = z.infer<typeof ScalpSpecSchema>;

/** Validate a written rule; a readable error names what is wrong. */
export function parseScalpSpec(raw: unknown): { ok: true; spec: ScalpSpec } | { ok: false; error: string } {
  const p = ScalpSpecSchema.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("; ") };
  try {
    scalpRuleFromSpec(p.data);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, spec: p.data };
}

/**
 * Compile a written rule into the lab's ScalpRule. The signal is the entry EDGE: +1 (or -1) on the bar the long (short)
 * conditions turn true, so a condition that stays true does not fire on every bar. Both sides at once is no signal.
 */
export function scalpRuleFromSpec(spec: ScalpSpec): ScalpRule {
  const knobs = { ...spec.params, ...spec.trade } as Record<string, z.infer<typeof Knob> | undefined>;
  const defaults: Params = { ...TRADE_DEFAULTS };
  const grid: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(knobs)) {
    if (!v) continue;
    defaults[k] = v.default;
    if (v.grid?.length) grid[k] = v.grid;
  }
  const names = Object.fromEntries(Object.keys(defaults).map((k) => [k, true]));
  let le: ReturnType<typeof compileConds> | null;
  let se: ReturnType<typeof compileConds> | null;
  try {
    le = spec.long ? compileConds(spec.long.entry, names) : null;
    se = spec.short ? compileConds(spec.short.entry, names) : null;
  } catch (err) {
    throw new Error(`rule ${spec.id}: ${(err as Error).message}`);
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    defaults,
    grid,
    signal(c: Candle[], p: Params) {
      const L = le?.(c, p);
      const S = se?.(c, p);
      const out = new Int8Array(c.length);
      let pl = false;
      let ps = false;
      for (let i = 0; i < c.length; i++) {
        const l = L ? L(i) : false;
        const s = S ? S(i) : false;
        if (l && !pl && !s) out[i] = 1;
        else if (s && !ps && !l) out[i] = -1;
        pl = l;
        ps = s;
      }
      return out;
    },
  };
}
