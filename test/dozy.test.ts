import { describe, expect, it } from "vitest";
import { dozy, dozyCandidates, dozySizeFrac } from "../src/bees/dozy.js";
import type { BeeContext } from "../src/bees/types.js";
import { freshBee } from "../src/ledger.js";
import { dailyStats } from "../src/market/indicators.js";
import type { Candle, DailyStats } from "../src/market/types.js";
import { applyRisk } from "../src/risk.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

const DAY = 86_400_000;
const daily = (over: Partial<DailyStats> = {}): DailyStats => ({ bars: 120, close: 100, mom90Pct: 20, atrPct: 4, volPct: 4, at: NOW, ...over });
function ctx(stats = [coin("BTC", { daily: daily({ mom90Pct: 10 }) }), coin("SOL", { daily: daily({ mom90Pct: 40, volPct: 5 }) }), coin("PEPE", { daily: daily({ mom90Pct: 300 }) }), coin("ETH", { daily: daily({ mom90Pct: -5 }) })], env: Record<string, string> = {}, slots = 3): BeeContext {
  const cfg = testConfig({ BEE_START_EQUITY_USD: "1000", MAX_NOTIONAL_USD_PER_BEE: "10000", ...env });
  return { bee: freshBee("bee1", 1000, NOW - 3_600_000), view: view(stats), cfg, knobs: cfg.bees.dozy, now: NOW, uplR: 0, slots };
}

describe("dailyStats", () => {
  const bars = (closes: number[], confirmedLast = true): Candle[] =>
    closes.map((c, i) => ({ ts: NOW - (closes.length - i) * DAY, o: c, h: c * 1.02, l: c * 0.98, c, volUsd: 1e6, confirmed: i < closes.length - 1 || confirmedLast }));
  it("measures 90-day momentum from confirmed closes only", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    const d = dailyStats(bars(closes), NOW)!;
    expect(d.bars).toBe(120);
    expect(d.close).toBe(219);
    expect(d.mom90Pct).toBeCloseTo((219 / 129 - 1) * 100, 6);
    // Today's open candle never moves the signal.
    const open = dailyStats(bars([...closes, 999], false), NOW)!;
    expect(open.mom90Pct).toBeCloseTo(d.mom90Pct!, 6);
    expect(d.atrPct).toBeGreaterThan(0);
    expect(d.volPct).toBeGreaterThan(0);
  });
  it("has no momentum with fewer than 91 bars", () => {
    expect(dailyStats(bars(Array.from({ length: 60 }, () => 100)), NOW)!.mom90Pct).toBeNull();
    expect(dailyStats([], NOW)).toBeNull();
  });
});

describe("dozy brain", () => {
  it("offers only its large coins in a 90-day uptrend, strongest first", () => {
    const c = ctx();
    expect(dozyCandidates(c).map((s) => s.coin)).toEqual(["SOL", "BTC"]); // PEPE is not on its list, ETH is down
    const m = dozy.menu(c);
    expect(Object.keys(m)).toEqual(["TREND_SOL", "TREND_BTC", "WAIT"]);
    expect(dozy.forcedEntry(c)?.instId).toBe(c.view.stats.get("SOL-USD_UM_XPERP-310404")!.instId);
    expect(dozy.menu(ctx([coin("ETH", { daily: daily({ mom90Pct: -5 }) })]))).toEqual({ WAIT: expect.anything() });
    expect(dozy.forcedEntry(ctx([coin("ETH", { daily: daily({ mom90Pct: -5 }) })]))).toBeNull();
  });

  it("holds with a single option (no Jev call) and code closes a broken trend", () => {
    const c = ctx();
    const btc = c.view.stats.get("BTC-USD_UM_XPERP-310404")!;
    c.bee.position = position(btc, { contracts: 100, riskUsd: 10 });
    expect(Object.keys(dozy.menu(c))).toEqual(["HOLD"]);
    expect(dozy.forcedClose!(c)).toBeNull();
    btc.daily = daily({ mom90Pct: -0.1 });
    expect(dozy.forcedClose!(c)).toBe("trend_over");
    btc.daily = undefined; // data missing: keep it, the stop still guards
    expect(dozy.forcedClose!(c)).toBeNull();
  });

  it("sizes by volatility and ignores the risk-per-trade rule", () => {
    // 2% target / 5% daily vol = 0.4x equity = $400 per position over the slots: 3 slots -> $133 each.
    const c = ctx(undefined, { RISK_PER_TRADE_PCT: "1.5", PAPER_MAX_LEVERAGE: "5" });
    const sol = c.view.stats.get("SOL-USD_UM_XPERP-310404")!;
    expect(dozySizeFrac(sol, c) * (4850 / 3)).toBeCloseTo(400 / 3, 6);
    const r = applyRisk({ ctx: c, brain: dozy, proposal: { label: "TREND_SOL", intent: dozy.menu(c).TREND_SOL!.intent, prob: 0.9, conviction: 2 }, jev: "ok", sizeMult: 1, dataAgeMs: 0, maxDataAgeMs: 60_000 });
    expect(r.vetoedBy).toBeNull();
    expect((r.action as { notionalUsd: number }).notionalUsd).toBeCloseTo(400 / 3, 6);
    // One slot: the whole target in one coin; a calm coin is capped at 1x equity.
    expect(dozySizeFrac(sol, { ...c, slots: 1 }) * 4850).toBeCloseTo(400, 6);
    const calm = coin("BTC", { daily: daily({ volPct: 1 }) });
    expect(dozySizeFrac(calm, c) * 4850).toBeCloseTo(1000, 6);
  });

  it("puts its catastrophe stop 3 daily ATRs away, between 8% and 30%", () => {
    const c = ctx([coin("BTC", { daily: daily({ atrPct: 4 }) }), coin("SOL", { daily: daily({ atrPct: 1 }) }), coin("XRP", { daily: daily({ atrPct: 20 }) })]);
    expect(dozy.stopFor("BTC-USD_UM_XPERP-310404", "long", 100, c)).toBeCloseTo(88, 6);
    expect(dozy.stopFor("SOL-USD_UM_XPERP-310404", "long", 100, c)).toBeCloseTo(92, 6);
    expect(dozy.stopFor("XRP-USD_UM_XPERP-310404", "long", 100, c)).toBeCloseTo(70, 6);
  });
});
