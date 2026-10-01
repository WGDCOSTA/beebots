// The public leaderboard. It holds only what its owners chose to show: a bot's name, avatar, style, plan, the public name of
// its owner and its equity samples. No e-mail, no rules, no positions. Samples arrive from the runner; standings are
// computed from them on request (score.ts has the rules) and cached for a few seconds, so a crowd costs one calculation.
import type { DatabaseSync } from "node:sqlite";
import { leagueOf, metricsOf, needOf, rankBy, seasonOf, whyNotRanked, MIN_DAYS, MIN_SAMPLES, MIN_TRADES, type Metrics, type Need, type Point, type Season } from "./score.js";

export interface Listing {
  botId: string;
  userId: string;
  handle: string;
  name: string;
  theme: string;
  avatar: string;
  style: string;
  tier: string;
  version: number;
}

export interface StandingRow {
  /** null while the bot is not ranked yet. */
  rank: number | null;
  botId: string;
  name: string;
  handle: string;
  theme: string;
  avatar: string;
  style: string;
  tier: string;
  version: number;
  league: string;
  metrics: Metrics | null;
  reason: string | null;
  /** The same as numbers, for pages that word it in the member's language. */
  need: Need | null;
  /** The viewer owns it. Filled in by the API; the leaderboard itself never reveals who is asking. */
  mine?: boolean;
}

export interface Standings {
  season: Season & { current: boolean };
  seasons: string[];
  leagues: Array<{ id: string; ranked: number; waiting: number }>;
  /** What a bot needs before it is ranked. */
  minimums: { minDays: number; minTrades: number; minSamples: number };
  rows: StandingRow[];
}

const KEEP_SEASONS = 5;
const CACHE_MS = 15_000;

export class Leaderboard {
  private cache = new Map<string, { at: number; out: Standings }>();

  constructor(private readonly dir: DatabaseSync, private readonly now: () => number = Date.now) {}

  /** Records one sample of a listed bot's paper account and refreshes how it is shown. */
  record(l: Listing, equity: number, orders: number, ts = this.now()): void {
    this.dir
      .prepare(
        "INSERT INTO lb_bots (bot_id, user_id, handle, name, theme, avatar, style, tier, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(bot_id) DO UPDATE SET handle = excluded.handle, name = excluded.name, theme = excluded.theme, avatar = excluded.avatar, style = excluded.style, tier = excluded.tier, version = excluded.version, updated_at = excluded.updated_at",
      )
      .run(l.botId, l.userId, l.handle, l.name, l.theme, l.avatar, l.style, l.tier, l.version, ts);
    this.dir.prepare("INSERT OR REPLACE INTO lb_points (season, bot_id, version, ts, equity, orders) VALUES (?, ?, ?, ?, ?, ?)").run(seasonOf(ts).id, l.botId, l.version, ts, equity, orders);
    this.cache.clear();
  }

  /** A bot leaves the leaderboard for good (unlisted, deleted): its row and every sample go. */
  remove(botId: string): void {
    this.dir.prepare("DELETE FROM lb_points WHERE bot_id = ?").run(botId);
    this.dir.prepare("DELETE FROM lb_bots WHERE bot_id = ?").run(botId);
    this.cache.clear();
  }

  /** A member changed their public name: show it at once. */
  rename(userId: string, handle: string): void {
    this.dir.prepare("UPDATE lb_bots SET handle = ? WHERE user_id = ?").run(handle, userId);
    this.cache.clear();
  }

  /** The bot ids of a member that are on the leaderboard. */
  listedBots(userId: string): string[] {
    return (this.dir.prepare("SELECT bot_id FROM lb_bots WHERE user_id = ?").all(userId) as Array<{ bot_id: string }>).map((r) => r.bot_id);
  }

  /** Drops samples older than the seasons worth keeping. */
  prune(ts = this.now()): void {
    const keepFrom = seasonOf(ts).start - (KEEP_SEASONS - 1) * 7 * 86_400_000;
    this.dir.prepare("DELETE FROM lb_points WHERE ts < ?").run(keepFrom);
    this.cache.clear();
  }

  standings(seasonId?: string): Standings {
    const cur = seasonOf(this.now());
    const id = seasonId ?? cur.id;
    const hit = this.cache.get(id);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.out;

    const seasons = [...new Set([cur.id, ...(this.dir.prepare("SELECT DISTINCT season FROM lb_points ORDER BY season DESC").all() as Array<{ season: string }>).map((r) => r.season)])].sort().reverse();
    const bots = new Map((this.dir.prepare("SELECT * FROM lb_bots").all() as Array<Record<string, string | number>>).map((r) => [String(r.bot_id), r]));
    const pts = this.dir.prepare("SELECT bot_id, version, ts, equity, orders FROM lb_points WHERE season = ? ORDER BY bot_id, version, ts").all(id) as Array<{ bot_id: string; version: number; ts: number; equity: number; orders: number }>;

    // Per bot only its latest version counts: a rules change starts a new paper account, and the old one is not ranked.
    const latest = new Map<string, { version: number; points: Point[] }>();
    for (const p of pts) {
      const cur = latest.get(p.bot_id);
      if (!cur || p.version > cur.version) latest.set(p.bot_id, { version: p.version, points: [{ ts: p.ts, equity: p.equity, orders: p.orders }] });
      else if (p.version === cur.version) cur.points.push({ ts: p.ts, equity: p.equity, orders: p.orders });
    }

    const rows: StandingRow[] = [];
    for (const [botId, { version, points }] of latest) {
      const b = bots.get(botId);
      if (!b) continue;
      const metrics = metricsOf(points);
      const reason = whyNotRanked(metrics);
      rows.push({ rank: null, botId, name: String(b.name), handle: String(b.handle), theme: String(b.theme), avatar: String(b.avatar), style: String(b.style), tier: String(b.tier), version, league: leagueOf(String(b.tier), String(b.style)), metrics, reason, need: needOf(metrics) });
    }

    const leagues = new Map<string, { ranked: number; waiting: number }>();
    for (const league of new Set(rows.map((r) => r.league))) {
      const inLeague = rows.filter((r) => r.league === league);
      const ranked = rankBy(inLeague.filter((r) => r.reason === null).map((r) => ({ metrics: r.metrics!, row: r })));
      for (const x of ranked) x.entry.row.rank = x.rank;
      leagues.set(league, { ranked: ranked.length, waiting: inLeague.length - ranked.length });
    }
    rows.sort((a, b) => a.league.localeCompare(b.league) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || (b.metrics?.score ?? -1e9) - (a.metrics?.score ?? -1e9));

    const out: Standings = {
      season: { ...seasonOf(seasonIdStart(id, cur)), id, current: id === cur.id },
      seasons,
      leagues: [...leagues].map(([lid, v]) => ({ id: lid, ...v })).sort((a, b) => a.id.localeCompare(b.id)),
      minimums: { minDays: MIN_DAYS, minTrades: MIN_TRADES, minSamples: MIN_SAMPLES },
      rows,
    };
    this.cache.set(id, { at: this.now(), out });
    return out;
  }

  /** Which bot ids belong to a member, for marking "yours" without revealing owners to anyone else. */
  ownedBy(userId: string): Set<string> {
    return new Set(this.listedBots(userId));
  }
}

/** The start time of a season given its id (only the current one is exact; others are reconstructed from the week). */
function seasonIdStart(id: string, cur: Season): number {
  if (id === cur.id) return cur.start;
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return cur.start;
  // ISO week 1 contains 4 January.
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  return monday + (Number(m[2]) - 1) * 7 * 86_400_000;
}
