// Dynamic profit-locking ratchet: hard profit floor plus the ATR "runner hug" (bees/ratchet.ts, engine markBee).
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { dynamicRatchetStop, hugMult, parseHug, parseLock } from "../src/bees/ratchet.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

const LOCK = parseLock("2.5:0.5,5:0.65");
const HUG = parseHug("2.5:1.2,5:0.8,8:0.6");

describe("ratchet rungs", () => {
  it("parses, sorts and drops bad pairs", () => {
    expect(parseLock("5:0.65, 2.5:0.5, x:1, 3:1.5, -1:0.2")).toEqual([
      { atPct: 2.5, keep: 0.5 },
      { atPct: 5, keep: 0.65 },
    ]);
    expect(parseHug("8:0.6,2.5:1.2")).toEqual([
      { atPct: 2.5, atr: 1.2 },
      { atPct: 8, atr: 0.6 },
    ]);
  });
  it("the hug tightens as the gain grows", () => {
    expect(hugMult(2, HUG)).toBeNull();
    expect(hugMult(3, HUG)).toBe(1.2);
    expect(hugMult(6, HUG)).toBe(0.8);
    expect(hugMult(12, HUG)).toBe(0.6);
  });
});

describe("dynamicRatchetStop", () => {
  it("nothing before +2.5%, or in a loss", () => {
    expect(dynamicRatchetStop("long", 100, 102, 1, LOCK, HUG)).toBeNull();
    expect(dynamicRatchetStop("long", 100, 99, 1, LOCK, HUG)).toBeNull();
  });
  it("+3% with a wide ATR: the hard floor (50% of the move) wins", () => {
    // floor 101.5; hug 103 - 1.2 x 3.09 = 99.29
    expect(dynamicRatchetStop("long", 100, 103, 3, LOCK, HUG)).toBeCloseTo(101.5, 10);
  });
  it("+6% with a tight ATR: the runner hug (0.8x ATR behind the peak) wins", () => {
    // floor 103.9; hug 106 - 0.8 x 0.53 = 105.576
    expect(dynamicRatchetStop("long", 100, 106, 0.5, LOCK, HUG)).toBeCloseTo(105.576, 10);
  });
  it("past +8% the hug is 0.6x ATR", () => {
    expect(dynamicRatchetStop("long", 100, 110, 1, LOCK, HUG)).toBeCloseTo(110 - 0.6 * 1.1, 10);
  });
  it("mirrors for a short, and falls back to the floor without an ATR", () => {
    expect(dynamicRatchetStop("short", 100, 94, 0.5, LOCK, HUG)).toBeCloseTo(94 + 0.8 * 0.47, 10);
    expect(dynamicRatchetStop("short", 100, 94, null, LOCK, HUG)).toBeCloseTo(96.1, 10);
  });
});

async function harness(px: number, env: Record<string, string> = {}) {
  const cfg = testConfig({ DRY_RUN: "true", ...env });
  const coins = (p: number) => [coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, p), coin("SUI", { ret24hPct: 12, ret7dPct: 40 }), coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000)];
  let v = view(coins(px));
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
  const client: SystemOne = {
    async systemOne() {
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 0.9, probabilities: { NOT_ON_MENU: 0.9 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const db = new Db(":memory:");
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
  await engine.start();
  engine.stop();
  const instId = [...v.stats.keys()].find((k) => k.startsWith("ENA"))!;
  const open = () => {
    engine.bees.bee3.position = { instId, coin: "ENA", side: "long", contracts: 21, entryPx: 100, openedAt: NOW - 60 * 60_000, stopPx: 90, riskUsd: 10, initialStopPx: 90 };
    engine.bees.bee3.flatSince = null;
  };
  return { engine, open, setPx: (p: number) => (v = view(coins(p))) };
}

describe("engine: the ratchet on a live position", () => {
  it("a +6% run hugs the peak at 0.8x ATR, never loosens, and a fade through it sells in profit", async () => {
    const h = await harness(106);
    h.open();
    await h.engine.tick();
    expect(h.engine.bees.bee3.position!.stopPx!).toBeCloseTo(105.576, 6);
    h.setPx(105.8); // a small fade: the stop stays where it was
    await h.engine.tick();
    expect(h.engine.bees.bee3.position?.stopPx).toBeCloseTo(105.576, 6);
    h.setPx(105.4); // through the hug: out, keeping most of the move
    await h.engine.tick();
    expect(h.engine.bees.bee3.position).toBeNull();
  });

  it("RATCHET=false leaves only the style's own lock", async () => {
    const h = await harness(106, { RATCHET: "false" });
    h.open();
    await h.engine.tick();
    expect(h.engine.bees.bee3.position!.stopPx!).toBeCloseTo(103.9, 6);
  });

  it("a style left out of RATCHET_STYLES is untouched", async () => {
    const h = await harness(106, { RATCHET_STYLES: "bizzy" });
    h.open();
    await h.engine.tick();
    expect(h.engine.bees.bee3.position!.stopPx!).toBeCloseTo(103.9, 6);
  });
});
