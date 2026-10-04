# GhostProof: Jev's decisions on our own chain

Every Jev decision, every order and every fill can be anchored on GhostProof as an **AgentProof event**: hashes and safe
metadata only. The private record stays in the engine's database; the chain holds its fingerprint. Later, anyone holding
the local row can recompute the hash and prove that row is exactly what was anchored, and when.

- Code: `src/ghostproof/` (`canonical.ts`, `schema.ts`, `events.ts`, `client.ts`, `recorder.ts`)
- Tests: `test/ghostproof.test.ts` (schema, idempotency and replay, hash mismatch, Merkle verification against vectors
  computed with ghostnode's own `hashOfEvent` / `buildMerkleProof`)
- Switches: `GHOSTPROOF=1`, `GHOSTPROOF_TOKEN`, `GHOSTPROOF_ACTOR`, `GHOSTPROOF_URL` (see `.env.example`)

## What the gateway offers today, and what is missing

The API contracts were read from ghostnode (`packages/ghostnode-pro/src/infrastructure/api/ProofChainRoutes.ts`,
`domain/proofchain/*`):

| Route | Use here |
|---|---|
| `POST /ghostdb/proofs` | **Not used.** Accepts only `ghostdb.*` types. Forcing trading events into GhostDB types is forbidden. |
| `POST /proofchain/events` | **Never used.** Reserved for node signers. |
| `GET /proofchain/status`, `/proofchain/blocks`, `/proofchain/blocks/:height`, `/proofchain/verify/chain` | Read-only, used to verify. |
| `GET /proofchain/verify/file/:x/proof?eventId=<leafB64>&epochId=&blockHeight=` | Merkle proof of a leaf, checked locally. |
| `POST /agentproof/v1/events` | **Does not exist yet.** This client targets it. The spec is below. |

Until the AgentProof route exists, the recorder **does not fall back** to anything. A 404 from the gateway keeps every
event in the local outbox with its hashes, and it looks again an hour later. Nothing is lost; an event older than 24 h
becomes `expired` (the gateway's window) and is never back-dated.

## What stays local, and what is sent

| Stays in the engine's SQLite (never sent) | Sent to GhostProof |
|---|---|
| Market snapshot Jev saw (`state_json`) | `inputHash` = sha256(canonical {state, menu}) |
| The menu of options | (inside `inputHash`) |
| Jev's choice, probabilities, confidence, conviction | `outputHash` = sha256(canonical {choice, probabilities, confidence, conviction}) |
| The whole decision row, incl. action, veto, forced-by, status | `decisionHash` = sha256(canonical row) |
| Order sizes, prices, client ids, errors | `decisionHash` of the order row |
| Fill price, notional, fees, realised PnL | `decisionHash` of the fill; `outputHash` of {realisedUsd, feeUsd}; `result` WIN/LOSS/FLAT |
| Bunny rules, prompts, strategy, skills, playbook | nothing |
| Exchange keys, LLM keys, the GhostID token | nothing (the token goes only in the `Authorization` header) |
| | `eventType`, `actorId`, `callId` (`bee4:d1234`), `policyVersion`, `modelVersion`, `result`, `createdAt` |
| | `safeMetadata`: `market` (`BTC-USD`), `timeframe`, `agent` (`bee1`..`bee9`), `mode` (dry/demo/live), `count` |

The schema is `.strict()` at every level: any other field (a prompt, a payload, a key) makes the event invalid, and the
client refuses it before sending.

### Events

| Type | When | `result` |
|---|---|---|
| `jev.trade.call.analyzed` | a decision that traded, was vetoed or was forced | `ANSWERED` / `NO_ANSWER` |
| `jev.trade.policy.decided` | the same decision, after code rules | `ALLOW` / `VETO` / `FORCED` |
| `jev.trade.order.submitted` | each order | `SUBMITTED` / `REJECTED` |
| `jev.trade.order.executed` | each fill | `FILLED` |
| `jev.trade.outcome.recorded` | a fill that realised PnL | `WIN` / `LOSS` / `FLAT` |
| `jev.trade.calls.digest` | per bunny, per finished hour | `DIGEST`; `inputHash` = Merkle root of **every** decision hash in the hour, `count` = how many |

Plain WAITs do not get their own event; the hourly digest covers them, so every decision is provable without flooding the
chain. `jev.trade.calls.digest` is the one type beyond the team's list; the extension needs to allow it, or the digest
can be dropped (the client then covers only important decisions).

## Hashing, byte for byte

- **Canonical JSON:** keys sorted at every depth, `undefined` dropped, arrays in order, `JSON.stringify`. This is
  ghostnode's `canonicalJson`.
- **Content hashes** (`inputHash`, `decisionHash`, `outputHash`): sha256 of the canonical JSON, lowercase hex.
- **eventId** (deterministic, computed by the client and by the server):
  `"jevproof_" + sha256hex(canonical { type: eventType, actorGhostId: actorId, payload })`.
  Here `payload = { version: "agentproof.event.v1", callId, inputHash, decisionHash, outputHash?, policyVersion, modelVersion, result, createdAt, safeMetadata }`.
  This mirrors `/ghostdb/proofs`, whose ids are `gdbproof_` + the same construction.
- **Leaf** (the chain's `hashOfEvent`):
  sha256 base64 of the canonical `{ eventId, type, timestamp: ms(createdAt), efpsMapHash: decisionHash, actorGhostId, payload }`.
- **Merkle:** parent = sha256(left ‖ right) on raw bytes, base64; the last node is doubled when a level is odd.

The client knows the eventId and the leaf before the server answers. If the gateway answers with any other eventId, the
client raises an integrity error and the event is marked `rejected`: a gateway that stored something else is not trusted
with the next one.

## States

`local` → `submitted` → `verified`, or `rejected` / `expired`.

- **local:** queued in `ghostproof_outbox`, with its leaf hash.
- **submitted:** the gateway accepted it into the current epoch. **This is not final.**
- **verified:** at least 6 minutes later, the client:
  1. found the block whose `epoch.epochId` is the event's epoch;
  2. fetched the Merkle proof for its own leaf;
  3. checked that the proof's leaf is that leaf, that the proof's root equals the block's `eventsRootB64`, and that the
     path leads to that root.
- **rejected:** refused by the schema, a 400 or 409, an eventId mismatch, or a proof that does not check out.
- **expired:** it waited longer than the gateway's 24 h window (the route did not exist, or there was no token).

The `pending` and `anchored` states of the spec are the server's view (epoch closing, block written). The client only
promotes an event after checking it itself.

## Failure handling

| Answer | What the client does |
|---|---|
| 201 | Check the schema and that the eventId matches, then mark `submitted`. |
| 400, 409 | Mark `rejected` and keep the error. No retry. |
| 401, 403 | **Fail closed:** stop sending for an hour; events stay `local`. |
| 404 | The route is missing: events stay `local`; look again in an hour. |
| 429, 503, network | Retry up to 3 tries (Retry-After, or 1 s / 2 s backoff), then try again next round. |
| Any other status | Mark `rejected`. |

Before sending, the client also refuses on its own an event that breaks the schema, has `createdAt` more than 5 minutes
in the future, or is more than 24 hours old.

## Proposed extension: `POST /agentproof/v1/events`

To be added beside `/ghostdb/proofs` in `ProofChainRoutes.ts`, with the same zero-trust pattern:

1. **Auth:** `Authorization: Bearer <GhostID JWT>` through the existing auth middleware.
   - New scope `agentproof:write`; refuse with 403 without it.
   - Refuse with 403 when `event.actorId !== jwt.ghostId`, so each actor is bound to its own identity.
2. **Body:** `{ event }`, validated with the Zod schema in `src/ghostproof/schema.ts` (strict). An unknown field is 400.
3. **Window:** refuse when `createdAt` is more than 5 min in the future or more than 24 h old (400).
4. **Rate limit:** per ghostId, like `/ghostdb/proofs`; answer 429 with `Retry-After`.
5. **Deterministic id:** eventId = `"jevproof_" + sha256hex(canonicalJson({ type, actorGhostId, payload }))`, as above.
6. **Idempotency:**
   - The same eventId again (same content) answers 201 with the same body.
   - The same `(actorId, eventType, callId)` with a different eventId is an inconsistent duplicate: 409.
7. **Store:** `EpochAggregator.submitEvent` builds the `GhostProofEvent`:
   - `{ eventId, type: eventType, timestamp: ms(createdAt), efpsMapHash: decisionHash, actorGhostId: actorId, payload }`;
   - `fileId` is left empty;
   - it is anchored by the normal epoch → block flow, with no new signing role.
8. **201 answer:** `{ accepted: true, eventId, epochId, status: "submitted", anchorRef: "proofchain:event:<eventId>" }`.
9. **Errors:** 400 schema or window; 401 no or invalid token; 403 scope or actor; 409 inconsistent duplicate; 429 rate;
   503 the aggregator is unavailable.

## Examples

### curl

```bash
TOKEN=...   # GhostID JWT with scope agentproof:write; never commit it
curl -sS -X POST https://gateway.efps.live/api/agentproof/v1/events \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"event":{
        "eventType":"jev.trade.policy.decided","actorId":"<your ghostId>","callId":"bee4:d1234",
        "inputHash":"<64 hex>","decisionHash":"<64 hex>","policyVersion":"pv_12","modelVersion":"jev-1.13.0",
        "result":"VETO","createdAt":"2026-10-04T12:00:00.000Z",
        "safeMetadata":{"market":"BTC-USD","timeframe":"tick","agent":"bee4","mode":"demo"}}}'

# Read-only checks
curl -sS https://gateway.efps.live/api/proofchain/status
curl -sS "https://gateway.efps.live/api/proofchain/blocks?order=desc&offset=0&limit=5"
curl -sS "https://gateway.efps.live/api/proofchain/verify/file/agentproof/proof?eventId=<leafB64 urlencoded>&epochId=<epoch>&blockHeight=<h>"
```

### TypeScript

```ts
import { GhostProofClient } from "./src/ghostproof/client.js";
import { decisionEvents, stored } from "./src/ghostproof/events.js";

const client = new GhostProofClient({ baseUrl: "https://gateway.efps.live/api", token: () => process.env.GHOSTPROOF_TOKEN ?? null });
const [analyzed, decided] = decisionEvents({ actorId: process.env.GHOSTPROOF_ACTOR!, mode: "demo", model: "jev-1.13.0" }, decisionRow);

const { eventId, leafHashB64 } = stored(decided); // known before sending
const r = await client.submit(decided);           // throws on 4xx, on integrity, after 3 tries on 429/503
// r.status === "submitted": not final
const height = await client.verify(leafHashB64, r.epochId); // null while the epoch has no block; throws if the proof is wrong
```

In the engine, the recorder does all of this every 30 s (`src/index.ts`, `GHOSTPROOF=1`), and its outbox is
`ghostproof_outbox`:

```sql
SELECT status, COUNT(*) FROM ghostproof_outbox GROUP BY status;
```

### Proving a decision later

```ts
import { decisionHash } from "./src/ghostproof/events.js";
// Take the row from the local decisions table, recompute decisionHash(row),
// and compare with the anchored event's decisionHash, or with its hour's digest (Merkle root of the decision hashes).
```
