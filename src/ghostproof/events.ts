// From the engine's own records to AgentProof events. Everything private (the market snapshot Jev saw, the menu, the
// answer, the rules, sizes, prices) is hashed here and never leaves; the hash is what the chain keeps. Recomputing a hash
// from the local row later proves the row is what was anchored.
import { canonicalJson, hashOf, merkleRootHex, sha256B64, sha256Hex } from "./canonical.js";
import { AGENTPROOF_VERSION, AgentProofEvent, type JevEventType } from "./schema.js";

export interface DecisionRow {
  id: number;
  bee: string;
  ts: number;
  state_json: string | null;
  menu_json: string | null;
  choice: string | null;
  probabilities_json: string | null;
  confidence: number | null;
  conviction: number | null;
  action_json: string;
  vetoed_by: string | null;
  forced_by: string | null;
  status: string | null;
  /** From decision_evaluations, when the engine recorded one. */
  policy_version_id: string | null;
  model: string | null;
}
export interface OrderRow {
  id: number;
  decision_id: number;
  bee: string;
  ts: number;
  inst_id: string;
  side: string;
  contracts: number;
  reduce_only: number;
  purpose: string;
  state: string;
  error: string | null;
}
export interface FillRow {
  id: number;
  order_id: number;
  decision_id: number | null;
  bee: string;
  ts: number;
  inst_id: string;
  side: string;
  contracts: number;
  px: number;
  notional_usd: number;
  fee_usd: number;
  realised_usd: number;
}

export interface Context {
  actorId: string;
  mode: "dry" | "demo" | "live";
  /** Jev's model when a row does not name the one that answered. */
  model: string;
}

const parse = (s: string | null): unknown => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return s;
  }
};
const kindOf = (r: DecisionRow): string => String((parse(r.action_json) as { kind?: unknown } | null)?.kind ?? "none");
const marketOf = (instId: string | null | undefined): string | undefined => {
  const coin = instId?.split("-")[0]?.toUpperCase();
  return coin && /^[A-Z0-9]{1,20}$/.test(coin) ? `${coin}-USD` : undefined;
};
const instOf = (r: DecisionRow): string | undefined => {
  const a = parse(r.action_json) as { instId?: unknown } | null;
  return typeof a?.instId === "string" ? a.instId : undefined;
};
const version = (v: string | null | undefined, fallback: string) => (v && /^[A-Za-z0-9:._@/+-]{1,64}$/.test(v) ? v : fallback).slice(0, 64);
const iso = (ms: number) => new Date(ms).toISOString();

/** Everything a decision was, hashed: proves the whole row, private parts included, without revealing it. */
export const decisionHash = (r: DecisionRow): string =>
  hashOf({ v: 1, id: r.id, bee: r.bee, ts: r.ts, state: parse(r.state_json), menu: parse(r.menu_json), choice: r.choice, probabilities: parse(r.probabilities_json), confidence: r.confidence, conviction: r.conviction, action: parse(r.action_json), vetoedBy: r.vetoed_by, forcedBy: r.forced_by, status: r.status });
/** What Jev was shown: the market snapshot and the menu. */
export const inputHash = (r: DecisionRow): string => hashOf({ state: parse(r.state_json), menu: parse(r.menu_json) });
/** What Jev answered. */
export const outputHash = (r: DecisionRow): string => hashOf({ choice: r.choice, probabilities: parse(r.probabilities_json), confidence: r.confidence, conviction: r.conviction });

/** A decision worth its own event: it traded, or code overruled or forced something. The rest go in the hourly digest. */
export function important(r: DecisionRow): boolean {
  const k = kindOf(r);
  return k !== "none" || !!r.vetoed_by || !!r.forced_by;
}

function event(c: Context, e: Omit<AgentProofEvent, "actorId">): AgentProofEvent {
  return AgentProofEvent.parse({ actorId: c.actorId, ...e });
}

/** jev.trade.call.analyzed and jev.trade.policy.decided for one decision. */
export function decisionEvents(c: Context, r: DecisionRow): AgentProofEvent[] {
  const base = {
    callId: `${r.bee}:d${r.id}`,
    inputHash: inputHash(r),
    decisionHash: decisionHash(r),
    policyVersion: version(r.policy_version_id, "engine"),
    modelVersion: version(r.model, c.model),
    createdAt: iso(r.ts),
    safeMetadata: { agent: r.bee, mode: c.mode, timeframe: "tick" as const, ...(marketOf(instOf(r)) ? { market: marketOf(instOf(r)) } : {}) },
  };
  const analyzed = event(c, { ...base, eventType: "jev.trade.call.analyzed", outputHash: outputHash(r), result: r.choice ? "ANSWERED" : "NO_ANSWER" });
  const decided = event(c, { ...base, eventType: "jev.trade.policy.decided", result: r.forced_by ? "FORCED" : r.vetoed_by ? "VETO" : "ALLOW" });
  return [analyzed, decided];
}

export function orderEvent(c: Context, o: OrderRow, model: string, policy: string | null): AgentProofEvent {
  return event(c, {
    eventType: "jev.trade.order.submitted",
    callId: `${o.bee}:d${o.decision_id}`,
    inputHash: hashOf({ decisionId: o.decision_id, bee: o.bee }),
    decisionHash: hashOf({ v: 1, id: o.id, decisionId: o.decision_id, ts: o.ts, instId: o.inst_id, side: o.side, contracts: o.contracts, reduceOnly: o.reduce_only, purpose: o.purpose, state: o.state, error: o.error }),
    policyVersion: version(policy, "engine"),
    modelVersion: version(model, c.model),
    result: o.error || /reject|fail|cancel/i.test(o.state) ? "REJECTED" : "SUBMITTED",
    createdAt: iso(o.ts),
    safeMetadata: { agent: o.bee, mode: c.mode, ...(marketOf(o.inst_id) ? { market: marketOf(o.inst_id) } : {}) },
  });
}

/** jev.trade.order.executed for a fill, and jev.trade.outcome.recorded when it closed with a result. */
export function fillEvents(c: Context, f: FillRow, model: string, policy: string | null): AgentProofEvent[] {
  const fillHash = hashOf({ v: 1, id: f.id, orderId: f.order_id, ts: f.ts, instId: f.inst_id, side: f.side, contracts: f.contracts, px: f.px, notionalUsd: f.notional_usd, feeUsd: f.fee_usd, realisedUsd: f.realised_usd });
  const base = {
    callId: f.decision_id !== null ? `${f.bee}:d${f.decision_id}` : `${f.bee}:f${f.id}`,
    inputHash: hashOf({ orderId: f.order_id, bee: f.bee }),
    decisionHash: fillHash,
    policyVersion: version(policy, "engine"),
    modelVersion: version(model, c.model),
    createdAt: iso(f.ts),
    safeMetadata: { agent: f.bee, mode: c.mode, ...(marketOf(f.inst_id) ? { market: marketOf(f.inst_id) } : {}) },
  };
  const out = [event(c, { ...base, eventType: "jev.trade.order.executed", result: "FILLED" })];
  if (Math.abs(f.realised_usd) > 1e-9) {
    const net = f.realised_usd - f.fee_usd;
    out.push(event(c, { ...base, eventType: "jev.trade.outcome.recorded", outputHash: hashOf({ realisedUsd: f.realised_usd, feeUsd: f.fee_usd }), result: net > 0 ? "WIN" : net < 0 ? "LOSS" : "FLAT" }));
  }
  return out;
}

/** One hour of a bunny's decisions, all of them: their hashes in a Merkle root. Any single decision is later provable from its row. */
export function digestEvent(c: Context, bee: string, hourStart: number, rows: DecisionRow[]): AgentProofEvent {
  const leaves = rows.map(decisionHash);
  return event(c, {
    eventType: "jev.trade.calls.digest",
    callId: `${bee}:h${Math.floor(hourStart / 3_600_000)}`,
    inputHash: merkleRootHex(leaves),
    decisionHash: hashOf({ bee, hourStart, first: rows[0]?.id ?? null, last: rows[rows.length - 1]?.id ?? null, n: rows.length }),
    policyVersion: "digest-v1",
    modelVersion: version(rows.find((r) => r.model)?.model, c.model),
    result: "DIGEST",
    createdAt: iso(hourStart + 3_600_000 - 1),
    safeMetadata: { agent: bee, mode: c.mode, timeframe: "1h", count: rows.length },
  });
}

/**
 * How the AgentProof extension stores the event (docs/GHOSTPROOF.md), so the client knows its leaf before the server
 * answers: eventId = "jevproof_" + sha256(canonical {type, actorGhostId, payload}); leaf = sha256 (base64) of the canonical
 * {eventId, type, timestamp, efpsMapHash, actorGhostId, payload}, the chain's own leaf rule (hashOfEvent).
 */
export function stored(e: AgentProofEvent): { eventId: string; leafHashB64: string } {
  const { eventType, actorId, ...rest } = e;
  const payload = { version: AGENTPROOF_VERSION, ...rest };
  const eventId = `jevproof_${sha256Hex(canonicalJson({ type: eventType, actorGhostId: actorId, payload }))}`;
  const leafHashB64 = sha256B64(canonicalJson({ eventId, type: eventType, timestamp: Date.parse(e.createdAt), efpsMapHash: e.decisionHash, actorGhostId: actorId, payload }));
  return { eventId, leafHashB64 };
}

export type { JevEventType };
