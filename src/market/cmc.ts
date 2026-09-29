// CoinMarketCap: market-wide context the exchange feed does not have. Read-only, optional (COINMARKETCAP_API_KEY).
//
// Every CMC_REFRESH_MIN minutes (default 15) it fetches, from CMC's documented Pro API:
//   - /v1/cryptocurrency/listings/latest (top CMC_TOP coins): rank, market cap, all-exchange 24h volume, 1h..30d moves;
//   - /v1/global-metrics/quotes/latest: total market cap and its 24h change, BTC and ETH dominance;
//   - /v3/fear-and-greed/latest: CMC's Fear & Greed index.
// Three calls per refresh, each ~1 credit (the free Basic plan has 10,000 a month); CMC_MAX_CALLS_DAY is a hard cap.
// Slower context, every CMC_SLOW_MIN minutes (default 120; three more credits): /v1/altcoin-season-index/latest (bitcoin or altcoin
// season), /v3/fear-and-greed/historical (the mood's last week, so a trend and not one number) and
// /v1/cryptocurrency/categories (which sectors lead and lag today).
// What it feeds: a compact `mkt` line in Jev's state (CMC_IN_JEV), CMC facts on each coin the brains weigh for
// watchlists, a market-mood line for councils and the coach, and the dashboard's system bar. It never places orders,
// and a CMC outage only removes the extra context: trading goes on with the exchange feed alone.
// The key goes only in CMC's X-CMC_PRO_API_KEY header: never in a URL, a log or the dashboard.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";
import { safeError } from "../redact.js";

export const CMC_BASE = "https://pro-api.coinmarketcap.com";

export interface CmcCoin {
  symbol: string;
  rank: number;
  mcapUsd: number | null;
  /** 24h volume across every exchange CMC tracks (the exchange feed only knows OKX's). */
  vol24hUsd: number | null;
  pct1h: number | null;
  pct24h: number | null;
  pct7d: number | null;
  pct30d: number | null;
}

export interface CmcGlobal {
  totalMcapUsd: number | null;
  mcapChange24hPct: number | null;
  totalVol24hUsd: number | null;
  btcDominancePct: number | null;
  ethDominancePct: number | null;
}

export interface CmcFearGreed {
  value: number;
  label: string;
}

/** CMC's Altcoin Season Index: 0..100, high = altcoins beating bitcoin (75+ is "altcoin season", 25- "bitcoin season"). */
export interface CmcAltSeason {
  index: number;
  yearlyHigh: number | null;
  yearlyLow: number | null;
}

/** Fear & Greed over the last days, oldest first, and its move over that span. */
export interface CmcFearTrend {
  days: Array<{ ts: number; value: number }>;
  change: number;
}

export interface CmcSector {
  name: string;
  mcapChange24hPct: number;
  avgPriceChangePct: number | null;
  mcapUsd: number;
  tokens: number;
}

export interface CmcState {
  updatedAt: number;
  global: CmcGlobal | null;
  fearGreed: CmcFearGreed | null;
  coins: Map<string, CmcCoin>;
  altSeason?: CmcAltSeason | null;
  fearTrend?: CmcFearTrend | null;
  /** Sectors leading (hot) and lagging (cold) over 24h, by market-cap change. */
  sectors?: { hot: CmcSector[]; cold: CmcSector[] } | null;
  /** When the slow context above was last fetched. */
  slowAt?: number;
}

export interface CmcOpts {
  apiKey: string;
  baseUrl?: string;
  top?: number;
  refreshMin?: number;
  maxCallsDay?: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Minutes between fetches of the slow context (altcoin season, the mood's week, sectors). Default 120. */
  slowEveryMin?: number;
  /** Called after each refresh that got anything (index.ts saves the mood for the lab's CLI council). */
  onUpdate?: (s: CmcState) => void;
}

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class CmcSource {
  private state: CmcState | null = null;
  private calls = 0;
  private day = "";
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly f: typeof fetch;
  private readonly now: () => number;

  constructor(private o: CmcOpts) {
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** What the last good refresh found, or null when there is none or it is over 2 hours old. */
  get(): CmcState | null {
    return this.state && this.now() - this.state.updatedAt < 2 * 3_600_000 ? this.state : null;
  }

  status() {
    return { ok: !!this.get(), updatedAt: this.state?.updatedAt ?? null, callsToday: this.calls, maxCallsDay: this.o.maxCallsDay ?? 300, error: this.lastError };
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), Math.max(5, this.o.refreshMin ?? 15) * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private budget(): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.day) {
      this.day = d;
      this.calls = 0;
    }
    if (this.calls >= (this.o.maxCallsDay ?? 300)) return false;
    this.calls++;
    return true;
  }

  private async get_(path: string): Promise<Json> {
    if (!this.budget()) throw new Error("daily CoinMarketCap call budget used up (CMC_MAX_CALLS_DAY)");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 10_000);
    try {
      const r = await this.f(`${(this.o.baseUrl ?? CMC_BASE).replace(/\/+$/, "")}${path}`, {
        headers: { "X-CMC_PRO_API_KEY": this.o.apiKey, accept: "application/json" },
        signal: ctl.signal,
      });
      const body = (await r.json().catch(() => ({}))) as Json;
      const st = (body.status ?? {}) as Json;
      if (!r.ok || (typeof st.error_code === "number" && st.error_code !== 0)) {
        throw new Error(`CoinMarketCap ${r.status}${st.error_message ? `: ${String(st.error_message).slice(0, 160)}` : ""}`);
      }
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  /** One refresh. Each part fails on its own; the last good value of a failed part is kept. */
  async refresh(): Promise<CmcState | null> {
    const prev = this.state;
    const next: CmcState = {
      updatedAt: this.now(),
      global: prev?.global ?? null,
      fearGreed: prev?.fearGreed ?? null,
      coins: prev?.coins ?? new Map(),
      altSeason: prev?.altSeason ?? null,
      fearTrend: prev?.fearTrend ?? null,
      sectors: prev?.sectors ?? null,
      slowAt: prev?.slowAt ?? 0,
    };
    let any = false;
    const errors: string[] = [];
    try {
      next.coins = parseListings(await this.get_(`/v1/cryptocurrency/listings/latest?start=1&limit=${Math.min(5000, Math.max(1, this.o.top ?? 200))}&convert=USD`));
      any = true;
    } catch (err) {
      errors.push(`listings: ${safeError(err).message}`);
    }
    try {
      next.global = parseGlobal(await this.get_("/v1/global-metrics/quotes/latest?convert=USD"));
      any = true;
    } catch (err) {
      errors.push(`global: ${safeError(err).message}`);
    }
    try {
      next.fearGreed = parseFearGreed(await this.get_("/v3/fear-and-greed/latest"));
      any = true;
    } catch (err) {
      errors.push(`fear&greed: ${safeError(err).message}`);
    }
    if (this.now() - (next.slowAt ?? 0) >= Math.max(15, this.o.slowEveryMin ?? 120) * 60_000) {
      next.slowAt = this.now();
      try {
        next.altSeason = parseAltSeason(await this.get_("/v1/altcoin-season-index/latest"));
      } catch (err) {
        errors.push(`altcoin season: ${safeError(err).message}`);
      }
      try {
        next.fearTrend = parseFearTrend(await this.get_("/v3/fear-and-greed/historical?limit=8"));
      } catch (err) {
        errors.push(`fear&greed history: ${safeError(err).message}`);
      }
      try {
        next.sectors = parseSectors(await this.get_("/v1/cryptocurrency/categories?limit=500"));
      } catch (err) {
        errors.push(`sectors: ${safeError(err).message}`);
      }
    }
    this.lastError = errors.length ? errors.join("; ").slice(0, 400) : null;
    if (errors.length) log.warn("coinmarketcap refresh incomplete", { errors: this.lastError });
    if (any) {
      this.state = next;
      try {
        this.o.onUpdate?.(next);
      } catch (err) {
        log.warn("coinmarketcap: onUpdate failed", { err: safeError(err) });
      }
    }
    return this.get();
  }
}

export function parseListings(body: Json): Map<string, CmcCoin> {
  const out = new Map<string, CmcCoin>();
  for (const c of (Array.isArray(body.data) ? body.data : []) as Json[]) {
    const symbol = String(c.symbol ?? "").toUpperCase();
    const rank = num(c.cmc_rank);
    if (!symbol || rank === null || out.has(symbol)) continue; // the first (best-ranked) coin keeps a shared ticker
    const q = ((c.quote as Json | undefined)?.USD ?? {}) as Json;
    out.set(symbol, {
      symbol,
      rank,
      mcapUsd: num(q.market_cap),
      vol24hUsd: num(q.volume_24h),
      pct1h: num(q.percent_change_1h),
      pct24h: num(q.percent_change_24h),
      pct7d: num(q.percent_change_7d),
      pct30d: num(q.percent_change_30d),
    });
  }
  return out;
}

export function parseGlobal(body: Json): CmcGlobal {
  const d = (body.data ?? {}) as Json;
  const q = ((d.quote as Json | undefined)?.USD ?? {}) as Json;
  return {
    totalMcapUsd: num(q.total_market_cap),
    mcapChange24hPct: num(q.total_market_cap_yesterday_percentage_change),
    totalVol24hUsd: num(q.total_volume_24h),
    btcDominancePct: num(d.btc_dominance),
    ethDominancePct: num(d.eth_dominance),
  };
}

export function parseFearGreed(body: Json): CmcFearGreed | null {
  const d = (body.data ?? {}) as Json;
  const value = num(d.value);
  return value === null ? null : { value, label: String(d.value_classification ?? "") };
}

export function parseAltSeason(body: Json): CmcAltSeason | null {
  const d = (body.data ?? {}) as Json;
  const index = num(d.altcoin_index);
  return index === null ? null : { index, yearlyHigh: num(d.yearly_high), yearlyLow: num(d.yearly_low) };
}

export function parseFearTrend(body: Json): CmcFearTrend | null {
  const days = ((Array.isArray(body.data) ? body.data : []) as Json[])
    .map((d) => ({ ts: Number(d.timestamp) * 1000, value: num(d.value) }))
    .filter((d): d is { ts: number; value: number } => Number.isFinite(d.ts) && d.value !== null)
    .sort((a, b) => a.ts - b.ts);
  if (days.length < 2) return null;
  return { days, change: days[days.length - 1]!.value - days[0]!.value };
}

/** Investor portfolios, launchpads and chain ecosystems are CMC categories too, but not sectors a trader rotates between. */
const NOT_A_SECTOR = /portfolio|capital|ventures|holdings|ecosystem|launchpad|\bido\b|binance alpha|alameda|a16z|coinbase|made in/i;

export function parseSectors(body: Json, n = 5): { hot: CmcSector[]; cold: CmcSector[] } | null {
  const all = ((Array.isArray(body.data) ? body.data : []) as Json[])
    .map((c) => ({
      name: String(c.name ?? "").trim(),
      mcapChange24hPct: num(c.market_cap_change),
      avgPriceChangePct: num(c.avg_price_change),
      mcapUsd: num(c.market_cap) ?? 0,
      tokens: num(c.num_tokens) ?? 0,
    }))
    .filter((c): c is CmcSector => !!c.name && c.mcapChange24hPct !== null && c.mcapUsd >= 3e9 && c.tokens >= 5 && !NOT_A_SECTOR.test(c.name))
    .sort((a, b) => b.mcapChange24hPct - a.mcapChange24hPct);
  if (all.length < 2 * n) return null;
  return { hot: all.slice(0, n), cold: all.slice(-n).reverse() };
}

/** Words for the Altcoin Season Index, as CMC uses them. */
export function altSeasonLabel(index: number): string {
  return index >= 75 ? "altcoin season" : index <= 25 ? "bitcoin season" : index >= 50 ? "leaning altcoins" : "leaning bitcoin";
}

const r = (x: number | null, dp = 1) => (x === null ? null : Number(x.toFixed(dp)));

/** One sentence telling Jev what `mkt` is (added to its instructions when the line is present). */
export const CMC_NOTE =
  "`mkt` is the whole crypto market from CoinMarketCap: fear_greed (0 extreme fear .. 100 extreme greed), btc_dom_pct (Bitcoin's share of the market cap) and mcap_24h_pct (total market cap change over 24h). " +
  "alt_season (when present) is CoinMarketCap's Altcoin Season Index (0..100: 75+ altcoins beat bitcoin, 25- bitcoin leads), fg_7d is Fear & Greed's move over the last week, and hot_sectors are today's leading sectors. " +
  "Use it as background: a hostile market argues for smaller or fewer new longs, a strong one for patience with winners. It never overrides the menu or the coin data.";

/** The compact market line Jev sees (a few tokens): Fear & Greed, BTC dominance, total market cap 24h move. */
export function jevMarketLine(s: CmcState | null): Record<string, number | string | null> | null {
  if (!s || (!s.global && !s.fearGreed)) return null;
  return {
    fear_greed: s.fearGreed ? r(s.fearGreed.value, 0) : null,
    btc_dom_pct: r(s.global?.btcDominancePct ?? null),
    mcap_24h_pct: r(s.global?.mcapChange24hPct ?? null, 2),
    ...(s.altSeason ? { alt_season: r(s.altSeason.index, 0) } : {}),
    ...(s.fearTrend ? { fg_7d: r(s.fearTrend.change, 0) } : {}),
    ...(s.sectors ? { hot_sectors: s.sectors.hot.slice(0, 3).map((x) => x.name).join(", ") } : {}),
  };
}

/** The market mood the brains (councils, coach) read, in words and numbers. */
export function marketMood(s: CmcState | null): Record<string, unknown> | null {
  if (!s || (!s.global && !s.fearGreed)) return null;
  return {
    source: "CoinMarketCap",
    fearGreed: s.fearGreed ? `${s.fearGreed.value} (${s.fearGreed.label})` : null,
    btcDominancePct: r(s.global?.btcDominancePct ?? null),
    ethDominancePct: r(s.global?.ethDominancePct ?? null),
    totalMcapTusd: s.global?.totalMcapUsd ? r(s.global.totalMcapUsd / 1e12, 2) : null,
    totalMcapChange24hPct: r(s.global?.mcapChange24hPct ?? null, 2),
    ...(s.altSeason ? { altcoinSeason: `${r(s.altSeason.index, 0)}/100 (${altSeasonLabel(s.altSeason.index)})` } : {}),
    ...(s.fearTrend ? { fearGreedWeek: `${s.fearTrend.days.map((d) => d.value).join(" → ")} (${s.fearTrend.change >= 0 ? "+" : ""}${s.fearTrend.change} in ${s.fearTrend.days.length - 1} days)` } : {}),
    ...(s.sectors
      ? {
          leadingSectors24h: s.sectors.hot.map((x) => `${x.name} ${x.mcapChange24hPct >= 0 ? "+" : ""}${r(x.mcapChange24hPct)}%`),
          laggingSectors24h: s.sectors.cold.map((x) => `${x.name} ${r(x.mcapChange24hPct)}%`),
        }
      : {}),
    asOf: new Date(s.updatedAt).toISOString(),
  };
}

/** Where the latest mood is kept for the lab's CLI council (a separate process): <LAB_DIR>/cmc-mood.json. */
export const moodPath = (labDir: string) => join(labDir, "cmc-mood.json");

export function saveMood(labDir: string, s: CmcState): void {
  mkdirSync(labDir, { recursive: true });
  writeFileSync(moodPath(labDir), JSON.stringify(marketMood(s)));
}

/** The saved mood, when under 2 hours old. */
export function loadMood(labDir: string, now = Date.now()): Record<string, unknown> | null {
  try {
    const m = JSON.parse(readFileSync(moodPath(labDir), "utf8")) as Record<string, unknown> | null;
    return m && typeof m.asOf === "string" && now - Date.parse(m.asOf) < 2 * 3_600_000 ? m : null;
  } catch {
    return null;
  }
}

/** Free check that a key works (/v1/key/info costs no credits). Returns null when fine, else a readable reason. */
export async function checkCmcKey(apiKey: string, f: typeof fetch = fetch, baseUrl = CMC_BASE): Promise<string | null> {
  try {
    const r = await f(`${baseUrl.replace(/\/+$/, "")}/v1/key/info`, { headers: { "X-CMC_PRO_API_KEY": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (r.ok) return null;
    const body = (await r.json().catch(() => ({}))) as Json;
    const msg = String(((body.status ?? {}) as Json).error_message ?? "");
    return `CoinMarketCap refused the key (${r.status}${msg ? `: ${msg.slice(0, 120)}` : ""}).`;
  } catch (err) {
    return `CoinMarketCap could not be reached: ${safeError(err).message}`;
  }
}
