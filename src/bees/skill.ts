// A trading style made from any lab skill (built-in, imported, or written and backtested by a bee): the bee's
// specialisation. Its brains choose it (brains/council.ts, brains/survival.ts); this turns it into a BeeBrain.
//
// Every tick the skill runs on each coin's latest confirmed 1h candles, exactly as in the lab: its last position is the
// signal (+1 long, -1 short, 0 flat). Flat, Jev is offered the coins where the skill wants a position (plus WAIT);
// positioned, it can hold, take profit, or exit when the skill goes flat or flips. Stops come from the skill (its ATR
// multiple, else the bee's knob), sizing from Jev's conviction, and the risk layer still has the last word.
import type { Candle, CoinStats } from "../market/types.js";
import type { Skill } from "../lab/skills/types.js";
import { atrStop, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Intent, Menu } from "./types.js";

/** Coins a skill brain scans per tick (most liquid first): enough choice, bounded CPU. */
const SCAN = 12;

export interface SkillSpec {
  skill: Skill;
  params: Record<string, number>;
}

/** The skill's position on the last confirmed bar, or null without enough history. Cached per coin and bar. */
export function skillSignal(spec: SkillSpec, candles: Candle[], cache?: Map<string, { at: string; sig: number | null }>, key?: string): number | null {
  const c = candles.filter((x) => x.confirmed);
  if (c.length < 30) return null;
  // The last bar's time and close identify the history the signal was computed on.
  const at = `${c[c.length - 1]!.ts}:${c[c.length - 1]!.c}`;
  const hit = key ? cache?.get(key) : undefined;
  if (hit && hit.at === at) return hit.sig;
  let sig: number | null = null;
  try {
    const s = spec.skill.signal(c, { ...spec.skill.defaults, ...spec.params });
    sig = s[s.length - 1] ?? 0;
  } catch {
    sig = null; // a broken skill trades nothing
  }
  if (key && cache) {
    cache.set(key, { at, sig });
    if (cache.size > 400) cache.clear();
  }
  return sig;
}

/** The skill's ATR stop multiple (a number, or a param name), or null. */
function stopMult(spec: SkillSpec): number | null {
  const s = spec.skill.stopAtr;
  if (typeof s === "number") return s > 0 ? s : null;
  if (typeof s === "string") {
    const v = spec.params[s] ?? spec.skill.defaults[s];
    return typeof v === "number" && v > 0 ? v : null;
  }
  return null;
}

export function skillBrain(spec: SkillSpec): BeeBrain {
  const cache = new Map<string, { at: string; sig: number | null }>();
  const scanned = (ctx: BeeContext): CoinStats[] =>
    ctx.view.gated
      .slice(0, SCAN)
      .map((id) => ctx.view.stats.get(id))
      .filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.knobs.spreadGateBps);
  const signal = (ctx: BeeContext, instId: string) => (ctx.candles ? skillSignal(spec, ctx.candles(instId), cache, `${instId}`) : null);
  const label = spec.skill.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 18);

  return {
    id: "skill",
    strategy:
      `You are specialised in the ${spec.skill.name} method (${spec.skill.family}): ${spec.skill.description} ` +
      "Your brains chose this specialisation from backtested evidence. Each coin's `sig` is the method's position on the last closed 1h bar (+1 long, -1 short, 0 none). " +
      "Enter only where the method signals and the market agrees; WAIT is a good answer. Positioned: hold while the method holds, exit when it goes flat or flips, take profit into strength.",
    convictionLabels: ["tentative", "decent", "clean", "textbook"],
    openGate: { minConviction: 1, minProb: () => 0.45 },
    requiresStrictSetup: true,
    neverForce: true,
    protectAdds: true,
    profitLock: [
      { atPct: 1, keep: 0.4 },
      { atPct: 2.5, keep: 0.6 },
    ],

    universe(ctx) {
      return scanned(ctx).map((s) => s.instId);
    },

    snapshotCoins(ctx) {
      const held = ctx.bee.position?.instId;
      const ids = scanned(ctx).map((s) => s.instId);
      return held && !ids.includes(held) && ctx.view.stats.has(held) ? [...ids, held] : ids;
    },

    coinSnapshot(s, ctx) {
      return {
        sig: signal(ctx, s.instId),
        r1h_pct: r2(s.ret1hPct, 2),
        r24h_pct: r2(s.ret24hPct, 1),
        r7d_pct: r2(s.ret7dPct, 1),
        rsi: r2(s.rsi14, 0),
        atr_pct: r2(s.atr14Pct, 2),
        spread_bp: r2(s.spreadBp, 1),
      };
    },

    menu(ctx) {
      const m: Menu = {};
      const p = ctx.bee.position;
      if (!p) {
        for (const s of scanned(ctx)) {
          const sig = signal(ctx, s.instId);
          if (!sig) continue;
          const side = sig > 0 ? "long" : "short";
          const intent: Intent = { kind: "open", instId: s.instId, side, sizeFrac: 1, setup: "strict" };
          m[`${label}_${side.toUpperCase()}_${s.coin}`] = { desc: null, intent };
        }
        if (Object.keys(m).length) m.WAIT = { desc: "no trade yet", intent: { kind: "hold" } };
        return m;
      }
      m.HOLD = { desc: "keep position", intent: { kind: "hold" } };
      const sig = signal(ctx, p.instId);
      const dir = p.side === "long" ? 1 : -1;
      if (sig !== null && sig !== dir) m.EXIT = { desc: sig === 0 ? "method went flat, close" : "method flipped, close", intent: { kind: "close", reason: "skill_exit" } };
      if ((ctx.uplR ?? 0) > 1) m.TAKE_PROFIT = { desc: "close in profit", intent: { kind: "close", reason: "take_profit" } };
      return m;
    },

    forcedEntry() {
      return null;
    },

    sizeFrac(_intent, conviction) {
      return [0.5, 0.65, 0.8, 1][Math.max(0, Math.min(3, conviction))]!;
    },

    stopFor(instId, side, entryPx, ctx) {
      return atrStop(ctx.view.stats.get(instId), side, entryPx, stopMult(spec) ?? ctx.knobs.stopAtrMult);
    },

    idleStatus(ctx) {
      return `${spec.skill.name}: no signal on ${scanned(ctx).length} coins, waiting`;
    },
  };
}
