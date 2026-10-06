// dozy-bee: daily time-series momentum on the large coins. The one rule the October 2026 research kept out of sample
// (docs/RESEARCH-2026-10.md): own a coin while its daily close is above the close 90 days ago, leave when it is not.
// Decides on daily bars, so it trades rarely and asks Jev rarely; positions are sized by volatility, not by a stop.
import type { CoinStats } from "../market/types.js";
import { maxNotionalUsd, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Menu } from "./types.js";

/** How far the catastrophe stop sits: 3 daily ATRs, never closer than 8% nor wider than 30%. */
const STOP_ATR = 3;
const STOP_MIN = 0.08;
const STOP_MAX = 0.3;
/** Coins offered at once (best momentum first). */
const SHOWN = 5;

/** Coins in a 90-day uptrend, strongest first. */
export function dozyCandidates(ctx: BeeContext): CoinStats[] {
  const coins = new Set(ctx.cfg.dozy.coins);
  return [...ctx.view.stats.values()]
    .filter((s) => coins.has(s.coin) && s.daily?.mom90Pct != null && s.daily.mom90Pct > 0 && s.spreadBp <= ctx.knobs.spreadGateBps)
    .sort((a, b) => b.daily!.mom90Pct! - a.daily!.mom90Pct!);
}

/**
 * Share of max notional for one position: the whole book aims at DOZY_VOL_TARGET_PCT daily volatility, split across
 * the positions it may hold (one position: the full target; three: a third each), never above 1x equity per coin.
 */
export function dozySizeFrac(s: CoinStats | undefined, ctx: BeeContext): number {
  const max = maxNotionalUsd(ctx);
  const vol = s?.daily?.volPct;
  if (!(max > 0) || !vol || !(vol > 0)) return 0;
  // The risk layer gives each position this share of (max notional / slots), so the slots split the target.
  return Math.max(0, Math.min(1, (ctx.bee.equityUsd * Math.min(1, ctx.cfg.dozy.volTargetPct / vol)) / max));
}

export const dozy: BeeBrain = {
  id: "dozy",
  strategy:
    "You are Dozy, the patient daily trend follower. You own large coins only while their daily close is above the close of 90 days ago, " +
    "the strongest first, and you leave a coin as soon as that stops being true (code closes it). You decide on daily bars: " +
    "intraday noise, one red candle or a scary headline are not reasons to act. Take the strongest uptrend on offer, add another " +
    "uptrending coin when a slot is free, and otherwise HOLD or WAIT. In a market where nothing is above its 90-day level you stay out: that is the method working.",
  convictionLabels: ["noise", "uptrend", "strong uptrend", "leader"],
  neverForce: false,
  ownSizing: true,

  universe(ctx) {
    return dozyCandidates(ctx).map((s) => s.instId);
  },
  snapshotCoins(ctx) {
    const ids = dozyCandidates(ctx).slice(0, SHOWN + 1).map((s) => s.instId);
    for (const p of [ctx.bee.position, ...(ctx.bee.legs ?? [])]) if (p && !ids.includes(p.instId)) ids.push(p.instId);
    return ids;
  },
  coinSnapshot(s) {
    return {
      mom90_pct: r2(s.daily?.mom90Pct ?? null, 1),
      vol_day_pct: r2(s.daily?.volPct ?? null, 2),
      atr_day_pct: r2(s.daily?.atrPct ?? null, 2),
      ret7d_pct: r2(s.ret7dPct, 1),
      funding_z: r2(s.fundingZ, 1),
    };
  },
  menu(ctx) {
    const m: Menu = {};
    if (ctx.bee.position) {
      m.HOLD = { desc: "the 90-day trend still holds; code exits when it breaks", intent: { kind: "hold" } };
      return m;
    }
    for (const s of dozyCandidates(ctx).slice(0, SHOWN)) {
      m[`TREND_${s.coin}`] = {
        desc: `+${r2(s.daily!.mom90Pct!, 1)}% over 90 days, ${r2(s.daily!.volPct ?? null, 1)}%/day volatility`,
        intent: { kind: "open", instId: s.instId, side: "long", sizeFrac: dozySizeFrac(s, ctx), setup: "strict" },
      };
    }
    m.WAIT = { desc: "no uptrend worth owning yet", intent: { kind: "hold" } };
    return m;
  },
  forcedEntry(ctx) {
    // Systematic: when it has been flat a while and a coin is in an uptrend, own the strongest.
    const s = dozyCandidates(ctx)[0];
    return s ? { kind: "open", instId: s.instId, side: "long", sizeFrac: dozySizeFrac(s, ctx), setup: "strict" } : null;
  },
  sizeFrac(intent, _conviction, ctx) {
    return dozySizeFrac(ctx.view.stats.get(intent.instId), ctx);
  },
  stopFor(instId, side, entryPx, ctx) {
    const atr = ctx.view.stats.get(instId)?.daily?.atrPct;
    const dist = Math.min(STOP_MAX, Math.max(STOP_MIN, atr ? (STOP_ATR * atr) / 100 : STOP_MAX));
    return side === "long" ? entryPx * (1 - dist) : entryPx * (1 + dist);
  },
  forcedClose(ctx) {
    const p = ctx.bee.position;
    const mom = p ? ctx.view.stats.get(p.instId)?.daily?.mom90Pct : undefined;
    // Only a known, broken trend closes: missing data keeps the position (the stop still guards it).
    return mom != null && mom <= 0 ? "trend_over" : null;
  },
  idleStatus(ctx) {
    return dozyCandidates(ctx).length ? "picking the strongest 90-day uptrend" : "no large coin above its 90-day level: staying out";
  },
};
