// Per-bee numeric snapshot for Jev. Numbers only, columnar, kept small (a few hundred input tokens).
// Each style sends the columns its own setup needs; a shared technical block then fills in what the style left out
// (momentum, trend strength, volatility, volume, positioning), so Jev never has to judge an entry on two numbers.
import { createHash } from "node:crypto";
import { beeLine, r2 } from "./bees/common.js";
import type { BeeBrain, BeeContext } from "./bees/types.js";
import type { CoinStats } from "./market/types.js";

/**
 * The technical columns every style gets, with the names a style may already use for the same number: a column is
 * added only when the style sends none of its names, so nothing is said twice.
 */
const TECH: Array<{ key: string; same: string[]; value: (s: CoinStats) => number | null }> = [
  { key: "rsi14", same: ["rsi", "rsi14"], value: (s) => r2(s.rsi14, 0) },
  { key: "macd_h_pct", same: ["macd_pct", "macd_h_pct"], value: (s) => r2(s.macdHistPct, 3) },
  { key: "bb_pctb", same: ["pctb", "bb_pctb"], value: (s) => r2(s.pctB, 2) },
  { key: "bb_w_pct", same: ["bb_w_pct", "bbw_pct"], value: (s) => r2(s.bbWidthPct, 2) },
  { key: "atr15m_pct", same: ["atr_pct", "atr15m_pct"], value: (s) => r2(s.atr14Pct, 2) },
  { key: "r1h_pct", same: ["r1h_pct", "impulse_1h_pct"], value: (s) => r2(s.ret1hPct, 2) },
  { key: "r24h_pct", same: ["r24h_pct"], value: (s) => r2(s.ret24hPct, 1) },
  { key: "vol_z", same: ["vol_z"], value: (s) => r2(s.volZ, 1) },
  { key: "fund_pct", same: ["fund_pct", "funding_pct"], value: (s) => r2(s.fundingPct, 4) },
  { key: "oi1h_pct", same: ["oi1h_pct", "oi_1h_pct"], value: (s) => r2(s.oiChg1hPct, 1) },
];

/** What the shared block adds to a style's row: its missing technical columns. */
export function techColumns(s: CoinStats, has: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of TECH) if (!t.same.some((k) => k in has)) out[t.key] = t.value(s);
  return out;
}

export interface Snapshot {
  state: Record<string, unknown>;
  /** First 16 hex chars of sha256(state). */
  hash: string;
  /** Rough size guard; the real number comes back as usage.input_tokens. */
  approxTokens: number;
}

/** `extra` is merged into the state before hashing (e.g. the lab vote, brains/signals.ts). */
export function buildSnapshot(brain: BeeBrain, ctx: BeeContext, extra?: Record<string, unknown> | null, tech = true): Snapshot {
  const ids = brain.snapshotCoins(ctx);
  let cols: string[] = [];
  const rows: Record<string, Array<number | string | null>> = {};
  for (const id of ids) {
    const s = ctx.view.stats.get(id);
    if (!s) continue;
    const own = brain.coinSnapshot(s, ctx);
    const snap = tech ? { ...own, ...techColumns(s, own) } : own;
    if (!cols.length) cols = Object.keys(snap);
    rows[s.coin] = cols.map((c) => snap[c] ?? null);
  }
  const d = new Date(ctx.now);
  const state: Record<string, unknown> = {
    utc: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    me: beeLine(ctx),
    coins: { cols, rows },
  };
  if (brain.id === "boozy") state.attn = ctx.view.newsAvailable ? "news_z" : "volume_z";
  if (extra) Object.assign(state, extra);
  const json = JSON.stringify(state);
  return {
    state,
    hash: createHash("sha256").update(json).digest("hex").slice(0, 16),
    approxTokens: Math.ceil(json.length / 3),
  };
}
