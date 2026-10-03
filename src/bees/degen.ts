// Degen's evidence-free fallback. Its normal method is the faster scalp brain (engine.ts), whose entries require the
// one-minute lab gate. This brain exists for explicit specialisation and for graceful operation while that gate is
// rebuilding: short-lived, two-sided opportunities across every liquid crypto coin, still behind the same hard risk.
import type { CoinStats } from "../market/types.js";
import { atrStop, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu, Side } from "./types.js";

interface Candidate {
  s: CoinStats;
  side: Side;
  score: number;
}

const candidates = (ctx: BeeContext): Candidate[] =>
  ctx.view.gated
    .map((id) => ctx.view.stats.get(id))
    .filter((s): s is CoinStats => !!s && s.ret1hPct !== null && s.spreadBp <= ctx.knobs.spreadGateBps)
    .map((s) => {
      const move = s.ret1hPct ?? 0;
      const impulse = s.macdHistPct ?? 0;
      const side: Side = move + impulse >= 0 ? "long" : "short";
      // Fast movement matters, but a volume expansion and a tight spread decide between similar moves.
      const score = Math.abs(move) + 0.2 * Math.max(0, s.volZ ?? 0) - 0.1 * s.spreadBp;
      return { s, side, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

export const degen: BeeBrain = {
  id: "degen",
  strategy:
    "You are Degen, the autonomous scalper. Seek short, fast trades in either direction across every liquid crypto X-Perp. " +
    "Prefer tight spreads, live volume and a clean one-hour impulse; a tiny move that cannot clear fees is not an edge. " +
    "Bank modest gains, cut a failed impulse quickly, and WAIT rather than trade for entertainment. Your lab evidence, hard stops, fee budget, daily loss stop and death line always outrank aggression.",
  convictionLabels: ["noise", "tradeable", "sharp", "surgical"],
  neverForce: true,
  requiresStrictSetup: true,
  openGate: { minConviction: 1, minProb: () => 0.55 },
  profitLock: [
    { atPct: 0.35, keep: 0.55 },
    { atPct: 0.7, keep: 0.72 },
  ],

  universe(ctx) {
    return candidates(ctx).map((c) => c.s.instId);
  },
  snapshotCoins(ctx) {
    const ids = candidates(ctx).slice(0, 8).map((c) => c.s.instId);
    const held = ctx.bee.position?.instId;
    if (held && !ids.includes(held)) ids.push(held);
    return ids;
  },
  coinSnapshot(s) {
    return {
      impulse_1h_pct: r2(s.ret1hPct, 2),
      macd_pct: r2(s.macdHistPct, 3),
      atr_pct: r2(s.atr14Pct, 2),
      vol_z: r2(s.volZ, 1),
      oi_1h_pct: r2(s.oiChg1hPct, 1),
      funding_z: r2(s.fundingZ, 1),
      spread_bp: r2(s.spreadBp, 1),
      vol_musd: r2(s.vol24hUsd / 1e6, 1),
    };
  },
  menu(ctx) {
    const m: Menu = {};
    const p = ctx.bee.position;
    if (!p) {
      for (const c of candidates(ctx).slice(0, 8)) {
        const label = `QUICK_${c.side.toUpperCase()}_${c.s.coin}`;
        m[label] = { desc: `${r2(c.s.ret1hPct, 2)}% impulse, ${r2(c.s.spreadBp, 1)} bp spread`, intent: { kind: "open", instId: c.s.instId, side: c.side, sizeFrac: 0.35, setup: "strict" } };
      }
      m.WAIT = { desc: "no clean short-term edge", intent: { kind: "hold" } };
      return m;
    }
    m.HOLD = { desc: "let the target, stop or time limit work", intent: { kind: "hold" } };
    const s = ctx.view.stats.get(p.instId);
    const signedImpulse = s?.ret1hPct === null || s?.ret1hPct === undefined ? 0 : (p.side === "long" ? 1 : -1) * s.ret1hPct;
    if (signedImpulse < 0) m.CUT_FAILED_IMPULSE = { desc: "the fast impulse reversed", intent: { kind: "close", reason: "impulse_reversed" } };
    if ((ctx.uplR ?? 0) >= 0.7) m.BANK = { desc: "capture the short gain", intent: { kind: "close", reason: "short_profit" } };
    return m;
  },
  forcedEntry: () => null,
  sizeFrac(intent) {
    return intent.sizeFrac;
  },
  stopFor(instId, side, entryPx, ctx) {
    return atrStop(ctx.view.stats.get(instId), side, entryPx, 1.2);
  },
  timeStopMinutes: () => 30,
  idleStatus: () => "waiting for a fast edge that clears costs",
};
