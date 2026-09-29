import { describe, expect, it, vi } from "vitest";
import { ALPACA_SYMBOL, alpacaCacheName, alpacaRows, AlpacaError, checkAlpacaKey, fetchAlpaca } from "../src/lab/alpaca.js";
import { datasetSource } from "../src/lab/history.js";
import { barsPerYear } from "../src/lab/series.js";
import type { Candle } from "../src/market/types.js";

const CREDS = { keyId: "PKTESTKEY123456", secret: "secret-abcdefghijklmnopqrstuvwxyz", feed: "iex" as const };
const NOW = Date.UTC(2026, 8, 29, 20, 0, 0);
const bar = (t: string, c = 100) => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1000, vw: c });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const seq = (...rs: Response[]) => vi.fn(async (..._a: unknown[]) => rs.shift() ?? json({ message: "no more replies" }, 500));
const url = (f: ReturnType<typeof seq>, i = 0) => new URL(String((f.mock.calls[i] as unknown[])[0]));
const hdr = (f: ReturnType<typeof seq>) => ((f.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> }).headers;

describe("alpaca history", () => {
  it("asks the stock bars endpoint with adjusted prices, the chosen feed and the key pair in headers", async () => {
    const f = seq(json({ bars: { SPY: [bar("2026-09-28T13:30:00Z", 500)] }, next_page_token: null }));
    const c = await fetchAlpaca(CREDS, "spy", "1H", 30, NOW, f as never);
    expect(c).toHaveLength(1);
    const u = url(f);
    expect(u.pathname).toBe("/v2/stocks/bars");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ symbols: "SPY", timeframe: "1Hour", adjustment: "all", feed: "iex", limit: "10000", sort: "asc" });
    expect(new Date(u.searchParams.get("start")!).getTime()).toBe(NOW - 30 * 86_400_000);
    expect(new Date(u.searchParams.get("end")!).getTime()).toBe(NOW);
    expect(hdr(f)).toMatchObject({ "APCA-API-KEY-ID": CREDS.keyId, "APCA-API-SECRET-KEY": CREDS.secret });
  });

  it("pages with next_page_token, sorts, dedupes, and leaves out the bar that has not closed", async () => {
    const f = seq(
      json({ bars: { SPY: [bar("2026-09-28T14:30:00Z", 2), bar("2026-09-28T13:30:00Z", 1)] }, next_page_token: "abc" }),
      json({ bars: { SPY: [bar("2026-09-28T14:30:00Z", 2), bar("2026-09-29T19:30:00Z", 3), bar("2026-09-29T19:59:00Z", 4)] }, next_page_token: null }),
    );
    const c = await fetchAlpaca(CREDS, "SPY", "1H", 30, NOW, f as never);
    // 19:30 and 19:59 open hour bars that close after NOW (20:00): both are still forming and are dropped.
    expect(c.map((x) => x.c)).toEqual([1, 2]);
    expect(url(f, 1).searchParams.get("page_token")).toBe("abc");
  });

  it("drops a bar whose hour is still open", async () => {
    const f = seq(json({ bars: { SPY: [bar("2026-09-29T18:00:00Z", 1), bar("2026-09-29T19:00:00Z", 2), bar("2026-09-29T19:30:00Z", 3)] } }));
    expect((await fetchAlpaca(CREDS, "SPY", "1H", 3, NOW, f as never)).map((x) => x.c)).toEqual([1, 2]);
  });

  it("uses the crypto endpoint for a pair, with no stock-only parameters", async () => {
    const f = seq(json({ bars: { "BTC/USD": [bar("2026-09-28T00:00:00Z", 60000)] } }));
    const c = await fetchAlpaca(CREDS, "btc/usd", "1D", 10, NOW, f as never);
    expect(c[0]!.c).toBe(60000);
    const u = url(f);
    expect(u.pathname).toBe("/v1beta3/crypto/us/bars");
    expect(u.searchParams.get("symbols")).toBe("BTC/USD");
    expect(u.searchParams.has("feed")).toBe(false);
    expect(u.searchParams.has("adjustment")).toBe(false);
  });

  it("keeps the SIP feed away from the newest 15 minutes", async () => {
    const f = seq(json({ bars: { SPY: [] } }));
    await fetchAlpaca({ ...CREDS, feed: "sip" }, "SPY", "1H", 5, NOW, f as never);
    expect(url(f).searchParams.get("feed")).toBe("sip");
    expect(new Date(url(f).searchParams.get("end")!).getTime()).toBe(NOW - 16 * 60_000);
  });

  it("waits and retries when rate limited, then gives up with Alpaca's own message", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    const ok = seq(json({ message: "slow down" }, 429), json({ bars: { SPY: [bar("2026-09-28T13:30:00Z")] } }));
    expect(await fetchAlpaca(CREDS, "SPY", "1H", 5, NOW, ok as never, wait)).toHaveLength(1);
    expect(waits).toEqual([1500]);
    const bad = seq(json({ message: "forbidden" }, 403));
    await expect(fetchAlpaca(CREDS, "SPY", "1H", 5, NOW, bad as never, wait)).rejects.toMatchObject({ status: 403, message: "HTTP 403: forbidden" });
    const bad2 = seq(json({ message: "invalid symbol" }, 422));
    await expect(fetchAlpaca(CREDS, "SPY", "1H", 5, NOW, bad2 as never, wait)).rejects.toBeInstanceOf(AlpacaError);
  });

  it("refuses a symbol that is not a ticker before it sends anything", async () => {
    const f = seq();
    await expect(fetchAlpaca(CREDS, "SPY&feed=sip", "1H", 5, NOW, f as never)).rejects.toThrow(/does not look like a ticker/);
    expect(f).not.toHaveBeenCalled();
    for (const ok of ["SPY", "BRK.B", "BTC/USD", "A"]) expect(ALPACA_SYMBOL.test(ok)).toBe(true);
    for (const bad of ["spy", "SPY,QQQ", "../x", "TOOLONGSYMBOL", ""]) expect(ALPACA_SYMBOL.test(bad)).toBe(false);
  });

  it("turns bars into candles with a USD volume, and names the cache so the lab knows the source", () => {
    const [c] = alpacaRows([{ t: "2026-09-28T13:30:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 200, vw: 1.25 }]);
    expect(c).toEqual({ ts: Date.parse("2026-09-28T13:30:00Z"), o: 1, h: 2, l: 0.5, c: 1.5, volUsd: 250, confirmed: true });
    expect(alpacaRows([{ t: "garbage", o: 1, h: 1, l: 1, c: 1, v: 1 }])).toEqual([]);
    expect(alpacaCacheName("SPY")).toBe("alpaca-SPY");
    expect(alpacaCacheName("BTC/USD")).toBe("alpaca-BTC-USD");
    expect(datasetSource("alpaca-SPY")).toBe("alpaca");
    expect(datasetSource("alpaca-BTC-USD")).toBe("alpaca");
    expect(datasetSource("binance-BTC-USDT")).toBe("ccxt");
    expect(datasetSource("BTC-USDT-SWAP")).toBe("okx");
  });
});

describe("alpaca key check", () => {
  const check = (r: Response, feed: "iex" | "sip" = "iex") => checkAlpacaKey({ ...CREDS, feed }, seq(r) as never);
  it("passes a good key and explains the usual failures", async () => {
    expect(await check(json({ bars: {} }))).toBeNull();
    expect(await check(json({ message: "unauthorized" }, 401))).toMatch(/rejected that key pair/);
    expect(await check(json({ message: "subscription does not permit querying recent SIP data" }, 403), "sip")).toMatch(/plan does not include the sip feed/);
    expect(await check(json({ message: "nope" }, 403))).toMatch(/refused the request: nope/);
    expect(await check(json({}, 500))).toMatch(/HTTP 500/);
    expect(await checkAlpacaKey(CREDS, (async () => Promise.reject(new Error("offline"))) as never)).toMatch(/Could not reach Alpaca \(offline\)/);
  });
});

describe("annualising a market with sessions", () => {
  const hourly = (n: number, gapEvery = 0): Candle[] => {
    const out: Candle[] = [];
    let ts = Date.UTC(2025, 0, 1);
    for (let i = 0; i < n; i++) {
      out.push({ ts, o: 1, h: 1, l: 1, c: 1, volUsd: 0, confirmed: true });
      ts += 3_600_000 * (gapEvery && (i + 1) % gapEvery === 0 ? 17 : 1);
    }
    return out;
  };
  it("agrees with the median gap on complete 24/7 data", () => {
    expect(barsPerYear(hourly(300))).toBeCloseTo(365 * 24, 5);
  });
  it("counts far fewer bars a year when there are overnight gaps (7 bars, then 17 hours off)", () => {
    const stock = barsPerYear(hourly(700, 7));
    // 7 bars per 23 hours -> about 2,666 a year, not 8,760.
    expect(Math.abs(stock - (7 * 365 * 24) / 23)).toBeLessThan(40);
    expect(stock).toBeLessThan(365 * 24 * 0.4);
  });
  it("still works on a short series", () => {
    expect(barsPerYear(hourly(10))).toBeCloseTo(365 * 24, 5);
    expect(barsPerYear(hourly(2))).toBe(365 * 24);
  });
});
