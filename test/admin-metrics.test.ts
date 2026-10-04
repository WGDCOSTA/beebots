import { describe, expect, it } from "vitest";
import { adminMetrics } from "../src/admin/metrics.js";
import { metered, parsePrices, priceOf, UsageMeter } from "../src/brains/usage.js";
import type { JsonAsk, LlmClient } from "../src/brains/llm.js";
import { Db } from "../src/db.js";
import { z } from "zod";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 4, 12, 30);

function seed() {
  const db = new Db(":memory:");
  const decide = (bee: "bee1" | "bee4", ts: number, kind: string, extra: { vetoedBy?: string; jevError?: string } = {}) =>
    db.insertDecision({ bee, ts, stateHash: null, stateJson: "{}", menuJson: "[]", choice: kind === "open" ? "LONG_BTC" : "WAIT", probabilities: null, confidence: 0.6, conviction: 0.5, latencyMs: 400, inputTokens: 900, jevCostUsd: 0.002, jevError: extra.jevError ?? null, action: { kind, instId: "BTC-USDT-SWAP" }, vetoedBy: extra.vetoedBy ?? null, forcedBy: null, status: "ok" });
  const d1 = decide("bee1", NOW - 2 * H, "open");
  decide("bee1", NOW - 2 * H, "none");
  decide("bee4", NOW - 3 * H, "open", { vetoedBy: "openGate" });
  decide("bee4", NOW - 30 * H, "none"); // outside 24h
  const o = db.insertOrder({ decisionId: d1, bee: "bee1", ts: NOW - 2 * H, clOrdId: "c1", instId: "BTC-USDT-SWAP", side: "buy", contracts: 1, reduceOnly: false, purpose: "open" });
  db.insertFill({ orderId: o, bee: "bee1", ts: NOW - 2 * H, instId: "BTC-USDT-SWAP", side: "buy", contracts: 1, px: 100, notionalUsd: 100, feeUsd: 0.05, realisedUsd: 0 });
  db.insertFill({ orderId: o, bee: "bee1", ts: NOW - H, instId: "BTC-USDT-SWAP", side: "sell", contracts: 1, px: 102, notionalUsd: 102, feeUsd: 0.05, realisedUsd: 2 });
  const eq = db.raw.prepare("INSERT INTO equity_snapshots (bee, ts, equity_usd, cash_usd, upl_usd) VALUES (?, ?, ?, 0, 0)");
  eq.run("bee1", NOW - 26 * H, 1000);
  eq.run("bee1", NOW - 5 * H, 1010);
  eq.run("bee1", NOW - 3 * H, 990);
  eq.run("bee1", NOW - H, 1012);
  eq.run("bee4", NOW - 4 * H, 500);
  const meter = new UsageMeter(db.raw, () => NOW - H);
  meter.record({ brain: "openai", model: "gpt-6-astra", purpose: "lab_study", inTokens: 100_000, outTokens: 20_000, latencyMs: 30_000, ok: true });
  meter.record({ brain: "claude", model: "claude-opus-5", purpose: "council", inTokens: 10_000, outTokens: 1_000, latencyMs: 8_000, ok: true });
  meter.record({ brain: "openai", model: "gpt-6-astra", purpose: "lab_study", inTokens: 0, outTokens: 0, latencyMs: 1_000, ok: false, error: "timeout" });
  return db;
}

describe("admin metrics", () => {
  const bees = [
    { slot: "bee1", name: "Bizzy", style: "bizzy", startEquityUsd: 1000 },
    { slot: "bee4", name: "Degen", style: "degen", startEquityUsd: 500 },
  ];

  it("aggregates trading, decisions, Jev and brain consumption per bucket", () => {
    const db = seed();
    const m = adminMetrics({ db: db.raw, bees, range: "24h", now: NOW, prices: parsePrices("gpt-6=5:20"), jevDailyCapUsd: 2 });
    expect(m.buckets).toHaveLength(24);
    const b1 = m.bees.find((b) => b.slot === "bee1")!;
    expect(b1).toMatchObject({ realisedUsd: 2, feesUsd: 0.1, netUsd: 1.9, fills: 2, closes: 1, winRatePct: 100, decisions: 2, opened: 1, equityUsd: 1012 });
    expect(b1.maxDrawdownPct).toBeCloseTo(1.98, 1);
    expect(m.totals).toMatchObject({ decisions: 3, opened: 1, vetoed: 1, netPnlUsd: 1.9, llmCalls: 3, llmTokens: 131_000 });
    expect(m.totals.jevUsd).toBeCloseTo(0.006, 6);
    // Equity carries forward through empty buckets, from the last snapshot before the range.
    expect(m.series.equity.bee1![0]).toBe(1000);
    expect(m.series.equity.bee1![23]).toBe(1012);
    // Astra is priced through its family prefix; Claude is not priced.
    expect(m.llm.models.find((x) => x.model === "gpt-6-astra")).toMatchObject({ calls: 2, errors: 1, costUsd: 0.9 });
    expect(m.llm.models.find((x) => x.model === "claude-opus-5")!.costUsd).toBeNull();
    expect(m.totals.llmUnpricedModels).toBe(1);
    expect(m.llm.purposes[0]).toMatchObject({ purpose: "lab_study", calls: 2, errors: 1, costUsd: 0.9 });
    expect(m.llm.brains.sort()).toEqual(["claude", "openai"]);
  });

  it("uses wider buckets for longer ranges", () => {
    const db = seed();
    expect(adminMetrics({ db: db.raw, bees, range: "7d", now: NOW, prices: new Map(), jevDailyCapUsd: 2 }).buckets).toHaveLength(28);
    expect(adminMetrics({ db: db.raw, bees, range: "90d", now: NOW, prices: new Map(), jevDailyCapUsd: 2 }).buckets).toHaveLength(90);
  });
});

describe("usage meter", () => {
  it("records every call, failures included, without changing the answer", async () => {
    const db = new Db(":memory:");
    const meter = new UsageMeter(db.raw);
    let fail = false;
    const inner: LlmClient = {
      brain: "openai",
      model: "gpt-6-astra",
      async json<T>(ask: JsonAsk<T>) {
        if (fail) throw new Error("boom");
        return { data: ask.validate.parse({ ok: true }), brain: "openai", model: "gpt-6-astra", inputTokens: 10, outputTokens: 5, latencyMs: 12 };
      },
    };
    const c = metered(inner, meter);
    const ask = { system: "", user: "", name: "council", schema: {}, validate: z.object({ ok: z.boolean() }) };
    expect((await c.json(ask)).data).toEqual({ ok: true });
    fail = true;
    await expect(c.json(ask)).rejects.toThrow("boom");
    const rows = db.raw.prepare("SELECT purpose, in_tokens, out_tokens, ok, error FROM llm_usage ORDER BY id").all();
    expect(rows).toEqual([
      { purpose: "council", in_tokens: 10, out_tokens: 5, ok: 1, error: null },
      { purpose: "council", in_tokens: 0, out_tokens: 0, ok: 0, error: "boom" },
    ]);
  });

  it("parses the owner's prices and matches exact ids before family prefixes", () => {
    const p = parsePrices("gpt-6=5:20, gpt-6-astra=6:24,bad,claude-opus-5=15:75");
    expect(priceOf(p, "gpt-6-astra")).toEqual({ inUsd: 6, outUsd: 24 });
    expect(priceOf(p, "gpt-6.1-sol")).toEqual({ inUsd: 5, outUsd: 20 });
    expect(priceOf(p, "kimi-k2.5")).toBeNull();
  });
});
