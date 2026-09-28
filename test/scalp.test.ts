// The scalper's lab (phase 1): exact accounting on hand-built bars, then the verdicts.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildScalpReport, loadScalpReport, saveScalpReport, scalpGate, DEFAULT_COSTS, evaluateScalpRule, microBreakout, passesCostGate, roundTripCostBps, scalpReportMarkdown, scalpStats, simulateScalp, TRADE_DEFAULTS, tradeParams, type CostModel, type TradeParams } from "../src/lab/scalp.js";
import { flat, set, walk } from "./synth.js";

const costs: CostModel = { makerFee: 0.0002, takerFee: 0.0005, slippageBps: 1, halfSpreadBps: 0.5, throughBps: 0.5 };
const tp = (o: Partial<TradeParams> = {}): TradeParams => ({ ...TRADE_DEFAULTS, targetAtr: 1, stopAtr: 1, holdBars: 10, waitBars: 2, makerEntry: 1, makerTarget: 1, costGateMult: 0, ...o });
/** 40 flat bars (range 0.2 -> ATR 0.2 = 20 bp at 100) with one entry desire at bar 20. */
const setup = (side: 1 | -1 = 1) => {
  const c = flat(40);
  const sig = new Int8Array(c.length);
  sig[20] = side;
  return { c, sig };
};

describe("simulateScalp: exact accounting", () => {
  it("maker entry, maker target: 20 bp gross, 4 bp of fees, 16 net", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 }); // trades through the resting bid at 100: filled at 100
    set(c, 22, { h: 100.3 }); // through the 100.2 target
    const s = simulateScalp(c, sig, tp(), costs);
    expect(s.trades).toHaveLength(1);
    const t = s.trades[0]!;
    expect(t).toMatchObject({ side: 1, entryPx: 100, reason: "target", makerEntry: true, makerExit: true });
    expect(t.exitPx).toBeCloseTo(100.2, 9);
    expect(t.grossBps).toBeCloseTo(20, 6);
    expect(t.feeBps).toBeCloseTo(4, 6);
    expect(t.netBps).toBeCloseTo(16, 6);
  });

  it("a stop is a taker fill with slippage and half a spread: -21.5 gross, 7 of fees", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    set(c, 22, { l: 99.7 }); // through the 99.8 stop
    const t = simulateScalp(c, sig, tp(), costs).trades[0]!;
    expect(t.reason).toBe("stop");
    expect(t.exitPx).toBeCloseTo(99.8 * (1 - 0.00015), 8);
    expect(t.grossBps).toBeCloseTo(((99.8 * (1 - 0.00015) - 100) / 100) * 1e4, 6);
    expect(t.feeBps).toBeCloseTo(7, 6);
    expect(t.netBps).toBeCloseTo(t.grossBps - 7, 6);
  });

  it("price only touching the limit is not a fill (queue haircut); no fill within waitBars = missed", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.996 }); // above 100 x (1 - 0.5bp) = 99.995: touched, not through
    set(c, 22, { l: 99.996 });
    const s = simulateScalp(c, sig, tp(), costs);
    expect(s.trades).toHaveLength(0);
    expect(s.missed).toBe(1);
    // ... and a later fill outside the wait window does not count either
    set(c, 23, { l: 99.9 });
    expect(simulateScalp(c, sig, tp(), costs).trades).toHaveLength(0);
    expect(simulateScalp(c, sig, tp({ waitBars: 3 }), costs).trades).toHaveLength(1);
  });

  it("the stop is checked before the target inside one bar", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    set(c, 22, { h: 100.5, l: 99.7 });
    expect(simulateScalp(c, sig, tp(), costs).trades[0]!.reason).toBe("stop");
  });

  it("a gap through the stop fills at the open, not at the stop", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    set(c, 22, { o: 99.0, h: 99.1, l: 98.9, c: 99.0 });
    const t = simulateScalp(c, sig, tp(), costs).trades[0]!;
    expect(t.exitPx).toBeCloseTo(99.0 * (1 - 0.00015), 8);
  });

  it("a maker entry cannot take its target on its own fill bar", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9, h: 100.4 }); // fills, and the bar also reaches the target: unknowable order, so no target here
    set(c, 22, { h: 100.1 });
    const t = simulateScalp(c, sig, tp({ holdBars: 3 }), costs).trades[0]!;
    expect(t.reason).toBe("time");
  });

  it("time stop exits at the close as a taker", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    const t = simulateScalp(c, sig, tp({ holdBars: 3 }), costs).trades[0]!;
    expect(t.reason).toBe("time");
    expect(t.bars).toBe(3);
    expect(t.exitPx).toBeCloseTo(100 * (1 - 0.00015), 8);
    expect(t.feeBps).toBeCloseTo(7, 6);
  });

  it("taker entry fills at the next open plus slippage and half a spread, and pays taker fees on entry", () => {
    const { c, sig } = setup();
    set(c, 22, { h: 100.4 });
    const t = simulateScalp(c, sig, tp({ makerEntry: 0, makerTarget: 0 }), costs).trades[0]!;
    expect(t.entryPx).toBeCloseTo(100 * 1.00015, 8);
    expect(t.reason).toBe("target");
    expect(t.feeBps).toBeCloseTo(10, 6);
    expect(t.makerEntry).toBe(false);
  });

  it("shorts mirror longs", () => {
    const { c, sig } = setup(-1);
    set(c, 21, { h: 100.1 });
    set(c, 22, { l: 99.7 });
    const t = simulateScalp(c, sig, tp(), costs).trades[0]!;
    expect(t).toMatchObject({ side: -1, entryPx: 100, reason: "target" });
    expect(t.exitPx).toBeCloseTo(99.8, 9);
    expect(t.grossBps).toBeCloseTo(20, 6);
  });

  it("the cost gate turns away a target that is small next to its round trip", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    // target 0.2 ATR = 4 bp; a maker round trip costs 4 bp, taker 15: gate x3 wants 12 bp
    const gated = simulateScalp(c, sig, tp({ targetAtr: 0.2, costGateMult: 3 }), costs);
    expect(gated.trades).toHaveLength(0);
    expect(gated.gated).toBe(1);
    expect(roundTripCostBps(costs, true, true)).toBeCloseTo(4, 6);
    expect(roundTripCostBps(costs, false, false)).toBeCloseTo(2 * (5 + 1 + 0.5), 6);
    expect(passesCostGate(12, costs, { makerEntry: 1, makerTarget: 1, costGateMult: 3 })).toBe(true);
    expect(passesCostGate(11.9, costs, { makerEntry: 1, makerTarget: 1, costGateMult: 3 })).toBe(false);
    expect(passesCostGate(1, costs, { makerEntry: 1, makerTarget: 1, costGateMult: 0 })).toBe(true);
  });

  it("the ATR band skips dead and wild markets, and one position is held at a time", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    expect(simulateScalp(c, sig, tp({ minAtrBps: 30 }), costs).gated).toBe(1);
    expect(simulateScalp(c, sig, tp({ maxAtrBps: 10 }), costs).gated).toBe(1);
    sig[22] = 1; // a second desire while the first trade is still open is ignored
    set(c, 22, { h: 100.3 });
    const s = simulateScalp(c, sig, tp(), costs);
    expect(s.trades).toHaveLength(1);
    expect(s.signals).toBe(1);
  });

  it("stats: expectancy, fees, win rate and drawdown add up", () => {
    const { c, sig } = setup();
    set(c, 21, { l: 99.9 });
    set(c, 22, { h: 100.3 });
    const st = scalpStats(simulateScalp(c, sig, tp(), costs), 1);
    expect(st).toMatchObject({ trades: 1, winRatePct: 100, fillRatePct: 100 });
    expect(st.netExpectancyBps).toBeCloseTo(16, 6);
    expect(st.grossExpectancyBps - st.feesBpsPerTrade).toBeCloseTo(st.netExpectancyBps, 9);
    expect(st.exits.target).toBe(1);
  });

  it("tradeParams reads only trade keys and keeps defaults for the rest", () => {
    expect(tradeParams({ n: 30, targetAtr: 2 })).toMatchObject({ targetAtr: 2, stopAtr: TRADE_DEFAULTS.stopAtr, holdBars: TRADE_DEFAULTS.holdBars });
  });
});

describe("rules", () => {
  it("micro breakout is causal: bars after i never change the signal at i", () => {
    const c = walk(3, 600, 6, 0.2);
    const full = microBreakout.signal(c, microBreakout.defaults);
    const cut = microBreakout.signal(c.slice(0, 400), microBreakout.defaults);
    for (let i = 0; i < 400; i++) expect(cut[i]).toBe(full[i]);
    expect(full.some((x) => x !== 0)).toBe(true);
  });
});

describe("walk-forward verdicts", () => {
  it("a random walk has no edge after costs, and the report says so", () => {
    const rep = buildScalpReport([{ id: "RW 1m", candles: walk(11, 12_000, 6, 0) }]);
    expect(rep.verdict.edge).toBe(false);
    expect(rep.results.every((r) => !r.edge)).toBe(true);
    expect(rep.results.every((r) => r.oos.netExpectancyBps < 0)).toBe(true);
    const md = scalpReportMarkdown(rep);
    expect(md).toContain("NO EDGE");
    expect(md).toContain("RW 1m");
  });

  it("momentum shows a gross edge only when costs are ignored: fees and spread are what decide", () => {
    const c = walk(7, 20_000, 6, 0.25);
    const free: CostModel = { makerFee: 0, takerFee: 0, slippageBps: 0, halfSpreadBps: 0, throughBps: 0.5 };
    const cheap = evaluateScalpRule(microBreakout, c, "AR", { costs: free });
    expect(cheap.edge).toBe(true);
    expect(cheap.oos.netExpectancyBps).toBeGreaterThan(1);
    const real = evaluateScalpRule(microBreakout, c, "AR", { costs: DEFAULT_COSTS });
    expect(real.edge).toBe(false);
    expect(real.oos.netExpectancyBps).toBeLessThan(cheap.oos.netExpectancyBps);
  });

  it("synthetic data can pass a rule but never opens the gate", () => {
    const c = walk(7, 20_000, 6, 0.25);
    const free: CostModel = { makerFee: 0, takerFee: 0, slippageBps: 0, halfSpreadBps: 0, throughBps: 0.5 };
    const rep = buildScalpReport([{ id: "SYN", candles: c, synthetic: true }], [microBreakout], { costs: free });
    expect(rep.results[0]!.edge).toBe(true);
    expect(rep.source).toBe("synthetic");
    expect(rep.verdict.edge).toBe(false);
    expect(rep.verdict.note).toMatch(/Synthetic/);
    const real = buildScalpReport([{ id: "OKX BTC 1m", candles: c }], [microBreakout], { costs: free });
    expect(real.verdict.edge).toBe(true);
    expect(real.verdict.passing[0]).toMatchObject({ dataset: "OKX BTC 1m", ruleId: "micro_breakout" });
  });

  it("too little history is reported, not guessed at", () => {
    const r = evaluateScalpRule(microBreakout, walk(1, 300, 6), "short");
    expect(r.edge).toBe(false);
    expect(r.why).toMatch(/too little history/);
  });

  it("is deterministic: the same data and costs give the same report", () => {
    const c = walk(5, 8000, 6, 0.1);
    const a = buildScalpReport([{ id: "X", candles: c }], [microBreakout], {}, 1);
    const b = buildScalpReport([{ id: "X", candles: c }], [microBreakout], {}, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.datasets[0]!.hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("the gate the live scalper is held to", () => {
  const free: CostModel = { makerFee: 0, takerFee: 0, slippageBps: 0, halfSpreadBps: 0, throughBps: 0.5 };
  const edgeReport = (now: number) => buildScalpReport([{ id: "BTC-USDT-SWAP 1m", candles: walk(7, 20_000, 6, 0.25) }], [microBreakout], { costs: free }, now);

  it("is closed with no report, on synthetic data, with no edge, and when the report is stale", () => {
    const now = Date.UTC(2026, 5, 1);
    expect(scalpGate(null, now)).toMatchObject({ open: false, rules: [] });
    expect(scalpGate(null, now).reason).toMatch(/pnpm lab scalp/);
    const syn = buildScalpReport([{ id: "SYN 1m", candles: walk(7, 20_000, 6, 0.25), synthetic: true }], [microBreakout], { costs: free }, now);
    expect(scalpGate(syn, now).reason).toMatch(/synthetic/);
    const none = buildScalpReport([{ id: "BTC-USDT-SWAP 1m", candles: walk(11, 12_000, 6, 0) }], [microBreakout], {}, now);
    expect(scalpGate(none, now)).toMatchObject({ open: false });
    expect(scalpGate(none, now).reason).toMatch(/no edge/);
    expect(scalpGate(edgeReport(now), now + 30 * 86_400_000).reason).toMatch(/days old/);
  });

  it("opens per coin, with the rule and parameters that passed, and survives a save and load", () => {
    const now = Date.UTC(2026, 5, 1);
    const rep = edgeReport(now);
    const g = scalpGate(rep, now + 86_400_000);
    expect(g.open).toBe(true);
    expect(g.rules[0]).toMatchObject({ coin: "BTC", ruleId: "micro_breakout" });
    expect(g.rules[0]!.netBps).toBeGreaterThan(1);
    const dir = mkdtempSync(join(tmpdir(), "scalp-"));
    saveScalpReport(dir, rep);
    expect(existsSync(join(dir, "scalp-report.md"))).toBe(true);
    expect(scalpGate(loadScalpReport(dir), now + 86_400_000).open).toBe(true);
    expect(loadScalpReport(join(dir, "nope"))).toBeNull();
  });
});
