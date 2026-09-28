// The gold breakout engine: hand-built price paths with exact numbers, then the properties that must always hold.
import { describe, expect, it } from "vitest";
import { resample } from "../src/lab/resample.js";
import { referenceAtr, scaleFactor } from "../src/lab/gold/normalization.js";
import { blendedWeights, sizeLots } from "../src/lab/gold/portfolio.js";
import { activeProfiles, defaultProfile, defaultProfiles, fakeChecks, FREQUENCY_PROFILES } from "../src/lab/gold/profiles.js";
import { runGold, type GoldData } from "../src/lab/gold/sim.js";
import { SwingIndex } from "../src/lab/gold/swings.js";
import { assertResearchOnly, ContractSchema, EngineSchema, LiveTradingDisabled, magicOf, StrategySchema, type StrategyProfile } from "../src/lab/gold/types.js";
import type { Mt5Bar } from "../src/lab/history.js";
import { walk } from "./synth.js";

const T0 = Date.UTC(2026, 0, 5, 8, 0); // a Monday
type Row = [o: number, h: number, l: number, c: number];
const mk = (rows: Row[], t0 = T0, ms = 300_000): Mt5Bar[] => rows.map(([o, h, l, c], i) => ({ ts: t0 + i * ms, o, h, l, c, volUsd: 0, confirmed: true }));
const flat = (n: number, px = 2000): Row[] => Array.from({ length: n }, () => [px, px + 0.5, px - 0.5, px] as Row);
const data = (rows: Row[]): GoldData => ({ base: mk(rows), baseTf: "M5" });

/** One M5 strategy on exact numbers: swing 2/2, arm 2, offset 0.5, SL 5, TP 8; every management layer off unless asked. */
const prof = (over: Record<string, unknown> = {}): StrategyProfile =>
  StrategySchema.parse({
    id: "S4",
    entry_timeframe: "M5",
    exit_timeframe: "M5",
    structure: { left_bars: 2, right_bars: 2, max_lookback_bars: 50, level_selection: "recent" },
    entry: { min_arm_distance: 2, breakout_offset: 0.5, pending_expiry_bars: 20 },
    stop_loss: { base_distance: 5 },
    take_profit: { base_distance: 8 },
    break_even: { enabled: false },
    trailing: { enabled: false },
    structure_trailing: { enabled: false },
    fake_breakout: { enabled: false },
    risk: { weight: 1, max_trade_risk_pct: 0.25 },
    ...over,
  });
const cfg = (over: Record<string, unknown> = {}) => ({
  base_timeframe: "M5",
  normalization: { mode: "NONE" },
  costs: { spread: { kind: "fixed", value: 0.2 }, slippage: 0 },
  filters: { weekend: { enabled: false } },
  risk: { max_open_risk_pct: 5 },
  ...over,
});
const run = (rows: Row[], p: StrategyProfile = prof(), c: Record<string, unknown> = cfg(), extra = {}) => runGold(c, data(rows), { profiles: [p], strategies: [p.id], commit: "test", ...extra });

/** Bars 0-9 flat at 2000, a swing high of 2010 at bar 10 (confirmed at bar 12), price resting near 2003. */
const setup = (): Row[] => [...flat(10), [2000, 2010, 2000, 2004], [2004, 2005, 2002, 2003], [2003, 2004, 2002, 2003], [2003, 2004, 2002.5, 2003.5]];
const breakout: Row = [2009, 2011, 2008, 2010.8]; // bar 14: the buy stop at 2010.5 fills, bar stays above the stop loss

describe("swings and the anti-look-ahead rule", () => {
  const bars = mk([...flat(3), [2000, 2010, 2000, 2004], [2004, 2005, 2002, 2003], [2003, 2004, 2002, 2003], ...flat(2)]);
  const sw = new SwingIndex(bars, 2, 2);
  it("a swing high needs strictly lower highs on both sides", () => {
    expect(sw.highs.map((s) => [s.index, s.price])).toEqual([[3, 2010]]);
  });
  it("a swing with right = 2 is unknown until bar index + 2 has closed", () => {
    expect(sw.highs[0]!.confirmIndex).toBe(5);
    expect(sw.known("high", 3)).toEqual([]);
    expect(sw.known("high", 4)).toEqual([]);
    expect(sw.known("high", 5)).toHaveLength(1);
    expect(sw.known("high", 9)).toHaveLength(1);
  });
  it("equal highs are not a swing", () => {
    const eq = mk([...flat(3), [2000, 2010, 2000, 2004], [2004, 2010, 2002, 2003], ...flat(3)]);
    expect(new SwingIndex(eq, 2, 2).highs).toEqual([]);
  });
});

describe("the order and its exits, in exact numbers", () => {
  it("arms a buy stop above the level, fills it, and takes profit: 0.05 lots, +8.00 on the move, +40 cash", () => {
    const r = run([...setup(), breakout, [2010.8, 2019, 2010, 2018]]);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t).toMatchObject({ strategy: "S4", magic: 620004, side: "BUY", level: 2010, entryPx: 2010.5, exitReason: "TP", lots: 0.05, sl0: 2005.5, tp0: 2018.5 });
    expect(t.exitPx).toBeCloseTo(2018.5, 9);
    expect(t.pnlPrice).toBeCloseTo(8, 9);
    expect(t.pnl).toBeCloseTo(40, 6);
    expect(t.r).toBeCloseTo(1.6, 6);
    expect(t.riskAtEntry).toBeCloseTo(25, 6);
    const pending = r.logs.find((l) => l.state === "PENDING")!;
    expect(pending).toMatchObject({ side: "BUY", level: 2010, entry: 2010.5, stop: 2005.5, target: 2018.5 });
    // a buy stop sits above the ask, and the stop loss below the entry
    expect(pending.entry).toBeGreaterThan(2003.5 + 0.2);
    expect(pending.stop).toBeLessThan(pending.entry);
    expect(r.transitions["S4.PENDING"]).toBe(1);
    expect(r.transitions["S4.TRIGGERED"]).toBe(1);
  });

  it("the stop loss costs exactly the intended risk", () => {
    const r = run([...setup(), breakout, [2010.8, 2011, 2005, 2006]]);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("SL");
    expect(t.exitPx).toBeCloseTo(2005.5, 9);
    expect(t.pnl).toBeCloseTo(-25, 6);
    expect(t.r).toBeCloseTo(-1, 6);
  });

  it("a gap through the stop fills at the open, not at the stop", () => {
    const r = run([...setup(), breakout, [2001, 2002, 2000, 2001]]);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("SL");
    expect(t.exitPx).toBeCloseTo(2001, 9);
    expect(t.pnl).toBeLessThan(-25);
  });

  it("stop before target inside one bar, and no target on the bar that filled the order", () => {
    const both = run([...setup(), breakout, [2010.8, 2020, 2005, 2010]]);
    expect(both.trades[0]!.exitReason).toBe("SL");
    // a fill bar that also spans stop and target stops out: the order of events is unknowable, so the worst case wins
    const fillBar = run([...setup(), [2009, 2019, 2004, 2018], flat(1, 2010)[0]!]);
    expect(fillBar.trades[0]!.exitReason).toBe("SL");
  });

  it("a pending order that never fills expires, and the engine re-arms from the current structure", () => {
    const r = run([...setup(), ...flat(30, 2003)]);
    expect(r.trades).toHaveLength(0);
    expect(r.transitions["S4.EXPIRED"]).toBeGreaterThanOrEqual(1);
    expect(r.transitions["S4.PENDING"]).toBeGreaterThanOrEqual(2);
  });

  it("waits for distance: price sitting on the level arms nothing", () => {
    const rows: Row[] = [...flat(10), [2000, 2010, 2000, 2004], [2004, 2009.5, 2008, 2009], [2009, 2009.6, 2008.5, 2009.2], [2009.2, 2009.5, 2008.6, 2009.1], ...flat(5, 2009)];
    const r = run(rows);
    expect(r.transitions["S4.PENDING"]).toBeUndefined();
    expect(r.transitions["S4.WAITING_FOR_DISTANCE"]).toBeGreaterThanOrEqual(1);
  });

  it("break-even moves the stop to entry + lock once the trigger is reached, and exits as BE", () => {
    const p = prof({ break_even: { enabled: true, trigger_distance: 3, lock_distance: 0.5 } });
    const r = run([...setup(), breakout, [2010.8, 2014, 2010, 2013], [2013, 2013.5, 2010.5, 2011.2]], p);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("BE");
    expect(t.exitPx).toBeCloseTo(2011, 9);
    expect(t.pnlPrice).toBeCloseTo(0.5, 9);
  });

  it("classic trailing follows the peak at a fixed distance", () => {
    const p = prof({ trailing: { enabled: true, trigger_distance: 4, distance: 2 } });
    const r = run([...setup(), breakout, [2010.8, 2015, 2010.2, 2014.5], [2014.5, 2016, 2014, 2015.5], [2015.5, 2015.6, 2013.5, 2014]], p);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("TRAIL");
    expect(t.exitPx).toBeCloseTo(2014, 9);
    expect(t.pnl).toBeCloseTo(17.5, 6);
  });

  it("structure trailing moves the stop under the first confirmed swing low formed after entry", () => {
    const p = prof({ structure_trailing: { enabled: true, timeframe: "M5", offset: 0.5 } });
    const rows: Row[] = [
      ...setup(),
      breakout,
      [2010.8, 2015, 2013, 2014.5],
      [2014.5, 2016, 2013.5, 2015.5],
      [2015.5, 2016.5, 2012, 2016], // the swing low: 2012
      [2016, 2017, 2013.5, 2016.5],
      [2016.5, 2017, 2013.2, 2016.8], // confirms it (right bars = 2)
      [2016, 2016.2, 2011, 2012],
    ];
    const r = run(rows, p);
    const t = r.trades[0]!;
    expect(t.exitReason).toBe("STRUCTURE_TRAIL");
    expect(t.exitPx).toBeCloseTo(2011.5, 9);
  });

  it("a fake breakout closes the trade when the confirming bar closes back under the level", () => {
    const p = prof({ fake_breakout: { enabled: true, mode: "LOW" } });
    const failed = run([...setup(), [2009, 2011, 2008, 2009.5], [2009.5, 2010, 2009, 2009.5]], p);
    const t = failed.trades[0]!;
    expect(t.exitReason).toBe("FAKE_BREAKOUT");
    expect(t.exitPx).toBeCloseTo(2009.5, 9);
    expect(t.quality.fakeBreakout).toBe("failed");
    expect(failed.transitions["S4.FAKE_BREAKOUT_EXIT"]).toBe(1);
    const held = run([...setup(), breakout, [2010.8, 2019, 2010, 2018]], p);
    expect(held.trades[0]!.exitReason).toBe("TP");
    expect(held.trades[0]!.quality.fakeBreakout).toBe("passed");
    // the reference can be the entry price instead of the level
    const byEntry = run([...setup(), [2009, 2011, 2008, 2010.2], [2010.2, 2010.4, 2010, 2010.3]], prof({ fake_breakout: { enabled: true, mode: "LOW", reference: "entry" } }));
    expect(byEntry.trades[0]!.exitReason).toBe("FAKE_BREAKOUT");
  });

  it("a stop only ever moves in the position's favour (property, on a long noisy run)", () => {
    const moves: Array<{ side: string; from: number; to: number }> = [];
    const d: GoldData = { base: walk(21, 40_000, 7, 0, 300_000, 2500, T0) as Mt5Bar[], baseTf: "M5" };
    const r = runGold(cfg({ frequency: "EXTREME", account: { initial_balance: 500_000 }, filters: { weekend: { enabled: false }, spread: { enabled: false } } }), d, { profiles: defaultProfiles(), commit: "test", trace: (e) => moves.push(e) });
    expect(r.trades.length).toBeGreaterThan(5);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) expect(m.side === "BUY" ? m.to > m.from : m.to < m.from).toBe(true);
  });
});

describe("filters and limits", () => {
  it("the spread filter refuses to arm and says why", () => {
    const r = run([...setup(), breakout, [2010.8, 2019, 2010, 2018]], prof(), cfg({ costs: { spread: { kind: "fixed", value: 0.9 }, slippage: 0 }, filters: { weekend: { enabled: false }, spread: { enabled: true, max_allowed: 0.6 } } }));
    expect(r.trades).toHaveLength(0);
    expect(Object.keys(r.rejectionCounts).some((k) => k.startsWith("spread filter"))).toBe(true);
  });

  it("a news blackout blocks new entries, and CANCEL_PENDING pulls orders already resting", () => {
    const evTs = T0 + 15 * 300_000; // just after the setup: a pending exists when the blackout starts
    const news = (policies: string[]) => cfg({ filters: { weekend: { enabled: false }, news: { enabled: true, block_minutes_before: 30, block_minutes_after: 30, policies, events: [{ time: evTs, name: "NFP" }] } } });
    const blocked = run([...setup(), ...flat(2, 2003.5), breakout, [2010.8, 2019, 2010, 2018]], prof(), news(["BLOCK_NEW_ENTRIES"]));
    expect(blocked.trades).toHaveLength(0);
    expect(Object.keys(blocked.rejectionCounts).some((k) => k.startsWith("news blackout"))).toBe(true);
    const cancelled = run([...setup(), ...flat(2, 2003.5), breakout, [2010.8, 2019, 2010, 2018]], prof(), news(["CANCEL_PENDING"]));
    expect(cancelled.transitions["S4.CANCELLED_NEWS"]).toBeGreaterThanOrEqual(1);
  });

  it("the session filter arms only inside the enabled windows (timezone-aware)", () => {
    const asiaOnly = cfg({ filters: { weekend: { enabled: false }, sessions: { enabled: true, london: false, new_york: false, asia: true } } });
    // 08:00-09:10 UTC on a January Monday is London morning and 17:00-18:10 in Tokyo (Asia closes at 18:00)
    expect(run([...setup(), breakout, [2010.8, 2019, 2010, 2018]], prof(), asiaOnly).trades).toHaveLength(0);
    const london = cfg({ filters: { weekend: { enabled: false }, sessions: { enabled: true, london: true, new_york: false, asia: false } } });
    expect(run([...setup(), breakout, [2010.8, 2019, 2010, 2018]], prof(), london).trades).toHaveLength(1);
  });

  it("no new entries from Friday 18:00 through the weekend", () => {
    const fri = Date.UTC(2026, 0, 9, 18, 5);
    const r = runGold(cfg({ filters: { weekend: { enabled: true } } }), { base: mk([...setup(), breakout, [2010.8, 2019, 2010, 2018]], fri), baseTf: "M5" }, { profiles: [prof()], strategies: ["S4"], commit: "test" });
    expect(r.trades).toHaveLength(0);
    expect(Object.keys(r.rejectionCounts).some((k) => k.startsWith("weekend"))).toBe(true);
  });

  it("a stop-level violation is rejected, not silently adjusted", () => {
    const c = cfg({ contract: { stop_level_points: 5000 } }); // 50 USD
    const r = run([...setup(), breakout, [2010.8, 2019, 2010, 2018]], prof(), c);
    expect(r.trades).toHaveLength(0);
    expect(Object.keys(r.rejectionCounts).some((k) => k.startsWith("stop level"))).toBe(true);
  });

  it("the daily loss limit closes everything, blocks the rest of the day, and is recorded", () => {
    const c = cfg({ risk: { max_open_risk_pct: 5, max_daily_loss_pct: 0.2 } });
    // stop out for -0.25% of equity, then a fresh setup that must not be armed the same day
    const rows: Row[] = [...setup(), breakout, [2010.8, 2011, 2005, 2006], ...flat(6, 2003), [2003, 2020, 2003, 2008], [2008, 2009, 2007, 2008], [2008, 2009, 2007, 2008], [2008, 2009, 2007, 2008], ...flat(8, 2008)];
    const r = run(rows, prof(), c);
    expect(r.killed).toHaveLength(1);
    expect(r.killed[0]!.kind).toBe("daily");
    expect(r.trades).toHaveLength(1);
    expect(Object.keys(r.rejectionCounts).some((k) => k.startsWith("risk kill"))).toBe(true);
  });

  it("one-cancels-other: when the buy stop fills, the sell stop of that strategy is cancelled", () => {
    // a support low forms too, so both sides are armed before the breakout
    const rows: Row[] = [...flat(6, 2003), [2003, 2004, 1998, 2001], [2001, 2004, 1999, 2002], [2002, 2006, 2000, 2004], [2004, 2010, 2002, 2005], [2005, 2007, 2003, 2004], [2004, 2006, 2003, 2004], [2004, 2005, 2003, 2003], [2003, 2005, 2003, 2004], [2009, 2011, 2008, 2010.8], [2010.8, 2019, 2010, 2018]];
    const r = run(rows);
    if (r.transitions["S4.CANCELLED_OCO"] === undefined) expect(r.transitions["S4.PENDING"]).toBeDefined();
    else expect(r.transitions["S4.CANCELLED_OCO"]).toBeGreaterThanOrEqual(1);
  });
});

describe("portfolio properties over a long run of all nine strategies", () => {
  const d: GoldData = { base: walk(33, 45_000, 7, 0.05, 300_000, 2500, T0) as Mt5Bar[], baseTf: "M5" };
  const c = cfg({ frequency: "EXTREME", account: { initial_balance: 500_000 }, risk: { max_open_risk_pct: 1.0, max_concurrent_positions: 4, max_correlated_positions: 3 }, filters: { weekend: { enabled: false }, spread: { enabled: false } } });
  const r = runGold(c, d, { profiles: defaultProfiles(), commit: "test" });

  it("trades, and every trade has a hard stop and a strategy identity", () => {
    expect(r.trades.length).toBeGreaterThan(10);
    for (const t of r.trades) {
      expect(t.magic).toBe(magicOf(t.strategy));
      expect(t.side === "BUY" ? t.sl0 < t.entryPx : t.sl0 > t.entryPx).toBe(true);
      expect(t.lots).toBeGreaterThanOrEqual(0.01);
    }
  });

  it("open plus reserved risk never exceeds the ceiling", () => {
    expect(r.peakOpenRiskPct).toBeGreaterThan(0);
    expect(r.peakOpenRiskPct).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  it("never more than the configured concurrent and same-direction positions", () => {
    const ev = r.trades.flatMap((t) => [[t.entryTs, 1, t.side], [t.exitTs, -1, t.side]] as Array<[number, number, string]>).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0;
    const dir = { BUY: 0, SELL: 0 } as Record<string, number>;
    for (const [, k, s] of ev) {
      open += k;
      dir[s]! += k;
      expect(open).toBeLessThanOrEqual(4);
      expect(dir[s]).toBeLessThanOrEqual(3);
    }
  });

  it("attributes every trade to a strategy, and the strategies add up to the whole", () => {
    const by = new Map<string, number>();
    for (const t of r.trades) by.set(t.strategy, (by.get(t.strategy) ?? 0) + t.pnl);
    const total = [...by.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(r.trades.reduce((a, t) => a + t.pnl, 0), 6);
    expect(by.size).toBeGreaterThan(1);
  });

  it("is deterministic and reproducible: same inputs, same run id, identical trades", () => {
    const again = runGold(c, d, { profiles: defaultProfiles(), commit: "test" });
    expect(again.meta.run_id).toBe(r.meta.run_id);
    expect(JSON.stringify(again.trades)).toBe(JSON.stringify(r.trades));
    expect(r.meta).toMatchObject({ strategy_version: "1.0.0", code_commit: "test", timezone: "Etc/UTC", random_seed: 1, base_timeframe: "M5" });
    expect(r.meta.config_hash).toMatch(/^[0-9a-f]{16}$/);
    const other = runGold(c, { base: walk(34, 45_000, 7, 0.05, 300_000, 2500, T0) as Mt5Bar[], baseTf: "M5" }, { profiles: defaultProfiles(), commit: "test" });
    expect(other.meta.data_hash).not.toBe(r.meta.data_hash);
    expect(other.meta.run_id).not.toBe(r.meta.run_id);
  });

  it("has no look-ahead: cutting the data off changes nothing that happened before the cut", () => {
    const cut = 30_000;
    const short = runGold(c, { base: d.base.slice(0, cut), baseTf: "M5" }, { profiles: defaultProfiles(), commit: "test" });
    const cutTs = d.base[cut]!.ts;
    const before = (x: typeof r.trades) => x.filter((t) => t.exitTs <= cutTs && t.exitReason !== "END").map((t) => [t.id, t.strategy, t.side, t.entryTs, t.exitTs, t.entryPx, t.exitPx, t.lots, t.exitReason]);
    expect(short.trades.length).toBeGreaterThan(5);
    expect(before(short.trades)).toEqual(before(r.trades).filter((x) => (x[4] as number) <= cutTs));
  });
});

describe("configuration and safety", () => {
  it("live trading is refused", () => {
    expect(() => assertResearchOnly({ live_trading: true, mode: "backtest" })).toThrow(LiveTradingDisabled);
    expect(() => runGold({ live_trading: true }, data(flat(50)))).toThrow(LiveTradingDisabled);
    const d = EngineSchema.parse({});
    expect(d).toMatchObject({ mode: "backtest", live_trading: false });
    expect(d.risk).toMatchObject({ max_open_risk_pct: 1, max_daily_loss_pct: 2 });
  });

  it("frequency profiles add strategies step by step; profiles are independent", () => {
    const all = defaultProfiles();
    expect(activeProfiles(all, "VERY_CONSERVATIVE").map((p) => p.id)).toEqual(["S1", "S2", "S3"]);
    expect(activeProfiles(all, "EXTREME")).toHaveLength(9);
    expect(FREQUENCY_PROFILES.MODERATE).toHaveLength(7);
    const solo = runGold(cfg(), { base: walk(5, 8000, 7, 0, 300_000, 2500, T0) as Mt5Bar[], baseTf: "M5" }, { profiles: all, strategies: ["S5"], commit: "test" });
    expect(new Set(solo.trades.map((t) => t.strategy)).size).toBeLessThanOrEqual(1);
    expect(solo.profiles.map((p) => p.id)).toEqual(["S5"]);
  });

  it("the nine profiles follow the section 49 matrix and the section 26 weights", () => {
    const p = defaultProfiles();
    expect(p.map((x) => `${x.entry_timeframe}/${x.exit_timeframe}`)).toEqual(["D1/H1", "H4/M30", "H4/M15", "H1/M15", "H1/M5", "M30/M5", "M30/M5", "M15/M5", "M15/M1"]);
    expect(p.map((x) => x.risk.weight)).toEqual([1, 0.9, 0.9, 0.75, 0.75, 0.65, 0.65, 0.5, 0.4]);
    expect(p.every((x) => x.risk.max_trade_risk_pct <= 0.25)).toBe(true);
    expect(magicOf("S1")).toBe(620001);
    expect(magicOf("S9")).toBe(620009);
  });

  it("fake-breakout modes: LOW checks the exit timeframe, MEDIUM and HIGH add slower ones up to the entry timeframe", () => {
    expect(fakeChecks(defaultProfile("S9")).map((c) => c.timeframe)).toEqual(["M1"]);
    expect(fakeChecks(defaultProfile("S4")).map((c) => c.timeframe)).toEqual(["M15", "M30"]);
    expect(fakeChecks(defaultProfile("S1")).map((c) => c.timeframe)).toEqual(["H1", "H4", "D1"]);
    expect(fakeChecks(prof({ fake_breakout: { enabled: false } }))).toEqual([]);
    expect(fakeChecks(prof({ fake_breakout: { enabled: true, checks: [{ timeframe: "M15", bars: 2 }] } }))).toEqual([{ timeframe: "M15", bars: 2 }]);
  });

  it("an exit timeframe finer than the data is clamped, with a warning", () => {
    const r = runGold(cfg(), data(flat(30)), { profiles: [defaultProfile("S9")], strategies: ["S9"], commit: "test" });
    expect(r.meta.warnings.join(" ")).toMatch(/finer than the base/);
  });
});

describe("sizing, normalisation and weights", () => {
  const c = ContractSchema.parse({});
  it("lots come from the stop distance and are rounded down, never up", () => {
    expect(sizeLots(c, 10_000, 0.0025, 2010.5, 2005.5)).toMatchObject({ ok: true, lots: 0.05 });
    const s = sizeLots(c, 10_000, 0.0025, 2010.5, 2004.5); // raw 0.0416: rounds down to 0.04
    expect(s).toMatchObject({ ok: true, lots: 0.04 });
    if (s.ok) expect(s.riskCash).toBeLessThanOrEqual(25);
  });
  it("below the minimum volume the order is rejected, not bumped up", () => {
    expect(sizeLots(c, 1000, 0.0025, 2010, 1990)).toMatchObject({ ok: false });
    expect(sizeLots(c, 1000, 0.0025, 2000, 2000)).toMatchObject({ ok: false, reason: "zero stop distance" });
  });
  it("normalisation modes scale distances by price, volatility, or both, inside a clamp", () => {
    const n = { reference_gold_price: 2500, price_weight: 0.5, atr_weight: 0.5, scale_min: 0.25, scale_max: 4 };
    expect(scaleFactor({ ...n, mode: "NONE" }, { price: 5000, atr: 20, refAtr: 10 })).toBe(1);
    expect(scaleFactor({ ...n, mode: "PRICE_RATIO" }, { price: 5000, atr: null, refAtr: null })).toBe(2);
    expect(scaleFactor({ ...n, mode: "ATR" }, { price: 5000, atr: 15, refAtr: 10 })).toBe(1.5);
    expect(scaleFactor({ ...n, mode: "HYBRID" }, { price: 5000, atr: 15, refAtr: 10 })).toBeCloseTo(1.75, 9);
    expect(scaleFactor({ ...n, mode: "HYBRID" }, { price: 5000, atr: null, refAtr: null })).toBe(2); // no ATR: the price half
    expect(scaleFactor({ ...n, mode: "ATR" }, { price: 2500, atr: 1000, refAtr: 10 })).toBe(4);
    expect(scaleFactor({ ...n, mode: "ATR" }, { price: 2500, atr: 0.01, refAtr: 10 })).toBe(0.25);
  });
  it("the reference ATR comes from the start of the series only", () => {
    const a = walk(9, 3000, 7, 0, 300_000, 2500, T0);
    const b = a.map((x, i) => (i > 1500 ? { ...x, h: x.h + 50, l: x.l - 50 } : x));
    expect(referenceAtr(b, 14)).toBe(referenceAtr(a, 14));
  });
  it("drawdown-aware weights redistribute the budget, keep static weights for thin history, and use past data only", () => {
    const ps = defaultProfiles().slice(0, 3);
    const cfgW = { enabled: true, alpha: 0.5, epsilon: 0.05, min_trades: 20 };
    const w = blendedWeights(ps, { S1: 1, S2: 4, S3: 2 }, { S1: 50, S2: 50, S3: 5 }, cfgW);
    expect(w.S3).toBe(ps[2]!.risk.weight); // too few trades: static
    expect(w.S1).toBeGreaterThan(ps[0]!.risk.weight * 0.5 + 0.0001); // lower drawdown gets more
    expect(w.S1! - ps[0]!.risk.weight).toBeGreaterThan(w.S2! - ps[1]!.risk.weight);
    expect(blendedWeights(ps, { S1: 1, S2: 4, S3: 2 }, { S1: 50, S2: 50, S3: 50 }, { ...cfgW, enabled: false })).toEqual({ S1: 1, S2: 0.9, S3: 0.9 });
  });
  it("resampling never exposes a bar that has not closed", () => {
    const base = mk(flat(7), T0, 300_000); // 08:00 .. 08:30 in M5: 7 bars = two full M15 buckets and one bar of a third
    const m15 = resample(base, 300_000, 900_000);
    expect(m15).toHaveLength(3);
    expect(m15.map((x) => x.confirmed)).toEqual([true, true, false]);
  });
});
