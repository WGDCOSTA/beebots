import { afterEach, describe, expect, it, vi } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

afterEach(() => vi.useRealTimers());

describe("market refresh watchdog", () => {
  it("abandons a refresh that never settles, so the next one runs", async () => {
    vi.useFakeTimers();
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([coin("BTC", {}, 100)]);
    let calls = 0;
    let hang = true;
    const feed = {
      view: () => v,
      refresh: () => {
        calls++;
        return hang ? new Promise<void>(() => {}) : Promise.resolve();
      },
      refreshTickers: async () => {},
      lastRefreshAt: NOW,
    } as never;
    const client = { systemOne: async () => ({}) } as never;
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate, () => NOW), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    const first = engine.refreshMarket();
    // While it hangs, a second refresh is skipped (one at a time).
    await engine.refreshMarket();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(Math.max(60_000, 3 * cfg.dataRefreshMs) + 1);
    await first;
    hang = false;
    await engine.refreshMarket();
    expect(calls).toBe(2);
  });
});
