// Arena storage. One small directory database (accounts, sign-in tokens, sessions, an audit trail) and one SQLite file
// per user. A user's file is only reachable through tenant(userId), which takes an id that exists in the directory, so
// no route can name a path and no user's data ever shares a file with another's.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Tier = "free" | "pro";
export interface ArenaUser {
  id: string;
  email: string;
  tier: Tier;
  createdAt: number;
}

const ID_RE = /^[0-9a-f]{32}$/;

const DIRECTORY = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, tier TEXT NOT NULL DEFAULT 'free', created_at INTEGER NOT NULL
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
`;

const TENANT = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, theme TEXT NOT NULL, avatar TEXT NOT NULL, style TEXT NOT NULL,
  coins TEXT NOT NULL, rules TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  tagline TEXT NOT NULL DEFAULT '', look TEXT NOT NULL DEFAULT '', image INTEGER NOT NULL DEFAULT 0
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
}

const toUser = (r: UserRow): ArenaUser => ({ id: r.id, email: r.email, tier: r.tier === "pro" ? "pro" : "free", createdAt: r.created_at });

export class ArenaStore {
  readonly dir: DatabaseSync;
  private readonly tenants = new Map<string, DatabaseSync>();

  constructor(private readonly root: string) {
    mkdirSync(join(root, "tenants"), { recursive: true });
    this.dir = new DatabaseSync(join(root, "arena.db"));
    this.dir.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.dir.exec(DIRECTORY);
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
    this.dir.prepare("INSERT INTO users (id, email, tier, created_at) VALUES (?, ?, 'free', ?)").run(id, email, now);
    return { id, email, tier: "free", createdAt: now };
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
      for (const [col, ddl] of [["tagline", "TEXT NOT NULL DEFAULT ''"], ["look", "TEXT NOT NULL DEFAULT ''"], ["image", "INTEGER NOT NULL DEFAULT 0"]] as const)
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
