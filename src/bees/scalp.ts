// The scalper (phase 2): a method a bee's brains may choose (only once the strategy lab has found an edge after costs).
//
// Two clocks. Jev is the SLOW one: with no mandate, at most every SCALP_MANDATE_MIN minutes it is offered
// SCALP_ON_<coin>_<bias> (or WAIT) and its choice becomes a MANDATE: a coin, a bias, a lifetime and a trade budget. The
// FAST clock is code: inside a mandate the engine's scalp loop runs the lab's rule on the coin's latest 1-minute
// candles every couple of seconds and trades it, with no Jev call per trade. The risk layer keeps its last word on
// every entry, stop and cap, and the cost gate is the lab's own: a target must be worth its round trip.
//
// Nothing here sends an order. The brain returns a plan; the engine places the maker limit (engine.ts scalpStep).
import type { Config } from "../config.js";
import { passesCostGate, roundTripCostBps, scalpRule, tradeParams, type CostModel } from "../lab/scalp.js";
import * as S from "../lab/series.js";
import type { Params } from "../lab/skills/types.js";
import type { Candle, CoinStats } from "../market/types.js";
import { atrStop, r2 } from "./common.js";
import type { BeeBrain, BeeContext, Intent, Menu, Side } from "./types.js";

/** What the lab's report says passed, per coin (scalpGate().rules). */
export interface GateRule {
  coin: string;
  ruleId: string;
  params: Params;
  netBps: number;
  trades: number;
}

export interface ScalpDeps {
  /** The lab's evidence now. Empty = the gate is closed: nothing new is opened. */
  rules: () => GateRule[];
  costs: () => CostModel;
  cfg: Config["scalp"];
}

export interface Mandate {
  coin: string;
  instId: string;
  bias: "long" | "short" | "both";
  issuedAt: number;
  expiresAt: number;
  maxTrades: number;
  used: number;
}

export interface ScalpPlan {
  label: string;
  instId: string;
  coin: string;
  side: Side;
  /** Maker limit price (the touch, or the rule's own price if better); ignored when `maker` is false. */
  limitPx: number;
  maker: boolean;
  /** The target exit rests as a maker limit (else it is a taker close when touched). */
  makerTarget: boolean;
  targetBps: number;
  stopBps: number;
  holdMin: number;
  ruleId: string;
  /** Timestamp of the 1-minute bar that signalled: one trade per signal bar. */
  signalTs: number;
  intent: Extract<Intent, { kind: "open" }>;
}

export interface ScalpStatus {
  mandate: Mandate | null;
  pausedUntil: number;
  lossStreak: number;
  gateOpen: boolean;
  note: string;
}

export interface ScalpApi {
  mandate(now: number): Mandate | null;
  /** Everything needed to try an entry now, or why not. */
  entry(ctx: BeeContext): ScalpPlan | { why: string };
  /** The plan the next fill belongs to (stopFor reads it). */
  begin(plan: ScalpPlan): void;
  opened(fillPx: number, entryFeeUsd: number, now: number): void;
  /** Whether the open scalp's target exit should be a maker limit. */
  makerTarget(): boolean;
  /** A scalp closed: gross realised P&L and this fill's fee (the entry fee was taken at `opened`). */
  closed(realisedUsd: number, exitFeeUsd: number, now: number): void;
  status(now: number): ScalpStatus;
}

export type ScalpBrain = BeeBrain & { scalp: ScalpApi };
export const isScalpBrain = (b: BeeBrain): b is ScalpBrain => b.id === "scalp" && "scalp" in b;

const hold: Intent = { kind: "hold" };
const ON = /^SCALP_ON_([A-Z0-9]+)_(BOTH|LONG|SHORT)$/;

export function scalpBrain(d: ScalpDeps): ScalpBrain {
  let mandate: Mandate | null = null;
  let lastAsk = -Infinity;
  let pausedUntil = 0;
  let lossStreak = 0;
  let pending: ScalpPlan | null = null;
  let active: { instId: string; targetBps: number; stopBps: number; holdMin: number; entryFeeUsd: number; makerTarget: boolean } | null = null;
  const lastSignalTs = new Map<string, number>();
  const sigCache = new Map<string, Int8Array>();

  const gate = () => d.rules().filter((r) => d.cfg.coins.includes(r.coin));
  const ruleFor = (coin: string) => gate().find((r) => r.coin === coin);
  const live = (now: number) => (mandate && now < mandate.expiresAt && mandate.used < mandate.maxTrades ? mandate : null);
  const instIdOf = (ctx: BeeContext, coin: string): string | null => {
    for (const i of ctx.view.instruments.values()) if (i.coin === coin && i.kind === "crypto" && i.state === "live" && ctx.view.stats.has(i.instId)) return i.instId;
    return null;
  };
  const universe = (ctx: BeeContext): string[] =>
    gate()
      .map((g) => instIdOf(ctx, g.coin))
      .filter((x): x is string => !!x);
  const atrBps = (c: Candle[]): number | null => {
    const a = S.atr(c, 14)[c.length - 1];
    const px = c[c.length - 1]?.c;
    return a !== undefined && Number.isFinite(a) && px ? (a / px) * 1e4 : null;
  };

  const api: ScalpApi = {
    mandate: (now) => live(now),
    begin: (plan) => void (pending = plan),
    opened(fillPx, entryFeeUsd, now) {
      const p = pending;
      if (!p) return;
      active = { instId: p.instId, targetBps: p.targetBps, stopBps: p.stopBps, holdMin: p.holdMin, entryFeeUsd, makerTarget: p.makerTarget };
      lastSignalTs.set(p.instId, p.signalTs);
      if (mandate) mandate.used++;
      void fillPx;
      void now;
    },
    makerTarget: () => active?.makerTarget ?? true,
    closed(realisedUsd, exitFeeUsd, now) {
      const net = realisedUsd - exitFeeUsd - (active?.entryFeeUsd ?? 0);
      active = null;
      pending = null;
      lossStreak = net < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= d.cfg.maxLossStreak) {
        pausedUntil = now + d.cfg.pauseMin * 60_000;
        lossStreak = 0;
      }
    },
    status(now) {
      const m = live(now);
      const paused = now < pausedUntil;
      const open = gate().length > 0;
      return {
        mandate: m,
        pausedUntil,
        lossStreak,
        gateOpen: open,
        note: !open ? "the lab gate is closed: no new scalps" : paused ? `paused after ${d.cfg.maxLossStreak} losses in a row, ${Math.ceil((pausedUntil - now) / 60_000)} min left` : m ? `scalping ${m.coin} (${m.bias}), ${m.used}/${m.maxTrades} trades, ${Math.max(0, Math.ceil((m.expiresAt - now) / 60_000))} min left` : "no mandate: waiting for Jev's next one",
      };
    },
    entry(ctx) {
      const now = ctx.now;
      const m = live(now);
      if (!m) return { why: "no mandate" };
      if (now < pausedUntil) return { why: "paused by the circuit breaker" };
      const gr = ruleFor(m.coin);
      if (!gr) return { why: "the lab gate no longer lists this coin" };
      const rule = scalpRule(gr.ruleId);
      if (!rule) return { why: `unknown rule ${gr.ruleId}` };
      const s = ctx.view.stats.get(m.instId);
      if (!s) return { why: "no market data for the coin" };
      const c = ctx.candles1m?.(m.instId) ?? [];
      if (c.length < 130) return { why: `only ${c.length} one-minute candles` };
      const last = c[c.length - 1]!;
      if (now - (last.ts + 60_000) > 3 * 60_000) return { why: "one-minute data is stale" };
      const key = `${m.instId}:${last.ts}:${last.c}`;
      let sig = sigCache.get(key);
      if (!sig) {
        try {
          sig = rule.signal(c, { ...rule.defaults, ...gr.params });
        } catch {
          return { why: "the rule failed" };
        }
        if (sigCache.size > 50) sigCache.clear();
        sigCache.set(key, sig);
      }
      const dir = sig[c.length - 1] as 0 | 1 | -1;
      if (dir === 0) return { why: "no signal on the last bar" };
      if ((dir === 1 && m.bias === "short") || (dir === -1 && m.bias === "long")) return { why: `signal against the mandate's ${m.bias} bias` };
      if (lastSignalTs.get(m.instId) === last.ts) return { why: "this signal bar was already traded" };
      if (s.spreadBp > d.cfg.knobs.spreadGateBps) return { why: `spread ${s.spreadBp.toFixed(1)} bp over the ${d.cfg.knobs.spreadGateBps} bp gate` };
      const tp = tradeParams({ ...rule.defaults, ...gr.params });
      const a = atrBps(c);
      if (a === null) return { why: "ATR not ready" };
      if (!(a >= tp.minAtrBps && a <= tp.maxAtrBps)) return { why: `ATR ${a.toFixed(1)} bp outside the rule's band` };
      const costs = d.costs();
      const targetBps = tp.targetAtr * a;
      if (!passesCostGate(targetBps, costs, tp)) return { why: `target ${targetBps.toFixed(1)} bp is under ${tp.costGateMult}x its ${roundTripCostBps(costs, tp.makerEntry > 0, tp.makerTarget > 0).toFixed(1)} bp round trip` };
      const maker = tp.makerEntry > 0;
      const wanted = last.c * (1 - dir * (tp.entryOffsetBps / 1e4));
      // Join the touch: never cross the book (post-only) and never pay up for the fill.
      const limitPx = dir === 1 ? Math.min(s.bid, wanted) : Math.max(s.ask, wanted);
      const side: Side = dir === 1 ? "long" : "short";
      return {
        label: `SCALP_${side.toUpperCase()}_${m.coin}`,
        instId: m.instId,
        coin: m.coin,
        side,
        limitPx,
        maker,
        makerTarget: tp.makerTarget > 0,
        targetBps,
        stopBps: tp.stopAtr * a,
        holdMin: Math.max(1, Math.round(tp.holdBars)),
        ruleId: gr.ruleId,
        signalTs: last.ts,
        intent: { kind: "open", instId: m.instId, side, sizeFrac: 1, setup: "strict" },
      };
    },
  };

  const brain: BeeBrain = {
    id: "scalp",
    strategy:
      "You set the MANDATE for a scalping bee; you do not place its trades. When it has none you are offered SCALP_ON_<coin>_<bias>: scalp that coin long only, short only or both ways for a while. " +
      "Code then trades the strategy lab's rule on 1-minute candles with maker orders, inside hard stops and a trade budget. Each coin shows the lab's out-of-sample edge after costs (lab_net_bp, lab_trades), its 1-minute ATR (atr_bp), the spread, and target_cost_x: how many times the target covers the round-trip cost (over 3 is what the gate needs). " +
      "Scalps pay off in liquid, active, tight-spread conditions and lose to fees in dead or wild ones. WAIT is a good answer: a bad mandate costs fees on every trade.",
    convictionLabels: ["tentative", "decent", "clean", "textbook"],
    openGate: { minConviction: 0, minProb: () => 0 },
    neverForce: true,
    requiresStrictSetup: false,

    universe,
    snapshotCoins(ctx) {
      const held = ctx.bee.position?.instId;
      const ids = universe(ctx);
      return held && !ids.includes(held) ? [...ids, held] : ids;
    },
    coinSnapshot(s: CoinStats, ctx) {
      const g = ruleFor(s.coin);
      const c = ctx.candles1m?.(s.instId) ?? [];
      const a = c.length >= 30 ? atrBps(c) : null;
      const tp = g ? tradeParams({ ...(scalpRule(g.ruleId)?.defaults ?? {}), ...g.params }) : null;
      const costs = d.costs();
      return {
        lab_net_bp: g ? r2(g.netBps, 1) : null,
        lab_trades: g?.trades ?? null,
        atr_bp: a === null ? null : r2(a, 1),
        spread_bp: r2(s.spreadBp, 1),
        target_cost_x: a !== null && tp ? r2((tp.targetAtr * a) / roundTripCostBps(costs, tp.makerEntry > 0, tp.makerTarget > 0), 1) : null,
        r1h_pct: r2(s.ret1hPct, 2),
        r24h_pct: r2(s.ret24hPct, 1),
        vol_z: r2(s.volZ, 1),
      };
    },
    menu(ctx) {
      const m: Menu = {};
      if (ctx.bee.position) {
        m.HOLD = { desc: null, intent: hold };
        return m;
      }
      const now = ctx.now;
      // Mandate active, paused, gate closed, or asked recently: one legal answer, so Jev is not called.
      if (live(now) || now < pausedUntil || !gate().length || now - lastAsk < d.cfg.mandateMin * 60_000) {
        m.WAIT = { desc: null, intent: hold };
        return m;
      }
      for (const g of gate()) {
        const id = instIdOf(ctx, g.coin);
        const s = id ? ctx.view.stats.get(id) : undefined;
        if (!id || !s || s.spreadBp > d.cfg.knobs.spreadGateBps) continue;
        for (const bias of ["BOTH", "LONG", "SHORT"] as const) m[`SCALP_ON_${g.coin}_${bias}`] = { desc: bias === "BOTH" ? `scalp ${g.coin} both ways for ${d.cfg.mandateMinutes} min` : `scalp ${g.coin} ${bias.toLowerCase()} only for ${d.cfg.mandateMinutes} min`, intent: hold };
      }
      m.WAIT = { desc: "no scalping now", intent: hold };
      return m;
    },
    onChoice(label, ctx) {
      lastAsk = ctx.now;
      const hit = ON.exec(label);
      if (!hit) return;
      const coin = hit[1]!;
      const instId = instIdOf(ctx, coin);
      if (!instId || !ruleFor(coin)) return;
      mandate = { coin, instId, bias: hit[2]!.toLowerCase() as Mandate["bias"], issuedAt: ctx.now, expiresAt: ctx.now + d.cfg.mandateMinutes * 60_000, maxTrades: d.cfg.mandateTrades, used: 0 };
    },
    forcedEntry: () => null,
    sizeFrac: () => d.cfg.sizeFrac,
    stopFor(instId, side, entryPx, ctx) {
      const plan = pending && pending.instId === instId ? pending : null;
      if (plan) return entryPx * (1 - (side === "long" ? 1 : -1) * (plan.stopBps / 1e4));
      return atrStop(ctx.view.stats.get(instId), side, entryPx, d.cfg.knobs.stopAtrMult);
    },
    forcedClose(ctx) {
      const p = ctx.bee.position;
      if (!p || !active || active.instId !== p.instId) return null;
      const mid = ctx.view.stats.get(p.instId)?.mid;
      if (!mid) return null;
      const dir = p.side === "long" ? 1 : -1;
      return dir * (mid - p.entryPx) >= (p.entryPx * active.targetBps) / 1e4 ? "scalp_target" : null;
    },
    timeStopMinutes: () => active?.holdMin ?? 15,
    idleStatus: (ctx) => api.status(ctx.now).note,
  };
  return Object.assign(brain, { scalp: api });
}
