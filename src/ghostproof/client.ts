// The GhostProof gateway, typed. Fail-closed: every answer is schema-checked, an answer that does not match what was sent
// is an error, and only 429 and 503 are retried (with Retry-After). Nothing here writes a block or calls the node-only
// /proofchain/events route.
import { z } from "zod";
import { verifyMerklePath } from "./canonical.js";
import { stored } from "./events.js";
import { AgentProofEvent, Block, MerkleProof, Status, SubmitResponse } from "./schema.js";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class GhostProofError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 for a network failure, or -1 for an integrity failure (the answer does not match). */
    readonly status: number,
    readonly code: "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "rate_limited" | "unavailable" | "network" | "integrity" | "http",
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
  /** Worth trying again later (the event stays queued). */
  get transient(): boolean {
    return this.code === "rate_limited" || this.code === "unavailable" || this.code === "network";
  }
}

const codeOf = (s: number): GhostProofError["code"] => (s === 400 ? "bad_request" : s === 401 ? "unauthorized" : s === 403 ? "forbidden" : s === 404 ? "not_found" : s === 409 ? "conflict" : s === 429 ? "rate_limited" : s === 503 ? "unavailable" : "http");

export interface ClientOpts {
  /** e.g. https://gateway.efps.live/api */
  baseUrl: string;
  /** The GhostID JWT, read when needed (never logged). */
  token: () => string | null;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Tries for a 429 or 503 before giving up for now. */
  maxTries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The gateway's window: no more than 5 minutes ahead, no more than 24 hours old. */
const FUTURE_MS = 5 * 60_000;
const PAST_MS = 24 * 3_600_000;

export class GhostProofClient {
  private readonly f: Fetch;
  private readonly base: string;
  constructor(private readonly o: ClientOpts) {
    this.f = o.fetch ?? ((u, i) => fetch(u, i));
    this.base = o.baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}, auth = false): Promise<T> {
    const tries = Math.max(1, this.o.maxTries ?? 3);
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let last: GhostProofError | null = null;
    for (let i = 0; i < tries; i++) {
      const headers: Record<string, string> = { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) };
      if (auth) {
        const t = this.o.token();
        if (!t) throw new GhostProofError("No GhostID token configured", 401, "unauthorized");
        headers.authorization = `Bearer ${t}`;
      }
      let res: Response;
      try {
        res = await this.f(`${this.base}${path}`, { ...init, headers, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
      } catch (e) {
        last = new GhostProofError(`GhostProof unreachable: ${(e as Error).message}`, 0, "network");
        await sleep(1000 * 2 ** i);
        continue;
      }
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const p = schema.safeParse(body);
        if (!p.success) throw new GhostProofError(`Unexpected GhostProof answer from ${path}`, -1, "integrity");
        return p.data;
      }
      const ra = Number(res.headers.get("retry-after"));
      const err = new GhostProofError(`GhostProof ${path} answered ${res.status}`, res.status, codeOf(res.status), Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
      if (!err.transient || err.code === "network") throw err;
      last = err;
      if (i < tries - 1) await sleep(err.retryAfterMs ?? 1000 * 2 ** i);
    }
    throw last!;
  }

  /**
   * Submits one event to the AgentProof extension. The answer must name the event this client computed (same eventId),
   * or it is an integrity failure: a gateway that stored something else must not be trusted with the next one.
   */
  async submit(event: AgentProofEvent): Promise<SubmitResponse> {
    const p = AgentProofEvent.safeParse(event);
    if (!p.success) throw new GhostProofError(`Event refused locally: ${p.error.issues[0]?.path.join(".") ?? "schema"}`, 400, "bad_request");
    const e = p.data;
    const at = Date.parse(e.createdAt);
    const now = (this.o.now ?? Date.now)();
    if (at > now + FUTURE_MS) throw new GhostProofError("Event refused locally: createdAt is in the future", 400, "bad_request");
    if (at < now - PAST_MS) throw new GhostProofError("Event refused locally: older than the gateway's window", 400, "bad_request");
    const r = await this.call("/agentproof/v1/events", SubmitResponse, { method: "POST", body: JSON.stringify({ event: e }) }, true);
    if (r.eventId !== stored(e).eventId) throw new GhostProofError("GhostProof stored a different event than the one sent", -1, "integrity");
    return r;
  }

  status() {
    return this.call("/proofchain/status", Status);
  }

  block(height: number) {
    return this.call(`/proofchain/blocks/${height}`, Block);
  }

  /** The newest blocks, newest first. */
  async recentBlocks(limit = 20): Promise<Block[]> {
    const r = await this.call(`/proofchain/blocks?order=desc&offset=0&limit=${limit}`, z.object({ blocks: z.array(Block) }).passthrough());
    return r.blocks;
  }

  proof(leafHashB64: string, epochId: string, blockHeight: number) {
    return this.call(`/proofchain/verify/file/agentproof/proof?eventId=${encodeURIComponent(leafHashB64)}&epochId=${encodeURIComponent(epochId)}&blockHeight=${blockHeight}`, MerkleProof);
  }

  verifyChain() {
    return this.call("/proofchain/verify/chain", z.object({ ok: z.boolean() }).passthrough());
  }

  /**
   * Checks an anchored event end to end, locally: the block for its epoch, the Merkle path from the leaf this client
   * computed, and that the path ends at the root the block carries. Returns the block height, or null when the epoch
   * has no block yet (still pending). Throws on any mismatch.
   */
  async verify(leafHashB64: string, epochId: string): Promise<number | null> {
    const block = (await this.recentBlocks(50)).find((b) => b.epoch.epochId === epochId) ?? null;
    if (!block) return null;
    const p = await this.proof(leafHashB64, epochId, block.height);
    if (p.leafHashB64 !== leafHashB64) throw new GhostProofError("Merkle proof is for another leaf", -1, "integrity");
    if (p.rootB64 !== block.epoch.eventsRootB64) throw new GhostProofError("Merkle proof root differs from the block's", -1, "integrity");
    if (!verifyMerklePath(p)) throw new GhostProofError("Merkle path does not lead to the root", -1, "integrity");
    return block.height;
  }
}
