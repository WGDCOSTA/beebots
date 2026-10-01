import { describe, expect, it } from "vitest";
import { DAY_MS, leagueOf, metricsOf, MIN_DAYS, MIN_SAMPLES, MIN_TRADES, needOf, rankBy, seasonOf, whyNotRanked, type Point } from "../src/arena/score.js";

const T0 = Date.UTC(2026, 8, 28); // Monday 28 Sep 2026, 00:00 UTC
const series = (equities: number[], stepMs = 600_000, orders = (i: number) => i): Point[] => equities.map((equity, i) => ({ ts: T0 + i * stepMs, equity, orders: orders(i) }));

describe("seasonOf", () => {
  it("is the UTC week, Monday to Monday, named by ISO week", () => {
    const s = seasonOf(Date.UTC(2026, 8, 30, 15, 0)); // Wednesday
    expect(s).toEqual({ id: "2026-W40", start: T0, end: T0 + 7 * DAY_MS });
    expect(seasonOf(T0).id).toBe("2026-W40");
    expect(seasonOf(T0 - 1).id).toBe("2026-W39");
    expect(seasonOf(T0 + 7 * DAY_MS).id).toBe("2026-W41");
  });
  it("uses the ISO week at the turn of the year", () => {
    expect(seasonOf(Date.UTC(2026, 0, 1)).id).toBe("2026-W01"); // Thursday: week 1 of 2026
    expect(seasonOf(Date.UTC(2025, 11, 29)).id).toBe("2026-W01"); // Monday of that same week
    expect(seasonOf(Date.UTC(2024, 11, 30)).id).toBe("2025-W01");
  });
});

describe("metricsOf", () => {
  it("measures return, the worst drop and trades", () => {
    const m = metricsOf(series([100, 110, 88, 99, 121], 6 * 3_600_000, (i) => i * 2))!;
    expect(m.returnPct).toBeCloseTo(21, 9);
    expect(m.maxDrawdownPct).toBeCloseTo(20, 9); // 110 -> 88
    expect(m.trades).toBe(8);
    expect(m.days).toBeCloseTo(1, 9);
    expect(m.score).toBeCloseTo(21 - 10, 9);
  });

  it("a flat line has no drawdown and no Sharpe", () => {
    const m = metricsOf(series([100, 100, 100, 100]))!;
    expect(m).toMatchObject({ returnPct: 0, maxDrawdownPct: 0, sharpe: null, score: 0 });
  });

  it("needs two samples and a positive start", () => {
    expect(metricsOf([])).toBeNull();
    expect(metricsOf(series([100]))).toBeNull();
    expect(metricsOf(series([0, 5]))).toBeNull();
  });

  it("a steady climb scores a higher Sharpe than a jagged one with the same end", () => {
    const steady = metricsOf(series([100, 101, 102, 103, 104, 105]))!;
    const jagged = metricsOf(series([100, 108, 97, 110, 99, 105]))!;
    expect(steady.returnPct).toBeCloseTo(jagged.returnPct, 9);
    expect(steady.sharpe!).toBeGreaterThan(jagged.sharpe!);
  });

  it("drawdown counts against the score at the stated weight", () => {
    const calm = metricsOf(series([100, 102, 104, 106]))!;
    const wild = metricsOf(series([100, 140, 70, 106]))!;
    expect(wild.returnPct).toBeCloseTo(calm.returnPct, 9);
    expect(calm.score).toBeGreaterThan(wild.score);
    expect(wild.score).toBeCloseTo(6 - 0.5 * 50, 9);
  });
});

describe("whyNotRanked", () => {
  const base = { samples: MIN_SAMPLES, days: MIN_DAYS, returnPct: 1, maxDrawdownPct: 1, sharpe: 1, trades: MIN_TRADES, score: 1 };
  it("is null once the bot has enough of everything", () => expect(whyNotRanked(base)).toBeNull());
  it("names what is missing", () => {
    expect(whyNotRanked(null)).toMatch(/Just started/);
    expect(whyNotRanked({ ...base, days: 1 })).toBe("Needs 2.0 more days to be ranked.");
    expect(whyNotRanked({ ...base, trades: 2 })).toBe("Needs 1 more trade to be ranked.");
    expect(whyNotRanked({ ...base, days: 0.5, trades: 0, samples: 3 })).toMatch(/2\.5 more days, 3 more trades, more history/);
  });
});

describe("rankBy and leagues", () => {
  const e = (name: string, score: number) => ({ name, metrics: { samples: 1, days: 1, returnPct: 0, maxDrawdownPct: 0, sharpe: null, trades: 0, score } });
  it("best score first, ties share a rank", () => {
    const r = rankBy([e("b", 2), e("a", 5), e("c", 2), e("d", -1)]);
    expect(r.map((x) => [x.entry.name, x.rank])).toEqual([["a", 1], ["b", 2], ["c", 2], ["d", 4]]);
  });
  it("Free and Pro never share a league", () => {
    expect(leagueOf("free", "breezy")).not.toBe(leagueOf("pro", "breezy"));
  });
});

describe("needOf", () => {
  const base = { days: 5, trades: 20, samples: 500 } as never;
  it("is null when eligible, and gives numbers a page can word", () => {
    expect(needOf(base)).toBeNull();
    expect(needOf(null)).toMatchObject({ started: false });
    expect(needOf({ ...(base as object), days: 1, trades: 2 } as never)).toMatchObject({ started: true, days: Number((MIN_DAYS - 1).toFixed(1)), trades: MIN_TRADES - 2, history: false });
  });
});
