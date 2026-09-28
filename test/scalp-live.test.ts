// Scalper phase 2: the brain (mandate, signal, cost gate, circuit breaker) and the engine loop around it.
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { isScalpBrain, scalpBrain, type GateRule } from "../src/bees/scalp.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { DEFAULT_COSTS, type ScalpGate } from "../src/lab/scalp.js";
import type { MarketFeed } from "../src/market/data.js";
import type { Candle, MarketView } from "../src/market/types.js";
import { bee, coin, ctx, NOW, testConfig, view } from "./fixtures.js";

const PARAMS = { n: 20, volMult: 0, trend: 0, targetAtr: 1.2, stopAtr: 1.2, holdBars: 15, makerEntry: 1, makerTarget: 1 };
const RULE: GateRule = { coin: "BTC", ruleId: "micro_breakout", params: PARAMS, netBps: 2.1, trades: 150 };
const scalpCfg = (env: Record<string, string> = {}) => testConfig({ DRY_RUN: "true", SCALP: "true", ...env });

/** `n` quiet 1-minute bars around 100 (range 0.12 = 12 bp of ATR), the last one closed two minutes before `now`. */
function quiet(n = 200, range = 0.12, now = NOW): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ ts: now - 120_000 - (n - 1 - i) * 60_000, o: 100, h: 100 + range / 2, l: 100 - range / 2, c: 100, volUsd: 1e6, confirmed: true }));
}
/** The same bars with a last bar that closes above the prior 20-bar high: a long signal. */
const breakout = (now = NOW, range = 0.12): Candle[] => {
  const c = quiet(200, range, now);
  c[c.length - 1] = { ...c[c.length - 1]!, o: 100, h: 100.2, l: 99.98, c: 100.15 };
  return c;
};

const brainOf = (rules: GateRule[] = [RULE], env: Record<string, string> = {}) => {
  const cfg = scalpCfg(env);
  return { cfg, brain: scalpBrain({ rules: () => rules, costs: () => DEFAULT_COSTS, cfg: cfg.scalp }) };
};
const mk = (b: ReturnType<typeof brainOf>, c: Candle[], now = NOW, spreadBp = 1, over = {}) => {
  const v = view([coin("BTC", { spreadBp }, 100), coin("ETH")]);
  return { ...ctx("boozy", bee("boozy"), v, b.cfg, now), candles1m: () => c, ...over };
};

describe("the scalp brain: the mandate", () => {
  it("offers a mandate on each coin the lab passed, and only WAIT when the gate is closed, a mandate runs, or Jev was just asked", () => {
    const b = brainOf();
    const labels = Object.keys(b.brain.menu(mk(b, quiet())));
    expect(labels.sort()).toEqual(["SCALP_ON_BTC_BOTH", "SCALP_ON_BTC_LONG", "SCALP_ON_BTC_SHORT", "WAIT"]);
    expect(Object.keys(brainOf([]).brain.menu(mk(brainOf([]), quiet())))).toEqual(["WAIT"]);
    // a coin outside SCALP_COINS is never offered
    const eth = brainOf([{ ...RULE, coin: "SOL" }]);
    expect(Object.keys(eth.brain.menu(mk(eth, quiet())))).toEqual(["WAIT"]);
    // wide spread: not offered
    expect(Object.keys(b.brain.menu(mk(b, quiet(), NOW, 4)))).toEqual(["WAIT"]);
    // Jev answered WAIT: no new question until SCALP_MANDATE_MIN has passed
    b.brain.onChoice!("WAIT", mk(b, quiet()));
    expect(Object.keys(b.brain.menu(mk(b, quiet(), NOW + 60_000)))).toEqual(["WAIT"]);
    expect(Object.keys(b.brain.menu(mk(b, quiet(), NOW + b.cfg.scalp.mandateMin * 60_000 + 1))).length).toBeGreaterThan(1);
  });

  it("holds while positioned, and a chosen mandate stops the questions", () => {
    const b = brainOf();
    const c = mk(b, quiet());
    expect(Object.keys(b.brain.menu({ ...c, bee: bee("boozy", { position: { instId: c.view.gated[0]!, coin: "BTC", side: "long", contracts: 1, entryPx: 100, openedAt: NOW, stopPx: 99, riskUsd: 1 } }) }))).toEqual(["HOLD"]);
    b.brain.onChoice!("SCALP_ON_BTC_LONG", c);
    const m = b.brain.scalp.mandate(NOW)!;
    expect(m).toMatchObject({ coin: "BTC", bias: "long", used: 0, maxTrades: b.cfg.scalp.mandateTrades });
    expect(m.expiresAt).toBe(NOW + b.cfg.scalp.mandateMinutes * 60_000);
    expect(Object.keys(b.brain.menu(c))).toEqual(["WAIT"]);
    expect(b.brain.scalp.mandate(m.expiresAt + 1)).toBeNull();
  });

  it("ignores a mandate label for a coin the lab did not pass", () => {
    const b = brainOf();
    b.brain.onChoice!("SCALP_ON_DOGE_BOTH", mk(b, quiet()));
    expect(b.brain.scalp.mandate(NOW)).toBeNull();
  });
});

describe("the scalp brain: the entry", () => {
  const armed = (bias = "BOTH") => {
    const b = brainOf();
    b.brain.onChoice!(`SCALP_ON_BTC_${bias}`, mk(b, quiet()));
    return b;
  };

  it("a lab-rule signal inside the mandate becomes a maker plan that joins the touch, with the cost gate satisfied", () => {
    const b = armed();
    const plan = b.brain.scalp.entry(mk(b, breakout()));
    expect("why" in plan).toBe(false);
    if ("why" in plan) return;
    expect(plan).toMatchObject({ label: "SCALP_LONG_BTC", coin: "BTC", side: "long", maker: true, makerTarget: true, ruleId: "micro_breakout", holdMin: 15 });
    expect(plan.limitPx).toBeCloseTo(99.995, 6); // the bid, not the rule's 100.15: never pay up, never cross
    expect(plan.targetBps).toBeGreaterThan(12); // at least 3x the 4 bp maker round trip
    expect(plan.stopBps).toBeCloseTo(plan.targetBps, 6);
    expect(plan.signalTs).toBe(NOW - 120_000);
  });

  it("says why not: no mandate, no signal, wrong bias, dead market, wide spread, stale or thin data", () => {
    const why = (b: ReturnType<typeof brainOf>, c: Candle[], now = NOW, spread = 1) => {
      const r = b.brain.scalp.entry(mk(b, c, now, spread));
      return "why" in r ? r.why : "PLAN";
    };
    expect(why(brainOf(), breakout())).toMatch(/no mandate/);
    expect(why(armed(), quiet())).toMatch(/no signal/);
    expect(why(armed("SHORT"), breakout())).toMatch(/against the mandate's short bias/);
    expect(why(armed(), breakout(NOW, 0.02))).toMatch(/round trip/); // 2 bp of ATR cannot pay a 4 bp trip
    expect(why(armed(), breakout(), NOW, 4)).toMatch(/spread/);
    expect(why(armed(), breakout(), NOW + 10 * 60_000)).toMatch(/stale/);
    expect(why(armed(), quiet(50))).toMatch(/only 50 one-minute candles/);
    expect(why(armed(), breakout(), NOW + 31 * 60_000)).toMatch(/no mandate/); // expired
  });

  it("trades a signal bar once, and stops when the mandate's trade budget is spent", () => {
    const b = armed();
    const plan = b.brain.scalp.entry(mk(b, breakout()));
    if ("why" in plan) throw new Error(plan.why);
    b.brain.scalp.begin(plan);
    b.brain.scalp.opened(99.995, 0.01, NOW);
    expect(b.brain.scalp.entry(mk(b, breakout()))).toMatchObject({ why: expect.stringMatching(/already traded/) });
    for (let i = 1; i < b.cfg.scalp.mandateTrades; i++) b.brain.scalp.opened(100, 0, NOW);
    expect(b.brain.scalp.mandate(NOW)).toBeNull(); // budget spent
  });

  it("the circuit breaker pauses after a run of losses, counted net of fees, and a win resets the count", () => {
    const b = armed();
    const s = b.brain.scalp;
    let t = NOW;
    const trade = (gross: number) => {
      t += 1_000; // every trade is on its own signal bar, all inside one mandate
      const p = s.entry(mk(b, breakout(t), t));
      if ("why" in p) throw new Error(p.why);
      s.begin(p);
      s.opened(100, 0.01, t);
      s.closed(gross, 0.01, t); // entry fee 0.01 + exit fee 0.01
    };
    const loseOnce = () => trade(-0.02);
    const n = b.cfg.scalp.maxLossStreak;
    for (let i = 0; i < n - 1; i++) loseOnce();
    expect(s.status(t).lossStreak).toBe(n - 1);
    // a win that clears its fees resets the streak
    trade(0.05);
    expect(s.status(t).lossStreak).toBe(0);
    // ... a gross win that does NOT clear its fees is a loss
    trade(0.015);
    expect(s.status(t).lossStreak).toBe(1);
    trade(0.05);
    for (let i = 0; i < n; i++) loseOnce();
    const st = s.status(t);
    expect(st.pausedUntil).toBeGreaterThan(t);
    expect(st.note).toMatch(/paused after/);
    expect(s.entry(mk(b, breakout(t + 60_000), t + 60_000))).toMatchObject({ why: expect.stringMatching(/paused/) });
    // after the pause it may trade again
    const later = t + b.cfg.scalp.pauseMin * 60_000 + 1;
    const c2 = breakout(later);
    b.brain.onChoice!("SCALP_ON_BTC_BOTH", mk(b, c2, later));
    expect("why" in s.entry(mk(b, c2, later))).toBe(false);
  });

  it("closes at the target (maker) and at the time stop, and the stop sits stopBps from the fill", () => {
    const b = armed();
    const c = mk(b, breakout());
    const plan = b.brain.scalp.entry(c);
    if ("why" in plan) throw new Error(plan.why);
    b.brain.scalp.begin(plan);
    const stop = b.brain.stopFor(plan.instId, "long", 100, c)!;
    expect(stop).toBeCloseTo(100 * (1 - plan.stopBps / 1e4), 9);
    b.brain.scalp.opened(100, 0, NOW);
    const held = (px: number) => ({ ...c, bee: bee("boozy", { position: { instId: plan.instId, coin: "BTC", side: "long" as const, contracts: 1, entryPx: 100, openedAt: NOW, stopPx: stop, riskUsd: 1 } }), view: view([coin("BTC", {}, px)]) });
    expect(b.brain.forcedClose!(held(100.01))).toBeNull();
    expect(b.brain.forcedClose!(held(100 * (1 + plan.targetBps / 1e4) + 0.001))).toBe("scalp_target");
    expect(b.brain.timeStopMinutes!(c)).toBe(15);
    expect(b.brain.scalp.makerTarget()).toBe(true);
  });
});

// ---------- the engine ----------

function rig(env: Record<string, string> = {}, gate: ScalpGate | null = { open: true, reason: "lab edge on BTC", rules: [RULE], costs: DEFAULT_COSTS, ageDays: 1 }) {
  const cfg = scalpCfg(env);
  let px = 100;
  let clock = NOW;
  let candles = breakout(NOW);
  const coins = () => [coin("BTC", { spreadBp: 1, atr14Pct: 0.1 }, px), coin("ETH")];
  let v: MarketView = view(coins());
  const setPx = (p: number) => {
    px = p;
    v = view(coins());
  };
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, refreshScalp: async () => {}, candles1m: () => candles, lastRefreshAt: NOW } as unknown as MarketFeed;
  let jevCalls = 0;
  const client: SystemOne = {
    async systemOne(req: unknown) {
      const labels = Object.keys((req as { questions: { action: { criteria: Record<string, string> } } }).questions.action.criteria);
      jevCalls++;
      const choice = labels.find((l) => l === "SCALP_ON_BTC_BOTH") ?? labels[0]!;
      return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
  // each poll of a resting limit order moves the price along `path`, the way a live book would between checks
  let path: number[] = [];
  const exec = new SimExecutor(() => v, cfg.risk.takerFeeRate, () => clock, { makerFeeRate: cfg.scalp.makerFee, pollMs: 1000, sleep: async (ms) => void ((clock += ms), path.length && setPx(path.shift()!)) });
  const db = new Db(":memory:");
  const engine = new Engine({
    cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec, bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW,
    specialization: (id) => (id === "bee1" ? { kind: "style", id: "scalp" } : null),
    ...(gate ? { scalpGate: () => gate } : {}),
  });
  return { cfg, engine, db, note: () => (engine as unknown as { scalpNote: Record<string, string> }).scalpNote, setPx, setPath: (p: number[]) => void (path = p), setCandles: (c: Candle[]) => void (candles = c), jevCalls: () => jevCalls };
}

async function started(r: ReturnType<typeof rig>) {
  await r.engine.start();
  r.engine.stop();
  for (const id of ["bee2", "bee3"] as const) r.engine.bees[id].cap = "trade_cap"; // only bee1 acts
}

const fills = (db: Db) => db.raw.prepare("SELECT o.purpose AS purpose, o.side AS side, f.px AS px, f.fee_usd AS fee, f.realised_usd AS realised FROM fills f JOIN orders o ON o.id = f.order_id ORDER BY f.id").all() as Array<{ purpose: string; side: string; px: number; fee: number; realised: number }>;

describe("the engine: Jev sets a mandate, code scalps inside it", () => {
  it("a bee specialised in scalp is asked once, then trades a maker entry and a maker target on its own", async () => {
    const r = rig();
    await started(r);
    await r.engine.tick(); // adopts the method and asks Jev: SCALP_ON_BTC_BOTH
    const b1 = () => r.engine.snapshot().bees.find((x) => x.bee === "bee1")!;
    expect(b1().scalp).toMatchObject({ gateOpen: true, mandate: { coin: "BTC", bias: "both", used: 0 } });
    expect(r.jevCalls()).toBe(1);
    expect(isScalpBrain((r.engine as unknown as { brain(id: string): never }).brain("bee1"))).toBe(true);

    // entry: a resting bid at the touch, filled when the market trades through it
    r.setPath([99.9]);
    await r.engine.scalpTick();
    const pos = r.engine.bees.bee1.position!;
    expect(pos).toBeTruthy();
    expect(pos.side).toBe("long");
    expect(pos.entryPx).toBeCloseTo(99.995, 6);
    expect(pos.stopPx!).toBeLessThan(pos.entryPx);
    expect(b1().scalp!.mandate!.used).toBe(1);
    const entryFee = fills(r.db)[0]!.fee;
    expect(entryFee).toBeCloseTo((pos.contracts * (1 / 100) * pos.entryPx * r.cfg.scalp.makerFee), 6); // the maker rate, not the taker's

    // target: mid above entry + targetBps: a resting ask, filled when the bid trades up through it
    r.setPx(100.3);
    r.setPath([100.6]);
    await r.engine.scalpTick();
    expect(r.engine.bees.bee1.position).toBeNull();
    const f = fills(r.db);
    expect(f.map((x) => [x.purpose, x.side])).toEqual([["scalp_open", "buy"], ["scalp_target", "sell"]]);
    expect(f[1]!.realised).toBeGreaterThan(0);
    expect(f[1]!.fee).toBeCloseTo(f[0]!.fee * (f[1]!.px / f[0]!.px), 3); // both legs at the maker rate
    // Jev was not asked for any of it
    expect(r.jevCalls()).toBe(1);
  });

  it("a stop is a taker close, and a loss counts toward the circuit breaker", async () => {
    const r = rig();
    await started(r);
    await r.engine.tick();
    r.setPath([99.9]);
    await r.engine.scalpTick();
    const stop = r.engine.bees.bee1.position!.stopPx!;
    r.setPx(stop - 0.05);
    await r.engine.scalpTick();
    expect(r.engine.bees.bee1.position).toBeNull();
    const f = fills(r.db);
    expect(f[1]!.purpose).toBe("stop");
    expect(f[1]!.realised).toBeLessThan(0);
    expect(f[1]!.fee).toBeGreaterThan(0);
    expect(r.engine.snapshot().bees.find((x) => x.bee === "bee1")!.scalp!.lossStreak).toBe(1);
  });

  it("an order that never fills traded nothing, left nothing resting, and is not a rejection", async () => {
    const r = rig();
    await started(r);
    await r.engine.tick();
    r.setPath([]); // the market never trades through the bid
    await r.engine.scalpTick();
    expect(r.engine.bees.bee1.position).toBeNull();
    expect(fills(r.db)).toEqual([]);
    const rows = r.db.raw.prepare("SELECT state, error FROM orders WHERE purpose = 'scalp_open'").all() as Array<{ state: string; error: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "rejected", error: "UNFILLED" });
    // no pause: the next look may try again (a fresh signal bar would be needed; the same one is not re-traded only after a fill)
    await r.engine.scalpTick();
    expect((r.db.raw.prepare("SELECT COUNT(*) AS n FROM orders WHERE purpose = 'scalp_open'").get() as { n: number }).n).toBe(2);
  });

  it("with the lab gate closed the method is refused and nothing scalps", async () => {
    const r = rig({}, { open: false, reason: "the lab found no edge after costs", rules: [], costs: DEFAULT_COSTS, ageDays: 1 });
    await started(r);
    await r.engine.tick();
    const b1 = r.engine.snapshot().bees.find((x) => x.bee === "bee1")!;
    expect(b1.scalp).toBeNull();
    r.setPath([99.9]);
    await r.engine.scalpTick();
    expect(r.engine.bees.bee1.position).toBeNull();
    expect(r.engine.snapshot().system!.scalp).toMatchObject({ enabled: true, gateOpen: false });
    expect(r.engine.snapshot().system!.scalp.reason).toMatch(/no edge/);
  });

  it("SCALP is off by default: no scalp loop, no method, nothing changes for anyone", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    expect(cfg.scalp.enabled).toBe(false);
    const r = rig({ SCALP: "false" });
    await started(r);
    await r.engine.tick();
    await r.engine.scalpTick();
    expect(r.engine.snapshot().bees.find((x) => x.bee === "bee1")!.scalp).toBeNull();
    expect(r.engine.snapshot().system!.scalp).toMatchObject({ enabled: false, gateOpen: false });
    expect(fills(r.db).filter((f) => f.purpose.startsWith("scalp"))).toEqual([]);
  });

  it("with real money the lab gate cannot be switched off", () => {
    const live = testConfig({ DRY_RUN: "false", MODE: "live", LIVE_ACK: "I-ACCEPT-REAL-MONEY-RISK", SCALP: "true", SCALP_REQUIRE_LAB: "false", BEE1_OKX_API_KEY: "a", BEE1_OKX_API_SECRET: "b", BEE1_OKX_API_PASSPHRASE: "c", BEE2_OKX_API_KEY: "a", BEE2_OKX_API_SECRET: "b", BEE2_OKX_API_PASSPHRASE: "c", BEE3_OKX_API_KEY: "a", BEE3_OKX_API_SECRET: "b", BEE3_OKX_API_PASSPHRASE: "c" });
    expect(live.mode).toBe("live");
    expect(live.scalp.requireLab).toBe(true);
    expect(scalpCfg({ SCALP_REQUIRE_LAB: "false" }).scalp.requireLab).toBe(false); // paper: the owner's call
  });

  it("the slow tick and the scalp loop never act on a bee at the same time", async () => {
    const r = rig();
    await started(r);
    await r.engine.tick();
    r.setPath([99.9]);
    // Whichever gets to the bee first works it; the other leaves it alone rather than double-acting.
    await Promise.all([r.engine.scalpTick(), r.engine.tick(), r.engine.scalpTick()]);
    const opens = () => fills(r.db).filter((f) => f.purpose === "scalp_open").length;
    expect(opens()).toBeLessThanOrEqual(1);
    await r.engine.scalpTick();
    expect(opens()).toBe(1);
    expect(r.engine.bees.bee1.position).toBeTruthy();
    expect(r.engine.bees.bee1.legs ?? []).toHaveLength(0);
  });
});
