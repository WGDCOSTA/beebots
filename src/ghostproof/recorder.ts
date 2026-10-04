// Records the engine's decisions as AgentProof events and sends them to GhostProof. Read-only on the engine's books: it
// scans decisions, orders and fills with cursors, turns the important ones into events (and every decision into an
// hourly digest), and keeps each event in an outbox in the same database, with its local leaf hash and its state:
//   local (not sent yet) -> submitted (in the current epoch) -> verified (in a block, Merkle path checked here)
//   or rejected (schema, conflict, integrity) or expired (older than the gateway's 24 h window before it could be sent).
// "submitted" is never reported as final. Without a token, or while the gateway has no AgentProof route, events stay
// local with their hashes: nothing is lost, and nothing is forced into another event type.
import type { DatabaseSync } from "node:sqlite";
import { log } from "../log.js";
import { GhostProofError, type GhostProofClient } from "./client.js";
import { decisionEvents, digestEvent, fillEvents, important, orderEvent, stored, type Context, type DecisionRow, type FillRow, type OrderRow } from "./events.js";
import type { AgentProofEvent } from "./schema.js";

const SQL = `
CREATE TABLE IF NOT EXISTS ghostproof_outbox (
  id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, call_id TEXT NOT NULL, body TEXT NOT NULL,
  leaf TEXT NOT NULL, status TEXT NOT NULL, epoch_id TEXT, block_height INTEGER, anchor_ref TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ghostproof_outbox_status ON ghostproof_outbox(status, id);
CREATE TABLE IF NOT EXISTS ghostproof_cursor (k TEXT PRIMARY KEY, v INTEGER NOT NULL);`;

const HOUR = 3_600_000;
/** The gateway refuses events older than a day; one that waited longer can no longer be sent. */
const WINDOW_MS = 24 * HOUR - 10 * 60_000;
/** An epoch is a few minutes; a submitted event is looked for in a block after this. */
const VERIFY_AFTER_MS = 6 * 60_000;

export type OutboxStatus = "local" | "submitted" | "verified" | "rejected" | "expired";

export interface RecorderOpts {
  db: DatabaseSync;
  ctx: Context;
  /** null = record locally only (no token or GHOSTPROOF_URL). */
  client: GhostProofClient | null;
  now?: () => number;
}

export class GhostProofRecorder {
  private readonly now: () => number;
  /** The gateway has no AgentProof route yet (404): keep events local, look again in an hour. */
  private routeMissingUntil = 0;
  /** Authentication or scope refused: fail closed, look again in an hour. */
  private blockedUntil = 0;
  private lastError: string | null = null;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;

  constructor(private readonly o: RecorderOpts) {
    this.now = o.now ?? Date.now;
    o.db.exec(SQL);
  }

  private cursor(k: string, init: () => number): number {
    const r = this.o.db.prepare("SELECT v FROM ghostproof_cursor WHERE k = ?").get(k) as { v: number } | undefined;
    if (r) return r.v;
    const v = init();
    this.setCursor(k, v);
    return v;
  }

  private setCursor(k: string, v: number): void {
    this.o.db.prepare("INSERT INTO ghostproof_cursor (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  /** Queues an event once (the same event computed twice is the same row). */
  private enqueue(e: AgentProofEvent): void {
    const s = stored(e);
    const t = this.now();
    this.o.db.prepare("INSERT OR IGNORE INTO ghostproof_outbox (event_id, type, call_id, body, leaf, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'local', ?, ?)").run(s.eventId, e.eventType, e.callId, JSON.stringify(e), s.leafHashB64, Date.parse(e.createdAt), t);
  }

  private evalOf(decisionId: number): { policy: string | null; model: string | null } {
    const r = this.o.db.prepare("SELECT policy_version_id AS p, COALESCE(answered_model, requested_model) AS m FROM decision_evaluations WHERE decision_id = ? ORDER BY CASE arm WHEN 'champion' THEN 0 ELSE 1 END, id LIMIT 1").get(decisionId) as { p: string; m: string } | undefined;
    return { policy: r?.p ?? null, model: r?.m ?? null };
  }

  private decisions(where: string, ...args: Array<number | string>): DecisionRow[] {
    return (this.o.db.prepare(`SELECT id, bee, ts, state_json, menu_json, choice, probabilities_json, confidence, conviction, action_json, vetoed_by, forced_by, status FROM decisions WHERE ${where} ORDER BY id LIMIT 5000`).all(...args) as unknown as Array<Omit<DecisionRow, "policy_version_id" | "model">>).map((r) => {
      const ev = this.evalOf(r.id);
      return { ...r, policy_version_id: ev.policy, model: ev.model };
    });
  }

  /**
   * Looks at what the engine recorded since the last scan. The first scan starts from now (history before the
   * integration was switched on is not sent: it is older than the gateway's window anyway). Returns how many events it queued.
   */
  scan(): number {
    const db = this.o.db;
    const c = this.o.ctx;
    const maxId = (t: string) => Number((db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ${t}`).get() as { n: number }).n);
    let queued = 0;

    const dCur = this.cursor("decisions", () => maxId("decisions"));
    const ds = this.decisions("id > ?", dCur);
    for (const r of ds) {
      if (!important(r)) continue;
      for (const e of decisionEvents(c, r)) {
        this.enqueue(e);
        queued++;
      }
    }
    if (ds.length) this.setCursor("decisions", ds[ds.length - 1]!.id);

    const oCur = this.cursor("orders", () => maxId("orders"));
    const os = db.prepare("SELECT id, decision_id, bee, ts, inst_id, side, contracts, reduce_only, purpose, state, error FROM orders WHERE id > ? ORDER BY id LIMIT 500").all(oCur) as unknown as OrderRow[];
    for (const o of os) {
      const ev = this.evalOf(o.decision_id);
      this.enqueue(orderEvent(c, o, ev.model ?? c.model, ev.policy));
      queued++;
    }
    if (os.length) this.setCursor("orders", os[os.length - 1]!.id);

    const fCur = this.cursor("fills", () => maxId("fills"));
    const fs = db.prepare("SELECT f.id, f.order_id, o.decision_id, f.bee, f.ts, f.inst_id, f.side, f.contracts, f.px, f.notional_usd, f.fee_usd, f.realised_usd FROM fills f LEFT JOIN orders o ON o.id = f.order_id WHERE f.id > ? ORDER BY f.id LIMIT 500").all(fCur) as unknown as FillRow[];
    for (const f of fs) {
      const ev = f.decision_id !== null ? this.evalOf(f.decision_id) : { model: null, policy: null };
      for (const e of fillEvents(c, f, ev.model ?? c.model, ev.policy)) {
        this.enqueue(e);
        queued++;
      }
    }
    if (fs.length) this.setCursor("fills", fs[fs.length - 1]!.id);

    // Hourly digests: every decision of every finished hour, per bunny, as one Merkle root.
    const done = Math.floor(this.now() / HOUR) * HOUR;
    let h = this.cursor("digest_hour", () => done);
    for (let n = 0; h < done && n < 48; n++, h += HOUR) {
      const bees = (db.prepare("SELECT DISTINCT bee FROM decisions WHERE ts >= ? AND ts < ?").all(h, h + HOUR) as Array<{ bee: string }>).map((r) => r.bee);
      for (const bee of bees) {
        const rows = this.decisions("bee = ? AND ts >= ? AND ts < ?", bee, h, h + HOUR);
        if (!rows.length) continue;
        this.enqueue(digestEvent(c, bee, h, rows));
        queued++;
      }
      this.setCursor("digest_hour", h + HOUR);
    }
    return queued;
  }

  private mark(id: number, status: OutboxStatus, f: { epoch?: string; height?: number; anchor?: string; error?: string | null } = {}): void {
    this.o.db.prepare("UPDATE ghostproof_outbox SET status = ?, epoch_id = COALESCE(?, epoch_id), block_height = COALESCE(?, block_height), anchor_ref = COALESCE(?, anchor_ref), error = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(status, f.epoch ?? null, f.height ?? null, f.anchor ?? null, f.error ?? null, this.now(), id);
  }

  /** Sends what is queued, oldest first, until the gateway says stop. */
  async flush(limit = 50): Promise<number> {
    const client = this.o.client;
    const t = this.now();
    // Too old for the gateway's window: say so, never back-date or re-time it.
    this.o.db.prepare("UPDATE ghostproof_outbox SET status = 'expired', error = 'older than the gateway accepts', updated_at = ? WHERE status = 'local' AND created_at < ?").run(t, t - WINDOW_MS);
    if (!client || t < this.routeMissingUntil || t < this.blockedUntil) return 0;
    const rows = this.o.db.prepare("SELECT id, body FROM ghostproof_outbox WHERE status = 'local' ORDER BY id LIMIT ?").all(limit) as Array<{ id: number; body: string }>;
    let sent = 0;
    for (const r of rows) {
      try {
        const res = await client.submit(JSON.parse(r.body) as AgentProofEvent);
        this.mark(r.id, "submitted", { epoch: res.epochId, anchor: res.anchorRef });
        sent++;
      } catch (e) {
        const err = e instanceof GhostProofError ? e : new GhostProofError(String(e), -1, "integrity");
        this.lastError = err.message;
        if (err.code === "not_found") {
          if (!this.routeMissingUntil) log.warn("ghostproof: the gateway has no AgentProof route yet; events stay in the local outbox with their hashes");
          this.routeMissingUntil = this.now() + HOUR;
          break;
        }
        if (err.code === "unauthorized" || err.code === "forbidden") {
          log.warn("ghostproof: the gateway refused the token or its scope; sending stops (fail closed)", { status: err.status });
          this.blockedUntil = this.now() + HOUR;
          break;
        }
        if (err.transient) break; // stays local, tried again next round
        this.mark(r.id, "rejected", { error: err.message.slice(0, 300) });
      }
    }
    return sent;
  }

  /** Looks for submitted events in their epoch's block and checks each Merkle path locally. */
  async verifyPending(limit = 20): Promise<number> {
    const client = this.o.client;
    if (!client || this.now() < this.blockedUntil) return 0;
    const rows = this.o.db.prepare("SELECT id, leaf, epoch_id AS epoch FROM ghostproof_outbox WHERE status = 'submitted' AND updated_at <= ? ORDER BY id LIMIT ?").all(this.now() - VERIFY_AFTER_MS, limit) as Array<{ id: number; leaf: string; epoch: string }>;
    let ok = 0;
    for (const r of rows) {
      try {
        const height = await client.verify(r.leaf, r.epoch);
        if (height === null) continue; // its epoch has no block yet
        this.mark(r.id, "verified", { height, error: null });
        ok++;
      } catch (e) {
        const err = e instanceof GhostProofError ? e : new GhostProofError(String(e), -1, "integrity");
        this.lastError = err.message;
        if (err.transient || err.code === "not_found") break;
        // A proof that does not lead to the block's root: never call it anchored.
        this.mark(r.id, "rejected", { error: `verification failed: ${err.message}`.slice(0, 300) });
      }
    }
    return ok;
  }

  status(): { enabled: boolean; sending: boolean; routeMissing: boolean; blocked: boolean; counts: Record<OutboxStatus, number>; lastError: string | null } {
    const counts: Record<OutboxStatus, number> = { local: 0, submitted: 0, verified: 0, rejected: 0, expired: 0 };
    for (const r of this.o.db.prepare("SELECT status, COUNT(*) AS n FROM ghostproof_outbox GROUP BY status").all() as Array<{ status: OutboxStatus; n: number }>) counts[r.status] = Number(r.n);
    const t = this.now();
    return { enabled: true, sending: !!this.o.client, routeMissing: t < this.routeMissingUntil, blocked: t < this.blockedUntil, counts, lastError: this.lastError };
  }

  start(everyMs = 30_000): void {
    const round = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        this.scan();
        await this.flush();
        await this.verifyPending();
      } catch (e) {
        log.warn("ghostproof: round failed", { error: (e as Error).message });
      } finally {
        this.busy = false;
      }
    };
    const t = setInterval(() => void round(), everyMs);
    t.unref?.();
    this.timers.push(t);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }
}
