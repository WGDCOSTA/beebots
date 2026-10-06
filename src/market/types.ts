import type { Kind } from "./kinds.js";

export interface Instrument {
  instId: string;
  coin: string;
  kind: Kind;
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
  state: string;
}

export interface Ticker {
  instId: string;
  last: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBp: number;
  vol24hUsd: number;
  open24h: number;
  ts: number;
}

/** Oldest first. `volUsd` is quote volume in USD. */
export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volUsd: number;
  confirmed: boolean;
}

export interface FundingNow {
  rate: number;
  nextFundingTime: number;
}

/** Everything the snapshot builder and risk layer may know about one coin. Numbers only. */
export interface CoinStats {
  instId: string;
  coin: string;
  last: number;
  mid: number;
  bid: number;
  ask: number;
  spreadBp: number;
  vol24hUsd: number;
  // 15m bars
  rsi14: number | null;
  pctB: number | null;
  bbWidthPct: number | null;
  bbMid: number | null;
  atr14Pct: number | null;
  macdHistPct: number | null;
  ret1hPct: number | null;
  // 1h bars
  ret24hPct: number | null;
  ret7dPct: number | null;
  volZ: number | null;
  // funding + OI
  fundingPct: number | null;
  fundingZ: number | null;
  oiUsd: number | null;
  oiChg1hPct: number | null;
  // news (kit news module; null when unavailable)
  newsZ: number | null;
  sentiment: number | null;
  // 4h trend (breezy's coins only)
  trend?: TrendStats;
  /** Larry Williams volatility breakout (bizzy): today's UTC open + k x yesterday's range, from 1h bars. */
  breakout?: { dayOpen: number; prevRange: number; trigger: number } | null;
  /** Daily trend numbers (dozy's coins only), from confirmed UTC daily candles refreshed a few times a day. */
  daily?: DailyStats;
}

export interface DailyStats {
  /** Confirmed daily candles behind these numbers. */
  bars: number;
  /** Last daily close. */
  close: number;
  /** % change of the last daily close over 90 days; null with fewer than 91 daily bars. */
  mom90Pct: number | null;
  /** ATR(14) of the daily bars, % of the close. */
  atrPct: number | null;
  /** Standard deviation of the last 30 daily returns, %. */
  volPct: number | null;
  /** When it was computed (ms). */
  at: number;
}

export interface TrendStats {
  /** Ensemble Donchian score, -9..+9 (long slices on minus short slices on). */
  score: number;
  longOn: number;
  shortOn: number;
  slicesAvailable: number;
  atr4hPct: number | null;
  rv90Pct: number | null;
  /** Average trailing stop of the slices in the dominant direction, or null if none on. */
  trailStop: number | null;
  /** At a 10-day (60 x 4h) closing high (+1) or low (-1), else 0. */
  tenDayExtreme: -1 | 0 | 1;
}

export interface MarketView {
  ts: number;
  instruments: Map<string, Instrument>;
  tickers: Map<string, Ticker>;
  stats: Map<string, CoinStats>;
  /** Gated crypto universe (boozy's pool), ranked by 24h volume. */
  gated: string[];
  /** Coins that passed volume but failed the spread gate (for "boozy wanted RAY" moments). */
  spreadBlocked: string[];
  /**
   * Stocks, ETFs and commodities that pass the macro gates, ranked by 24h volume ([] without macro bees). Only macro
   * bees see them (engine.ts), and only while their session is open (market/sessions.ts).
   */
  macro: string[];
  newsAvailable: boolean;
}
