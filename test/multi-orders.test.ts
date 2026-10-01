import { describe, expect, it } from "vitest";
import { boozy } from "../src/bees/boozy.js";
import type { BeeContext } from "../src/bees/types.js";
import { Evolution, perksFor, type EvolutionOpts } from "../src/evolution.js";
import { applyFill, freshBee, promoteLeg } from "../src/ledger.js";
import { applyRisk } from "../src/risk.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

const OPTS: EvolutionOpts = { survival: true, rewards: true, dangerPct: 80, criticalPct: 60, deathPct: 40, maxLimitBoost: 0.5, boostLimits: true, startEquityUsd: 1000 };

describe("multi-orders perk", () => {
  it("starts with three position slots and adds three per level inside the configured cap", () => {
    expect([0, 1, 2, 3, 4, 5].map((l) => perksFor(l, { ...OPTS, maxPositions: 18 }).positions)).toEqual([3, 6, 9, 12, 15, 18]);
    expect(perksFor(5, { ...OPTS, maxPositions: 2 }).positions).toBe(2);
    expect(perksFor(5, { ...OPTS, maxPositions: 1 }).positions).toBe(1);
    expect(perksFor(2, { ...OPTS, maxPositions: 18, boostLimits: false }).positions).toBe(9);
    expect(perksFor(0, { ...OPTS, maxPositions: 18, rewards: false }).positions).toBe(3);
  });
});

describe("ledger with legs", () => {
  const f = (instId: string, side: "buy" | "sell", contracts: number, px: number, leg = false) => ({ instId, coin: instId.split("-")[0]!, side, contracts, px, feeUsd: 0.1, ctVal: 1, ts: NOW, leg });
  it("opens, marks and closes a leg apart from the main position, then promotes it", () => {
    const b = freshBee("bee1", 1000, NOW);
    applyFill(b, f("BTC-X", "buy", 1, 100));
    applyFill(b, f("SOL-X", "sell", 2, 50, true));
    expect(b.position?.coin).toBe("BTC");
    expect(b.legs?.map((l) => [l.coin, l.side, l.contracts])).toEqual([["SOL", "short", 2]]);
    // Adding to the leg and partly closing it touch only the leg.
    applyFill(b, f("SOL-X", "sell", 2, 40));
    expect(b.legs![0]).toMatchObject({ contracts: 4, entryPx: 45 });
    const r = applyFill(b, f("SOL-X", "buy", 4, 40));
    expect(r).toBeCloseTo(20); // short from 45 to 40 on 4
    expect(b.legs).toEqual([]);
    // Main closes while a leg is open: the leg steps up only when the engine promotes it.
    applyFill(b, f("ETH-X", "buy", 1, 10, true));
    applyFill(b, f("BTC-X", "sell", 1, 110));
    expect(b.position).toBeNull();
    expect(promoteLeg(b)).toBe(true);
    expect(b.position?.coin).toBe("ETH");
    expect(b.legs).toEqual([]);
    expect(promoteLeg(b)).toBe(false);
  });
});

describe("risk with legs", () => {
  const btc = coin("BTC", { ret7dPct: 10 }, 100);
  const sol = coin("SOL", { ret7dPct: 20 }, 100);
  function ctx(slots: number, legs = 0): BeeContext {
    const cfg = testConfig({ BEE_START_EQUITY_USD: "1000", MAX_NOTIONAL_USD_PER_BEE: "5000" });
    const b = freshBee("bee1", 1000, NOW - 3_600_000);
    b.position = position(btc, { contracts: 500, riskUsd: 10 }); // $500 at $1 a contract
    if (legs) b.legs = [position(sol, { contracts: 400, riskUsd: 10 })];
    return { bee: b, view: view([btc, sol, coin("ETH", { ret7dPct: 5 }, 100)]), cfg, knobs: cfg.bees.boozy, now: NOW, uplR: 0, slots };
  }
  const base = { brain: boozy, jev: "ok" as const, sizeMult: 1, dataAgeMs: 0, maxDataAgeMs: 60_000 };
  const legOpen = (instId: string) => ({ label: "LEG", intent: { kind: "leg_open" as const, instId, side: "long" as const, sizeFrac: 1, setup: "strict" as const }, prob: 0.9, conviction: 3 });

  it("opens a leg only with a free slot, on a coin not held, inside the shared cap", () => {
    expect(applyRisk({ ...base, ctx: ctx(1), proposal: legOpen("SOL-USD_UM_XPERP-310404") }).vetoedBy).toBe("no_free_slot");
    expect(applyRisk({ ...base, ctx: ctx(2), proposal: legOpen("BTC-USD_UM_XPERP-310404") }).vetoedBy).toBe("already_held");
    const ok = applyRisk({ ...base, ctx: ctx(2), proposal: legOpen("SOL-USD_UM_XPERP-310404") });
    expect(ok.vetoedBy).toBeNull();
    expect(ok.action.kind).toBe("leg_open");
    // Max = 2x x 1000 x 0.97 = 1940; per slot 970; $500 already held leaves room for 970.
    expect((ok.action as { notionalUsd: number }).notionalUsd).toBeLessThanOrEqual(970 + 1e-9);
    // 3 slots, $900 held: a third position gets at most the rest of the cap.
    const third = applyRisk({ ...base, ctx: ctx(3, 1), proposal: legOpen("ETH-USD_UM_XPERP-310404") });
    expect((third.action as { notionalUsd: number }).notionalUsd).toBeLessThanOrEqual(1940 - 900 + 1e-9);
    const flat = ctx(2);
    flat.bee.position = null;
    expect(applyRisk({ ...base, ctx: flat, proposal: legOpen("SOL-USD_UM_XPERP-310404") }).vetoedBy).toBe("invalid_while_flat");
  });
});

describe("engine with multi-orders", () => {
  it("a level-5 bee is offered LEG_ options, opens a leg, and code closes it at its stop", async () => {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const cfg = testConfig({ DRY_RUN: "true", BEE_START_EQUITY_USD: "1000", MAX_NOTIONAL_USD_PER_BEE: "5000" });
    const v = view([coin("BTC", { ret7dPct: 25, ret24hPct: 5 }, 100), coin("SOL", { ret7dPct: 20 }, 100), coin("ETH", { ret7dPct: 15 }, 100)]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    type Req = { state: Record<string, unknown>; questions: { action: { instructions: string; criteria: Record<string, string> } } };
    const reqs: Req[] = [];
    const client = {
      async systemOne(req: unknown) {
        const r = req as Req;
        reqs.push(r);
        const labels = Object.keys(r.questions.action.criteria);
        const choice = labels.find((l) => l.startsWith("LEG_")) ?? labels.find((l) => l.startsWith("APE_")) ?? labels[0]!;
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 0.95 } }, conviction: { type: "score", score: 4, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const evolution = new Evolution({ ...OPTS, deathPct: cfg.risk.retireAtPct, maxPositions: 3 });
    let t = NOW;
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => t }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate, () => t), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => t, evolution });
    await engine.start();
    engine.stop();
    await engine.tick(); // opens the main position
    const boozyId = cfg.beeIds.find((id) => cfg.slots[id].style === "boozy")!;
    expect(engine.bees[boozyId].position).not.toBeNull();
    expect(engine.bees[boozyId].legs ?? []).toEqual([]);

    evolution.bees[boozyId]!.level = 5; // the configured cap in this harness is 3 slots
    t += 3 * 60_000; // past boozy's cooldown
    reqs.length = 0;
    await engine.tick();
    const legReq = reqs.find((r) => Object.keys(r.questions.action.criteria).some((l) => l.startsWith("LEG_")));
    expect(legReq).toBeDefined();
    expect(legReq!.questions.action.instructions).toContain("LEG_* options");
    const bee = engine.bees[boozyId];
    expect(bee.legs?.length).toBe(1);
    const leg = bee.legs![0]!;
    expect(leg.coin).not.toBe(bee.position!.coin);
    expect(leg.stopPx).not.toBeNull();
    const pub = engine.snapshot().bees.find((b) => b.bee === boozyId)!;
    expect(pub.slots).toBe(3);
    expect(pub.legs.map((l) => l.coin)).toEqual([leg.coin]);

    // The leg's coin crashes through its stop: code closes the leg, the main position stays.
    const s = v.stats.get(leg.instId)!;
    const tk = v.tickers.get(leg.instId)!;
    const crash = leg.side === "long" ? leg.stopPx! * 0.98 : leg.stopPx! * 1.02;
    Object.assign(s, { mid: crash, last: crash, bid: crash, ask: crash });
    Object.assign(tk, { mid: crash, last: crash, bid: crash, ask: crash });
    t += 60_000;
    await engine.tick();
    expect(engine.bees[boozyId].legs?.some((l) => l.coin === leg.coin)).toBe(false);
    expect(engine.bees[boozyId].position).not.toBeNull();
    const closed = db.raw.prepare("SELECT forced_by FROM decisions WHERE bee = ? AND forced_by = 'stop' ORDER BY ts DESC LIMIT 1").get(boozyId) as { forced_by: string } | undefined;
    expect(closed?.forced_by).toBe("stop");
  });
});
