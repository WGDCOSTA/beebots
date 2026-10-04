import { describe, expect, it } from "vitest";
import { degen } from "../src/bees/degen.js";
import { bee, coin, ctx, NOW, position, testConfig, view } from "./fixtures.js";

describe("Degen", () => {
  it("scans every gated liquid crypto and limits forced exploration to a small paper-only probe", () => {
    const cfg = testConfig();
    const btc = coin("BTC", { ret1hPct: 0.8, macdHistPct: 0.1, volZ: 1, spreadBp: 0.8 });
    const sol = coin("SOL", { ret1hPct: -1.1, macdHistPct: -0.2, volZ: 1.5, spreadBp: 0.7 });
    const wide = coin("DOGE", { ret1hPct: 5, spreadBp: 4 });
    const c = ctx("degen", bee("degen"), view([btc, sol, wide]), cfg);

    expect(degen.universe(c)).toEqual([sol.instId, btc.instId]);
    expect(degen.menu(c)).toMatchObject({
      QUICK_SHORT_SOL: { intent: { kind: "open", side: "short", setup: "strict" } },
      QUICK_LONG_BTC: { intent: { kind: "open", side: "long", setup: "strict" } },
      WAIT: { intent: { kind: "hold" } },
    });
    expect(degen.neverForce).toBe(false);
    expect(degen.forcedEntry?.(c)).toMatchObject({ kind: "open", instId: sol.instId, side: "short", sizeFrac: 0.2, setup: "strict" });
    expect(degen.forcedEntry?.({ ...c, cfg: { ...cfg, mode: "live" } })).toBeNull();
  });

  it("cuts a reversed impulse, banks a short gain, and uses a 30-minute time stop", () => {
    const cfg = testConfig();
    const sol = coin("SOL", { ret1hPct: 0.4, spreadBp: 0.7 });
    const b = bee("degen", { position: position(sol, { side: "short", openedAt: NOW - 10 * 60_000, riskUsd: 10 }), uplUsd: 8 });
    const c = ctx("degen", b, view([sol]), cfg);
    expect(degen.menu(c)).toMatchObject({
      CUT_FAILED_IMPULSE: { intent: { kind: "close", reason: "impulse_reversed" } },
      BANK: { intent: { kind: "close", reason: "short_profit" } },
    });
    expect(degen.timeStopMinutes?.(c)).toBe(30);
    expect(degen.stopFor(sol.instId, "short", 100, c)).toBeGreaterThan(100);
  });
});
