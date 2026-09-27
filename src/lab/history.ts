// Historical candles for the strategy lab: fetched from OKX's public history endpoint (paged back in time), cached as
// JSON under the lab folder, or read from a CSV you bring. A seeded synthetic market is available for offline runs
// and tests. Public data only: no key, no account.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Candle } from "../market/types.js";
import { parseCandles } from "../okx/public.js";
import type { OkxPublicRest } from "../okx/rest.js";

export type Bar = "15m" | "1H" | "4H" | "1D";
export const BAR_MS: Record<Bar, number> = { "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000 };

export interface Dataset {
  /** e.g. "BTC-USDT-SWAP 1H" */
  id: string;
  instId: string;
  bar: Bar;
  candles: Candle[];
  source: "okx" | "csv" | "synthetic";
}

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
