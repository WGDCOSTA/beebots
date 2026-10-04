// The AgentProof contract: what a trading decision looks like when it leaves for GhostProof. Metadata and hashes only.
// The event types and fields follow the GhostProof team's proposal for `POST /agentproof/v1/events`; the server side does
// not exist yet (ghostnode has only /ghostdb/proofs, whose types are GhostDB's), so this is the contract the client
// holds itself to and the extension implements (docs/GHOSTPROOF.md).
import { z } from "zod";

export const AGENTPROOF_VERSION = "agentproof.event.v1";

export const JEV_EVENT_TYPES = [
  "jev.trade.call.analyzed",
  "jev.trade.policy.decided",
  "jev.trade.order.submitted",
  "jev.trade.order.executed",
  "jev.trade.outcome.recorded",
  /** One per bunny per hour: the Merkle root of every decision in that hour, so all of them are covered, not only the trades. */
  "jev.trade.calls.digest",
] as const;
export type JevEventType = (typeof JEV_EVENT_TYPES)[number];

export const RESULTS = ["ANSWERED", "NO_ANSWER", "ALLOW", "VETO", "FORCED", "SUBMITTED", "REJECTED", "FILLED", "WIN", "LOSS", "FLAT", "DIGEST"] as const;

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9:._-]+$/);
const Version = z.string().min(1).max(64).regex(/^[A-Za-z0-9:._@/+-]+$/);

/** The only metadata that may travel in clear: nothing about the strategy, the rules, the prompt, sizes or the account. */
export const SafeMetadata = z
  .object({
    market: z.string().regex(/^[A-Z0-9]{1,20}-USDT?$/).optional(),
    timeframe: z.enum(["tick", "1m", "5m", "15m", "1h", "4h", "1d"]).optional(),
    agent: z.string().regex(/^bee[1-9]$/).optional(),
    mode: z.enum(["dry", "demo", "live"]).optional(),
    count: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const AgentProofEvent = z
  .object({
    eventType: z.enum(JEV_EVENT_TYPES),
    actorId: Id,
    callId: Id,
    inputHash: Hash,
    decisionHash: Hash,
    outputHash: Hash.optional(),
    policyVersion: Version,
    modelVersion: Version,
    result: z.enum(RESULTS),
    createdAt: z.string().datetime({ offset: true }),
    safeMetadata: SafeMetadata,
  })
  .strict();
export type AgentProofEvent = z.infer<typeof AgentProofEvent>;

export const SubmitResponse = z
  .object({
    accepted: z.literal(true),
    eventId: z.string().regex(/^jevproof_[a-f0-9]{64}$/),
    epochId: z.string().regex(/^[0-9]{13}:[1-9][0-9]{0,4}$/),
    status: z.literal("submitted"),
    anchorRef: z.string(),
  })
  .strict()
  .refine((r) => r.anchorRef === `proofchain:event:${r.eventId}`, "anchorRef does not match eventId");
export type SubmitResponse = z.infer<typeof SubmitResponse>;

/** GET /proofchain/verify/file/:x/proof (MerkleProofV1). */
export const MerkleProof = z.object({
  version: z.literal(1),
  epochId: z.string(),
  blockHeight: z.number().int().nonnegative(),
  rootB64: z.string(),
  leafHashB64: z.string(),
  leafIndex: z.number().int().nonnegative(),
  path: z.array(z.object({ siblingB64: z.string(), side: z.enum(["left", "right"]) })),
});
export type MerkleProof = z.infer<typeof MerkleProof>;

/** The parts of a block (ProofBlockV1) the client checks. */
export const Block = z.object({
  height: z.number().int().nonnegative(),
  blockHashB64: z.string(),
  prevBlockHashB64: z.string(),
  epoch: z.object({ epochId: z.string(), eventsRootB64: z.string(), eventsCount: z.number().int().nonnegative() }).passthrough(),
}).passthrough();
export type Block = z.infer<typeof Block>;

export const Status = z.object({ latestBlock: z.object({ height: z.number().int().nonnegative() }).passthrough(), currentEpoch: z.object({ id: z.string() }).passthrough() }).passthrough();
