// The gold research layer: metrics, Monte Carlo, stability, coarse-to-fine, walk-forward, ablation, black-box fit,
// reports, the MT5 plan, configuration files, the MT5 CSV importer, and a golden regression.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEngineConfig, loadProfiles, parseNewsCsv, parseTradesCsv, SKILL_DIR, writeDefaultConfigs } from "../src/lab/gold/config.js";
import { defaultEngine, defaultProfile, defaultProfiles } from "../src/lab/gold/profiles.js";
import { ABLATION_STEPS, ablate, runAblation } from "../src/lab/gold/research/ablation.js";
import { fitConfig, fitObserved, matchScore, profileFor, type FitParams } from "../src/lab/gold/research/blackbox.js";
import { computeMetrics, drawdowns, qualityBreakdown, runMetrics, streaks } from "../src/lab/gold/research/metrics.js";
import { mt5Plan } from "../src/lab/gold/research/mt5plan.js";
import { DEFAULT_MC, monteCarlo } from "../src/lab/gold/research/montecarlo.js";
import { coarseToFine, score } from "../src/lab/gold/research/optimizer.js";
import { applyChoice, choiceKey } from "../src/lab/gold/research/params.js";
import { buildReport, renderReport, sanityChecks, validationGates } from "../src/lab/gold/research/report.js";
import { parameterStability } from "../src/lab/gold/research/stability.js";
import { makeWindows, sliceData, walkForward } from "../src/lab/gold/research/walkforward.js";
import { runGold, type GoldData } from "../src/lab/gold/sim.js";
import type { GoldTrade } from "../src/lab/gold/types.js";
import { parseMt5Csv, type Mt5Bar } from "../src/lab/history.js";
import { walk } from "./synth.js";

const T0 = Date.UTC(2026, 0, 5, 8, 0);
const M5 = 300_000;
const gold = (seed: number, bars: number, ms = M5): GoldData => ({ base: walk(seed, bars, 7, 0.05, ms, 2500, T0) as Mt5Bar[], baseTf: ms === M5 ? "M5" : "M15" });
const BIG = { account: { initial_balance: 500_000 }, filters: { weekend: { enabled: false }, spread: { enabled: false } }, base_timeframe: "M5" };

const trade = (over: Partial<GoldTrade> = {}): GoldTrade => ({
  id: 1, strategy: "S4", magic: 620004, side: "BUY", signalTs: T0, entryTs: T0, exitTs: T0 + 3_600_000, level: 2000, entryPx: 2000, exitPx: 2010, sl0: 1995, tp0: 2010, lots: 0.1, pnl: 100, pnlPrice: 10, commission: 0, swap: 0, r: 2, riskAtEntry: 50, riskPct: 0.25, exitReason: "TP", bars: 12, minutes: 60,
  quality: { armDistance: 5, levelAgeBars: 10, touches: 1, minutesSinceLastTouch: 30, atrAtEntry: 2, spreadAtEntry: 0.3, breakoutBarRange: 3, mfe: 10, mae: 1, mfeR: 2, maeR: 0.2, minutesToMfe: 40, minutesToMae: 5, fakeBreakout: "passed", normalizationFactor: 1, entryTimeframe: "H1" },
  ...over,
});

describe("metrics", () => {
  it("streaks and drawdowns", () => {
    expect(streaks([1, 1, -1, -1, -1, 1, 0, 1, 1, 1, 1])).toEqual({ win: 4, loss: 3 });
    const d = drawdowns([100, 120, 90, 110, 80, 130]);
    expect(d.max).toBeCloseTo(((120 - 80) / 120) * 100, 9);
  });

  it("profit factor, expectancy, payoff, split and monthly returns add up", () => {
    const ts = [trade({ pnl: 100, r: 2 }), trade({ id: 2, pnl: -50, r: -1, side: "SELL", exitTs: T0 + 86_400_000 * 40 }), trade({ id: 3, pnl: 150, r: 3, exitTs: T0 + 86_400_000 * 41 })];
    const m = computeMetrics(ts, 10_000, T0, T0 + 86_400_000 * 90);
    expect(m).toMatchObject({ trades: 3, netProfit: 200, winRatePct: (2 / 3) * 100, long: { trades: 2 }, short: { trades: 1 } });
    expect(m.profitFactor).toBeCloseTo(250 / 50, 9);
    expect(m.expectancy).toBeCloseTo(200 / 3, 9);
    expect(m.expectancyR).toBeCloseTo(4 / 3, 9);
    expect(m.payoff).toBeCloseTo(125 / 50, 9);
    expect(m.maxWinningStreak).toBe(1);
    expect(Object.keys(m.monthly)).toEqual(["2026-01", "2026-02"]);
    expect(m.timeInMarketPct).toBeGreaterThan(0);
  });

  it("run metrics split by strategy and the shares add up to the whole", () => {
    const r = runGold({ ...BIG, frequency: "EXTREME" }, gold(11, 30_000), { profiles: defaultProfiles(), commit: "t" });
    const m = runMetrics(r);
    expect(m.portfolio.trades).toBe(r.trades.length);
    expect(Object.keys(m.perStrategy)).toEqual(r.profiles.map((p) => p.id));
    expect(Object.values(m.attribution).reduce((a, x) => a + x.pnl, 0)).toBeCloseTo(m.portfolio.netProfit, 6);
    expect(Object.values(m.perStrategy).reduce((a, x) => a + x.trades, 0)).toBe(m.portfolio.trades);
    const q = qualityBreakdown(r.trades);
    expect(Object.values(q.exits).reduce((a, x) => a + x.n, 0)).toBe(r.trades.length);
    expect(q.byFake.map((x) => x.fakeBreakout)).toEqual(["off", "passed", "failed"]);
  });
});

describe("Monte Carlo", () => {
  const opts = { ...DEFAULT_MC, initial: 10_000, years: 1, contract: { tick_size: 0.01, tick_value: 1 } };
  const winners = Array.from({ length: 40 }, (_, i) => trade({ id: i, pnl: 100, pnlPrice: 10 }));
  const losers = Array.from({ length: 40 }, (_, i) => trade({ id: i, pnl: -400, pnlPrice: -40, lots: 0.1 }));

  it("is seeded: same seed, same answer; another seed, another answer", () => {
    const a = monteCarlo(winners, { ...opts, runs: 200, seed: 5 });
    expect(monteCarlo(winners, { ...opts, runs: 200, seed: 5 })).toEqual(a);
    expect(monteCarlo(winners, { ...opts, runs: 200, seed: 6 }).medianNetProfit).not.toBe(a.medianNetProfit);
  });

  it("an all-winning edge never loses; an all-losing one is ruined; perturbations cost money", () => {
    const zero = { ...opts, extraSpread: 0, slippage: 0, priceNoise: 0, missProb: 0, latency: 0, runs: 100 };
    const clean = monteCarlo(winners, zero);
    expect(clean.probabilityOfLossPct).toBe(0);
    expect(clean.medianNetProfit).toBeCloseTo(40 * 1000 * 0.1 * 1, 3); // 40 trades x 0.1 lots x 10 USD x 100 oz
    const harsh = monteCarlo(winners, { ...zero, extraSpread: 0.5, slippage: 0.3, latency: 0.3 });
    expect(harsh.medianNetProfit).toBeLessThan(clean.medianNetProfit);
    const ruined = monteCarlo(losers, { ...opts, runs: 100 });
    expect(ruined.probabilityOfRuinPct).toBe(100);
    expect(ruined.worst.sequence.length).toBeGreaterThan(0);
    expect(ruined.p95MaxDrawdownPct).toBeGreaterThanOrEqual(ruined.medianMaxDrawdownPct);
  });

  it("no trades, no numbers", () => {
    expect(monteCarlo([], { ...opts, runs: 10 })).toMatchObject({ runs: 0, probabilityOfRuinPct: 0 });
  });
});

describe("parameter stability", () => {
  const pts = (scores: number[]) => scores.map((s, i) => ({ choice: { sl: [0.6, 0.8, 1, 1.3, 1.6][i]! }, score: s, trades: 50 }));
  it("17 excellent, 16 and 18 terrible: an isolated peak is rejected however high it ranks", () => {
    const r = parameterStability(pts([-0.5, -0.4, 3, -0.6, -0.3]), ["sl"]);
    expect(r.best!.choice.sl).toBe(1);
    expect(r.best!.isolated).toBe(true);
    expect(r.bestStable).toBeNull();
    expect(r.isolatedSharePct).toBe(100);
  });
  it("a plateau is accepted", () => {
    const r = parameterStability(pts([0.4, 0.9, 1.0, 0.85, 0.3]), ["sl"]);
    expect(r.bestStable!.choice.sl).toBe(1);
    expect(r.bestStable!.isolated).toBe(false);
    expect(r.plateauSharePct).toBe(100);
  });
  it("coarse-to-fine lands on the plateau, not on the spike", () => {
    // a lone spike at arm=0.5/sl=1.6 (score 9), and a broad hill around arm=1/sl=1
    const f = (c: Record<string, string | number>) => {
      const arm = Number(c.arm);
      const sl = Number(c.sl);
      const spike = arm === 0.5 && sl === 1.6 ? 9 : 0;
      const hill = 2 - Math.abs(arm - 1) * 1.2 - Math.abs(sl - 1) * 1.2;
      return { score: spike || hill, trades: 60 };
    };
    const r = coarseToFine(f, { dims: ["arm", "sl"], minTrades: 30 });
    expect(r.best).not.toBeNull();
    expect(r.best!.choice.arm).not.toBe(0.5);
    expect(Math.abs(Number(r.best!.choice.arm) - 1)).toBeLessThan(0.3);
    expect(r.evaluations).toBeLessThan(60);
    expect(r.fine.length).toBeGreaterThan(0);
  });
  it("scoring punishes too few trades and deep drawdowns", () => {
    const m = computeMetrics([trade({ r: 1 })], 10_000, T0, T0 + 1e9);
    expect(score(m, 30)).toBeLessThan(0);
    const many = computeMetrics(Array.from({ length: 50 }, (_, i) => trade({ id: i, r: 0.2, pnl: 10 })), 10_000, T0, T0 + 1e10);
    expect(score(many, 30)).toBeGreaterThan(0);
  });
  it("choices apply to a profile without mutating it", () => {
    const p = defaultProfile("S4");
    const q = applyChoice(p, { sl: 1.5, arm: 0.5, fake: "OFF", norm: "ATR", left: 4 });
    expect(q.stop_loss.base_distance).toBeCloseTo(p.stop_loss.base_distance * 1.5, 9);
    expect(q.entry.min_arm_distance).toBeCloseTo(p.entry.min_arm_distance * 0.5, 9);
    expect(q.fake_breakout.enabled).toBe(false);
    expect(q.normalization?.mode).toBe("ATR");
    expect(q.structure.left_bars).toBe(4);
    expect(p.stop_loss.base_distance).toBe(26);
    expect(choiceKey({ b: 1, a: 2 })).toBe("a=2,b=1");
  });
});

describe("walk-forward", () => {
  it("makes rolling windows that fit the data", () => {
    const w = makeWindows(Date.UTC(2016, 0, 1), Date.UTC(2023, 0, 1), { trainMonths: 36, validateMonths: 12, stepMonths: 12 });
    expect(w).toHaveLength(4);
    expect(new Date(w[0]!.train[0]).getUTCFullYear()).toBe(2016);
    expect(w[0]!.validate[0]).toBe(w[0]!.train[1]);
    expect(new Date(w[3]!.validate[1]).getUTCFullYear()).toBe(2023);
    expect(makeWindows(0, 1000, { trainMonths: 36, validateMonths: 12, stepMonths: 12 })).toEqual([]);
  });

  it("slices the data with a warm-up and keeps it sorted", () => {
    const d = gold(3, 2000);
    const s = sliceData(d, T0 + 500 * M5, T0 + 900 * M5, 100 * M5);
    expect(s.base[0]!.ts).toBe(T0 + 400 * M5);
    expect(s.base[s.base.length - 1]!.ts).toBe(T0 + 899 * M5);
  });

  it("trains on the past, validates on what it has not seen, and reports every window", () => {
    const d: GoldData = { base: walk(41, 26_000, 7, 0.08, 900_000, 2500, T0) as Mt5Bar[], baseTf: "M15" }; // ~9 months of M15
    const cfg = { ...BIG, base_timeframe: "M15", frequency: "EXTREME" };
    const wf = walkForward(cfg, d, defaultProfiles(), ["S8"], { trainMonths: 3, validateMonths: 1, stepMonths: 2, warmupDays: 10, minTrades: 5, search: { dims: ["fake", "tp"], maxCoarse: 8, maxFine: 6, minTrades: 5 } }, { commit: "t" });
    expect(wf.totalWindows).toBeGreaterThanOrEqual(2);
    expect(wf.windows).toHaveLength(wf.totalWindows);
    for (const w of wf.windows) {
      const [vs, ve] = [Date.parse(w.validate[0]), Date.parse(w.validate[1])];
      // every validation trade was armed and entered inside its validation window: nothing from the training period leaks
      for (const t of w.validateTrades) {
        expect(t.entryTs).toBeGreaterThanOrEqual(vs);
        expect(t.entryTs).toBeLessThan(ve);
      }
      expect(Date.parse(w.train[1])).toBe(vs);
      expect(w.evaluations).toBeGreaterThan(0);
    }
    expect(wf.oos.trades).toBe(wf.windows.reduce((a, w) => a + w.validateTrades.length, 0));
    expect(wf.note).toMatch(/losing|profitable or not/);
  });
});

describe("ablation", () => {
  it("switches layers on one at a time, in the documented order", () => {
    expect(ABLATION_STEPS).toHaveLength(10);
    const cfg = defaultEngine({ ...BIG });
    const ps = defaultProfiles();
    const base = ablate(cfg, ps, 0);
    expect(base.profiles.every((p) => p.entry.min_arm_distance === 0 && p.entry.breakout_offset === 0 && !p.fake_breakout.enabled && !p.break_even.enabled && !p.trailing.enabled && !p.structure_trailing.enabled)).toBe(true);
    expect(base.profiles.every((p) => p.risk.weight === 1)).toBe(true);
    expect(ablate(cfg, ps, 1).profiles[3]!.entry.min_arm_distance).toBe(ps[3]!.entry.min_arm_distance);
    expect(ablate(cfg, ps, 1).profiles[3]!.entry.breakout_offset).toBe(0);
    expect(ablate(cfg, ps, 4).profiles[3]!.break_even.enabled).toBe(true);
    expect(ablate(cfg, ps, 4).profiles[3]!.trailing.enabled).toBe(false);
    const full = ablate(cfg, ps, 9);
    expect(full.profiles.map((p) => p.risk.weight)).toEqual(ps.map((p) => p.risk.weight));
    expect(ps[3]!.entry.breakout_offset).toBeGreaterThan(0); // the input is untouched
  });

  it("runs the ten steps on the same data and reports the deltas", () => {
    const rows = runAblation(defaultEngine({ ...BIG, frequency: "EXTREME" }), gold(9, 15_000), defaultProfiles(), ["S8"], { commit: "t" });
    expect(rows.map((r) => r.step)).toEqual([...ABLATION_STEPS]);
    expect(rows[1]!.delta.netProfit).toBeCloseTo(rows[1]!.metrics.netProfit - rows[0]!.metrics.netProfit, 6);
    expect(rows[8]!.note).toMatch(/no news calendar/);
  });
});

describe("black-box calibration", () => {
  const truth: FitParams = { entryTf: "M15", left: 3, right: 3, lookback: 100, arm: 6, offset: 1, expiryBars: 24, fake: "OFF", sl: 15, tp: 25, trail: false };
  const d: GoldData = { base: walk(51, 12_000, 7, 0.1, 900_000, 2500, T0) as Mt5Bar[], baseTf: "M15" };
  const cfg = { ...BIG, base_timeframe: "M15" };
  const truthRun = runGold(fitConfig(cfg), d, { profiles: [profileFor(truth, "M15")], strategies: ["S4"], commit: "t" });
  const observed = truthRun.trades.map((t) => ({ entryTs: t.entryTs, entryPx: t.entryPx, direction: t.side, exitTs: t.exitTs, exitPx: t.exitPx }));

  it("the model that made the trades scores itself near the maximum", () => {
    expect(observed.length).toBeGreaterThan(5);
    const s = matchScore(truthRun.trades.map((t) => ({ entryTs: t.entryTs, entryPx: t.entryPx, side: t.side, level: t.level })), observed, 1_800_000, 1.5, 1);
    expect(s.entryMatch).toBe(1);
    expect(s.directionMatch).toBe(1);
    expect(s.score).toBeGreaterThan(3.5);
    expect(matchScore([], observed, 1_800_000, 1.5, 1).score).toBe(0);
  });

  it("returns ranked ESTIMATES with a disclaimer, never facts", () => {
    const res = fitObserved(cfg, d, observed, { evaluations: 25, refine: 15, top: 3, seed: 2, paddingDays: 20 });
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.length).toBeLessThanOrEqual(3);
    expect(res.candidates.every((c) => c.label === "estimated")).toBe(true);
    expect(res.candidates.map((c) => c.fit.score)).toEqual([...res.candidates.map((c) => c.fit.score)].sort((a, b) => b - a));
    expect(res.disclaimer).toMatch(/ESTIMATES/);
    expect(res.disclaimer).toMatch(/not.*facts about any commercial system/);
  });
});

describe("reports", () => {
  const r = runGold({ ...BIG, frequency: "EXTREME" }, gold(13, 30_000), { profiles: defaultProfiles(), commit: "abc123" });

  it("sanity checks pass on a real run", () => {
    const c = sanityChecks(r);
    expect(c.length).toBeGreaterThanOrEqual(8);
    expect(c.filter((x) => !x.ok)).toEqual([]);
  });

  it("holds all thirteen things, leads with the drawdown, and counts what was not run as not passed", () => {
    const rep = buildReport(r, { dataSource: "test data" });
    expect(Object.keys(rep)).toEqual(expect.arrayContaining(["configuration", "dataPeriod", "dataSource", "brokerAssumptions", "tradeCount", "portfolioMetrics", "perStrategyMetrics", "drawdown", "equityCurve", "parameterStability", "failed", "limitations", "reproducibility"]));
    expect(rep.reproducibility).toMatchObject({ code_commit: "abc123", strategy_version: "1.0.0" });
    const md = renderReport(rep);
    expect(md.split("\n")[2]).toMatch(/Maximum drawdown/);
    expect(md).toMatch(/not run: walk-forward/);
    expect(md).toMatch(/config_hash:/);
    expect(md).toMatch(/Limitations/);
    expect(rep.failed.gates.every((g) => g.status !== "pass")).toBe(true);
  });

  it("validation gates pass and fail on thresholds", () => {
    const m = runMetrics(r).portfolio;
    const mc = { runs: 10, tradesPerRun: 5, medianCagrPct: 1, medianMaxDrawdownPct: 5, p95MaxDrawdownPct: 40, medianNetProfit: 1, probabilityOfLossPct: 10, probabilityOfRuinPct: 0, worst: { netProfit: -1, maxDrawdownPct: 1, sequence: [] }, finalEquity: { p5: 1, p50: 1, p95: 1 } };
    const gates = validationGates(m, { monteCarlo: mc });
    expect(gates.find((g) => g.name.includes("probability of ruin"))!.status).toBe("pass");
    expect(gates.find((g) => g.name.includes("95th percentile"))!.status).toBe("fail");
    expect(gates.find((g) => g.name === "walk-forward")!.status).toBe("not run");
  });

  it("the MT5 plan is derived from the configuration and keeps live trading off", () => {
    const plan = mt5Plan(defaultEngine({ frequency: "MODERATE" }), defaultProfiles().slice(0, 3));
    expect(plan).toMatch(/InpLiveTrading.*false/);
    expect(plan).toMatch(/620001/);
    expect(plan).toMatch(/620003/);
    expect(plan).not.toMatch(/620004/);
    expect(plan).toMatch(/BuyStop/);
    expect(plan).toMatch(/OrderCalcProfit/);
    expect(plan).toMatch(/does not reproduce any commercial EA/);
  });
});

describe("configuration files and importers", () => {
  it("the shipped JSON configs match the code defaults (no drift)", () => {
    expect(existsSync(join(SKILL_DIR, "config", "default.json"))).toBe(true);
    expect(loadProfiles(join(SKILL_DIR, "config"))).toEqual(defaultProfiles());
    expect(loadEngineConfig(join(SKILL_DIR, "config"))).toEqual(defaultEngine());
  });
  it("writes editable configs and reads edits back, validated", () => {
    const dir = mkdtempSync(join(tmpdir(), "gold-"));
    expect(writeDefaultConfigs(dir)).toHaveLength(10);
    const s4 = JSON.parse(readFileSync(join(dir, "s4.json"), "utf8"));
    s4.stop_loss.base_distance = 30;
    // a bad edit is an error, not a silent default
    const bad = { ...s4, stop_loss: { base_distance: -1 } };
    expect(() => loadProfiles(dir)).not.toThrow();
    expect(loadEngineConfig(dir, { risk: { max_open_risk_pct: 0.5 } }).risk.max_open_risk_pct).toBe(0.5);
    expect(() => loadEngineConfig(dir, { live_trading: "yes" })).toThrow();
    void bad;
  });
  it("parses a news calendar and public trade records", () => {
    const ev = parseNewsCsv("time,name,impact\n2026-01-09T13:30:00,NFP,high\n2026-01-14T13:30:00Z,CPI,high\n");
    expect(ev.map((e) => e.name)).toEqual(["NFP", "CPI"]);
    expect(ev[0]!.time).toBe(Date.UTC(2026, 0, 9, 13, 30));
    expect(() => parseNewsCsv("when,what\n1,2")).toThrow(/time/);
    const tr = parseTradesCsv("entry_time,entry_price,direction,exit_time,exit_price\n2026-01-05T10:00:00,2031.5,buy,2026-01-05T12:00:00,2040\n2026-01-06T10:00:00,2020,SELL,,\n");
    expect(tr).toHaveLength(2);
    expect(tr[0]).toMatchObject({ direction: "BUY", entryPx: 2031.5, exitPx: 2040 });
    expect(tr[1]!.direction).toBe("SELL");
  });
  it("imports an MT5 CSV: tab separated, angle-bracket headers, the spread column, a server offset", () => {
    const csv = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\n2026.01.05\t10:05:00\t2000.10\t2001.00\t1999.50\t2000.50\t120\t0\t30\n2026.01.05\t10:00:00\t1999.00\t2000.20\t1998.80\t2000.10\t99\t0\t25\n";
    const bars = parseMt5Csv(csv, { utcOffsetHours: 2, pointSize: 0.01 });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.ts).toBe(Date.UTC(2026, 0, 5, 8, 0)); // sorted, and server time 10:00 with a +2 h offset is 08:00 UTC
    expect(bars[0]!.spread).toBeCloseTo(0.25, 9);
    expect(bars[1]!.c).toBe(2000.5);
    expect(() => parseMt5Csv("<DATE>\t<OPEN>\n2026.01.05\t1")).toThrow(/needs/);
  });
  it("the real spread history reaches the fills when the cost model says data", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ts: T0 + i * M5, o: 2000, h: 2000.5, l: 1999.5, c: 2000, volUsd: 0, confirmed: true, spread: i < 20 ? 0.2 : 2.0 }));
    const r = runGold({ ...BIG, costs: { spread: { kind: "data", value: 0.3 } } }, { base: rows, baseTf: "M5" }, { profiles: [defaultProfile("S9")], strategies: ["S9"], commit: "t" });
    expect(r.meta.spread_model).toMatch(/bar data/);
  });
});

describe("golden regression: the engine must not silently change its mind", () => {
  // A fixed seeded dataset and configuration. If a change to the engine moves these numbers, that is a decision
  // to make on purpose: update the expectations in the same commit and say why.
  it("S1-S9 on a fixed 30,000-bar M5 path", () => {
    const r = runGold({ ...BIG, frequency: "EXTREME" }, gold(11, 30_000), { profiles: defaultProfiles(), commit: "golden" });
    const per: Record<string, number> = {};
    for (const t of r.trades) per[t.strategy] = (per[t.strategy] ?? 0) + 1;
    const summary = { trades: r.trades.length, net: Math.round(r.trades.reduce((a, t) => a + t.pnl, 0)), perStrategy: per, killed: r.killed.length };
    expect(summary).toMatchInlineSnapshot(`
      {
        "killed": 0,
        "net": -15144,
        "perStrategy": {
          "S1": 7,
          "S2": 26,
          "S3": 4,
          "S4": 38,
          "S5": 94,
          "S6": 77,
          "S7": 134,
          "S8": 332,
          "S9": 203,
        },
        "trades": 915,
      }
    `);
  });
});
