import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 4);

function decision(db: Db, ts: number, choice = "LONG_BTC") {
  return db.insertDecision({
    bee: "bee1", ts, stateHash: "h", stateJson: JSON.stringify({ big: "x".repeat(500) }), menuJson: '["WAIT","LONG_BTC"]', choice,
    probabilities: { WAIT: 0.3, LONG_BTC: 0.7 }, confidence: 0.7, conviction: 0.5, latencyMs: 400, inputTokens: 900,
    jevCostUsd: 0.002, jevError: null, action: { kind: "open", instId: "BTC-USDT-SWAP" }, vetoedBy: null, forcedBy: null, status: "ok",
  });
}
const row = (db: Db, id: number) =>
  db.raw.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Record<string, unknown>;

describe("compactDecisions", () => {
  it("drops the inputs of decisions older than the cutoff and keeps everything else", () => {
    const db = new Db(":memory:");
    const old = decision(db, NOW - 31 * DAY);
    const edge = decision(db, NOW - 30 * DAY); // exactly at the cutoff: kept
    const fresh = decision(db, NOW - 2 * DAY);
    const before = row(db, old);

    expect(db.compactDecisions(NOW - 30 * DAY)).toBe(1);

    const after = row(db, old);
    expect(after.state_json).toBeNull();
    expect(after.menu_json).toBeNull();
    expect(after.probabilities_json).toBeNull();
    for (const k of ["id", "bee", "ts", "state_hash", "choice", "confidence", "conviction", "latency_ms", "input_tokens", "jev_cost_usd", "action_json", "vetoed_by", "forced_by", "status"])
      expect(after[k], k).toEqual(before[k]);
    for (const id of [edge, fresh]) {
      expect(row(db, id).state_json).not.toBeNull();
      expect(row(db, id).menu_json).not.toBeNull();
      expect(row(db, id).probabilities_json).not.toBeNull();
    }
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(3);
  });

  it("works in batches, is idempotent and keeps the spend total", () => {
    const db = new Db(":memory:");
    for (let i = 0; i < 25; i++) decision(db, NOW - (40 + i) * DAY);
    decision(db, NOW - DAY);
    const spend = db.jevSpendSince(0);

    expect(db.compactDecisions(NOW - 30 * DAY, 4)).toBe(25);
    expect(db.compactDecisions(NOW - 30 * DAY, 4)).toBe(0);
    expect(db.jevSpendSince(0)).toBeCloseTo(spend, 10);
    const left = db.raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE state_json IS NOT NULL").get() as { n: number };
    expect(left.n).toBe(1);
  });
});

describe("pruneEvents", () => {
  it("removes only events older than the cutoff", () => {
    const db = new Db(":memory:");
    db.raw.prepare("INSERT INTO events (ts, type, json) VALUES (?, 'x', '{}'), (?, 'x', '{}')").run(NOW - 4 * DAY, NOW - DAY);
    db.pruneEvents(NOW - 3 * DAY);
    const ts = (db.raw.prepare("SELECT ts FROM events").all() as Array<{ ts: number }>).map((r) => r.ts);
    expect(ts).toEqual([NOW - DAY]);
  });
});
