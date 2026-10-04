import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { canonicalJson, hashOf, merkleRootHex, sha256B64, verifyMerklePath } from "../src/ghostproof/canonical.js";
import { GhostProofClient, GhostProofError, type Fetch } from "../src/ghostproof/client.js";
import { decisionEvents, decisionHash, digestEvent, fillEvents, important, stored, type Context, type DecisionRow } from "../src/ghostproof/events.js";
import { GhostProofRecorder } from "../src/ghostproof/recorder.js";
import { AgentProofEvent } from "../src/ghostproof/schema.js";

// Vectors computed with ghostnode's own code (domain/proofchain/canonical.ts hashOfEvent, merkle.ts buildMerkleRootB64 /
// buildMerkleProof), so these tests pin byte-compatibility with the chain.
const LEAVES = ["a", "b", "c", "d", "e"].map((x) => sha256B64(x));
const ROOT = "3RTQulFrtlSjBSt28FHbAm9OMi0L4IFGj6uZRA+ecwU=";
const PROOF4 = {
  version: 1 as const, epochId: "1700000000000:300", blockHeight: 7, rootB64: ROOT, leafIndex: 4,
  leafHashB64: "P3m7e0NbBTIWUdrv03TNxoHcBvqmXjdOODN7iMoEbeo=",
  path: [
    { siblingB64: "P3m7e0NbBTIWUdrv03TNxoHcBvqmXjdOODN7iMoEbeo=", side: "right" as const },
    { siblingB64: "dd4iLYrevXZ/maX+NaXz9Y2/o9UewotU6dpCJeyPFw0=", side: "right" as const },
    { siblingB64: "FO3l6Ol62TcjJ3KPUJm5VgSjlZPKw704o0OtdiBSE+c=", side: "left" as const },
  ],
};
const PROOF1 = {
  ...PROOF4, leafIndex: 1, leafHashB64: "PiPoFgA5WUoziU9lZOGxNIu9egCI1CxKy3PurtWcAJ0=",
  path: [
    { siblingB64: "ypeBEsobvcr6wjGzmiPcTaeG7/gUfE5yuYB3ha/uSLs=", side: "left" as const },
    { siblingB64: "v/4LNNuha8b6wXwIusVdZ2ze1aSt5B/iyZJKXd6PPls=", side: "right" as const },
    { siblingB64: "3pE6xBquYSn3NY2t6keph6gVCab7JnsB8FCCgPjdW0Y=", side: "right" as const },
  ],
};

const T0 = Date.parse("2026-10-04T12:00:00.000Z");
const ctx: Context = { actorId: "ghost-1", mode: "demo", model: "jev-1" };
const row = (o: Partial<DecisionRow> = {}): DecisionRow => ({
  id: 1, bee: "bee4", ts: T0, state_json: JSON.stringify({ px: 100, rsi14: 31, secretRule: "buy the dip under 30" }),
  menu_json: JSON.stringify([{ id: "LONG_BTC" }, { id: "WAIT" }]), choice: "LONG_BTC", probabilities_json: JSON.stringify({ LONG_BTC: 0.7 }),
  confidence: 0.7, conviction: 0.6, action_json: JSON.stringify({ kind: "open", instId: "BTC-USDT-SWAP", side: "long" }),
  vetoed_by: null, forced_by: null, status: "opened", policy_version_id: "pv_1", model: "jev-1", ...o,
});

describe("canonical JSON and hashes", () => {
  it("sorts keys at every depth and drops undefined, like the chain", () => {
    expect(canonicalJson({ z: 1, a: { y: [2, { d: 1, c: undefined }], b: "x" } })).toBe('{"a":{"b":"x","y":[2,{"d":1}]},"z":1}');
    expect(hashOf({ b: 1, a: 2 })).toBe(hashOf({ a: 2, b: 1 }));
  });

  it("computes the same leaf hash as ghostnode's hashOfEvent", () => {
    const leaf = sha256B64(canonicalJson({ eventId: "jevproof_x", type: "jev.trade.policy.decided", timestamp: 1700000000000, efpsMapHash: "ab", actorGhostId: "ghost-1", payload: { z: 1, a: { y: [2, { d: 1, c: undefined }], b: "x" } } }));
    expect(leaf).toBe("mt6o8ut7CgsruDbumGPwNwUYR3kmq1HosBydXKT48N0=");
  });
});

describe("Merkle verification", () => {
  it("builds the chain's root (odd count, last leaf doubled)", () => {
    expect(merkleRootHex(LEAVES.map((l) => Buffer.from(l, "base64").toString("hex")))).toBe(Buffer.from(ROOT, "base64").toString("hex"));
  });

  it("accepts the chain's proofs, left and right", () => {
    expect(verifyMerklePath(PROOF4)).toBe(true);
    expect(verifyMerklePath(PROOF1)).toBe(true);
  });

  it("rejects a tampered leaf, sibling, side or root", () => {
    expect(verifyMerklePath({ ...PROOF1, leafHashB64: LEAVES[2]! })).toBe(false);
    expect(verifyMerklePath({ ...PROOF1, path: [{ ...PROOF1.path[0]!, siblingB64: LEAVES[3]! }, ...PROOF1.path.slice(1)] })).toBe(false);
    expect(verifyMerklePath({ ...PROOF1, path: [{ ...PROOF1.path[0]!, side: "right" }, ...PROOF1.path.slice(1)] })).toBe(false);
    expect(verifyMerklePath({ ...PROOF1, rootB64: LEAVES[0]! })).toBe(false);
  });
});

describe("AgentProof schema", () => {
  const good = decisionEvents(ctx, row())[0]!;

  it("accepts the adapter's events", () => {
    expect(AgentProofEvent.safeParse(good).success).toBe(true);
  });

  it("rejects any field it does not know (a prompt, a payload, a key)", () => {
    for (const extra of [{ prompt: "you are Jev" }, { payload: { state: 1 } }, { apiKey: "k" }]) expect(AgentProofEvent.safeParse({ ...good, ...extra }).success).toBe(false);
    expect(AgentProofEvent.safeParse({ ...good, safeMetadata: { ...good.safeMetadata, rules: "secret" } }).success).toBe(false);
  });

  it("rejects malformed hashes, unknown types and bad markets", () => {
    expect(AgentProofEvent.safeParse({ ...good, inputHash: "XYZ" }).success).toBe(false);
    expect(AgentProofEvent.safeParse({ ...good, eventType: "ghostdb.file.created" }).success).toBe(false);
    expect(AgentProofEvent.safeParse({ ...good, safeMetadata: { market: "btc usdt" } }).success).toBe(false);
  });
});

describe("JEV adapter", () => {
  it("never puts the private snapshot, menu or answer in the event", () => {
    const text = JSON.stringify(decisionEvents(ctx, row()));
    expect(text).not.toContain("secretRule");
    expect(text).not.toContain("buy the dip");
    expect(text).not.toContain("LONG_BTC");
    expect(text).toContain('"market":"BTC-USD"');
  });

  it("is deterministic: the same row is the same event and the same eventId (replay-safe)", () => {
    const a = decisionEvents(ctx, row()).map(stored);
    const b = decisionEvents(ctx, row()).map(stored);
    expect(a).toEqual(b);
    expect(a[0]!.eventId).toMatch(/^jevproof_[a-f0-9]{64}$/);
  });

  it("changes the decision hash when any private part changes (tamper evidence)", () => {
    expect(decisionHash(row())).not.toBe(decisionHash(row({ state_json: JSON.stringify({ px: 101 }) })));
    expect(decisionHash(row())).not.toBe(decisionHash(row({ probabilities_json: JSON.stringify({ LONG_BTC: 0.71 }) })));
  });

  it("marks trades, vetoes and forced actions as important, plain waits go to the digest", () => {
    expect(important(row())).toBe(true);
    expect(important(row({ action_json: '{"kind":"none"}', vetoed_by: "openGate" }))).toBe(true);
    expect(important(row({ action_json: '{"kind":"none"}', choice: "WAIT" }))).toBe(false);
  });

  it("maps policy results and fills", () => {
    expect(decisionEvents(ctx, row({ vetoed_by: "cooldown" }))[1]!.result).toBe("VETO");
    expect(decisionEvents(ctx, row({ forced_by: "stop" }))[1]!.result).toBe("FORCED");
    const fill = { id: 1, order_id: 1, decision_id: 1, bee: "bee4", ts: T0, inst_id: "ETH-USDT-SWAP", side: "sell", contracts: 1, px: 2000, notional_usd: 20, fee_usd: 0.01, realised_usd: 1.5 };
    expect(fillEvents(ctx, fill, "jev-1", null).map((e) => [e.eventType, e.result])).toEqual([["jev.trade.order.executed", "FILLED"], ["jev.trade.outcome.recorded", "WIN"]]);
  });

  it("digests a whole hour as one Merkle root of decision hashes", () => {
    const rows = [row(), row({ id: 2, choice: "WAIT" }), row({ id: 3 })];
    const e = digestEvent(ctx, "bee4", T0, rows);
    expect(e.inputHash).toBe(merkleRootHex(rows.map(decisionHash)));
    expect(e.safeMetadata.count).toBe(3);
  });
});

// A fake gateway: answers like the proposed /agentproof/v1/events, blocks and proofs from ghostnode-shaped data.
function gateway(opts: { status?: number[]; eventId?: (sent: string) => string; retryAfter?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...(opts.status ?? [])];
  const f: Fetch = async (url, init) => {
    calls.push({ url, init });
    const st = queue.shift() ?? 201;
    if (st >= 400) return new Response("{}", { status: st, headers: opts.retryAfter ? { "retry-after": opts.retryAfter } : {} });
    const ev = JSON.parse(String(init?.body)).event as AgentProofEvent;
    const eventId = opts.eventId ? opts.eventId(stored(ev).eventId) : stored(ev).eventId;
    return new Response(JSON.stringify({ accepted: true, eventId, epochId: "1700000000000:300", status: "submitted", anchorRef: `proofchain:event:${eventId}` }), { status: 201 });
  };
  return { f, calls };
}
const client = (f: Fetch, sleeps: number[] = []) => new GhostProofClient({ baseUrl: "https://gw.test/api/", token: () => "jwt", fetch: f, sleep: async (ms) => void sleeps.push(ms), now: () => T0 });

describe("GhostProof client", () => {
  const ev = decisionEvents(ctx, row())[1]!;

  it("submits with the bearer token to the AgentProof route only", async () => {
    const g = gateway();
    const r = await client(g.f).submit(ev);
    expect(r.status).toBe("submitted");
    expect(g.calls[0]!.url).toBe("https://gw.test/api/agentproof/v1/events");
    expect((g.calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer jwt");
    expect(g.calls.some((c) => c.url.includes("/proofchain/events"))).toBe(false);
  });

  it("fails on hash mismatch: the gateway answering another eventId is an integrity error", async () => {
    const g = gateway({ eventId: () => `jevproof_${"0".repeat(64)}` });
    await expect(client(g.f).submit(ev)).rejects.toMatchObject({ code: "integrity" });
  });

  it("retries 429 and 503 (honouring Retry-After), never 400/401/403/404/409", async () => {
    const sleeps: number[] = [];
    const g = gateway({ status: [429, 503], retryAfter: "2" });
    await client(g.f, sleeps).submit(ev);
    expect(g.calls.length).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);
    for (const st of [400, 401, 403, 404, 409]) {
      const h = gateway({ status: [st] });
      await expect(client(h.f).submit(ev)).rejects.toBeInstanceOf(GhostProofError);
      expect(h.calls.length).toBe(1);
    }
  });

  it("refuses locally an event from the future, out of the window, or off-schema, without sending", async () => {
    const g = gateway();
    const c = client(g.f);
    await expect(c.submit({ ...ev, createdAt: new Date(T0 + 10 * 60_000).toISOString() })).rejects.toMatchObject({ code: "bad_request" });
    await expect(c.submit({ ...ev, createdAt: new Date(T0 - 25 * 3_600_000).toISOString() })).rejects.toMatchObject({ code: "bad_request" });
    await expect(c.submit({ ...ev, prompt: "x" } as unknown as AgentProofEvent)).rejects.toMatchObject({ code: "bad_request" });
    expect(g.calls.length).toBe(0);
  });

  it("verifies an anchored event against the block root, and refuses a forged proof", async () => {
    const block = { height: 7, blockHashB64: "h", prevBlockHashB64: "p", epoch: { epochId: PROOF1.epochId, eventsRootB64: ROOT, eventsCount: 5 } };
    const f = (proof: object): Fetch => async (url) => new Response(JSON.stringify(url.includes("/blocks?") ? { blocks: [block] } : proof), { status: 200 });
    expect(await client(f(PROOF1)).verify(PROOF1.leafHashB64, PROOF1.epochId)).toBe(7);
    await expect(client(f({ ...PROOF1, path: PROOF4.path })).verify(PROOF1.leafHashB64, PROOF1.epochId)).rejects.toMatchObject({ code: "integrity" });
    await expect(client(f({ ...PROOF1, rootB64: LEAVES[0] })).verify(PROOF1.leafHashB64, PROOF1.epochId)).rejects.toMatchObject({ code: "integrity" });
    await expect(client(f(PROOF4)).verify(PROOF1.leafHashB64, PROOF1.epochId)).rejects.toMatchObject({ code: "integrity" });
    expect(await client(f(PROOF1)).verify(PROOF1.leafHashB64, "1700000300000:300")).toBeNull();
  });
});

describe("GhostProof recorder", () => {
  const setup = (f: Fetch | null, now = { t: T0 }) => {
    const db = new Db(":memory:");
    const rec = new GhostProofRecorder({ db: db.raw, ctx, client: f ? new GhostProofClient({ baseUrl: "https://gw.test/api", token: () => "jwt", fetch: f, sleep: async () => {}, now: () => now.t }) : null, now: () => now.t });
    rec.scan(); // the first scan starts the cursors at "now": no backfill
    const decide = (o: { kind?: string; choice?: string; ts?: number; vetoed?: string } = {}) =>
      db.insertDecision({ bee: "bee4", ts: o.ts ?? now.t, stateHash: null, stateJson: '{"px":1}', menuJson: "[]", choice: o.choice ?? "LONG_BTC", probabilities: null, confidence: 0.7, conviction: 0.6, latencyMs: 1, inputTokens: 1, jevCostUsd: 0, jevError: null, action: { kind: o.kind ?? "open", instId: "BTC-USDT-SWAP" }, vetoedBy: o.vetoed ?? null, forcedBy: null, status: "ok" });
    return { db, rec, decide, now };
  };

  it("queues important decisions once (idempotent), and leaves plain waits to the digest", () => {
    const { rec, decide, now } = setup(null);
    decide();
    decide({ kind: "none", choice: "WAIT" });
    expect(rec.scan()).toBe(2);
    expect(rec.scan()).toBe(0); // replay: nothing new
    expect(rec.status().counts.local).toBe(2);
    now.t = T0 + 3_600_000 + 1000;
    rec.scan();
    expect(rec.status().counts.local).toBe(3); // + the hour's digest covering both
  });

  it("sends, then verifies against the block before calling it verified", async () => {
    const now = { t: T0 };
    let leaf = "";
    const f: Fetch = async (url, init) => {
      if (url.endsWith("/agentproof/v1/events")) {
        const ev = JSON.parse(String(init!.body)).event as AgentProofEvent;
        leaf = stored(ev).leafHashB64;
        const id = stored(ev).eventId;
        return new Response(JSON.stringify({ accepted: true, eventId: id, epochId: "1700000000000:300", status: "submitted", anchorRef: `proofchain:event:${id}` }), { status: 201 });
      }
      const root = leaf; // a one-leaf epoch: the root is the leaf, empty path
      if (url.includes("/blocks?")) return new Response(JSON.stringify({ blocks: [{ height: 9, blockHashB64: "h", prevBlockHashB64: "p", epoch: { epochId: "1700000000000:300", eventsRootB64: root, eventsCount: 1 } }] }));
      return new Response(JSON.stringify({ version: 1, epochId: "1700000000000:300", blockHeight: 9, rootB64: root, leafHashB64: leaf, leafIndex: 0, path: [] }));
    };
    const s = setup(f, now);
    s.decide({ kind: "none", choice: "WAIT", vetoed: "openGate" });
    s.rec.scan();
    // one at a time so every leaf is checked against its own one-leaf block
    expect(await s.rec.flush(1)).toBe(1);
    expect(s.rec.status().counts.submitted).toBe(1);
    expect(await s.rec.verifyPending()).toBe(0); // too early: "submitted" is not final
    now.t += 7 * 60_000;
    expect(await s.rec.verifyPending()).toBe(1);
    expect(s.rec.status().counts.verified).toBe(1);
  });

  it("keeps events local while the route does not exist, and fails closed on 401/403", async () => {
    const g404 = setup(gateway({ status: [404, 404] }).f);
    g404.decide();
    g404.rec.scan();
    expect(await g404.rec.flush()).toBe(0);
    expect(g404.rec.status()).toMatchObject({ routeMissing: true, counts: { local: 2 } });

    const g401 = setup(gateway({ status: [401] }).f);
    g401.decide();
    g401.rec.scan();
    expect(await g401.rec.flush()).toBe(0);
    expect(g401.rec.status()).toMatchObject({ blocked: true, counts: { local: 2, rejected: 0 } });
  });

  it("expires what waited past the gateway's window instead of back-dating it", async () => {
    const s = setup(null);
    s.decide();
    s.rec.scan();
    s.now.t += 25 * 3_600_000;
    await s.rec.flush();
    expect(s.rec.status().counts.expired).toBe(2);
  });
});
