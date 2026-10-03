import { describe, expect, it } from "vitest";
import {
  calendarSummary,
  emptyCalendar,
  hourOfWeek,
  MIN_SAMPLES,
  mayOpen,
  SessionRecorder,
  sessionInfo,
  sessionLabel,
  type TickSample,
} from "../src/market/sessions.js";
import { DEGEN_SETTINGS } from "../src/settings.js";

// Monday 2026-09-28 00:00 UTC.
const MON = Date.UTC(2026, 8, 28);
const H = 3_600_000;

/**
 * Two weeks of minute samples for a "stock" that quotes Mon-Fri 13:00-20:00 UTC (and sits still otherwise), and a
 * crypto coin that must be ignored.
 */
function recorded() {
  const rec = new SessionRecorder(emptyCalendar(MON));
  let px = 100;
  for (let t = MON; t < MON + 14 * 24 * H; t += 60_000) {
    const d = new Date(t);
    const weekday = (d.getUTCDay() + 6) % 7;
    const open = weekday < 5 && d.getUTCHours() >= 13 && d.getUTCHours() < 20;
    if (open) px += 0.01;
    const ticks: TickSample[] = [
      { coin: "NVDA", kind: "stock", ts: open ? t : MON, last: px, vol24h: 1000, spreadBp: 5 },
      { coin: "BTC", kind: "crypto", ts: t, last: t, vol24h: 1, spreadBp: 1 },
    ];
    rec.sample(ticks, t);
  }
  return rec.calendar;
}

describe("session calendar", () => {
  const cal = recorded();

  it("counts hours of the week from Monday 00:00 UTC", () => {
    expect(hourOfWeek(MON)).toBe(0);
    expect(hourOfWeek(MON + 6 * 24 * H + 23 * H)).toBe(167);
  });

  it("learns open and closed hours from ticker activity, ignoring crypto", () => {
    expect(Object.keys(cal.coins)).toEqual(["NVDA"]);
    const [nvda] = calendarSummary(cal);
    expect(nvda).toMatchObject({ coin: "NVDA", kind: "stock", verifiedPct: 100, openHoursPerWeek: 35 });
    expect(nvda!.grid[0]).toBe("Mon .............#######....");
    expect(nvda!.grid[6]).toBe("Sun ........................");
    expect(nvda!.meanSpreadBp).toBe(5);
  });

  it("says how long until the close or the next open", () => {
    const tue1430 = MON + 24 * H + 14.5 * H;
    // Tue 20:00 -> Wed 13:00: a 17 h closure.
    expect(sessionInfo(cal, "NVDA", tue1430)).toEqual({ status: "open", closesInMin: 330, opensInMin: null, closedForMin: 17 * 60 });
    // Fri 14:30: the weekend closure runs to Mon 13:00 (65 h).
    expect(sessionInfo(cal, "NVDA", MON + 4 * 24 * H + 14.5 * H).closedForMin).toBe(65 * 60);
    expect(mayOpen(sessionInfo(cal, "NVDA", tue1430), 30)).toBe(true);
    const tue1945 = MON + 24 * H + 19.75 * H;
    expect(sessionInfo(cal, "NVDA", tue1945).closesInMin).toBe(15);
    expect(mayOpen(sessionInfo(cal, "NVDA", tue1945), 30)).toBe(false);
    const sat = MON + 5 * 24 * H + 12 * H;
    expect(sessionInfo(cal, "NVDA", sat)).toEqual({ status: "closed", closesInMin: null, opensInMin: 49 * 60 });
    expect(sessionLabel(sessionInfo(cal, "NVDA", tue1430))).toBe("open 330m");
  });

  it("anything not watched long enough is unverified, and unverified never opens", () => {
    expect(sessionInfo(cal, "XAU", MON)).toEqual({ status: "unverified", closesInMin: null, opensInMin: null });
    expect(sessionInfo(null, "NVDA", MON + 14 * H).status).toBe("unverified");
    const young = new SessionRecorder(emptyCalendar(MON));
    for (let i = 0; i <= MIN_SAMPLES - 1; i++) young.sample([{ coin: "XAU", kind: "commodity", ts: MON + i * 60_000, last: 1 + i, vol24h: 1, spreadBp: 1 }], MON + i * 60_000);
    expect(sessionInfo(young.calendar, "XAU", MON).status).toBe("unverified");
    expect(mayOpen(sessionInfo(young.calendar, "XAU", MON), 30)).toBe(false);
  });
});

describe("engine with a macro bee", () => {
  async function run(o: { allow: boolean; open: boolean }) {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const { loadConfig } = await import("../src/config.js");
    const { coin, NOW, view } = await import("./fixtures.js");
    const s = {
      version: 1 as const,
      jevKey: "jev-key-12345678",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        ...["A", "B", "C"].map((n) => ({ name: `Bee ${n}`, style: "boozy" as const, tagline: "", rules: "", coins: [], image: false })),
        DEGEN_SETTINGS,
        { name: "Goldie", style: "boozy" as const, tagline: "", rules: "", coins: [], image: false, market: "commodities" as const },
      ],
    };
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), ALLOW_NON_CRYPTO: String(o.allow) }, s as never);
    const v = view([coin("BTC", {}, 80000), coin("SOL", { ret7dPct: 20 }, 150), coin("XAU", { ret7dPct: 3, ret24hPct: 0.8, macdHistPct: 0.02, rsi14: 48, pctB: 0.4 }, 4000), coin("NVDA", { ret7dPct: 9 }, 200)]);
    const xau = "XAU-USD_UM_XPERP-310404";
    const nvda = "NVDA-USD_UM_XPERP-310404";
    v.instruments.get(xau)!.kind = "commodity";
    v.instruments.get(nvda)!.kind = "stock";
    v.gated = v.gated.filter((i) => i !== xau && i !== nvda);
    v.macro = [nvda, xau];
    const full = (n: number) => Array<number>(168).fill(n);
    const cal = { version: 1 as const, startedAt: 0, updatedAt: 0, coins: { XAU: { kind: "commodity" as const, samples: full(30), active: full(o.open ? 30 : 0), spreadSum: full(0) } } };
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    type Req = { state: Record<string, unknown>; questions: { action: { instructions: string; criteria: Record<string, string> } } };
    const reqs: Req[] = [];
    const client = {
      async systemOne(req: unknown) {
        reqs.push(req as Req);
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice: "NOT_ON_MENU", confidence: 1, probabilities: {} }, conviction: { type: "score", score: 1, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW, sessions: () => cal });
    await engine.start();
    engine.stop();
    await engine.tick();
    const labels = (r: Req) => Object.keys(r.questions.action.criteria);
    return { reqs, macro: reqs.filter((r) => r.state.session), crypto: reqs.filter((r) => !r.state.session), labels };
  }

  it("a commodities bee sees only gold, only in an open session, and only with ALLOW_NON_CRYPTO", async () => {
    const on = await run({ allow: true, open: true });
    expect(on.macro).toHaveLength(1);
    // The macro style: a trend-pullback setup on gold, and WAIT.
    expect(on.labels(on.macro[0]!)).toEqual(["TREND_LONG_XAU", "WAIT"]);
    expect(on.macro[0]!.state.session).toEqual({ XAU: "open" });
    expect(on.macro[0]!.questions.action.instructions).toContain("state.session");
    // The crypto bees never see stocks or gold.
    for (const r of on.crypto) expect(on.labels(r).some((l) => /XAU|NVDA/.test(l))).toBe(false);

    const shut = await run({ allow: true, open: false });
    expect(shut.reqs.some((r) => shut.labels(r).some((l) => l.includes("XAU")))).toBe(false);
    const off = await run({ allow: false, open: true });
    expect(off.reqs.some((r) => off.labels(r).some((l) => l.includes("XAU")))).toBe(false);
  });
});

describe("engine: the macro style end to end", () => {
  it("opens gold at no more than 1x, smaller late in the session, and flattens before the close", async () => {
    const { Alerts } = await import("../src/alerts.js");
    const { Engine } = await import("../src/engine.js");
    const { EventBus } = await import("../src/events.js");
    const { SimExecutor } = await import("../src/exec/executor.js");
    const { Jev } = await import("../src/jev.js");
    const { Db } = await import("../src/db.js");
    const { loadConfig } = await import("../src/config.js");
    const { coin, NOW, view } = await import("./fixtures.js");
    const s = {
      version: 1 as const,
      jevKey: "jev-key-12345678",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        ...["A", "B", "C"].map((n) => ({ name: `Bee ${n}`, style: "boozy" as const, tagline: "", rules: "", coins: [], image: false })),
        DEGEN_SETTINGS,
        { name: "Goldie", style: "breezy" as const, tagline: "", rules: "", coins: ["XAU"], image: false, market: "commodities" as const },
      ],
    };
    // This test isolates macro sizing; multi-order progression is covered in multi-orders.test.ts.
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20), ALLOW_NON_CRYPTO: "true", BEE_START_EQUITY_USD: "1000", MAX_NOTIONAL_USD_PER_BEE: "5000", MAX_POSITIONS_PER_BEE: "1" }, s as never);
    const v = view([coin("BTC", {}, 80000), coin("XAU", { ret7dPct: 3, ret24hPct: 0.8, macdHistPct: 0.02, rsi14: 48, pctB: 0.4 }, 4000)]);
    const xau = "XAU-USD_UM_XPERP-310404";
    v.instruments.get(xau)!.kind = "commodity";
    v.gated = v.gated.filter((i) => i !== xau);
    v.macro = [xau];
    // NOW is Thursday 12:00 UTC: gold quotes every hour except Thursday 13:00 (a one-hour break).
    const full = (n: number) => Array<number>(168).fill(n);
    const active = full(30);
    active[3 * 24 + 13] = 0;
    const cal = { version: 1 as const, startedAt: 0, updatedAt: 0, coins: { XAU: { kind: "commodity" as const, samples: full(30), active, spreadSum: full(0) } } };
    let t = NOW;
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as never;
    let answer = "TREND_LONG_XAU";
    const client = {
      async systemOne(req: unknown) {
        const labels = Object.keys((req as { questions: { action: { criteria: Record<string, string> } } }).questions.action.criteria);
        const choice = labels.includes(answer) ? answer : labels[0]!;
        return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice, confidence: 1, probabilities: { [choice]: 0.9 } }, conviction: { type: "score", score: 4, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => t }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => t, sessions: () => cal });
    await engine.start();
    engine.stop();
    await engine.tick();
    const p = engine.bees.bee5.position!;
    expect(p?.coin).toBe("XAU");
    const notional = p.contracts * v.instruments.get(xau)!.ctVal * 4000;
    // 1x equity x 0.97 margin headroom x full conviction x 0.5 late-session factor (60 min to the break).
    expect(notional).toBeLessThanOrEqual(1000 * 0.97 * 0.5 + 1);
    expect(notional).toBeGreaterThan(1000 * 0.97 * 0.5 * 0.9);
    expect(p.stopPx).toBeCloseTo(p.entryPx * (1 - 0.005 * 2.5), 6);

    // 12:55: five minutes to the break. Jev says hold; the code flattens.
    answer = "HOLD";
    t = NOW + 55 * 60_000;
    await engine.tick();
    expect(engine.bees.bee5.position).toBeNull();
    const last = db.raw.prepare("SELECT forced_by FROM decisions WHERE bee = 'bee5' ORDER BY ts DESC LIMIT 1").get() as { forced_by: string | null };
    expect(last.forced_by).toBe("session_close");
  });
});
