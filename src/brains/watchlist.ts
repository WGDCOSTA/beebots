// Watchlists: which coins each bee trades is chosen by its LLM brains, on evidence, inside hard limits.
//
// A brain (council, coach or survival council) picks the coins from CANDIDATES, never beyond them:
//   - the owner's coins for the bee when set (a hard limit), else
//   - the coins its style can trade (Breakout: BTC/ETH/SOL/HYPE, Trend: BTC/ETH), else
//   - the most liquid gated coins right now, the lab's coins and the coins the bee has traded.
// Evidence per coin: how the lab's skills did out of sample on it, the bee's real record on it, and live liquidity.
// The engine then only offers Jev the watchlist's coins (effectiveWatchlist below): the style, the owner's list and
// the survival tier still narrow it, a coin on probation trades at half size, and with no usable watchlist the bee
// falls back to its style's normal choice. Brains never place orders.
import { z } from "zod";
import type { Tier } from "../evolution.js";
import type { Ranking } from "../lab/tournament.js";
import { coinOfDataset } from "../graph/hive-mind.js";
import type { MarketView } from "../market/types.js";
import { kindOf } from "../market/kinds.js";
import { marketKinds } from "../market/sessions.js";

export const BIZZY_COINS = ["BTC", "ETH", "SOL", "HYPE"];
export const BREEZY_COINS = ["BTC", "ETH"];
export const MAX_WATCHLIST = 8;
/** How many of the most liquid coins count as "safe" for a bee in danger. */
export const LIQUID_TOP = 10;

export interface WatchItem {
  coin: string;
  reason: string;
  /** New coin on trial: half size until the coach keeps it. */
  probation: boolean;
  addedAt?: number;
}

/** Live facts about a coin (from the engine's market view). */
export interface CoinInfo {
  coin: string;
  vol24hUsd: number;
  ret7dPct: number | null;
  spreadBp: number;
  atrPct: number | null;
}

export interface CoinEvidence {
  coin: string;
  /** Best out-of-sample result any lab skill had on this coin, and the mean over the bee's adopted skills. */
  lab: { bestSkill: string; bestScore: number; adoptedScore: number | null } | null;
  /** The bee's real closed-trade record on this coin. */
  record: { netUsd: number; trades: number; winRatePct: number | null } | null;
  live: { volMusd: number; ret7dPct: number | null; spreadBp: number; atrPct: number | null } | null;
}

/** Coins a style may trade at all (null = any). */
export function styleCoins(style: string): string[] | null {
  return style === "bizzy" ? BIZZY_COINS : style === "breezy" ? BREEZY_COINS : null;
}

/** Watchlist size a bee may hold: 3 in danger, else 3 + its level, at most 8. */
export function watchlistSize(level: number, tier: Tier | null): number {
  if (tier === "danger" || tier === "critical") return 3;
  return Math.min(MAX_WATCHLIST, 3 + Math.max(0, level));
}

export function candidateCoins(o: {
  style: string;
  ownerCoins: string[];
  universe: CoinInfo[];
  ranking: Ranking | null;
  traded: string[];
  limit?: number;
  /** What the bee trades (crypto by default): macro bees only ever get stocks/commodities of their market. */
  market?: string;
}): string[] {
  if (o.ownerCoins.length) return [...new Set(o.ownerCoins.map((c) => c.toUpperCase()))];
  const market = o.market ?? "crypto";
  const fixed = market === "crypto" ? styleCoins(o.style) : null;
  if (fixed) return fixed;
  const kinds = marketKinds(market);
  const ok = (c: string) => kinds.includes(kindOf(c));
  const liquid = [...o.universe].filter((c) => ok(c.coin)).sort((a, b) => b.vol24hUsd - a.vol24hUsd).slice(0, o.limit ?? 30).map((c) => c.coin);
  const lab = (o.ranking?.datasets ?? []).map((d) => coinOfDataset(d.id)).filter((c) => !/^SYN\d/.test(c) && ok(c));
  return [...new Set([...liquid, ...lab, ...o.traded.map((c) => c.toUpperCase()).filter(ok)])];
}

/** The evidence a brain sees for each candidate. */
export function coinEvidence(o: {
  candidates: string[];
  ranking: Ranking | null;
  adoptedSkills: string[];
  record: Array<{ coin: string; netUsd: number; trades: number; winRatePct: number | null }>;
  universe: CoinInfo[];
}): CoinEvidence[] {
  const live = new Map(o.universe.map((c) => [c.coin, c]));
  const rec = new Map(o.record.map((r) => [r.coin, r]));
  // Per coin: best skill score and the mean over adopted skills, from the lab's out-of-sample folds.
  const perCoin = new Map<string, { best: [string, number]; adopted: number[] }>();
  for (const s of o.ranking?.results ?? []) {
    if (s.family === "benchmark") continue;
    const byDs = new Map<string, number[]>();
    for (const f of s.folds ?? []) byDs.set(coinOfDataset(f.dataset), [...(byDs.get(coinOfDataset(f.dataset)) ?? []), f.oosScore]);
    for (const [coin, scores] of byDs) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const e = perCoin.get(coin) ?? { best: [s.skillId, -Infinity], adopted: [] };
      if (avg > e.best[1]) e.best = [s.skillId, avg];
      if (o.adoptedSkills.includes(s.skillId)) e.adopted.push(avg);
      perCoin.set(coin, e);
    }
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return o.candidates.map((coin) => {
    const l = perCoin.get(coin);
    const r = rec.get(coin);
    const v = live.get(coin);
    return {
      coin,
      lab: l ? { bestSkill: l.best[0], bestScore: r2(l.best[1]), adoptedScore: l.adopted.length ? r2(l.adopted.reduce((a, b) => a + b, 0) / l.adopted.length) : null } : null,
      record: r ? { netUsd: r2(r.netUsd), trades: r.trades, winRatePct: r.winRatePct } : null,
      live: v ? { volMusd: r2(v.vol24hUsd / 1e6), ret7dPct: v.ret7dPct === null ? null : r2(v.ret7dPct), spreadBp: r2(v.spreadBp), atrPct: v.atrPct === null ? null : r2(v.atrPct) } : null,
    };
  });
}

/** A brain's pick, cleaned: only candidates, no duplicates, at most `size`. */
export function normaliseWatchlist(picks: Array<{ coin: string; reason: string }>, candidates: string[], size: number, now: number): WatchItem[] {
  const allowed = new Set(candidates.map((c) => c.toUpperCase()));
  const seen = new Set<string>();
  const out: WatchItem[] = [];
  for (const p of picks) {
    const coin = p.coin.trim().toUpperCase().replace(/-.*$/, "");
    if (!allowed.has(coin) || seen.has(coin)) continue;
    seen.add(coin);
    out.push({ coin, reason: p.reason.slice(0, 300), probation: false, addedAt: now });
    if (out.length >= size) break;
  }
  return out;
}

/** No brain: the candidates with the best lab evidence for the bee's skills, then the best record, then liquidity. */
export function rulesWatchlist(evidence: CoinEvidence[], size: number, now: number): WatchItem[] {
  const score = (e: CoinEvidence) => (e.lab?.adoptedScore ?? e.lab?.bestScore ?? 0) * 10 + (e.record ? Math.sign(e.record.netUsd) : 0) + Math.log10(1 + (e.live?.volMusd ?? 0)) / 10;
  return [...evidence]
    .sort((a, b) => score(b) - score(a))
    .slice(0, size)
    .map((e) => ({ coin: e.coin, reason: "rules pick: lab evidence, record and liquidity", probation: false, addedAt: now }));
}

/** JSON schema fragment every council answer carries. */
export const WATCHLIST_SCHEMA = {
  type: "array",
  description: "The coins this bee should trade, chosen only from coinCandidates, each with a short evidence-based reason",
  items: { type: "object", additionalProperties: false, required: ["coin", "reason"], properties: { coin: { type: "string" }, reason: { type: "string" } } },
} as const;
export const WatchPicks = z.array(z.object({ coin: z.string().max(20), reason: z.string().max(400) })).max(12);

/**
 * What the engine actually lets the bee trade from its watchlist right now. Returns null (= the style's normal choice)
 * when watchlists are off or nothing usable is left.
 */
export function effectiveWatchlist(o: {
  enabled: boolean;
  picks: WatchItem[] | null | undefined;
  style: string;
  ownerCoins: string[];
  tier: Tier | null;
  /** Gated coins, most liquid first. */
  liquid: string[];
  market?: string;
}): { coins: string[]; probation: string[] } | null {
  if (!o.enabled || !o.picks?.length) return null;
  let items = o.picks;
  if (o.ownerCoins.length) items = items.filter((i) => o.ownerCoins.includes(i.coin));
  const fixed = (o.market ?? "crypto") === "crypto" ? styleCoins(o.style) : null;
  if (fixed) items = items.filter((i) => fixed.includes(i.coin));
  else items = items.filter((i) => marketKinds(o.market ?? "crypto").includes(kindOf(i.coin)));
  // Survival: in danger only the most liquid coins stay on, and no coin on trial.
  if (o.tier === "danger" || o.tier === "critical") {
    const safe = new Set(o.liquid.slice(0, LIQUID_TOP));
    items = items.filter((i) => safe.has(i.coin) && !i.probation);
  }
  if (!items.length) return null;
  return { coins: items.map((i) => i.coin), probation: items.filter((i) => i.probation).map((i) => i.coin) };
}

/** Candidates and evidence for one bee, in one call (council, coach and survival council share it). */
export function watchInput(o: {
  style: string;
  market?: string;
  ownerCoins: string[];
  universe: CoinInfo[];
  ranking: Ranking | null;
  adoptedSkills: string[];
  record: Array<{ coin: string; netUsd: number; trades: number; winRatePct: number | null }>;
}): { candidates: string[]; evidence: CoinEvidence[] } {
  const candidates = candidateCoins({ style: o.style, market: o.market, ownerCoins: o.ownerCoins, universe: o.universe, ranking: o.ranking, traded: o.record.map((r) => r.coin) });
  return { candidates, evidence: coinEvidence({ candidates, ranking: o.ranking, adoptedSkills: o.adoptedSkills, record: o.record, universe: o.universe }) };
}

export const WATCHLIST_PROMPT =
  "Also choose the bee's WATCHLIST: the coins it should trade, only from coinCandidates, at most watchlistSize of them. " +
  "Weigh the lab's out-of-sample evidence per coin (lab.adoptedScore is how the skills you picked did on it), the bee's real record there, and live liquidity (volMusd, spreadBp). " +
  "A coin with no evidence is a gamble: include one only with a concrete reason. Give each coin a short reason.";

/** The live facts about the gated coins (most liquid first), for the brains' evidence. */
export function coinInfos(view: MarketView, limit = 40): CoinInfo[] {
  const out: CoinInfo[] = [];
  for (const instId of [...view.gated.slice(0, limit), ...view.macro.slice(0, limit)]) {
    const s = view.stats.get(instId);
    if (s) out.push({ coin: s.coin.toUpperCase(), vol24hUsd: s.vol24hUsd, ret7dPct: s.ret7dPct, spreadBp: s.spreadBp, atrPct: s.atr14Pct });
  }
  return out;
}

export const watchlistLine = (coins: string[], probation: string[]) =>
  `Watchlist chosen by this bee's AI brains from lab evidence: ${coins.join(", ")}; it only trades these.` +
  (probation.length ? ` On probation (half size): ${probation.join(", ")}.` : "");
