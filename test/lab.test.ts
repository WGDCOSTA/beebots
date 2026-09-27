import { describe, expect, it } from "vitest";
import { metrics, score, simulate } from "../src/lab/backtest.js";
import { parseCsv, syntheticCandles } from "../src/lab/history.js";
import { BUILTIN_SKILLS, expandGrid, positions, skillFromSpec, skillRegistry, skillsFromJson } from "../src/lab/skills/index.js";
import { runTournament, walkForwardWindows } from "../src/lab/tournament.js";
import type { Candle } from "../src/market/types.js";

const H = 3_600_000;
const line = (n: number, f: (i: number) => number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = f(i);
    const o = i ? f(i - 1) : c;
    return { ts: Date.UTC(2025, 0, 1) + i * H, o, h: Math.max(o, c) * 1.001, l: Math.min(o, c) * 0.999, c, volUsd: 1e6, confirmed: true };
  });

describe("skills never look ahead", () => {
  const c = syntheticCandles(7, 900);
  for (const s of BUILTIN_SKILLS) {
    it(s.id, () => {
      const p = expandGrid(s, 1)[0]!;
      const full = s.signal(c, p);
      const cut = 600;
      const part = s.signal(c.slice(0, cut), p);
      // The last bar of a truncated series may differ only for williams_vol_breakout, whose day-end exit uses the next
      // bar's timestamp (known in advance); every earlier bar must match exactly.
      for (let i = 0; i < cut - 1; i++) expect(part[i]).toBe(full[i]);
    });
  }
});

describe("simulate", () => {
  it("buy and hold on a steady rise makes money after fees", () => {
    const c = line(500, (i) => 100 * 1.001 ** i);
    const sig = new Int8Array(c.length).fill(1);
    const r = simulate(c, sig, { fundingPer8hPct: 0 }, 10, c.length);
    const m = metrics(r, c, 10, c.length);
    expect(r.trades).toHaveLength(1);
    expect(m.totalReturnPct).toBeGreaterThan(50);
    expect(m.totalReturnPct).toBeLessThan(m.benchmarkPct);
    expect(r.feesUsd).toBeGreaterThan(0);
  });

  it("fills a signal on the next bar's open, never the same bar", () => {
    const c = line(50, (i) => 100 + i);
    const sig = new Int8Array(c.length);
    sig[20] = 1;
    const r = simulate(c, sig, { slippageBps: 0, feeRate: 0, fundingPer8hPct: 0 }, 1, c.length);
    expect(r.trades[0]!.entryTs).toBe(c[21]!.ts);
    expect(r.trades[0]!.entryPx).toBe(c[21]!.o);
  });

  it("an ATR stop closes a loser and blocks re-entry until the signal changes", () => {
    const c = line(300, (i) => (i < 150 ? 100 : 100 - (i - 150) * 0.5));
    const sig = new Int8Array(c.length).fill(1);
    const r = simulate(c, sig, { stopAtr: 1, fundingPer8hPct: 0 }, 20, c.length);
    expect(r.trades.some((t) => t.reason === "stop")).toBe(true);
    expect(r.trades.filter((t) => t.reason === "stop")).toHaveLength(1);
  });

  it("scores few-trade results down", () => {
    const base = { sqn: 1, totalReturnPct: 10, cagrPct: 10, sharpe: 2, sortino: 2, maxDrawdownPct: 5, calmar: 2, trades: 2, winRatePct: 100, profitFactor: 3, expectancyPct: 5, avgBars: 10, exposurePct: 50, feesPct: 0.1, benchmarkPct: 5, bars: 500 };
    expect(score({ ...base, trades: 2 })).toBeLessThan(score({ ...base, trades: 20 }));
  });
});

describe("positions()", () => {
  it("holds until the exit, flips on the opposite entry", () => {
    const le = [0, 1, 0, 0, 0, 0, 0];
    const lx = [0, 0, 0, 1, 0, 0, 0];
    const se = [0, 0, 0, 0, 0, 1, 0];
    const p = positions(7, { longEntry: (i) => !!le[i], longExit: (i) => !!lx[i], shortEntry: (i) => !!se[i], shortExit: () => false });
    expect([...p]).toEqual([0, 1, 1, 0, 0, -1, -1]);
  });
});

describe("importable skills (JSON)", () => {
  const spec = {
    id: "golden_pullback",
    name: "Golden pullback",
    family: "hybrid",
    params: { lo: { default: 30, grid: [20, 30] } },
    stopAtr: 3,
    long: {
      entry: [
        { left: "close", op: ">", right: "sma(50)" },
        { left: "rsi(3)", op: "<", right: "$lo" },
      ],
      exit: [{ any: [{ left: "rsi(3)", op: ">", right: 70 }, { left: "close", op: "crosses_below", right: "sma(50)" }] }],
    },
  };

  it("compiles and trades", () => {
    const s = skillFromSpec(spec, "test.json");
    expect(s.grid).toEqual({ lo: [20, 30] });
    const sig = s.signal(syntheticCandles(3, 1500), { lo: 30 });
    expect(sig.some((x) => x === 1)).toBe(true);
    expect(sig.every((x) => x >= 0)).toBe(true);
  });

  it("rejects unknown indicators and parameters with a readable error", () => {
    expect(() => skillFromSpec({ ...spec, long: { entry: [{ left: "magic(3)", op: ">", right: 1 }], exit: spec.long.exit } })).toThrow(/unknown indicator "magic"/);
    expect(() => skillFromSpec({ ...spec, long: { entry: [{ left: "rsi(3)", op: "<", right: "$nope" }], exit: spec.long.exit } })).toThrow(/unknown parameter/);
    expect(() => skillFromSpec({ ...spec, id: "Bad Id" })).toThrow(/skill Bad Id/);
  });

  it("reads packs", () => {
    expect(skillsFromJson({ skills: [spec, { ...spec, id: "second" }] }, "pack.json").map((s) => s.id)).toEqual(["golden_pullback", "second"]);
  });

  it("the shipped ./skills folder imports cleanly", () => {
    const r = skillRegistry(["./skills"]);
    expect(r.errors).toEqual([]);
    expect(r.skills.length).toBeGreaterThan(BUILTIN_SKILLS.length);
  });
});

describe("history", () => {
  it("parses a CSV with seconds or ISO timestamps", () => {
    const c = parseCsv("time,open,high,low,close,volume\n1735689600,1,2,0.5,1.5,10\n2025-01-01T01:00:00Z,1.5,2,1,1.8,5\n");
    expect(c).toHaveLength(2);
    expect(c[0]!.ts).toBe(1735689600000);
    expect(c[1]!.c).toBe(1.8);
  });

  it("synthetic markets are reproducible", () => {
    expect(syntheticCandles(1, 50)).toEqual(syntheticCandles(1, 50));
  });
});

describe("tournament", () => {
  it("walk-forward folds tile the test region after the warm-up", () => {
    const w = walkForwardWindows(1000, { folds: 3, testFrac: 0.5, warmup: 100 });
    expect(w).toHaveLength(3);
    expect(w[0]!.test.from).toBe(500);
    expect(w[2]!.test.to).toBe(1000);
    for (const f of w) expect(f.train.to).toBe(f.test.from);
  });

  it("ranks every skill on out-of-sample folds only", () => {
    const skills = BUILTIN_SKILLS.filter((s) => ["buy_hold", "sma_cross", "rsi_reversion"].includes(s.id));
    const ds = [{ id: "SYN 1H", instId: "SYN", bar: "1H" as const, candles: syntheticCandles(11, 1500), source: "synthetic" as const }];
    const r = runTournament(skills, ds, { folds: 2, maxCombos: 6 });
    expect(r.results.map((x) => x.rank)).toEqual([1, 2, 3]);
    for (let i = 1; i < r.results.length; i++) expect(r.results[i - 1]!.score).toBeGreaterThanOrEqual(r.results[i]!.score);
    for (const s of r.results) expect(s.folds).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });
});
