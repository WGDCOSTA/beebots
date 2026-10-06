import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

type Req = { questions: { action: { criteria: Record<string, string> } } };
const HOLDS = ["WAIT", "HOLD", "RIDE"];

async function harness(env: Record<string, string>) {
  const cfg = testConfig({ DRY_RUN: "true", BEE_START_EQUITY_USD: "1000", ...env });
  const v = view([coin("BTC", { ret7dPct: 25, ret24hPct: 5 }, 100), coin("SOL", { ret7dPct: 20 }, 100), coin("ETH", { ret7dPct: 15 }, 100)]);
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
  const reqs: Req[] = [];
  const client = {
    async systemOne(req: unknown) {
      const r = req as Req;
      reqs.push(r);
      // A patient Jev: always the wait/hold option when there is one.
      const labels = Object.keys(r.questions.action.criteria);
      const choice = labels.find((l) => HOLDS.includes(l)) ?? labels[0]!;
      return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 0.95 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  const db = new Db(":memory:");
  const clock = { t: NOW };
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => clock.t }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate, () => clock.t), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => clock.t });
  await engine.start();
  engine.stop();
  return { engine, reqs, clock, cfg };
}

describe("JEV_REASK_MIN", () => {
  it("keeps Jev's hold/wait while nothing changed, and asks again after the interval", async () => {
    const { engine, reqs, clock } = await harness({ JEV_REASK_MIN: "5" });
    await engine.tick(); // no wait option yet: Jev opens a position
    clock.t += 10_000;
    await engine.tick(); // holding is new: asked once, says RIDE
    const first = reqs.length;
    expect(first).toBeGreaterThan(0);
    expect(engine.bees.bee1.position ?? engine.bees.bee2.position ?? engine.bees.bee3.position ?? engine.bees.bee4.position).not.toBeNull();
    for (let i = 0; i < 5; i++) {
      clock.t += 10_000;
      await engine.tick();
    }
    expect(reqs.length).toBe(first);
    clock.t += 5 * 60_000;
    await engine.tick();
    expect(reqs.length).toBeGreaterThan(first);
  });

  it("asks every tick when off (the default)", async () => {
    const { engine, reqs, clock } = await harness({});
    await engine.tick();
    const first = reqs.length;
    clock.t += 10_000;
    await engine.tick();
    expect(reqs.length).toBe(2 * first);
  });

  it("does not ask for a bunny sent home by the daily loss stop", async () => {
    const { engine, reqs, clock, cfg } = await harness({});
    for (const id of cfg.beeIds) engine.bees[id].cap = "loss_stop";
    clock.t += 10_000;
    await engine.tick();
    expect(reqs.length).toBe(0);
  });
});
