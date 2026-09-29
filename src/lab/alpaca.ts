// Alpaca (alpaca.markets) as a source of history for the lab: US stocks, ETFs and crypto candles from the Market Data API.
// DATA ONLY. This file reads bars; beebots never sends Alpaca an order, and the keys should be Alpaca paper keys (or any
// keys that only see data): a key that can trade is more power than the lab needs.
//
// Notes the numbers depend on:
//  - The free plan serves the IEX feed: prices from one exchange (a few percent of US volume). Fine for testing skills on
//    daily and hourly bars; thin for scalping. "sip" (all exchanges) needs a paid plan, and its newest 15 minutes are off limits.
//  - Prices are adjusted for splits and dividends (adjustment=all), so an old bar and a new one are comparable.
//  - Stocks trade in sessions: there are no bars overnight or on weekends. The lab annualises by real bar density (series.ts).
import type { Candle } from "../market/types.js";
import { BAR_MS, type Bar } from "./history.js";

export const ALPACA_DATA_URL = "https://data.alpaca.markets";
export type AlpacaFeed = "iex" | "sip";

export interface AlpacaCreds {
  keyId: string;
  secret: string;
  feed?: AlpacaFeed;
  baseUrl?: string;
}

export const ALPACA_TIMEFRAME: Record<Bar, string> = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "1H": "1Hour", "4H": "4Hour", "1D": "1Day" };

/** What `pnpm lab fetch --source alpaca` downloads when no symbols are given: broad US equity, gold and oil ETFs, and three big stocks. */
export const ALPACA_DEFAULT_SYMBOLS = ["SPY", "QQQ", "GLD", "USO", "NVDA", "AAPL"];

/** A ticker like SPY or BRK.B, or a crypto pair like BTC/USD. */
export const ALPACA_SYMBOL = /^[A-Z0-9]{1,8}(\.[A-Z])?(\/[A-Z]{2,5})?$/;

export class AlpacaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AlpacaError";
  }
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

/** Alpaca bars -> candles (volume in USD: shares x the bar's volume-weighted price). `t` is the bar's OPEN time. */
export function alpacaRows(rows: RawBar[]): Candle[] {
  return rows
    .map((r) => ({ ts: Date.parse(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), volUsd: Number(r.v) * Number(r.vw ?? r.c) || 0, confirmed: true }))
    .filter((x) => [x.ts, x.o, x.h, x.l, x.c].every(Number.isFinite))
    .sort((a, b) => a.ts - b.ts);
}

/** The cache name for a symbol: "alpaca-SPY", "alpaca-BTC-USD". The prefix is how the lab knows where a file came from. */
export const alpacaCacheName = (symbol: string): string => `alpaca-${symbol.replace("/", "-")}`;

const isCrypto = (symbol: string) => symbol.includes("/");
const headers = (c: AlpacaCreds) => ({ "APCA-API-KEY-ID": c.keyId, "APCA-API-SECRET-KEY": c.secret, accept: "application/json" });

async function fail(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { message?: string };
    if (j.message) msg += `: ${String(j.message).slice(0, 200)}`;
  } catch {
    /* not JSON */
  }
  throw new AlpacaError(res.status, msg);
}

type Fetch = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, c: AlpacaCreds, f: Fetch, wait: (ms: number) => Promise<unknown>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { headers: headers(c), signal: AbortSignal.timeout(30_000) });
    if (res.status !== 429 || attempt >= 4) return res;
    await wait(1500 * (attempt + 1));
  }
}

/**
 * Candles for one symbol over the last `days`, oldest first, the bar that has not closed yet left out. Pages through the
 * API's next_page_token. Throws AlpacaError with Alpaca's own message (a bad key, an unknown symbol, a feed the plan lacks).
 */
export async function fetchAlpaca(c: AlpacaCreds, symbol: string, bar: Bar, days: number, now = Date.now(), f: Fetch = fetch, wait: (ms: number) => Promise<unknown> = sleep): Promise<Candle[]> {
  const sym = symbol.trim().toUpperCase();
  if (!ALPACA_SYMBOL.test(sym)) throw new AlpacaError(400, `"${symbol}" does not look like a ticker or a pair like BTC/USD`);
  const base = (c.baseUrl ?? ALPACA_DATA_URL).replace(/\/+$/, "");
  const feed = c.feed ?? "iex";
  const crypto = isCrypto(sym);
  const ms = BAR_MS[bar];
  // The SIP feed refuses the newest 15 minutes on a plan without real-time SIP.
  const end = feed === "sip" && !crypto ? now - 16 * 60_000 : now;
  const byTs = new Map<number, Candle>();
  let token: string | undefined;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ symbols: sym, timeframe: ALPACA_TIMEFRAME[bar], start: new Date(now - days * 86_400_000).toISOString(), end: new Date(end).toISOString(), limit: "10000", sort: "asc" });
    if (!crypto) {
      q.set("adjustment", "all");
      q.set("feed", feed);
    }
    if (token) q.set("page_token", token);
    const res = await get(`${base}${crypto ? "/v1beta3/crypto/us/bars" : "/v2/stocks/bars"}?${q}`, c, f, wait);
    if (!res.ok) await fail(res);
    const j = (await res.json()) as { bars?: Record<string, RawBar[]> | null; next_page_token?: string | null };
    for (const x of alpacaRows(j.bars?.[sym] ?? [])) if (x.ts + ms <= now) byTs.set(x.ts, x);
    token = j.next_page_token ?? undefined;
    if (!token) break;
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** One tiny authenticated read: proves the key pair works and that the plan serves the chosen feed. An error message, or null. */
export async function checkAlpacaKey(c: AlpacaCreds, f: Fetch = fetch): Promise<string | null> {
  const base = (c.baseUrl ?? ALPACA_DATA_URL).replace(/\/+$/, "");
  try {
    const res = await f(`${base}/v2/stocks/bars/latest?${new URLSearchParams({ symbols: "SPY", feed: c.feed ?? "iex" })}`, { headers: headers(c), signal: AbortSignal.timeout(15_000) });
    if (res.ok) return null;
    let msg = "";
    try {
      msg = String(((await res.json()) as { message?: string }).message ?? "");
    } catch {
      /* not JSON */
    }
    if (res.status === 401) return "Alpaca rejected that key pair. Copy the key ID and the secret again from the Alpaca dashboard (use paper keys).";
    if (res.status === 403) return /subscription|feed|sip/i.test(msg) ? `Your Alpaca plan does not include the ${c.feed ?? "iex"} feed. Use iex (free), or a plan with SIP.` : `Alpaca refused the request${msg ? `: ${msg.slice(0, 160)}` : ""}.`;
    return `Alpaca answered HTTP ${res.status}${msg ? `: ${msg.slice(0, 160)}` : ""}.`;
  } catch (err) {
    return `Could not reach Alpaca (${(err as Error).message}).`;
  }
}
