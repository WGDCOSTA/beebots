// Importable skills: a small JSON rule language so new strategies can be added (or written by an LLM) without code.
//
//   {
//     "id": "golden_pullback", "name": "Golden pullback", "family": "hybrid",
//     "description": "Above the 200 SMA, buy an RSI(3) dip, sell the bounce.",
//     "params": { "lo": { "default": 20, "grid": [10, 20, 30] } },
//     "stopAtr": 3,
//     "long":  { "entry": [ { "left": "close", "op": ">", "right": "sma(200)" }, { "left": "rsi(3)", "op": "<", "right": "$lo" } ],
//                "exit":  [ { "left": "rsi(3)", "op": ">", "right": 70 } ] },
//     "short": { ... optional, same shape ... }
//   }
//
// Conditions in a list must all hold; `{ "any": [ ... ] }` holds when one of its conditions does. Operators: < <= > >=
// crosses_above crosses_below. Expressions: close open high low volume, sma(n) ema(n) rsi(n) atr(n) atr_pct(n) roc(n)
// zscore(n) stoch(n) highest(n) lowest(n) (prior n bars) bb_upper(n,k) bb_mid(n) bb_lower(n,k) bb_pctb(n,k)
// macd_hist(fast,slow,signal) supertrend(n,mult) adx(n) plus_di(n) minus_di(n) cci(n) mfi(n) willr(n) stoch_d(n,d)
// volume_sma(n), numbers, and $param references.
//
// Exits in Freqtrade's terms, on top of the rules: "roi": { "0": 0.06, "60": 0.03, "240": 0 } (take profit by minutes
// held, like minimal_roi), "stoploss": -0.08, "trailing": { "positive": 0.01, "offset": 0.03 }.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Candle } from "../../market/types.js";
import * as S from "../series.js";
import { FAMILIES, positions, type Params, type Skill } from "./types.js";

const Operand = z.union([z.string().min(1).max(60), z.number()]);
export const Cond: z.ZodType<CondT> = z.lazy(() =>
  z.union([
    z.object({ left: Operand, op: z.enum(["<", "<=", ">", ">=", "crosses_above", "crosses_below"]), right: Operand }).strict(),
    z.object({ any: z.array(Cond).min(1).max(8) }).strict(),
  ]),
);
export type CondT = { left: string | number; op: "<" | "<=" | ">" | ">=" | "crosses_above" | "crosses_below"; right: string | number } | { any: CondT[] };
const Side = z.object({ entry: z.array(Cond).min(1).max(8), exit: z.array(Cond).min(1).max(8) }).strict();

export const SkillSpecSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{2,40}$/, "lowercase letters, digits and _ only"),
    name: z.string().min(1).max(60),
    family: z.enum(FAMILIES),
    description: z.string().max(400).default(""),
    params: z.record(z.object({ default: z.number(), grid: z.array(z.number()).max(8).optional() })).default({}),
    stopAtr: z.union([z.number().min(0).max(10), z.string().regex(/^\$[A-Za-z_][A-Za-z0-9_]*$/)]).optional(),
    // Freqtrade-style exits. roi: { "<minutes>": fraction } like minimal_roi; stoploss: negative fraction.
    roi: z.record(z.string().regex(/^\d+$/), z.number().min(0).max(10)).optional(),
    stoploss: z.number().min(-0.99).max(0).optional(),
    trailing: z.object({ positive: z.number().gt(0).max(0.5), offset: z.number().min(0).max(5) }).strict().optional(),
    long: Side.optional(),
    short: Side.optional(),
  })
  .strict()
  .refine((s) => s.long || s.short, "a skill needs a long side, a short side, or both");
export type SkillSpec = z.infer<typeof SkillSpecSchema>;

type Expr = (c: Candle[], p: Params) => S.Series;

const FNS: Record<string, { arity: number[]; make: (a: number[]) => (c: Candle[]) => S.Series }> = {
  sma: { arity: [1], make: ([n]) => (c) => S.sma(S.closes(c), n!) },
  ema: { arity: [1], make: ([n]) => (c) => S.ema(S.closes(c), n!) },
  rsi: { arity: [1], make: ([n]) => (c) => S.rsi(S.closes(c), n) },
  atr: { arity: [1], make: ([n]) => (c) => S.atr(c, n) },
  atr_pct: { arity: [1], make: ([n]) => (c) => S.atr(c, n).map((a, i) => (a / c[i]!.c) * 100) },
  roc: { arity: [1], make: ([n]) => (c) => S.roc(S.closes(c), n!) },
  zscore: { arity: [1], make: ([n]) => (c) => S.zscore(S.closes(c), n!) },
  stoch: { arity: [1], make: ([n]) => (c) => S.stochK(c, n) },
  highest: { arity: [1], make: ([n]) => (c) => S.priorHigh(c, n!) },
  lowest: { arity: [1], make: ([n]) => (c) => S.priorLow(c, n!) },
  bb_upper: { arity: [1, 2], make: ([n, k]) => (c) => S.bollinger(S.closes(c), n, k ?? 2).upper },
  bb_mid: { arity: [1], make: ([n]) => (c) => S.bollinger(S.closes(c), n).mid },
  bb_lower: { arity: [1, 2], make: ([n, k]) => (c) => S.bollinger(S.closes(c), n, k ?? 2).lower },
  bb_pctb: { arity: [1, 2], make: ([n, k]) => (c) => S.bollinger(S.closes(c), n, k ?? 2).pctB },
  macd_hist: { arity: [0, 3], make: ([f, s, g]) => (c) => S.macd(S.closes(c), f ?? 12, s ?? 26, g ?? 9).hist },
  supertrend: { arity: [0, 2], make: ([n, m]) => (c) => S.supertrend(c, n ?? 10, m ?? 3) },
  adx: { arity: [0, 1], make: ([n]) => (c) => S.adx(c, n ?? 14).adx },
  plus_di: { arity: [0, 1], make: ([n]) => (c) => S.adx(c, n ?? 14).plusDi },
  minus_di: { arity: [0, 1], make: ([n]) => (c) => S.adx(c, n ?? 14).minusDi },
  cci: { arity: [0, 1], make: ([n]) => (c) => S.cci(c, n ?? 20) },
  mfi: { arity: [0, 1], make: ([n]) => (c) => S.mfi(c, n ?? 14) },
  willr: { arity: [0, 1], make: ([n]) => (c) => S.willr(c, n ?? 14) },
  stoch_d: { arity: [0, 1, 2], make: ([n, d]) => (c) => S.stochD(c, n ?? 14, d ?? 3) },
  volume_sma: { arity: [1], make: ([n]) => (c) => S.sma(S.volume(c), n!) },
};
const FIELDS: Record<string, (c: Candle) => number> = { close: (x) => x.c, open: (x) => x.o, high: (x) => x.h, low: (x) => x.l, volume: (x) => x.volUsd };

function arg(tok: string, params: Record<string, unknown>): (p: Params) => number {
  const t = tok.trim();
  if (t.startsWith("$")) {
    const name = t.slice(1);
    if (!(name in params)) throw new Error(`unknown parameter ${t}`);
    return (p) => p[name]!;
  }
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`"${t}" is not a number or $param`);
  return () => n;
}

/** Compile one operand into a series factory. Throws with a readable message on anything unknown. */
export function compileExpr(src: string | number, params: Record<string, unknown>): Expr {
  if (typeof src === "number") return (c) => new Float64Array(c.length).fill(src);
  // Indicator and field names are case-insensitive; $param names are not.
  const s = src.trim();
  if (s.startsWith("$") || /^-?\d/.test(s)) {
    const a = arg(s, params);
    return (c, p) => new Float64Array(c.length).fill(a(p));
  }
  if (FIELDS[s.toLowerCase()]) {
    const f = FIELDS[s.toLowerCase()]!;
    return (c) => Float64Array.from(c, f);
  }
  const m = /^([a-z_]+)\s*\(([^()]*)\)$/i.exec(s) ?? (FNS[s.toLowerCase()] ? [s, s, ""] : null);
  if (!m) throw new Error(`cannot read "${src}"`);
  const fn = FNS[m[1]!.toLowerCase()];
  if (!fn) throw new Error(`unknown indicator "${m[1]}"`);
  const args = m[2]!.trim() ? m[2]!.split(",").map((t) => arg(t, params)) : [];
  if (!fn.arity.includes(args.length)) throw new Error(`${m[1]} takes ${fn.arity.join(" or ")} argument(s)`);
  return (c, p) => fn.make(args.map((a) => a(p)))(c);
}

type Test = (i: number) => boolean;

export function compileConds(conds: CondT[], params: Record<string, unknown>): (c: Candle[], p: Params) => Test {
  const parts = conds.map((cond) => {
    if ("any" in cond) {
      const alts = cond.any.map((a) => compileConds([a], params));
      return (c: Candle[], p: Params): Test => {
        const ts = alts.map((a) => a(c, p));
        return (i) => ts.some((t) => t(i));
      };
    }
    const L = compileExpr(cond.left, params);
    const R = compileExpr(cond.right, params);
    return (c: Candle[], p: Params): Test => {
      const l = L(c, p);
      const r = R(c, p);
      switch (cond.op) {
        case "<":
          return (i) => l[i]! < r[i]!;
        case "<=":
          return (i) => l[i]! <= r[i]!;
        case ">":
          return (i) => l[i]! > r[i]!;
        case ">=":
          return (i) => l[i]! >= r[i]!;
        case "crosses_above":
          return (i) => i > 0 && l[i - 1]! <= r[i - 1]! && l[i]! > r[i]!;
        case "crosses_below":
          return (i) => i > 0 && l[i - 1]! >= r[i - 1]! && l[i]! < r[i]!;
      }
    };
  });
  return (c, p) => {
    const ts = parts.map((f) => f(c, p));
    return (i) => ts.every((t) => t(i));
  };
}

/** Validate and compile a JSON skill. Throws a readable error naming the skill. */
export function skillFromSpec(raw: unknown, source = "import"): Skill {
  const parsed = SkillSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const id = (raw as { id?: unknown })?.id;
    throw new Error(`skill ${typeof id === "string" ? id : "?"}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const spec = parsed.data;
  try {
    const defaults = Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, v.default]));
    const grid = Object.fromEntries(Object.entries(spec.params).flatMap(([k, v]) => (v.grid?.length ? [[k, v.grid]] : [])));
    const le = spec.long ? compileConds(spec.long.entry, defaults) : null;
    const lx = spec.long ? compileConds(spec.long.exit, defaults) : null;
    const se = spec.short ? compileConds(spec.short.entry, defaults) : null;
    const sx = spec.short ? compileConds(spec.short.exit, defaults) : null;
    return {
      id: spec.id,
      name: spec.name,
      family: spec.family,
      description: spec.description,
      defaults,
      grid,
      stopAtr: typeof spec.stopAtr === "string" ? spec.stopAtr.slice(1) : spec.stopAtr,
      ...(spec.roi || spec.stoploss !== undefined || spec.trailing
        ? {
            exits: {
              ...(spec.roi ? { roi: Object.entries(spec.roi).map(([m, r]) => [Number(m), r] as [number, number]) } : {}),
              ...(spec.stoploss !== undefined ? { stoploss: spec.stoploss } : {}),
              ...(spec.trailing ? { trailing: spec.trailing } : {}),
            },
          }
        : {}),
      source,
      signal: (c, p) =>
        positions(c.length, {
          longEntry: le?.(c, p),
          longExit: lx?.(c, p),
          shortEntry: se?.(c, p),
          shortExit: sx?.(c, p),
        }),
    };
  } catch (err) {
    throw new Error(`skill ${spec.id}: ${(err as Error).message}`);
  }
}

/** A file holds one skill, an array of skills, or { "skills": [...] } (a pack). */
export function skillsFromJson(raw: unknown, source: string): Skill[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { skills?: unknown }).skills) ? (raw as { skills: unknown[] }).skills : [raw];
  return list.map((s) => skillFromSpec(s, source));
}

/** Every *.json under `dir` (one level deep). Bad files are reported, not fatal. */
export function loadSkillDir(dir: string): { skills: Skill[]; errors: string[] } {
  const skills: Skill[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { skills, errors };
  }
  for (const f of names) {
    const path = join(dir, f);
    if (!statSync(path).isFile()) continue;
    try {
      skills.push(...skillsFromJson(JSON.parse(readFileSync(path, "utf8")), f));
    } catch (err) {
      errors.push(`${f}: ${(err as Error).message}`);
    }
  }
  return { skills, errors };
}
