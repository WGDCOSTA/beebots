import { describe, expect, it } from "vitest";
import { boozy } from "../src/bees/boozy.js";
import { degen } from "../src/bees/degen.js";
import { blockerOf, blockers } from "../src/bunnyProfile.js";
import { Db } from "../src/db.js";
import { buildSnapshot, techColumns } from "../src/snapshot.js";
import { bee, coin, ctx, NOW, view } from "./fixtures.js";

const rich = { rsi14: 71.234, macdHistPct: 0.01234, pctB: 0.912, bbWidthPct: 2.345, atr14Pct: 0.876, ret1hPct: 1.234, ret24hPct: 5.67, volZ: 2.34, fundingPct: 0.01234, oiChg1hPct: 3.21 };

describe("the technical block Jev sees", () => {
  it("adds momentum, trend, volatility, volume and positioning to every style", () => {
    const v = view([coin("BTC", rich, 100_000), coin("ETH", rich, 4000)]);
    const s = buildSnapshot(boozy, ctx("boozy", bee("boozy"), v));
    const cols = (s.state.coins as { cols: string[] }).cols;
    for (const k of ["rsi14", "macd_h_pct", "bb_pctb", "bb_w_pct", "atr15m_pct", "vol_z", "fund_pct"]) expect(cols).toContain(k);
    expect(s.approxTokens).toBeLessThan(600);
  });
  it("never says a number twice under two names", () => {
    const c = coin("SOL", rich, 150);
    const own = degen.coinSnapshot(c, ctx("boozy", bee("boozy"), view([c])));
    const extra = techColumns(c, own);
    expect(extra).not.toHaveProperty("macd_h_pct"); // degen sends macd_pct
    expect(extra).not.toHaveProperty("atr15m_pct"); // degen sends atr_pct
    expect(extra).not.toHaveProperty("r1h_pct"); // degen sends impulse_1h_pct
    expect(extra).toHaveProperty("rsi14", 71);
  });
  it("can be turned off (JEV_TECH=false)", () => {
    const v = view([coin("BTC", rich, 100_000)]);
    const on = buildSnapshot(boozy, ctx("boozy", bee("boozy"), v));
    const off = buildSnapshot(boozy, ctx("boozy", bee("boozy"), v), null, false);
    expect((off.state.coins as { cols: string[] }).cols.length).toBeLessThan((on.state.coins as { cols: string[] }).cols.length);
  });
});

describe("why a bunny isn't trading", () => {
  it("names each reason a decision did not open", () => {
    expect(blockerOf({ choice: "QUICK_LONG_BTC", status: null, vetoed: "weak_conviction p=0.42 c=1", action: '{"kind":"none"}' })).toBe("vetoed: weak conviction");
    expect(blockerOf({ choice: "WAIT", status: "WAIT", vetoed: null, action: '{"kind":"none"}' })).toBe("Jev chose WAIT");
    expect(blockerOf({ choice: null, status: "waiting for a fast edge that clears costs (flat 12/1440 min)", vetoed: null, action: '{"kind":"none"}' })).toBe("waiting for a fast edge that clears costs");
    expect(blockerOf({ choice: "APE_BTC", status: null, vetoed: null, action: '{"kind":"open"}' })).toBeNull();
  });
  it("counts the last day's reasons and opens from the engine's log", () => {
    const db = new Db(":memory:");
    const add = (choice: string | null, vetoed: string | null, kind: string, status: string | null = null) =>
      db.raw.prepare("INSERT INTO decisions (bee, ts, choice, vetoed_by, status, action_json) VALUES ('bee4', ?, ?, ?, ?, ?)").run(NOW - 3_600_000, choice, vetoed, status, JSON.stringify({ kind }));
    add("WAIT", null, "none");
    add("WAIT", null, "none");
    add("QUICK_LONG_SOL", "weak_conviction p=0.50 c=1", "none");
    add("QUICK_SHORT_ETH", null, "open");
    const b = blockers(db.raw, "bee4", NOW);
    expect(b).toMatchObject({ decisions: 4, opens: 1, top: [{ why: "Jev chose WAIT", n: 2 }, { why: "vetoed: weak conviction", n: 1 }] });
  });
});
