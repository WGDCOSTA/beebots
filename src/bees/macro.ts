// The macro squad's style: gold, silver, oil, stocks and ETFs (bees whose market is not crypto; see docs/MACRO_SQUAD.md).
//
// Two setups, read from the 15m indicators and the 1h returns every coin already has:
//   - TREND: the week and the day agree (7d and 24h returns, MACD histogram) and price has pulled back (RSI 35-60 for
//     a long, 40-65 for a short, and %B back toward the middle band). Metals and indices trend in steps; enter on the dip.
//   - REVERT: no weekly trend (|7d| under 2.5%) and price stretched outside its Bollinger band with RSI at an extreme.
// It only opens a listed setup (never forced in when flat), at most MACRO_MAX_LEVERAGE x equity (1x by default), and
// smaller late in a session. The code closes it before its session ends (SESSION_FLATTEN) so no gap can hit it.
import { atrStop, MARGIN_HEADROOM, maxNotionalUsd, r2 } from "./common.js";
import type { CoinStats } from "../market/types.js";
import { mustFlatten } from "../market/sessions.js";
import type { BeeBrain, BeeContext, Intent, Menu, Side } from "./types.js";

/** Weekly move (in %) under which a coin counts as ranging: the reversion setup applies. */
const RANGE_7D_PCT = 2.5;
/** Opens with less than this to the close are sized by MACRO_LATE_SESSION_SIZE. */
const LATE_SESSION_MIN = 120;

export type MacroSetup = "trend_long" | "trend_short" | "revert_long" | "revert_short";

/** The setup a coin shows right now, or null. */
export function macroSetup(s: CoinStats): MacroSetup | null {
  const { rsi14: rsi, pctB, ret7dPct: w, ret24hPct: d, macdHistPct: macd } = s;
  if (rsi === null || pctB === null || w === null || d === null) return null;
  const up = w > 0 && d > 0 && (macd ?? 0) > 0;
  const down = w < 0 && d < 0 && (macd ?? 0) < 0;
  if (up && rsi >= 35 && rsi <= 60 && pctB <= 0.6) return "trend_long";
  if (down && rsi >= 40 && rsi <= 65 && pctB >= 0.4) return "trend_short";
  if (Math.abs(w) < RANGE_7D_PCT) {
    if (pctB < 0 && rsi < 32) return "revert_long";
    if (pctB > 1 && rsi > 68) return "revert_short";
  }
  return null;
}

const sideOf = (x: MacroSetup): Side => (x.endsWith("long") ? "long" : "short");

function coins(ctx: BeeContext): CoinStats[] {
  return ctx.view.gated.map((id) => ctx.view.stats.get(id)).filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.knobs.spreadGateBps);
}

/**
 * Share of the bee's max notional that MACRO_MAX_LEVERAGE allows: MACRO_MAX_LEVERAGE x equity (with the margin
 * headroom), measured against the max notional, which MAX_LEVERAGE and MAX_NOTIONAL_USD_PER_BEE already cap.
 */
function leverageCap(ctx: BeeContext): number {
  const max = maxNotionalUsd(ctx);
  return max > 0 ? Math.min(1, (ctx.cfg.macro.maxLeverage * ctx.bee.equityUsd * MARGIN_HEADROOM) / max) : 0;
}

export const macro: BeeBrain = {
  id: "macro",
  strategy:
    "You are a macro-squad bee trading gold, silver, oil, stocks and ETFs as X-Perps. Two setups only: TREND (the week and the day agree and price has pulled back: buy the dip in an uptrend, sell the rally in a downtrend) and REVERT (no weekly trend and price stretched outside its band: fade it back to the middle). " +
    "Pick a setup only when it is clean; WAIT is a good answer. These markets keep hours: the code closes you before the session ends. Take profit into strength, cut a position when its setup is gone.",
  convictionLabels: ["tentative", "decent", "clean", "textbook"],
  openGate: { minConviction: 1, minProb: () => 0.45 },
  requiresStrictSetup: true,
  neverForce: true,
  protectAdds: true,
  profitLock: [
    { atPct: 0.8, keep: 0.4 },
    { atPct: 1.5, keep: 0.6 },
    { atPct: 3, keep: 0.75 },
  ],

  universe(ctx) {
    return coins(ctx).map((s) => s.instId);
  },

  snapshotCoins(ctx) {
    const held = ctx.bee.position?.instId;
    const ids = coins(ctx).map((s) => s.instId);
    return held && !ids.includes(held) && ctx.view.stats.has(held) ? [...ids, held] : ids;
  },

  coinSnapshot(s) {
    return {
      setup: macroSetup(s) ?? "none",
      r1h_pct: r2(s.ret1hPct, 2),
      r24h_pct: r2(s.ret24hPct, 2),
      r7d_pct: r2(s.ret7dPct, 1),
      rsi: r2(s.rsi14, 0),
      pct_b: r2(s.pctB, 2),
      macd_pct: r2(s.macdHistPct, 3),
      atr_pct: r2(s.atr14Pct, 2),
      spread_bp: r2(s.spreadBp, 1),
    };
  },

  menu(ctx) {
    const m: Menu = {};
    const p = ctx.bee.position;
    if (!p) {
      for (const s of coins(ctx)) {
        const x = macroSetup(s);
        if (!x) continue;
        const intent: Intent = { kind: "open", instId: s.instId, side: sideOf(x), sizeFrac: 1, setup: "strict" };
        m[`${x.toUpperCase()}_${s.coin}`] = { desc: null, intent };
      }
      if (Object.keys(m).length) m.WAIT = { desc: "no trade yet", intent: { kind: "hold" } };
      return m;
    }
    m.HOLD = { desc: "keep position", intent: { kind: "hold" } };
    const s = ctx.view.stats.get(p.instId);
    const upl = ctx.uplR ?? 0;
    if (upl > 0.5) m.TAKE_PROFIT = { desc: "close in profit", intent: { kind: "close", reason: "take_profit" } };
    if (upl > 1.5) m.TRIM_HALF = { desc: "take half off", intent: { kind: "trim", fraction: 0.5 } };
    // The setup is gone when the day and the momentum have turned against the position.
    const dir = p.side === "long" ? 1 : -1;
    if (s && s.ret24hPct !== null && dir * s.ret24hPct < 0 && dir * (s.macdHistPct ?? 0) < 0) m.CUT = { desc: "setup gone, close", intent: { kind: "close", reason: "setup_gone" } };
    return m;
  },

  forcedEntry() {
    return null; // never forced in: macro markets wait for a setup
  },

  sizeFrac(intent, conviction, ctx) {
    const byConviction = [0.5, 0.65, 0.8, 1][Math.max(0, Math.min(3, conviction))]!;
    const coin = ctx.view.stats.get(intent.instId)?.coin ?? intent.instId.split("-")[0]!;
    const closes = ctx.session?.(coin).closesInMin ?? null;
    const late = closes !== null && closes < LATE_SESSION_MIN ? ctx.cfg.macro.lateSessionSize : 1;
    return byConviction * leverageCap(ctx) * late;
  },

  stopFor(instId, side, entryPx, ctx) {
    return atrStop(ctx.view.stats.get(instId), side, entryPx, ctx.knobs.stopAtrMult);
  },

  forcedClose(ctx) {
    const p = ctx.bee.position;
    if (!p || !ctx.session) return null;
    return mustFlatten(ctx.session(p.coin), ctx.cfg.macro.flatten, ctx.cfg.macro.flattenMin) ? "session_close" : null;
  },

  idleStatus(ctx) {
    const n = coins(ctx).length;
    return n ? `waiting for a trend or reversion setup on ${n} open market${n === 1 ? "" : "s"}` : "no market open: waiting for a verified session";
  },
};
