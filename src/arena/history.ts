// Historical market data for the Arena: real OKX candles of the instruments members' agents trade, kept in one shared
// SQLite file (public data, no member's data in it). It feeds two things: a skill's backtest and an agent's simulated
// training. `HistoricalApi` answers like OKX's public API frozen at a moment in the past, so the very same market feed and
// engine that run an agent on paper can be replayed over history without knowing it.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "../log.js";
import { fetchHistory } from "../lab/history.js";
import type { PublicApi } from "../okx/public.js";
import type { OkxPublicRest } from "../okx/rest.js";
import { safeError } from "../redact.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";

export type HBar = "15m" | "1H" | "4H";
export const HBARS: HBar[] = ["15m", "1H", "4H"];
export const HBAR_MS: Record<HBar, number> = { "15m": 900_000, "1H": 3_600_000, "4H": 14_400_000 };
/** How far back each bar size is kept. A 30-day training needs about 50 days of 4-hour bars before it (the trend uses 300) and a week of hourly ones. */
export const KEEP_DAYS: Record<HBar, number> = { "15m": 35, "1H": 70, "4H": 140 };
/** The longest window a backtest or a training may cover. */
export const MAX_WINDOW_DAYS = 30;

const SQL = `
CREATE TABLE IF NOT EXISTS candles (inst_id TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, vol REAL NOT NULL, PRIMARY KEY (inst_id, bar, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS instruments (inst_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface Coverage {
  instId: string;
  coin: string;
  bar: HBar;
  from: number;
  to: number;
  bars: number;
}

export class CandleStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;");
    this.db.exec(SQL);
  }

  /** Stores confirmed candles (a forming one is never kept: it would change). */
  put(instId: string, bar: HBar, candles: Candle[]): number {
    const st = this.db.prepare("INSERT OR REPLACE INTO candles (inst_id, bar, ts, o, h, l, c, vol) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const x of candles) {
        if (!x.confirmed || ![x.o, x.h, x.l, x.c].every((v) => Number.isFinite(v) && v > 0)) continue;
        st.run(instId, bar, x.ts, x.o, x.h, x.l, x.c, Number.isFinite(x.volUsd) ? x.volUsd : 0);
        n++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  /** Bars that opened in [from, to), oldest first. */
  range(instId: string, bar: HBar, from: number, to: number): Candle[] {
    return (this.db.prepare("SELECT ts, o, h, l, c, vol FROM candles WHERE inst_id = ? AND bar = ? AND ts >= ? AND ts < ? ORDER BY ts").all(instId, bar, from, to) as Array<{ ts: number; o: number; h: number; l: number; c: number; vol: number }>).map((r) => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, volUsd: r.vol, confirmed: true }));
  }

  /** The last `limit` bars that had closed by `t` (a bar opened at ts closes at ts + its length), oldest first. */
  closedBy(instId: string, bar: HBar, t: number, limit: number): Candle[] {
    const rows = this.db.prepare("SELECT ts, o, h, l, c, vol FROM candles WHERE inst_id = ? AND bar = ? AND ts <= ? ORDER BY ts DESC LIMIT ?").all(instId, bar, t - HBAR_MS[bar], limit) as Array<{ ts: number; o: number; h: number; l: number; c: number; vol: number }>;
    return rows.reverse().map((r) => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, volUsd: r.vol, confirmed: true }));
  }

  coverage(instId: string, bar: HBar): { from: number; to: number; bars: number } | null {
    const r = this.db.prepare("SELECT MIN(ts) AS a, MAX(ts) AS b, COUNT(*) AS n FROM candles WHERE inst_id = ? AND bar = ?").get(instId, bar) as { a: number | null; b: number | null; n: number };
    return r.n ? { from: r.a!, to: r.b!, bars: r.n } : null;
  }

  setInstruments(list: Instrument[]): void {
    const st = this.db.prepare("INSERT OR REPLACE INTO instruments (inst_id, json) VALUES (?, ?)");
    for (const i of list) st.run(i.instId, JSON.stringify(i));
  }

  instruments(): Instrument[] {
    return (this.db.prepare("SELECT json FROM instruments ORDER BY inst_id").all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Instrument);
  }

  instrumentOf(coin: string): Instrument | undefined {
    return this.instruments().find((i) => i.coin === coin.toUpperCase());
  }

  /** What is stored, per coin and bar size: the page shows it, so a member knows which coins have history. */
  summary(): Coverage[] {
    const out: Coverage[] = [];
    for (const i of this.instruments())
      for (const bar of HBARS) {
        const c = this.coverage(i.instId, bar);
        if (c) out.push({ instId: i.instId, coin: i.coin, bar, ...c });
      }
    return out;
  }

  /** Drops what is older than each bar size keeps. */
  prune(now: number): void {
    for (const bar of HBARS) this.db.prepare("DELETE FROM candles WHERE bar = ? AND ts < ?").run(bar, now - KEEP_DAYS[bar] * 86_400_000 - HBAR_MS[bar]);
  }

  get lastSyncAt(): number {
    return Number((this.db.prepare("SELECT v FROM meta WHERE k = 'synced_at'").get() as { v: string } | undefined)?.v ?? 0);
  }

  markSynced(at: number): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('synced_at', ?)").run(String(at));
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Brings the store up to date for some coins: the live instrument list (sizes and ticks, so paper fills round like OKX's), and
 * every bar size back to what it keeps. Only the missing part is fetched. A coin that fails is skipped and tried next time.
 */
export async function syncHistory(store: CandleStore, deps: { rest: OkxPublicRest; instruments: () => Promise<Instrument[]> }, coins: readonly string[], now = Date.now()): Promise<{ fetched: number; failed: string[] }> {
  const live = await deps.instruments();
  const want = live.filter((i) => coins.includes(i.coin) && i.state === "live");
  store.setInstruments(want);
  let fetched = 0;
  const failed: string[] = [];
  for (const i of want) {
    for (const bar of HBARS) {
      try {
        const cov = store.coverage(i.instId, bar);
        const full = KEEP_DAYS[bar];
        // a gap at the old end is not refilled; the newer end is followed from the last stored bar
        const days = cov && cov.from <= now - (full - 1) * 86_400_000 ? Math.min(full, Math.ceil((now - cov.to) / 86_400_000) + 1) : full;
        fetched += store.put(i.instId, bar, await fetchHistory(deps.rest, i.instId, bar, days, now));
      } catch (e) {
        failed.push(`${i.coin} ${bar}`);
        log.warn("arena: history sync failed", { instId: i.instId, bar, error: safeError(e).message });
      }
    }
  }
  store.prune(now);
  store.markSynced(now);
  return { fetched, failed };
}

/** Paper fills on replayed history assume this spread around the last price (a liquid X-Perp's is usually 1 to 3 basis points). */
export const REPLAY_SPREAD_BP = 2;

/**
 * OKX's public API as it looked at `clock()`: candles that had closed by then, a ticker made from the last closed 15-minute
 * bar, no funding or open interest (history of those is not stored, and the page says so). Nothing after the clock is visible.
 */
export class HistoricalApi implements PublicApi {
  constructor(
    private readonly store: CandleStore,
    private readonly clock: () => number,
    private readonly only?: readonly string[],
  ) {}

  private list(): Instrument[] {
    const all = this.store.instruments();
    return this.only ? all.filter((i) => this.only!.includes(i.coin)) : all;
  }

  async instruments(): Promise<Instrument[]> {
    return this.list();
  }

  async tickers(): Promise<Map<string, Ticker>> {
    const t = this.clock();
    const out = new Map<string, Ticker>();
    for (const i of this.list()) {
      const last15 = this.store.closedBy(i.instId, "15m", t, 1)[0];
      if (!last15) continue;
      const day = this.store.closedBy(i.instId, "1H", t, 24);
      const last = last15.c;
      const half = (last * REPLAY_SPREAD_BP) / 20_000;
      out.set(i.instId, { instId: i.instId, last, bid: last - half, ask: last + half, mid: last, spreadBp: REPLAY_SPREAD_BP, vol24hUsd: day.reduce((s, x) => s + x.volUsd, 0), open24h: day[0]?.o ?? last, ts: t });
    }
    return out;
  }

  async candles(instId: string, bar: "1m" | "15m" | "1H" | "4H" | "1Dutc", limit: number): Promise<Candle[]> {
    if (bar === "1m" || bar === "1Dutc") return []; // not stored: the scalper and the daily trend do not train
    return this.store.closedBy(instId, bar, this.clock(), limit);
  }

  async openInterest(): Promise<Map<string, number>> {
    return new Map();
  }

  async funding(): Promise<FundingNow> {
    throw new Error("no funding history");
  }

  async fundingHistory(): Promise<number[]> {
    return [];
  }
}
