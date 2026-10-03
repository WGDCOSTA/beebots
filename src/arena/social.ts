// The Warren feed: the members' agents in public, results only. Listed agents post on their own (a closed trade with its
// result, a milestone, a new version), two agents that closed opposite trades on the same coin around the same time are
// paired as a rivalry, and members follow agents and cheer posts. Open positions and rules never appear here, the same
// rule as the leaderboard. Everything lives in the directory database, next to the leaderboard, and goes when the agent
// is unlisted or deleted, or its member deletes the account.
import type { DatabaseSync } from "node:sqlite";

export const REACTIONS = ["carrot", "fire", "eyes", "clap"] as const;
export type Reaction = (typeof REACTIONS)[number];
export type PostKind = "closed" | "milestone" | "version" | "rivalry";

/** Equity changes (in %) that make a milestone post, once each per version. */
export const MILESTONES = [5, 10, 25, 50, -5, -10, -25];
/** Two closes on one coin, opposite sides, within this time make a rivalry. */
export const RIVALRY_MS = 6 * 3_600_000;
const KEEP_DAYS = 30;

export interface AgentCard {
  botId: string;
  userId: string;
  name: string;
  avatar: string;
  theme: string;
  handle: string;
  image: boolean;
}

export interface PostView {
  id: number;
  ts: number;
  kind: PostKind;
  agent: Omit<AgentCard, "userId">;
  /** The other side of a rivalry. */
  other: Omit<AgentCard, "userId"> | null;
  data: Record<string, unknown>;
  reactions: Record<Reaction, number>;
  mine: Reaction[];
  /** The viewer follows this agent. */
  following: boolean;
  /** One of the viewer's own agents. */
  own: boolean;
}

const SQL = `
CREATE TABLE IF NOT EXISTS social_posts (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL, bot_id TEXT NOT NULL, user_id TEXT NOT NULL, card TEXT NOT NULL, other_bot TEXT, other_user TEXT, other_card TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS social_posts_ts ON social_posts(ts);
CREATE INDEX IF NOT EXISTS social_posts_bot ON social_posts(bot_id);
CREATE TABLE IF NOT EXISTS social_follows (user_id TEXT NOT NULL, bot_id TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, bot_id));
CREATE TABLE IF NOT EXISTS social_reactions (post_id INTEGER NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (post_id, user_id, kind));
CREATE TABLE IF NOT EXISTS social_cursor (bot_id TEXT NOT NULL, version INTEGER NOT NULL, fill_id INTEGER NOT NULL DEFAULT 0, milestones TEXT NOT NULL DEFAULT '[]', PRIMARY KEY (bot_id, version));
`;

const pub = (c: AgentCard): Omit<AgentCard, "userId"> => ({ botId: c.botId, name: c.name, avatar: c.avatar, theme: c.theme, handle: c.handle, image: c.image });

export class Social {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SQL);
  }

  private insert(kind: PostKind, a: AgentCard, data: Record<string, unknown>, other: AgentCard | null = null, ts = this.now()): number {
    return Number(
      this.db
        .prepare("INSERT INTO social_posts (ts, kind, bot_id, user_id, card, other_bot, other_user, other_card, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(ts, kind, a.botId, a.userId, JSON.stringify(pub(a)), other?.botId ?? null, other?.userId ?? null, other ? JSON.stringify(pub(other)) : null, JSON.stringify(data)).lastInsertRowid,
    );
  }

  /** Where an agent's version left off: the last fill seen, and the milestones already posted. */
  cursor(botId: string, version: number): { fillId: number; milestones: number[] } {
    const r = this.db.prepare("SELECT fill_id AS f, milestones AS m FROM social_cursor WHERE bot_id = ? AND version = ?").get(botId, version) as { f: number; m: string } | undefined;
    return r ? { fillId: r.f, milestones: JSON.parse(r.m) as number[] } : { fillId: -1, milestones: [] };
  }

  private setCursor(botId: string, version: number, c: { fillId: number; milestones: number[] }): void {
    this.db.prepare("INSERT INTO social_cursor (bot_id, version, fill_id, milestones) VALUES (?, ?, ?, ?) ON CONFLICT(bot_id, version) DO UPDATE SET fill_id = excluded.fill_id, milestones = excluded.milestones").run(botId, version, c.fillId, JSON.stringify(c.milestones));
  }

  /**
   * What an agent did since the last look, turned into posts. `fills` are its closing fills (realised P&L), oldest first;
   * the first look of a version only remembers where it is, so history is not posted all at once. Returns the posts made.
   */
  record(a: AgentCard, version: number, fills: Array<{ id: number; ts: number; coin: string; side: "buy" | "sell"; notionalUsd: number; realisedUsd: number }>, pnlPct: number | null): number {
    const c = this.cursor(a.botId, version);
    let made = 0;
    if (c.fillId < 0) {
      // A new version: say so once, and start from its latest fill.
      if (version > 1) {
        this.insert("version", a, { version });
        made++;
      }
      this.setCursor(a.botId, version, { fillId: fills.length ? fills[fills.length - 1]!.id : 0, milestones: [] });
      return made;
    }
    let last = c.fillId;
    for (const f of fills) {
      if (f.id <= c.fillId) continue;
      last = Math.max(last, f.id);
      // Closing with a sell means it was long; with a buy, short.
      const side = f.side === "sell" ? "long" : "short";
      const pct = f.notionalUsd > 0 ? Number(((f.realisedUsd / f.notionalUsd) * 100).toFixed(2)) : null;
      const pnlUsd = Number(f.realisedUsd.toFixed(2));
      this.insert("closed", a, { coin: f.coin, side, pnlUsd, pct }, null, f.ts);
      made++;
      made += this.rivalry(a, pnlUsd, f.ts, f.coin, side);
    }
    const done = new Set(c.milestones);
    if (pnlPct !== null)
      for (const m of MILESTONES)
        if (!done.has(m) && (m > 0 ? pnlPct >= m : pnlPct <= m)) {
          this.insert("milestone", a, { pct: m, now: Number(pnlPct.toFixed(2)) });
          done.add(m);
          made++;
        }
    this.setCursor(a.botId, version, { fillId: last, milestones: [...done] });
    return made;
  }

  /** Another member's agent that closed the other side of the same coin lately: the two are paired, once per pair and coin a day. */
  private rivalry(a: AgentCard, pnlUsd: number, ts: number, coin: string, side: string): number {
    const rows = this.db.prepare("SELECT bot_id AS b, user_id AS u, card, data FROM social_posts WHERE kind = 'closed' AND bot_id != ? AND user_id != ? AND ts >= ? ORDER BY ts DESC LIMIT 50").all(a.botId, a.userId, ts - RIVALRY_MS) as Array<{ b: string; u: string; card: string; data: string }>;
    for (const r of rows) {
      const d = JSON.parse(r.data) as { coin: string; side: string; pnlUsd: number };
      if (d.coin !== coin || d.side === side) continue;
      const seen = this.db.prepare("SELECT 1 FROM social_posts WHERE kind = 'rivalry' AND ts >= ? AND ((bot_id = ? AND other_bot = ?) OR (bot_id = ? AND other_bot = ?)) AND data LIKE ?").get(ts - 86_400_000, a.botId, r.b, r.b, a.botId, `%"coin":"${coin}"%`);
      if (seen) continue;
      const other = { ...(JSON.parse(r.card) as Omit<AgentCard, "userId">), userId: r.u };
      this.insert("rivalry", a, { coin, side, pnlUsd, otherSide: d.side, otherPnlUsd: d.pnlUsd }, other, ts);
      return 1;
    }
    return 0;
  }

  /** The feed, newest first; `following` keeps only the agents the viewer follows (and the viewer's own). */
  feed(viewer: string | null, o: { following?: boolean; bot?: string; before?: number; limit?: number } = {}): PostView[] {
    const limit = Math.max(1, Math.min(60, o.limit ?? 30));
    const before = o.before ?? Number.MAX_SAFE_INTEGER;
    const where: string[] = ["id < ?"];
    const args: Array<string | number> = [before];
    if (o.bot) {
      where.push("(bot_id = ? OR other_bot = ?)");
      args.push(o.bot, o.bot);
    }
    if (o.following && viewer) {
      where.push("(user_id = ? OR bot_id IN (SELECT bot_id FROM social_follows WHERE user_id = ?) OR other_bot IN (SELECT bot_id FROM social_follows WHERE user_id = ?))");
      args.push(viewer, viewer, viewer);
    }
    const rows = this.db.prepare(`SELECT * FROM social_posts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Array<{ id: number; ts: number; kind: string; bot_id: string; user_id: string; card: string; other_card: string | null; data: string }>;
    const follows = new Set(viewer ? (this.db.prepare("SELECT bot_id AS b FROM social_follows WHERE user_id = ?").all(viewer) as Array<{ b: string }>).map((r) => r.b) : []);
    return rows.map((r) => {
      const counts = Object.fromEntries(REACTIONS.map((k) => [k, 0])) as Record<Reaction, number>;
      for (const x of this.db.prepare("SELECT kind, COUNT(*) AS n FROM social_reactions WHERE post_id = ? GROUP BY kind").all(r.id) as Array<{ kind: Reaction; n: number }>) if (x.kind in counts) counts[x.kind] = Number(x.n);
      const mine = viewer ? (this.db.prepare("SELECT kind FROM social_reactions WHERE post_id = ? AND user_id = ?").all(r.id, viewer) as Array<{ kind: Reaction }>).map((x) => x.kind) : [];
      return { id: r.id, ts: r.ts, kind: r.kind as PostKind, agent: JSON.parse(r.card), other: r.other_card ? JSON.parse(r.other_card) : null, data: JSON.parse(r.data), reactions: counts, mine, following: follows.has(r.bot_id), own: !!viewer && r.user_id === viewer };
    });
  }

  /** Adds or removes the viewer's reaction. Returns the post's counts, or null for a post that is gone. */
  react(viewer: string, postId: number, kind: string): Record<Reaction, number> | null {
    if (!(REACTIONS as readonly string[]).includes(kind)) return null;
    if (!this.db.prepare("SELECT 1 FROM social_posts WHERE id = ?").get(postId)) return null;
    const had = this.db.prepare("DELETE FROM social_reactions WHERE post_id = ? AND user_id = ? AND kind = ?").run(postId, viewer, kind).changes;
    if (!Number(had)) this.db.prepare("INSERT INTO social_reactions (post_id, user_id, kind) VALUES (?, ?, ?)").run(postId, viewer, kind);
    const counts = Object.fromEntries(REACTIONS.map((k) => [k, 0])) as Record<Reaction, number>;
    for (const x of this.db.prepare("SELECT kind, COUNT(*) AS n FROM social_reactions WHERE post_id = ? GROUP BY kind").all(postId) as Array<{ kind: Reaction; n: number }>) counts[x.kind] = Number(x.n);
    return counts;
  }

  follow(viewer: string, botId: string, on: boolean): void {
    if (on) this.db.prepare("INSERT OR IGNORE INTO social_follows (user_id, bot_id, ts) VALUES (?, ?, ?)").run(viewer, botId, this.now());
    else this.db.prepare("DELETE FROM social_follows WHERE user_id = ? AND bot_id = ?").run(viewer, botId);
  }

  followers(botId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM social_follows WHERE bot_id = ?").get(botId) as { n: number }).n);
  }

  following(viewer: string): string[] {
    return (this.db.prepare("SELECT bot_id AS b FROM social_follows WHERE user_id = ? ORDER BY ts").all(viewer) as Array<{ b: string }>).map((r) => r.b);
  }

  /** An agent leaves the feed (unlisted, stopped for good or deleted): its posts, the rivalries it is in, its followers. */
  forgetBot(botId: string): void {
    this.db.prepare("DELETE FROM social_reactions WHERE post_id IN (SELECT id FROM social_posts WHERE bot_id = ? OR other_bot = ?)").run(botId, botId);
    this.db.prepare("DELETE FROM social_posts WHERE bot_id = ? OR other_bot = ?").run(botId, botId);
    this.db.prepare("DELETE FROM social_follows WHERE bot_id = ?").run(botId);
    this.db.prepare("DELETE FROM social_cursor WHERE bot_id = ?").run(botId);
  }

  /** A member deletes the account: everything of theirs, including whom they followed and how they reacted. */
  forgetUser(userId: string): void {
    for (const r of this.db.prepare("SELECT DISTINCT bot_id AS b FROM social_posts WHERE user_id = ? UNION SELECT DISTINCT other_bot FROM social_posts WHERE other_user = ?").all(userId, userId) as Array<{ b: string | null }>) if (r.b) this.forgetBot(r.b);
    this.db.prepare("DELETE FROM social_follows WHERE user_id = ?").run(userId);
    this.db.prepare("DELETE FROM social_reactions WHERE user_id = ?").run(userId);
  }

  /** Old posts go after KEEP_DAYS, with their reactions. */
  prune(now = this.now()): void {
    const cut = now - KEEP_DAYS * 86_400_000;
    this.db.prepare("DELETE FROM social_reactions WHERE post_id IN (SELECT id FROM social_posts WHERE ts < ?)").run(cut);
    this.db.prepare("DELETE FROM social_posts WHERE ts < ?").run(cut);
  }
}
