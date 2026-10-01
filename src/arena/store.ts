// Arena storage. One small directory database (accounts, sign-in tokens, sessions, an audit trail) and one SQLite file
// per user. A user's file is only reachable through tenant(userId), which takes an id that exists in the directory, so
// no route can name a path and no user's data ever shares a file with another's.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LOCALE, isLocale, type Locale } from "./locales.js";

export type Tier = "free" | "pro";
export interface ArenaUser {
  id: string;
  email: string;
  tier: Tier;
  /** The public name on the leaderboard. Never the e-mail address. */
  handle: string;
  /** The language of the pages and of the e-mails sent to them. */
  locale: Locale;
  createdAt: number;
}

/** What a new member accepts before anything else. Bumping the version asks everyone again. The texts themselves are drafts until counsel signs them off. */
export const CONSENT_VERSION = "2026-10-draft";
export const CONSENT_ITEMS = ["terms", "simulated", "age"] as const;
export type ConsentItem = (typeof CONSENT_ITEMS)[number];

export const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,19}$/;
const RESERVED_HANDLES = new Set(["admin", "administrator", "arena", "warren", "official", "support", "staff", "moderator", "mod", "system", "root", "bizzy", "breezy", "boozy", "jev", "null", "undefined", "anonymous"]);

/** Says what is wrong with a wished-for public name, or null when it is fine (before uniqueness). */
export function handleProblem(raw: unknown): string | null {
  if (typeof raw !== "string") return "Pick a public name.";
  const h = raw.trim().toLowerCase();
  if (!HANDLE_RE.test(h)) return "Public name: 3 to 20 letters, numbers, - or _, starting with a letter or number.";
  if (RESERVED_HANDLES.has(h)) return "That name is reserved. Pick another.";
  return null;
}

const ID_RE = /^[0-9a-f]{32}$/;

const DIRECTORY = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, tier TEXT NOT NULL DEFAULT 'free', created_at INTEGER NOT NULL,
  handle TEXT,
  locale TEXT NOT NULL DEFAULT 'en'
);
-- Evidence of what each member accepted and when: the document version and the time. No address, no device.
CREATE TABLE IF NOT EXISTS consents (
  user_id TEXT NOT NULL, item TEXT NOT NULL, version TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id, item, version)
);
CREATE TABLE IF NOT EXISTS login_tokens (
  hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, ts);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT, event TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
-- The public leaderboard: only bots their owners chose to list, and only what is shown there (ranking.ts).
CREATE TABLE IF NOT EXISTS lb_bots (
  bot_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, handle TEXT NOT NULL, name TEXT NOT NULL, theme TEXT NOT NULL,
  avatar TEXT NOT NULL, style TEXT NOT NULL, tier TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lb_bots_user ON lb_bots(user_id);
CREATE TABLE IF NOT EXISTS lb_points (
  season TEXT NOT NULL, bot_id TEXT NOT NULL, version INTEGER NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL,
  orders INTEGER NOT NULL, PRIMARY KEY (season, bot_id, version, ts)
);
`;

const TENANT = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, avatar TEXT NOT NULL, style TEXT NOT NULL,
  coins TEXT NOT NULL, rules TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  tagline TEXT NOT NULL DEFAULT '', look TEXT NOT NULL DEFAULT '', image INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'running'
);
CREATE TABLE IF NOT EXISTS bot_versions (
  bot_id TEXT NOT NULL, version INTEGER NOT NULL, style TEXT NOT NULL, coins TEXT NOT NULL, rules TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, version)
);
`;

interface UserRow {
  id: string;
  email: string;
  tier: string;
  created_at: number;
  handle: string | null;
  locale: string | null;
}

const toUser = (r: UserRow): ArenaUser => ({ id: r.id, email: r.email, tier: r.tier === "pro" ? "pro" : "free", handle: r.handle ?? `bunny-${r.id.slice(0, 4)}`, locale: isLocale(r.locale) ? r.locale : DEFAULT_LOCALE, createdAt: r.created_at });

export class ArenaStore {
  readonly dir: DatabaseSync;
  private readonly tenants = new Map<string, DatabaseSync>();

  constructor(private readonly root: string) {
    mkdirSync(join(root, "tenants"), { recursive: true });
    this.dir = new DatabaseSync(join(root, "arena.db"));
    this.dir.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.dir.exec(DIRECTORY);
    // Directories made before public names existed: add the column and give everyone a neutral name (never their e-mail).
    if (!(this.dir.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).some((c) => c.name === "handle")) this.dir.exec("ALTER TABLE users ADD COLUMN handle TEXT");
    if (!(this.dir.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>).some((c) => c.name === "locale")) this.dir.exec("ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
    this.dir.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_handle ON users(handle)");
    for (const r of this.dir.prepare("SELECT id FROM users WHERE handle IS NULL").all() as Array<{ id: string }>) this.dir.prepare("UPDATE users SET handle = ? WHERE id = ?").run(this.freeHandle(r.id), r.id);
  }

  /** A neutral default public name that nobody has taken. */
  private freeHandle(id: string): string {
    for (let n = 4; n <= 32; n++) {
      const h = `bunny-${id.slice(0, n)}`.slice(0, 20);
      if (!this.dir.prepare("SELECT 1 FROM users WHERE handle = ?").get(h)) return h;
    }
    return `bunny-${id.slice(0, 12)}`;
  }

  setLocale(userId: string, locale: Locale): void {
    this.dir.prepare("UPDATE users SET locale = ? WHERE id = ?").run(locale, userId);
  }

  /** True while the member has not accepted every item of the current version. */
  consentNeeded(userId: string): boolean {
    const n = (this.dir.prepare("SELECT COUNT(*) AS n FROM consents WHERE user_id = ? AND version = ?").get(userId, CONSENT_VERSION) as { n: number }).n;
    return n < CONSENT_ITEMS.length;
  }

  /** Records that the member accepted every item of the current version. */
  acceptConsent(userId: string, now: number): void {
    for (const item of CONSENT_ITEMS) this.dir.prepare("INSERT OR IGNORE INTO consents (user_id, item, version, ts) VALUES (?, ?, ?, ?)").run(userId, item, CONSENT_VERSION, now);
    this.audit(userId, "accepted terms", now);
  }

  /** Changes a member's public name. Returns a message when it cannot, or null on success. */
  setHandle(userId: string, raw: unknown): string | null {
    const bad = handleProblem(raw);
    if (bad) return bad;
    const h = String(raw).trim().toLowerCase();
    const taken = this.dir.prepare("SELECT id FROM users WHERE handle = ?").get(h) as { id: string } | undefined;
    if (taken && taken.id !== userId) return "That name is taken. Pick another.";
    this.dir.prepare("UPDATE users SET handle = ? WHERE id = ?").run(h, userId);
    return null;
  }

  userByEmail(email: string): ArenaUser | null {
    const r = this.dir.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  userById(id: string): ArenaUser | null {
    if (!ID_RE.test(id)) return null;
    const r = this.dir.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  createUser(id: string, email: string, now: number): ArenaUser {
    const handle = this.freeHandle(id);
    this.dir.prepare("INSERT INTO users (id, email, tier, created_at, handle) VALUES (?, ?, 'free', ?, ?)").run(id, email, now, handle);
    return { id, email, tier: "free", handle, locale: DEFAULT_LOCALE, createdAt: now };
  }

  /** This user's own database. Throws for an id that is not a current user, so a path can never be chosen by a caller. */
  tenant(userId: string): DatabaseSync {
    if (!this.userById(userId)) throw new Error("unknown user");
    let db = this.tenants.get(userId);
    if (!db) {
      db = new DatabaseSync(join(this.root, "tenants", `${userId}.db`));
      db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      db.exec(TENANT);
      // Databases made before a column existed get it here (CREATE TABLE IF NOT EXISTS does not add columns).
      const have = new Set((db.prepare("PRAGMA table_info(bots)").all() as Array<{ name: string }>).map((c) => c.name));
      for (const [col, ddl] of [["tagline", "TEXT NOT NULL DEFAULT ''"], ["look", "TEXT NOT NULL DEFAULT ''"], ["image", "INTEGER NOT NULL DEFAULT 0"], ["listed", "INTEGER NOT NULL DEFAULT 1"], ["state", "TEXT NOT NULL DEFAULT 'running'"]] as const)
        if (!have.has(col)) db.exec(`ALTER TABLE bots ADD COLUMN ${col} ${ddl}`);
      this.tenants.set(userId, db);
    }
    return db;
  }

  /** Where a member's bot portraits live: a folder of their own, named by bot id (ids are hex, never a path). */
  private portraitFile(userId: string, botId: string): string {
    if (!this.userById(userId) || !/^[0-9a-f]{12}$/.test(botId)) throw new Error("bad portrait path");
    return join(this.root, "tenants", userId, "portraits", `${botId}.jpg`);
  }

  savePortrait(userId: string, botId: string, jpg: Buffer): void {
    const f = this.portraitFile(userId, botId);
    mkdirSync(join(this.root, "tenants", userId, "portraits"), { recursive: true });
    writeFileSync(f, jpg);
  }

  readPortrait(userId: string, botId: string): Buffer | null {
    const f = this.portraitFile(userId, botId);
    return existsSync(f) ? readFileSync(f) : null;
  }

  removePortrait(userId: string, botId: string): void {
    rmSync(this.portraitFile(userId, botId), { force: true });
  }

  /** The platform-wide count of AI calls made today, for the daily budget. Increments when asked. */
  aiToday(day: string, add = 0): number {
    if (add) this.dir.prepare("INSERT INTO ai_usage (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = n + ?").run(day, add, add);
    return (this.dir.prepare("SELECT n FROM ai_usage WHERE day = ?").get(day) as { n: number } | undefined)?.n ?? 0;
  }

  audit(userId: string | null, event: string, now: number): void {
    this.dir.prepare("INSERT INTO audit (ts, user_id, event) VALUES (?, ?, ?)").run(now, userId, event);
  }

  /** Erases the account: sessions, the row and the user's whole database file. */
  deleteUser(userId: string, now: number): void {
    if (!this.userById(userId)) return;
    this.tenants.get(userId)?.close();
    this.tenants.delete(userId);
    this.dir.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    this.dir.prepare("DELETE FROM consents WHERE user_id = ?").run(userId);
    // Their bots leave the public leaderboard with them.
    this.dir.prepare("DELETE FROM lb_points WHERE bot_id IN (SELECT bot_id FROM lb_bots WHERE user_id = ?)").run(userId);
    this.dir.prepare("DELETE FROM lb_bots WHERE user_id = ?").run(userId);
    this.dir.prepare("DELETE FROM users WHERE id = ?").run(userId);
    for (const ext of ["", "-wal", "-shm"]) rmSync(join(this.root, "tenants", `${userId}.db${ext}`), { force: true });
    rmSync(join(this.root, "tenants", userId), { recursive: true, force: true });
    this.audit(userId, "account deleted", now);
  }

  close(): void {
    for (const db of this.tenants.values()) db.close();
    this.tenants.clear();
    this.dir.close();
  }
}
