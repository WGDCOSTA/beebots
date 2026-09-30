// Passwordless sign-in. A person asks for a link by e-mail; the link carries a one-time token (stored only as a hash,
// valid 15 minutes) that the page trades for a session (also stored only as a hash, 30 days, sliding). Asking for a link
// always answers the same way, so the form cannot be used to learn who has an account.
import { createHash, randomBytes } from "node:crypto";
import { log } from "../log.js";
import type { Mailer } from "./mailer.js";
import type { ArenaStore, ArenaUser } from "./store.js";

export const TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;
const EMAIL_PER_HOUR = 5;
const ADDR_PER_HOUR = 20;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export interface AuthOpts {
  /** Where the sign-in page lives, e.g. https://arena.example.com (the link is baseUrl/#/arena/verify?token=...). */
  baseUrl: string;
  now?: () => number;
}

export class ArenaAuth {
  private readonly now: () => number;
  constructor(private readonly store: ArenaStore, private readonly mailer: Mailer, private readonly opts: AuthOpts) {
    this.now = opts.now ?? Date.now;
  }

  private tooMany(key: string, limit: number): boolean {
    const t = this.now();
    this.store.dir.prepare("DELETE FROM attempts WHERE ts < ?").run(t - 3_600_000);
    const n = (this.store.dir.prepare("SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts >= ?").get(key, t - 3_600_000) as { n: number }).n;
    if (n >= limit) return true;
    this.store.dir.prepare("INSERT INTO attempts (key, ts) VALUES (?, ?)").run(key, t);
    return false;
  }

  /** Always resolves the same way for a well-formed request; a bad address is the only visible failure. */
  async requestLink(rawEmail: unknown, addr: string): Promise<{ ok: boolean }> {
    const email = normaliseEmail(rawEmail);
    if (!email) return { ok: false };
    if (this.tooMany(`addr:${addr}`, ADDR_PER_HOUR) || this.tooMany(`email:${email}`, EMAIL_PER_HOUR)) return { ok: true };
    const token = secret();
    const t = this.now();
    this.store.dir.prepare("INSERT INTO login_tokens (hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), email, t, t + TOKEN_TTL_MS);
    const link = `${this.opts.baseUrl.replace(/\/$/, "")}/#/arena/verify?token=${token}`;
    try {
      await this.mailer.send(email, "Your Arena sign-in link", `Open this link to sign in (valid 15 minutes, works once):\n\n${link}\n\nIf you did not ask for it, ignore this e-mail.`);
    } catch (e) {
      log.warn("arena: sign-in mail failed", { error: e instanceof Error ? e.message : String(e) });
    }
    return { ok: true };
  }

  /** Trades a one-time token for a session. The account is created on first use. */
  verify(token: unknown): { session: string; user: ArenaUser } | null {
    if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
    const t = this.now();
    const h = sha(token);
    const row = this.store.dir.prepare("SELECT email, expires_at, used_at FROM login_tokens WHERE hash = ?").get(h) as { email: string; expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at !== null || row.expires_at < t) return null;
    // Claim it atomically: of two simultaneous tries only one changes a row.
    const claimed = this.store.dir.prepare("UPDATE login_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(t, h);
    if (Number(claimed.changes) !== 1) return null;
    const user = this.store.userByEmail(row.email) ?? this.store.createUser(randomBytes(16).toString("hex"), row.email, t);
    const session = secret();
    this.store.dir.prepare("INSERT INTO sessions (hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)").run(sha(session), user.id, t, t + SESSION_TTL_MS, t);
    this.store.audit(user.id, "signed in", t);
    return { session, user };
  }

  /** The signed-in user for a session token, or null. Using a session keeps it alive for another 30 days. */
  user(session: string | undefined): ArenaUser | null {
    if (!session || session.length > 200) return null;
    const t = this.now();
    const h = sha(session);
    const row = this.store.dir.prepare("SELECT user_id, expires_at FROM sessions WHERE hash = ?").get(h) as { user_id: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at < t) {
      this.store.dir.prepare("DELETE FROM sessions WHERE hash = ?").run(h);
      return null;
    }
    this.store.dir.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE hash = ?").run(t, t + SESSION_TTL_MS, h);
    return this.store.userById(row.user_id);
  }

  logout(session: string | undefined): void {
    if (session) this.store.dir.prepare("DELETE FROM sessions WHERE hash = ?").run(sha(session));
  }
}
