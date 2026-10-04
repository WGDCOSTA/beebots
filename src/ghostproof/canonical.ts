// Canonical JSON and hashing, byte for byte the same as GhostProof's (ghostnode domain/proofchain/canonical.ts):
// keys sorted at every depth, undefined dropped, arrays kept in order. A hash computed here is the hash the chain
// computes, so a Merkle proof can be checked locally without trusting the gateway.
import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = sortKeys(x);
  }
  return out;
}

export function canonicalJson(v: Json | Record<string, unknown> | unknown): string {
  return JSON.stringify(sortKeys(v));
}

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const sha256B64 = (data: string | Buffer): string => createHash("sha256").update(data).digest("base64");
/** The hash of a value's canonical JSON, lowercase hex: what every *Hash field carries. */
export const hashOf = (v: unknown): string => sha256Hex(canonicalJson(v));

/** A Merkle root over hex leaves, the chain's rule (parent = sha256(left || right) on raw bytes, last leaf doubled when odd), as hex. */
export function merkleRootHex(leavesHex: string[]): string {
  if (!leavesHex.length) return sha256Hex("");
  let level: Buffer[] = leavesHex.map((h) => Buffer.from(h, "hex"));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(createHash("sha256").update(Buffer.concat([level[i]!, level[i + 1] ?? level[i]!])).digest());
    level = next;
  }
  return level[0]!.toString("hex");
}

/** The chain's Merkle proof (MerkleProofV1): walk from the leaf to the root with the siblings, base64 throughout. */
export function verifyMerklePath(p: { leafHashB64: string; rootB64: string; path: Array<{ siblingB64: string; side: "left" | "right" }> }): boolean {
  let cur = Buffer.from(p.leafHashB64, "base64");
  for (const step of p.path) {
    const sib = Buffer.from(step.siblingB64, "base64");
    cur = createHash("sha256").update(step.side === "right" ? Buffer.concat([cur, sib]) : Buffer.concat([sib, cur])).digest();
  }
  return cur.toString("base64") === p.rootB64;
}
