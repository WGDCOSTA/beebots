// Ideas taken from the big open-source frameworks: CCXT (history from 100+ exchanges), Freqtrade (minimal_roi,
// stoploss and trailing-stop exits; its JSON data files) and Backtrader (the SQN analyzer).
import { describe, expect, it } from "vitest";
import { metrics, simulate } from "../src/lab/backtest.js";
import { coinOfDataset } from "../src/graph/hive-mind.js";
import { fetchHistoryCcxt, ohlcvRows, parseFreqtradeJson, syntheticCandles, type OhlcvExchange } from "../src/lab/history.js";
import * as S from "../src/lab/series.js";
import { skillFromSpec, skillRegistry } from "../src/lab/skills/index.js";
import type { Candle } from "../src/market/types.js";

const H = 3_600_000;
const T0 = Date.UTC(2025, 0, 1);
const bars = (closes: number[], wick = 0.002): Candle[] =>
  closes.map((c, i) => {
    const o = i ? closes[i - 1]! : c;
    return { ts: T0 + i * H, o, h: Math.max(o, c) * (1 + wick), l: Math.min(o, c) * (1 - wick), c, volUsd: 1e6, confirmed: true };
  });

describe("indicators", () => {
  const c = syntheticCandles(9, 600);
  const finite = (xs: Float64Array) => [...xs].filter(Number.isFinite);
  it("ADX and DI stay in 0..100 and warm up after 2n bars", () => {
    const a = S.adx(c, 14);
    expect(Number.isNaN(a.adx[26]!)).toBe(true);
    expect(Number.isFinite(a.adx[27]!)).toBe(true);
    for (const x of [...finite(a.adx), ...finite(a.plusDi), ...finite(a.minusDi)]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
  });
  it("a steady rise reads as a strong up-trend", () => {
    const up = bars(Array.from({ length: 120 }, (_, i) => 100 + i));
    const a = S.adx(up, 14);
    expect(a.plusDi[119]!).toBeGreaterThan(a.minusDi[119]!);
    expect(a.adx[119]!).toBeGreaterThan(40);
    expect(S.cci(up, 20)[119]!).toBeGreaterThan(50);
    expect(S.willr(up, 14)[119]!).toBeGreaterThan(-10);
  });
  it("MFI, Williams %R and Stochastic %D stay in range", () => {
    for (const x of finite(S.mfi(c, 14))) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
    }
    for (const x of finite(S.willr(c, 14))) {
      expect(x).toBeGreaterThanOrEqual(-100);
      expect(x).toBeLessThanOrEqual(0);
    }
    expect(finite(S.stochD(c, 14, 3)).length).toBe(600 - 15);
  });
});

describe("Freqtrade-style exits", () => {
  const long = (n: number) => new Int8Array(n).fill(1);
  const base = { fundingPer8hPct: 0, slippageBps: 0, feeRate: 0 };

  it("minimal_roi takes profit at the first rung the price reaches", () => {
    const c = bars(Array.from({ length: 40 }, (_, i) => 100 * 1.01 ** i));
    const r = simulate(c, long(c.length), { ...base, exits: { roi: [[0, 0.05]] } }, 1, c.length);
    expect(r.trades[0]!.reason).toBe("roi");
    expect(r.trades[0]!.exitPx).toBeCloseTo(r.trades[0]!.entryPx * 1.05, 6);
  });

  it("a later ROI rung applies once enough minutes have passed", () => {
    const c = bars(Array.from({ length: 40 }, () => 100).map((x, i) => x + (i > 5 ? 1.5 : 0)), 0);
    const r = simulate(c, long(c.length), { ...base, exits: { roi: [[0, 0.5], [180, 0.01]] } }, 1, c.length);
    expect(r.trades[0]!.reason).toBe("roi");
    expect(r.trades[0]!.exitTs - r.trades[0]!.entryTs).toBeGreaterThanOrEqual(180 * 60_000);
  });

  it("stoploss closes at the fixed loss and blocks re-entry on the same signal", () => {
    const c = bars(Array.from({ length: 60 }, (_, i) => 100 - i));
    const r = simulate(c, long(c.length), { ...base, exits: { stoploss: -0.05 } }, 1, c.length);
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.reason).toBe("stop");
    expect(r.trades[0]!.retPct).toBeCloseTo(-5, 0);
  });

  it("the trailing stop only arms past its offset, then locks in profit", () => {
    const path = [...Array.from({ length: 20 }, (_, i) => 100 + i), ...Array.from({ length: 20 }, (_, i) => 119 - i * 2)];
    const c = bars(path, 0);
    const r = simulate(c, long(c.length), { ...base, exits: { trailing: { positive: 0.02, offset: 0.05 } } }, 1, c.length);
    expect(r.trades[0]!.reason).toBe("trailing");
    expect(r.trades[0]!.pnlUsd).toBeGreaterThan(0);
  });

  it("a JSON skill carries roi, stoploss and trailing into its exits", () => {
    const s = skillFromSpec({
      id: "x_exits",
      name: "x",
      family: "trend",
      roi: { "0": 0.04, "60": 0.02 },
      stoploss: -0.05,
      trailing: { positive: 0.01, offset: 0.02 },
      long: { entry: [{ left: "close", op: ">", right: "sma(10)" }], exit: [{ left: "close", op: "<", right: "sma(10)" }] },
    });
    expect(s.exits).toEqual({ roi: [[0, 0.04], [60, 0.02]], stoploss: -0.05, trailing: { positive: 0.01, offset: 0.02 } });
  });
});

describe("Backtrader's SQN", () => {
  it("sqrt(N) x mean / stdev of trade returns (needs 5+ trades, capped at +/-10)", () => {
    const c = bars(Array.from({ length: 200 }, (_, i) => 100 + 10 * Math.sin(i / 5)));
    const sig = new Int8Array(c.length).map((_, i) => (Math.floor(i / 10) % 2 ? 1 : 0));
    const r = simulate(c, sig, { fundingPer8hPct: 0 }, 1, c.length);
    const m = metrics(r, c, 1, c.length);
    const x = r.trades.map((t) => t.retPct);
    const mean = x.reduce((a, b) => a + b, 0) / x.length;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - 1));
    expect(x.length).toBeGreaterThanOrEqual(5);
    expect(m.sqn).toBeCloseTo(Math.max(-10, Math.min(10, (Math.sqrt(x.length) * mean) / sd)), 8);
    const few = simulate(c, sig.map((v, i) => (i < 30 ? v : 0)), { fundingPer8hPct: 0 }, 1, c.length);
    expect(metrics(few, c, 1, c.length).sqn).toBe(0);
  });
});

describe("CCXT history", () => {
  it("pages forward with since, drops the unclosed candle, de-duplicates", async () => {
    const now = T0 + 2500 * H + 10 * 60_000;
    const calls: Array<[string, string | undefined, number | undefined, number | undefined]> = [];
    const ex: OhlcvExchange = {
      async fetchOHLCV(symbol, tf, since, limit) {
        calls.push([symbol, tf, since, limit]);
        const start = Math.ceil(since! / H) * H;
        const rows = [];
        for (let t = start - H; t <= now && rows.length < limit!; t += H) rows.push([t, 1, 2, 0.5, 1.5, 10]);
        return rows;
      },
    };
    const c = await fetchHistoryCcxt(ex, "BTC/USDT", "1H", 100, now, 1000);
    expect(calls[0]!.slice(0, 2)).toEqual(["BTC/USDT", "1h"]);
    expect(calls.length).toBeGreaterThan(2);
    expect(c.length).toBe(new Set(c.map((x) => x.ts)).size);
    expect(c[c.length - 1]!.ts + H).toBeLessThanOrEqual(now);
    expect(c[0]!.volUsd).toBe(15);
  });

  it("dataset names map to coins for the hive mind", () => {
    expect(coinOfDataset("binance-BTC-USDT 1H")).toBe("BTC");
    expect(coinOfDataset("ETH-USDT-SWAP 1H")).toBe("ETH");
  });
});

describe("Freqtrade data files", () => {
  it("reads [ts, o, h, l, c, v] rows", () => {
    const c = parseFreqtradeJson(JSON.stringify([[2000, 1, 2, 0.5, 1.5, 4], [1000, 1, 1, 1, 1, 0]]));
    expect(c.map((x) => x.ts)).toEqual([1000, 2000]);
    expect(ohlcvRows([["3000", "1", "1", "1", "2", "3"]])[0]!.volUsd).toBe(6);
  });
});

describe("shipped packs", () => {
  it("all compile and trade on a synthetic market", () => {
    const r = skillRegistry(["./skills"]);
    expect(r.errors).toEqual([]);
    const c = syntheticCandles(21, 2500);
    for (const id of ["ft_bb_rsi", "ft_adx_di_trend", "ft_cci_reversal", "ft_ema_volume_momentum", "bt_sma_cross", "bt_close_sma"]) {
      const s = r.skills.find((x) => x.id === id)!;
      expect(s.signal(c, s.defaults).some((x) => x !== 0), id).toBe(true);
    }
  });
});
