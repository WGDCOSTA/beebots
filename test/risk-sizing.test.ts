import { describe, expect, it } from "vitest";
import { boozy } from "../src/bees/boozy.js";
import type { BeeBrain, BeeContext } from "../src/bees/types.js";
import { freshBee } from "../src/ledger.js";
import { applyRisk } from "../src/risk.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

describe("paper leverage cap", () => {
  it("is off by default and keeps hard rule 3", () => {
    const c = testConfig();
    expect(c.risk.maxLeverage).toBe(2);
    expect(c.risk.riskPerTradePct).toBe(0);
  });
  it("raises the cap only for paper trading, up to 5x", () => {
    expect(testConfig({ PAPER_MAX_LEVERAGE: "5" }).risk.maxLeverage).toBe(5);
    expect(testConfig({ DRY_RUN: "true", PAPER_MAX_LEVERAGE: "3" }).risk.maxLeverage).toBe(3);
    const demoKeys = Object.fromEntries(["BEE1", "BEE2", "BEE3", "BEE4"].flatMap((b) => ["KEY", "SECRET", "PASSPHRASE"].map((k) => [`${b}_OKX_DEMO_API_${k}`, "x"])));
    expect(testConfig({ ...demoKeys, DRY_RUN: "false", MODE: "demo", PAPER_MAX_LEVERAGE: "5" }).risk.maxLeverage).toBe(2);
    expect(() => testConfig({ PAPER_MAX_LEVERAGE: "6" })).toThrow(/PAPER_MAX_LEVERAGE/);
    expect(() => testConfig({ MAX_LEVERAGE: "3" })).toThrow(/Hard rule 3/);
    expect(() => testConfig({ RISK_PER_TRADE_PCT: "7" })).toThrow(/RISK_PER_TRADE_PCT/);
  });
});

describe("risk-based sizing", () => {
  const btc = coin("BTC", {}, 100);
  const ID = btc.instId;
  // A brain whose stop sits `dist` below (long) or above (short) the price.
  const withStop = (dist: number): BeeBrain => ({ ...boozy, stopFor: (_i, side, px) => (side === "long" ? px * (1 - dist) : px * (1 + dist)) });
  function ctx(env: Record<string, string>, slots = 3): BeeContext {
    const cfg = testConfig({ BEE_START_EQUITY_USD: "1000", MAX_NOTIONAL_USD_PER_BEE: "10000", ...env });
    return { bee: freshBee("bee1", 1000, NOW - 3_600_000), view: view([btc]), cfg, knobs: cfg.bees.boozy, now: NOW, uplR: 0, slots };
  }
  const open = (side: "long" | "short" = "long", sizeFrac = 1) => ({ label: "OPEN", intent: { kind: "open" as const, instId: ID, side, sizeFrac, setup: "strict" as const }, prob: 0.9, conviction: 3 });
  const notional = (r: ReturnType<typeof applyRisk>) => (r.action as { notionalUsd?: number }).notionalUsd;
  const run = (c: BeeContext, brain: BeeBrain, proposal = open(), sizeMult = 1) =>
    applyRisk({ ctx: c, brain, proposal, jev: "ok", sizeMult, dataAgeMs: 0, maxDataAgeMs: 60_000 });

  it("sizes so the stop costs the set share of equity", () => {
    // 1.5% of $1000 = $15 at a 2% stop = $750 notional; half the brain's size choice, half the risk.
    const r = run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.02));
    expect(r.vetoedBy).toBeNull();
    expect(notional(r)).toBeCloseTo(750, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.02), open("long", 0.5)))).toBeCloseTo(375, 6);
    const short = run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.01), open("short"));
    expect(notional(short)).toBeCloseTo(1500, 6);
  });

  it("never passes the leverage cap, and scales with the survival multiplier", () => {
    // A 0.5% stop asks for $3000; the 2x cap x 0.97 allows $1940, the 5x paper cap $4850.
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5" }), withStop(0.005)))).toBeCloseTo(1940, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.005)))).toBeCloseTo(3000, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.003)))).toBeCloseTo(4850, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" }), withStop(0.02), open(), 0.5))).toBeCloseTo(375, 6);
  });

  it("falls back to share-of-the-cap sizing when off, or when the stop is unknown or too close", () => {
    // Old rule: 2x x 1000 x 0.97 / 3 slots = $646.67.
    const old = 1940 / 3;
    expect(notional(run(ctx({}), withStop(0.02)))).toBeCloseTo(old, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5" }), { ...boozy, stopFor: () => null }))).toBeCloseTo(old, 6);
    expect(notional(run(ctx({ RISK_PER_TRADE_PCT: "1.5" }), withStop(0.001)))).toBeCloseTo(old, 6);
  });
});
