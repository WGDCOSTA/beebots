import { describe, expect, it } from "vitest";
import { macro, macroSetup } from "../src/bees/macro.js";
import type { BeeContext } from "../src/bees/types.js";
import { LONG_CLOSURE_MIN, mustFlatten, type SessionInfo } from "../src/market/sessions.js";
import { applyRisk } from "../src/risk.js";
import { bee, coin, NOW, position, testConfig, view } from "./fixtures.js";

const open = (closesInMin: number | null, closedForMin: number | null = 17 * 60): SessionInfo => ({ status: "open", closesInMin, opensInMin: null, closedForMin });

function mctx(over: { session?: SessionInfo; env?: Record<string, string>; pos?: boolean; uplUsd?: number } = {}): BeeContext {
  const cfg = testConfig(over.env ?? {});
  const xau = coin("XAU", { ret7dPct: 3, ret24hPct: 0.8, macdHistPct: 0.02, rsi14: 48, pctB: 0.4, atr14Pct: 0.4 }, 4000);
  const v = view([xau]);
  const b = bee("bee4", over.pos ? { position: position(xau, { contracts: 1, riskUsd: 10 }), uplUsd: over.uplUsd ?? 0 } : {});
  const p = b.position;
  return {
    bee: b,
    view: v,
    cfg,
    knobs: cfg.macro.knobs,
    now: NOW,
    uplR: p ? b.uplUsd / p.riskUsd : null,
    session: () => over.session ?? open(300),
  };
}

describe("macro setups", () => {
  it("reads trend pullbacks and range reversions, and nothing else", () => {
    expect(macroSetup(coin("A", { ret7dPct: 3, ret24hPct: 1, macdHistPct: 0.01, rsi14: 45, pctB: 0.3 }))).toBe("trend_long");
    expect(macroSetup(coin("A", { ret7dPct: -3, ret24hPct: -1, macdHistPct: -0.01, rsi14: 55, pctB: 0.7 }))).toBe("trend_short");
    expect(macroSetup(coin("A", { ret7dPct: 1, ret24hPct: -1, rsi14: 25, pctB: -0.1 }))).toBe("revert_long");
    expect(macroSetup(coin("A", { ret7dPct: -1, ret24hPct: 1, rsi14: 75, pctB: 1.2 }))).toBe("revert_short");
    // An uptrend that has not pulled back, a strong week stretched below its band, missing data: no setup.
    expect(macroSetup(coin("A", { ret7dPct: 3, ret24hPct: 1, macdHistPct: 0.01, rsi14: 72, pctB: 0.95 }))).toBeNull();
    expect(macroSetup(coin("A", { ret7dPct: 6, ret24hPct: -1, rsi14: 25, pctB: -0.1 }))).toBeNull();
    expect(macroSetup(coin("A", { rsi14: null }))).toBeNull();
  });

  it("offers only setups (plus WAIT) when flat, and is never forced in", () => {
    const c = mctx();
    expect(Object.keys(macro.menu(c))).toEqual(["TREND_LONG_XAU", "WAIT"]);
    expect(macro.forcedEntry(c)).toBeNull();
    expect(macro.neverForce).toBe(true);
    const quiet = { ...c, view: view([coin("XAG")]) };
    expect(macro.menu(quiet)).toEqual({});
    expect(macro.idleStatus!(quiet)).toMatch(/waiting for a trend or reversion setup/);
  });

  it("when positioned: hold, take profit, trim, and cut once the setup is gone", () => {
    expect(Object.keys(macro.menu(mctx({ pos: true, uplUsd: 20 })))).toEqual(["HOLD", "TAKE_PROFIT", "TRIM_HALF"]);
    const c = mctx({ pos: true, uplUsd: -5 });
    c.view.stats.get(c.bee.position!.instId)!.ret24hPct = -0.5;
    c.view.stats.get(c.bee.position!.instId)!.macdHistPct = -0.01;
    expect(Object.keys(macro.menu(c))).toEqual(["HOLD", "CUT"]);
  });
});

describe("macro sizing", () => {
  it("caps leverage at MACRO_MAX_LEVERAGE and halves late in a session", () => {
    const intent = { kind: "open" as const, instId: "XAU-USD_UM_XPERP-310404", side: "long" as const, sizeFrac: 1, setup: "strict" as const };
    // MAX_LEVERAGE 2, macro 1x: half of the max notional at full conviction.
    expect(macro.sizeFrac(intent, 3, mctx())).toBeCloseTo(0.5);
    expect(macro.sizeFrac(intent, 0, mctx())).toBeCloseTo(0.25);
    expect(macro.sizeFrac(intent, 3, mctx({ session: open(90) }))).toBeCloseTo(0.25);
    expect(macro.sizeFrac(intent, 3, mctx({ env: { MACRO_MAX_LEVERAGE: "2" } }))).toBeCloseTo(1);
    // It can never exceed MAX_LEVERAGE.
    expect(macro.sizeFrac(intent, 3, mctx({ env: { MACRO_MAX_LEVERAGE: "5" } }))).toBeCloseTo(1);
  });

  it("uses the macro knobs, not a crypto style's", () => {
    const c = mctx();
    expect(c.cfg.macro.knobs).toMatchObject({ maxTradesPerDay: 4, spreadGateBps: 15, cooldownMinutes: 30, stopAtrMult: 2.5 });
    expect(macro.stopFor("XAU-USD_UM_XPERP-310404", "long", 4000, c)).toBeCloseTo(4000 - 4000 * 0.004 * 2.5);
  });
});

describe("flatten before the close", () => {
  it("all closes, weekend only long closures, off never; only in a verified open session", () => {
    expect(mustFlatten(open(8), "all", 10)).toBe(true);
    expect(mustFlatten(open(30), "all", 10)).toBe(false);
    expect(mustFlatten(open(8, 17 * 60), "weekend", 10)).toBe(false);
    expect(mustFlatten(open(8, 65 * 60), "weekend", 10)).toBe(true);
    expect(mustFlatten(open(8, null), "weekend", 10)).toBe(true);
    expect(LONG_CLOSURE_MIN).toBe(1440);
    expect(mustFlatten(open(8), "off", 10)).toBe(false);
    expect(mustFlatten(open(null), "all", 10)).toBe(false);
    expect(mustFlatten({ status: "unverified", closesInMin: null, opensInMin: null }, "all", 10)).toBe(false);
  });

  it("the risk layer closes a macro position before the session ends, whatever Jev says", () => {
    const base = { brain: macro, jev: "ok" as const, sizeMult: 1, dataAgeMs: 0, maxDataAgeMs: 60_000 };
    const hold = { label: "HOLD", intent: { kind: "hold" as const }, prob: 0.9, conviction: 3 };
    const r = applyRisk({ ...base, ctx: mctx({ pos: true, session: open(5) }), proposal: hold });
    expect(r.action).toEqual({ kind: "close", reason: "session_close" });
    expect(r.forcedBy).toBe("session_close");
    expect(r.status).toMatch(/session close: closing XAU/);
    // Weekend mode keeps it through an overnight closure; plenty of time left: Jev's hold stands.
    expect(applyRisk({ ...base, ctx: mctx({ pos: true, session: open(5), env: { SESSION_FLATTEN: "weekend" } }), proposal: hold }).action).toEqual({ kind: "none" });
    expect(applyRisk({ ...base, ctx: mctx({ pos: true, session: open(200) }), proposal: hold }).action).toEqual({ kind: "none" });
  });
});
