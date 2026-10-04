// The platform operator's controls for the Arena, used by the owner's admin panel (admin/admin.ts, "Arena" tab).
// Served on the Arena's own port under /ops/* only: the public reverse proxy forwards /arena/* and never /ops/*, so this
// is reachable only inside the Docker network, and every call must carry ARENA_OPS_TOKEN (unset = closed).
// It lists every member's agents with their paper results and changes their state (pause, resume, stop) through the
// same path a member's own buttons use (Bots.setState, then runner.update). It never reads model keys, rules text or
// e-mail addresses: the operator sees public names, agents and results.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Bots, BotError, type BotState } from "./bots.js";
import type { RunStatus } from "./runner.js";
import type { ArenaStore } from "./store.js";
import { log } from "../log.js";

export interface OpsRunner {
  status(userId: string, botIds: string[]): Record<string, RunStatus>;
  update(userId: string): Promise<void>;
  running: number;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("too large");
  }
  const b = raw ? JSON.parse(raw) : {};
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

const ACTIONS: Record<string, BotState> = { pause: "paused", resume: "running", stop: "stopped" };

export class ArenaOps {
  constructor(
    private readonly store: ArenaStore,
    private readonly runner: OpsRunner | null,
    private readonly token: string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  get open(): boolean {
    return !!this.token && this.token.length >= 24;
  }

  private authorised(req: IncomingMessage): boolean {
    if (!this.open) return false;
    const got = Buffer.from(String(req.headers["x-ops-token"] ?? ""));
    const want = Buffer.from(this.token!);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** Every member's agents with their state and paper results. */
  agents() {
    const out: Array<Record<string, unknown>> = [];
    const states: Record<string, number> = {};
    for (const userId of this.store.allUserIds()) {
      const u = this.store.userById(userId);
      if (!u) continue;
      const bots = new Bots(this.store.tenant(userId), u.tier, this.now).list();
      const runs = this.runner?.status(userId, bots.map((b) => b.id)) ?? {};
      for (const b of bots) {
        const r = runs[b.id];
        states[b.state] = (states[b.state] ?? 0) + 1;
        out.push({
          userId,
          handle: u.handle,
          tier: u.tier,
          botId: b.id,
          name: b.name,
          theme: b.theme,
          avatar: b.avatar,
          image: b.image,
          mode: b.mode,
          style: b.style,
          coins: b.coins,
          listed: b.listed,
          version: b.version,
          brains: b.brains.length,
          state: b.state,
          run: r
            ? { state: r.state, equityUsd: r.equityUsd ?? null, startUsd: r.startEquityUsd ?? null, pnlPct: r.pnlPct ?? null, decisions: r.decisions ?? null, spentUsd: r.spentUsd ?? null, position: r.position ? `${r.position.side} ${r.position.coin}` : null }
            : null,
        });
      }
    }
    return { members: this.store.allUserIds().length, agents: out, states, running: this.runner?.running ?? 0, at: this.now() };
  }

  /** Change one agent (userId + botId) or every agent ({ all: true }). A change that does not apply is skipped, not failed. */
  async setState(body: Record<string, unknown>) {
    const to = ACTIONS[String(body.action ?? "")];
    if (!to) return { status: 400, body: { error: "action: pause, resume or stop" } };
    const targets: Array<{ userId: string; botId?: string }> = body.all === true ? this.store.allUserIds().map((userId) => ({ userId })) : [{ userId: String(body.userId ?? ""), botId: String(body.botId ?? "") }];
    let changed = 0;
    const skipped: string[] = [];
    for (const t of targets) {
      const u = this.store.userById(t.userId);
      if (!u) {
        skipped.push(`${t.userId}: no such member`);
        continue;
      }
      const bots = new Bots(this.store.tenant(t.userId), u.tier, this.now);
      for (const b of bots.list()) {
        if (t.botId && b.id !== t.botId) continue;
        try {
          bots.setState(b.id, to);
          changed++;
        } catch (e) {
          skipped.push(`${b.name}: ${e instanceof BotError ? e.message : "could not change"}`);
        }
      }
      await this.runner?.update(t.userId);
    }
    this.store.audit(null, `operator ${body.action} ${body.all === true ? "every agent" : String(body.botId ?? "")}: ${changed} changed`, this.now());
    log.info("arena ops: state change", { action: body.action, all: body.all === true, changed, skipped: skipped.length });
    return { status: 200, body: { changed, skipped: skipped.slice(0, 50), ...this.agents() } };
  }

  /** Handles /ops/*. Returns false for any other path. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/ops/")) return false;
    if (!this.authorised(req)) {
      send(res, this.open ? 401 : 503, { error: this.open ? "not authorised" : "operator controls are off (ARENA_OPS_TOKEN)" });
      return true;
    }
    if (req.method === "GET" && path === "/ops/agents") {
      send(res, 200, this.agents());
      return true;
    }
    if (req.method === "POST" && path === "/ops/state") {
      let body: Record<string, unknown>;
      try {
        body = await readBody(req);
      } catch {
        send(res, 400, { error: "bad request" });
        return true;
      }
      const r = await this.setState(body);
      send(res, r.status, r.body);
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  }
}
