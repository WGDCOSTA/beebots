// The deterministic risk layer (hard rule 2: Jev chooses, code decides).
// Pure: no I/O, no clock, no randomness. Every veto, shrink and force says why.

import { exposureUsd, maxNotionalUsd, minutesSince, positionNotional } from "./bees/common.js";
import type { Action, BeeBrain, BeeContext, CapReason, Intent } from "./bees/types.js";

export type { Action } from "./bees/types.js";

export interface Proposal {
  label: string;
  intent: Intent;
  /** Jev's probability for the chosen label. */
  prob: number;
  /** Conviction level, rounded to 0..3. */
  conviction: number;
}

/** "no_options": the menu was empty, so Jev was not asked (forcing rules still apply). */
export type JevStatus = "ok" | "unreachable" | "daily_cap" | "no_options";

export interface RiskInput {
  ctx: BeeContext;
  brain: BeeBrain;
  /** null when Jev was not asked or did not answer. */
  proposal: Proposal | null;
  jev: JevStatus;
  /** 1, or LIVE_SIZE_MULTIPLIER during the live ramp. */
  sizeMult: number;
  /** Age of the last full market refresh. */
  dataAgeMs: number;
  maxDataAgeMs: number;
}

export interface RiskResult {
  action: Action;
  /** Why Jev's choice was not followed as-is. */
  vetoedBy: string | null;
  /** Code forced this action (stop, cap, max-flat...). */
  forcedBy: string | null;
  /** The bee's cap after this check. */
  cap: CapReason | null;
  /** Cap that tripped on this tick (fire an alert + banner). */
  capTripped: CapReason | null;
  /** One line for the dashboard. */
  status: string;
}

const NONE: Action = { kind: "none" };
const isOpening = (i: Intent) => i.kind === "open" || i.kind === "switch" || i.kind === "add" || i.kind === "leg_open";

/** Cap state for a bee, and whether one newly tripped. Caps only escalate within a day. */
export function evaluateCaps(ctx: BeeContext): { cap: CapReason | null; tripped: CapReason | null } {
  const { bee, cfg, knobs } = ctx;
  let cap = bee.cap;
  const set = (c: CapReason) => {
    const tripped = cap === c ? null : c;
    cap = c;
    return tripped;
  };
  if (cap === "retired") return { cap, tripped: null };
  if (bee.equityUsd <= cfg.risk.startEquityUsd * (cfg.risk.retireAtPct / 100)) return { cap: "retired", tripped: set("retired") };
  if (cap === "loss_stop") return { cap, tripped: null };
  if (bee.equityUsd <= bee.dayStartEquityUsd * (1 - cfg.risk.dailyLossStopPct / 100)) return { cap: "loss_stop", tripped: set("loss_stop") };
  if (cap) return { cap, tripped: null };
  if (bee.tradesToday >= knobs.maxTradesPerDay) return { cap: "trade_cap", tripped: set("trade_cap") };
  if (bee.feesTodayUsd >= knobs.feeBudgetUsdDay) return { cap: "fee_budget", tripped: set("fee_budget") };
  return { cap: null, tripped: null };
}

/** Benched bees ride: only a stop (or the loss stop) closes the position before the 00:00 UTC reset. */
const riding = (ctx: BeeContext) => (ctx.bee.position ? `riding its ${ctx.bee.position.coin} until the stop or 00:00 UTC` : "back at 00:00 UTC");

export function capStatus(cap: CapReason, ctx: BeeContext): string {
  switch (cap) {
    case "retired":
      return "retired for good (equity below the retire line)";
    case "loss_stop":
      return "sent home: daily loss stop, flat until 00:00 UTC";
    case "trade_cap":
      return `benched: all ${ctx.knobs.maxTradesPerDay} trade${ctx.knobs.maxTradesPerDay === 1 ? "" : "s"} used today, ${riding(ctx)}`;
    case "fee_budget":
      return `benched: fee budget gone ($${ctx.bee.feesTodayUsd.toFixed(2)} of $${ctx.knobs.feeBudgetUsdDay.toFixed(2)}), ${riding(ctx)}`;
  }
}

interface OpenCheck {
  ok: boolean;
  why?: string;
  notionalUsd?: number;
}

/** Spread gate, funding veto, min size and the size cap for an open/switch/add. */
function checkOpen(intent: Intent, input: RiskInput, conviction: number): OpenCheck {
  const { ctx, brain, sizeMult } = input;
  const { bee, view, knobs } = ctx;
  const max = maxNotionalUsd(ctx) * sizeMult;
  if (!(max > 0)) return { ok: false, why: "no_equity" };
  // Multi-orders: every position shares one leverage cap. Each gets up to max / slots, and together they never pass
  // max. With one slot this is exactly the single-position rule.
  const slots = Math.max(1, ctx.slots ?? 1);
  const perSlot = max / slots;

  if (intent.kind === "add") {
    const p = bee.position!;
    const s = view.stats.get(p.instId);
    const inst = view.instruments.get(p.instId);
    if (!s || !inst) return { ok: false, why: "no_market_data" };
    if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${p.coin} ${s.spreadBp.toFixed(1)}bp` };
    const room = Math.min(perSlot - positionNotional(p, s.mid, inst.ctVal), max - exposureUsd(ctx));
    const n = Math.min(intent.sizeFrac * maxNotionalUsd(ctx) * sizeMult, room);
    const minUsd = inst.minSz * inst.ctVal * s.mid;
    if (n < minUsd) return { ok: false, why: "size_cap" };
    return { ok: true, notionalUsd: n };
  }
  if (intent.kind !== "open" && intent.kind !== "switch" && intent.kind !== "leg_open") return { ok: false, why: "not_opening" };

  const s = view.stats.get(intent.instId);
  const inst = view.instruments.get(intent.instId);
  if (!s || !inst) return { ok: false, why: "no_market_data" };
  if (s.spreadBp > knobs.spreadGateBps) return { ok: false, why: `spread_gate ${s.coin} ${s.spreadBp.toFixed(1)}bp` };
  if (intent.side === "long" && brain.fundingVetoLongZ !== undefined && s.fundingZ !== null && s.fundingZ > brain.fundingVetoLongZ) {
    return { ok: false, why: `funding_veto ${s.coin} z=${s.fundingZ.toFixed(1)}` };
  }
  const asOpen = intent.kind === "leg_open" ? { ...intent, kind: "open" as const } : intent;
  const frac = Math.max(0, Math.min(1, brain.sizeFrac(asOpen, conviction, ctx)));
  // A switch replaces the main position, so its notional frees up; an open or a leg adds to what is held.
  const others = intent.kind === "switch" ? exposureUsd(ctx, bee.position?.instId) : exposureUsd(ctx);
  const n = Math.min(frac * perSlot, max - others);
  if (n <= 0) return { ok: false, why: "exposure_cap" };
  const minUsd = inst.minSz * inst.ctVal * s.mid;
  if (n < minUsd) return { ok: false, why: `below_min_size ${s.coin} $${n.toFixed(2)} < $${minUsd.toFixed(2)}` };
  return { ok: true, notionalUsd: n };
}

function toAction(intent: Intent, notionalUsd?: number): Action {
  switch (intent.kind) {
    case "hold":
      return NONE;
    case "close":
      return { kind: "close", reason: intent.reason };
    case "trim":
      return { kind: "trim", fraction: intent.fraction };
    case "add":
      return { kind: "add", notionalUsd: notionalUsd! };
    case "open":
      return { kind: "open", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
    case "switch":
      return { kind: "switch", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
    case "leg_open":
      return { kind: "leg_open", instId: intent.instId, side: intent.side, notionalUsd: notionalUsd! };
    case "leg_close":
      return { kind: "leg_close", instId: intent.instId, reason: intent.reason };
  }
}

export function applyRisk(input: RiskInput): RiskResult {
  const { ctx, brain, proposal, jev } = input;
  const { bee, view, knobs, now } = ctx;
  const p = bee.position;
  const { cap, tripped } = evaluateCaps(ctx);
  const out = (action: Action, extra: Partial<RiskResult> & { status: string }): RiskResult => ({
    action,
    vetoedBy: null,
    forcedBy: null,
    cap,
    capTripped: tripped,
    ...extra,
  });

  // 1. Retired / daily loss stop: go flat and stay flat. Forcing is suspended.
  if (cap === "retired" || cap === "loss_stop") {
    const status = capStatus(cap, ctx);
    if (p) return out({ kind: "close", reason: cap }, { forcedBy: cap, vetoedBy: proposal ? cap : null, status });
    return out(NONE, { vetoedBy: proposal ? cap : null, status });
  }

  // 2. Code stops fire whatever Jev says, and even when Jev is down.
  if (p) {
    const s = view.stats.get(p.instId);
    if (s && p.stopPx !== null) {
      const hit = p.side === "long" ? s.mid <= p.stopPx : s.mid >= p.stopPx;
      if (hit) return out({ kind: "close", reason: "stop" }, { forcedBy: "stop", vetoedBy: proposal ? "stop" : null, status: `stopped out of ${p.coin}` });
    }
    const fc = brain.forcedClose?.(ctx);
    if (fc) return out({ kind: "close", reason: fc }, { forcedBy: fc, vetoedBy: proposal ? fc : null, status: `${fc.replace(/_/g, " ")}: closing ${p.coin}` });
    const ts = brain.timeStopMinutes?.(ctx);
    if (ts !== undefined && minutesSince(p.openedAt, now) >= ts) {
      return out({ kind: "close", reason: "time_stop" }, { forcedBy: "time_stop", vetoedBy: proposal ? "time_stop" : null, status: `time stop on ${p.coin}` });
    }
  }

  // 3. Jev fail-closed: hold whatever we have, open nothing.
  if (jev === "daily_cap") return out(NONE, { vetoedBy: "jev_daily_cap", status: "Jev daily cap hit: all bees hold" });
  if (jev === "unreachable" || (jev === "ok" && !proposal)) return out(NONE, { vetoedBy: "jev_unreachable", status: "Jev unreachable: holding" });

  let intent: Intent = proposal?.intent ?? { kind: "hold" };
  let vetoedBy: string | null = null;
  let notionalUsd: number | undefined;
  const veto = (why: string) => {
    vetoedBy = why;
    intent = { kind: "hold" };
  };

  // 4. Menu sanity: the intent must fit the position we actually have.
  if (!p && intent.kind !== "open" && intent.kind !== "hold") veto("invalid_while_flat");
  if (p && intent.kind === "open") veto("invalid_while_positioned");
  if (p && intent.kind === "switch" && intent.instId === p.instId && intent.side === p.side) veto("switch_to_same");
  // A main open or switch can't land on a coin already held as a leg (it would merge into the leg).
  if ((intent.kind === "open" || intent.kind === "switch") && (bee.legs ?? []).some((l) => l.instId === (intent as { instId: string }).instId)) veto("already_held");
  // Multi-orders: a leg needs a main position, a free slot and a coin the bee does not hold yet.
  if (intent.kind === "leg_open") {
    const held = [p?.instId, ...(bee.legs ?? []).map((l) => l.instId)];
    if (!p) veto("leg_while_flat");
    else if ((bee.legs?.length ?? 0) + 1 >= Math.max(1, ctx.slots ?? 1)) veto("no_free_slot");
    else if (held.includes(intent.instId)) veto("already_held");
  }
  if (intent.kind === "leg_close") {
    const target = intent.instId;
    if (!(bee.legs ?? []).some((l) => l.instId === target)) veto("no_such_leg");
  }

  // 5. Opening gates.
  if (proposal && isOpening(intent)) {
    const dataStale = input.dataAgeMs > input.maxDataAgeMs;
    const cooldownLeft = bee.lastOrderAt === null ? 0 : knobs.cooldownMinutes - minutesSince(bee.lastOrderAt, now);
    if (cap === "trade_cap" || cap === "fee_budget") veto(cap);
    else if (dataStale) veto("stale_market_data");
    else if (brain.openGate && intent.kind !== "add" && (proposal.prob < brain.openGate.minProb(ctx) || proposal.conviction < brain.openGate.minConviction)) {
      veto(`weak_conviction p=${proposal.prob.toFixed(2)} c=${proposal.conviction}`);
    } else if (brain.requiresStrictSetup && (intent.kind === "open" || intent.kind === "switch" || intent.kind === "leg_open") && intent.setup === "loose") veto("no_setup_yet");
    else if (cooldownLeft > 0) veto(`cooldown ${Math.ceil(cooldownLeft)}m`);
    else {
      const c = checkOpen(intent, input, proposal.conviction);
      if (c.ok) notionalUsd = c.notionalUsd;
      else veto(c.why!);
    }
  }

  let action = toAction(intent, notionalUsd);
  let forcedBy: string | null = null;
  let status = !proposal ? (brain.idleStatus?.(ctx) ?? "no valid options") : vetoedBy ? `wanted ${proposal.label}, code said no: ${vetoedBy}` : proposal.label;

  // 6. Never flat for long (drama rule 2). Suspended while any cap is active or data is stale.
  if (!p && action.kind === "none") {
    const flatMin = minutesSince(bee.flatSince, now);
    if (cap) status = capStatus(cap, ctx);
    else if (input.dataAgeMs > input.maxDataAgeMs) status = "stale market data: waiting";
    else if (brain.neverForce) {
      /* waits for its own setup; status already says what it is waiting for */
    } else if (flatMin >= knobs.maxFlatMinutes) {
      const f = brain.forcedEntry(ctx);
      const c = f ? checkOpen(f, input, 0) : { ok: false, why: "no_candidate" };
      if (f && c.ok) {
        action = toAction(f, c.notionalUsd);
        forcedBy = "max_flat";
        status = `forced in after ${flatMin.toFixed(0)} min flat`;
      } else status = `flat, cannot force: ${c.why}`;
    } else status = `${status} (flat ${flatMin.toFixed(0)}/${knobs.maxFlatMinutes} min)`;
  }
  if (p && action.kind === "none" && cap) status = capStatus(cap, ctx);

  // 7. Sizing is code's job: when Jev holds an undersized position, bring it back to target (not while capped or stale).
  if (p && action.kind === "none" && !cap && brain.rebalance && input.dataAgeMs <= input.maxDataAgeMs) {
    const add = brain.rebalance(ctx);
    const c = add ? checkOpen(add, input, 0) : null;
    if (add && c?.ok) {
      action = toAction(add, c.notionalUsd);
      forcedBy = "rebalance";
      status = `sized up to target (+$${c.notionalUsd!.toFixed(0)})`;
    }
  }

  return { action, vetoedBy, forcedBy, cap, capTripped: tripped, status };
}
