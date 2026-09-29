// Historical candles for the strategy lab: fetched from OKX's public history endpoint (paged back in time), cached as
// JSON under the lab folder, or read from a CSV you bring. A seeded synthetic market is available for offline runs
// and tests. Public data only: no key, no account.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Candle } from "../market/types.js";
import { parseCandles } from "../okx/public.js";
import type { OkxPublicRest } from "../okx/rest.js";

export type Bar = "1m" | "5m" | "15m" | "30m" | "1H" | "4H" | "1D";
export const BAR_MS: Record<Bar, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000 };
export const BARS = Object.keys(BAR_MS) as Bar[];

export interface Dataset {
  /** e.g. "BTC-USDT-SWAP 1H" */
  id: string;
  instId: string;
  bar: Bar;
  candles: Candle[];
  source: "okx" | "ccxt" | "alpaca" | "csv" | "synthetic";
}

/** Where a cached history file came from, by its name: "alpaca-SPY" is Alpaca, "binance-BTC-USDT" a CCXT exchange, the rest OKX. */
export const datasetSource = (instId: string): "okx" | "ccxt" | "alpaca" => (instId.startsWith("alpaca-") ? "alpaca" : /^[a-z0-9]+-/.test(instId) ? "ccxt" : "okx");

/** OKX serves at most 100 rows per history page (older than `after`). */
const PAGE = 100;

export async function fetchHistory(rest: OkxPublicRest, instId: string, bar: Bar, days: number, now = Date.now()): Promise<Candle[]> {
  const since = now - days * 86_400_000;
  const byTs = new Map<number, Candle>();
  let after = now + BAR_MS[bar];
  for (let page = 0; page < 2000; page++) {
    const rows = await rest.get<string[][]>("/api/v5/market/history-candles", { instId, bar, after, limit: PAGE }, { ttlMs: 0, demo: false });
    if (!rows.length) break;
    const cs = parseCandles(rows);
    for (const x of cs) if (x.confirmed && x.ts >= since) byTs.set(x.ts, x);
    const oldest = cs[0]!.ts;
    if (oldest <= since || oldest >= after) break;
    after = oldest;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

// ---------- CCXT: public OHLCV from 100+ exchanges (data only; beebots never sends an order through it) ----------

/** The one CCXT method the lab uses, so tests can inject a fake exchange. */
export interface OhlcvExchange {
  fetchOHLCV(symbol: string, timeframe?: string, since?: number, limit?: number): Promise<Array<Array<number | string | undefined>>>;
}

export const CCXT_TIMEFRAME: Record<Bar, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1H": "1h", "4H": "4h", "1D": "1d" };

/** CCXT / Freqtrade rows [ts, open, high, low, close, volume(base)] -> candles (volume in USD ~ base x close). */
export function ohlcvRows(rows: Array<Array<number | string | undefined | null>>): Candle[] {
  return rows
    .map((r) => {
      const [ts, o, h, l, c, v] = r.map((x) => Number(x));
      return { ts: ts!, o: o!, h: h!, l: l!, c: c!, volUsd: Number.isFinite(v) ? v! * c! : 0, confirmed: true };
    })
    .filter((x) => [x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite))
    .sort((a, b) => a.ts - b.ts);
}

/** A CCXT exchange by id ("binance", "bybit", "kraken", ...), with CCXT's own rate limiter on. Public data only. */
export async function ccxtExchange(id: string): Promise<OhlcvExchange> {
  const mod = (await import("ccxt")) as unknown as { default: Record<string, unknown> & { exchanges: string[] } };
  const ccxt = mod.default;
  if (!ccxt.exchanges.includes(id)) throw new Error(`CCXT has no exchange "${id}" (try binance, bybit, okx, kraken, coinbase, ...)`);
  const Cls = ccxt[id] as new (o: object) => OhlcvExchange;
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return new Cls({ enableRateLimit: true, ...(proxy ? { httpsProxy: proxy } : {}) });
}

/** Pages forward from `days` ago with `since`, dropping the candle that has not closed yet. */
export async function fetchHistoryCcxt(ex: OhlcvExchange, symbol: string, bar: Bar, days: number, now = Date.now(), pageLimit = 1000): Promise<Candle[]> {
  const ms = BAR_MS[bar];
  let since = now - days * 86_400_000;
  const byTs = new Map<number, Candle>();
  for (let page = 0; page < 5000; page++) {
    const rows = await ex.fetchOHLCV(symbol, CCXT_TIMEFRAME[bar], since, pageLimit);
    const cs = ohlcvRows(rows);
    if (!cs.length) break;
    for (const x of cs) if (x.ts + ms <= now) byTs.set(x.ts, x);
    const last = cs[cs.length - 1]!.ts;
    if (last + ms >= now || last < since) break;
    since = last + ms;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * Freqtrade's JSON data files (user_data/data/<exchange>/BTC_USDT-1h.json): an array of [ts, o, h, l, c, v] rows.
 * Also accepts { "candles": [...] } (this lab's own cache).
 */
export function parseFreqtradeJson(text: string): Candle[] {
  const j = JSON.parse(text) as unknown;
  if (Array.isArray(j)) return ohlcvRows(j as Array<Array<number>>);
  const c = (j as { candles?: Candle[] }).candles;
  if (Array.isArray(c)) return c;
  throw new Error("JSON is neither Freqtrade OHLCV rows nor a lab cache file");
}

export const cacheFile = (dir: string, instId: string, bar: Bar) => join(dir, `${instId.replace(/[^A-Za-z0-9_-]/g, "_")}_${bar}.json`);

export function readCache(dir: string, instId: string, bar: Bar): Candle[] | null {
  const f = cacheFile(dir, instId, bar);
  if (!existsSync(f)) return null;
  const j = JSON.parse(readFileSync(f, "utf8")) as { candles?: Candle[] };
  return Array.isArray(j.candles) ? j.candles : null;
}

export function writeCache(dir: string, instId: string, bar: Bar, candles: Candle[]): string {
  const f = cacheFile(dir, instId, bar);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ instId, bar, fetchedAt: Date.now(), candles }));
  return f;
}

/** CSV with a header row: ts (ms or ISO), open, high, low, close, and optionally volume (USD). */
export function parseCsv(text: string): Candle[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines
    .shift()!
    .toLowerCase()
    .split(/[,;\t]/)
    .map((h) => h.trim());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iT = col("ts", "time", "timestamp", "date", "datetime", "open_time");
  const iO = col("o", "open");
  const iH = col("h", "high");
  const iL = col("l", "low");
  const iC = col("c", "close");
  const iV = col("volume", "vol", "volusd", "volume_usd", "quote_volume");
  if ([iT, iO, iH, iL, iC].some((i) => i < 0)) throw new Error("CSV needs ts, open, high, low and close columns");
  const out: Candle[] = [];
  for (const line of lines) {
    const f = line.split(/[,;\t]/);
    const rawT = f[iT]!.trim();
    const ts = /^\d+$/.test(rawT) ? Number(rawT) * (rawT.length <= 10 ? 1000 : 1) : Date.parse(rawT);
    const x = { ts, o: +f[iO]!, h: +f[iH]!, l: +f[iL]!, c: +f[iC]!, volUsd: iV >= 0 ? +f[iV]! : 0, confirmed: true };
    if ([x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite)) out.push(x);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * MetaTrader 5 "Export bars" CSV: tab- or comma-separated with <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL>
 * <VOL> <SPREAD> (dates like 2024.01.02, times like 09:30:00; daily files have no <TIME>). Times are the broker
 * server's clock: pass `utcOffsetHours` (server time minus UTC) to store UTC. `spread` is in points (kept per bar so
 * the gold engine can replay the real spread history); `pointSize` converts it to price units (XAUUSD is usually 0.01).
 */
export interface Mt5Bar extends Candle {
  /** Spread in price units, when the export carries it. */
  spread?: number;
}
export function parseMt5Csv(text: string, opts: { utcOffsetHours?: number; pointSize?: number } = {}): Mt5Bar[] {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const sep = lines[0]!.includes("\t") ? "\t" : lines[0]!.includes(";") ? ";" : ",";
  const head = lines.shift()!.split(sep).map((h) => h.replace(/[<>]/g, "").trim().toLowerCase());
  const col = (...n: string[]) => head.findIndex((h) => n.includes(h));
  const iD = col("date");
  const iT = col("time");
  const iO = col("open");
  const iH = col("high");
  const iL = col("low");
  const iC = col("close");
  const iV = col("tickvol", "tick_volume", "volume");
  const iS = col("spread");
  if ([iD, iO, iH, iL, iC].some((i) => i < 0)) throw new Error("MT5 CSV needs <DATE>, <OPEN>, <HIGH>, <LOW> and <CLOSE> columns");
  const off = (opts.utcOffsetHours ?? 0) * 3_600_000;
  const point = opts.pointSize ?? 0.01;
  const out: Mt5Bar[] = [];
  for (const line of lines) {
    const f = line.split(sep);
    const d = f[iD]!.trim().replace(/\./g, "-");
    const t = iT >= 0 ? f[iT]!.trim() : "00:00:00";
    const ts = Date.parse(`${d}T${t.length === 5 ? `${t}:00` : t}Z`) - off;
    const x: Mt5Bar = { ts, o: +f[iO]!, h: +f[iH]!, l: +f[iL]!, c: +f[iC]!, volUsd: iV >= 0 ? +f[iV]! : 0, confirmed: true };
    if (iS >= 0 && Number.isFinite(+f[iS]!)) x.spread = +f[iS]! * point;
    if ([x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite)) out.push(x);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Small seeded PRNG (mulberry32), so a synthetic market is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A regime-switching random walk: trending up, trending down and choppy stretches with volatility clusters. Good for
 * exercising the lab offline; it proves nothing about real markets.
 */
export function syntheticCandles(seed: number, bars: number, barMs = BAR_MS["1H"], startPx = 100, start = Date.UTC(2025, 0, 1)): Candle[] {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const out: Candle[] = [];
  let px = startPx;
  let drift = 0;
  let vol = 0.008;
  let regimeLeft = 0;
  let meanRef = px;
  let mode: "up" | "down" | "chop" = "chop";
  for (let i = 0; i < bars; i++) {
    if (regimeLeft-- <= 0) {
      const u = r();
      mode = u < 0.35 ? "up" : u < 0.6 ? "down" : "chop";
      drift = mode === "up" ? 0.0012 : mode === "down" ? -0.0012 : 0;
      vol = 0.004 + r() * 0.012;
      regimeLeft = 100 + Math.floor(r() * 400);
      meanRef = px;
    }
    const pull = mode === "chop" ? 0.02 * Math.log(meanRef / px) : 0;
    const ret = drift + pull + vol * gauss();
    const o = px;
    const c = Math.max(0.0001, o * Math.exp(ret));
    const wick = Math.abs(vol * gauss()) * o * 0.6;
    out.push({ ts: start + i * barMs, o, h: Math.max(o, c) + wick, l: Math.max(0.00001, Math.min(o, c) - wick), c, volUsd: 1e6 * (1 + r()), confirmed: true });
    px = c;
  }
  return out;
}
