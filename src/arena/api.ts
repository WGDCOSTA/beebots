// The Arena's HTTP API. Every state-changing call is a POST with the x-arena header (a cross-site form cannot set it),
// the session is an HttpOnly SameSite=Lax cookie, and nothing here can name another user: the only user a call can reach
// is the one its own session belongs to.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson } from "../gate.js";
import { clientAddr } from "../visitors.js";
import { ArenaAuth, SESSION_TTL_MS } from "./auth.js";
import { AiError, MemberAi, type AiService } from "./ai.js";
import { BotError, Bots, COINS, LIMITS } from "./bots.js";
import { THEMES } from "./themes.js";
import type { ArenaStore, ArenaUser } from "./store.js";

const COOKIE = "arena_session";
const MAX_BODY = 4 * 1024;

export interface ApiOpts {
  /** Mark the cookie Secure (true whenever the site is served over https). */
  secureCookie: boolean;
  now?: () => number;
  /** The platform's AI help for a member's first bot (null = off). */
  ai?: AiService | null;
  /** AI calls the whole platform may spend in a day. */
  aiDailyLimit?: number;
}

const view = (u: ArenaUser) => ({ id: u.id, email: u.email, tier: u.tier, createdAt: u.createdAt });

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function sessionOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return undefined;
}

export class ArenaApi {
  private readonly now: () => number;
  constructor(private readonly auth: ArenaAuth, private readonly store: ArenaStore, private readonly opts: ApiOpts) {
    this.now = opts.now ?? Date.now;
  }

  private cookie(value: string, maxAgeSec: number): string {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${this.opts.secureCookie ? "; Secure" : ""}`;
  }

  private send(res: ServerResponse, status: number, body: unknown): true {
    reply(res, status, body);
    return true;
  }

  private memberAi(u: ArenaUser): MemberAi {
    return new MemberAi(this.store.tenant(u.id), u.tier, this.opts.ai ?? null, {
      now: this.now,
      dailyLimit: this.opts.aiDailyLimit ?? 100,
      today: (day, add) => this.store.aiToday(day, add),
    });
  }

  /** Returns false for a path that is not the Arena's. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/arena/")) return false;
    const route = path.slice("/arena".length);

    if (req.method === "GET" && route === "/me") {
      const u = this.auth.user(sessionOf(req));
      if (!u) reply(res, 401, { error: "not signed in" });
      else reply(res, 200, { user: view(u), limits: LIMITS[u.tier] });
      return true;
    }
    if (req.method === "GET" && route.startsWith("/bot-image/")) {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      const id = route.slice("/bot-image/".length);
      let jpg: Buffer | null = null;
      try {
        jpg = this.store.readPortrait(u.id, id);
      } catch {
        jpg = null;
      }
      if (!jpg) return this.send(res, 404, { error: "no portrait" });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=300" });
      res.end(jpg);
      return true;
    }
    if (req.method === "GET" && route === "/ai/status") {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      return this.send(res, 200, this.memberAi(u).status());
    }
    if (req.method === "GET" && route === "/catalogue") {
      reply(res, 200, { themes: THEMES, coins: COINS, limits: LIMITS });
      return true;
    }
    if (req.method === "GET" && route === "/bots") {
      const u = this.auth.user(sessionOf(req));
      if (!u) reply(res, 401, { error: "not signed in" });
      else reply(res, 200, { bots: new Bots(this.store.tenant(u.id), u.tier, this.now).list() });
      return true;
    }
    if (req.method !== "POST") {
      reply(res, 405, { error: "method not allowed" });
      return true;
    }
    if (req.headers["x-arena"] !== "1") {
      reply(res, 403, { error: "missing x-arena header" });
      return true;
    }
    let body: Record<string, unknown>;
    try {
      const b = await readJson(req, MAX_BODY);
      body = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      reply(res, 400, { error: "bad request" });
      return true;
    }

    switch (route) {
      case "/auth/request": {
        const addr = clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress);
        const r = await this.auth.requestLink(body.email, addr);
        if (r.ok) reply(res, 200, { ok: true, message: "If that address can sign in, a link is on its way." });
        else reply(res, 400, { error: "Enter a valid e-mail address." });
        return true;
      }
      case "/auth/verify": {
        const r = this.auth.verify(body.token);
        if (!r) reply(res, 400, { error: "This link is invalid, expired or already used. Ask for a new one." });
        else reply(res, 200, { user: view(r.user) }, { "set-cookie": this.cookie(r.session, Math.floor(SESSION_TTL_MS / 1000)) });
        return true;
      }
      case "/auth/logout": {
        this.auth.logout(sessionOf(req));
        reply(res, 200, { ok: true }, { "set-cookie": this.cookie("", 0) });
        return true;
      }
      case "/bots/create":
      case "/bots/update":
      case "/bots/delete":
      case "/bots/versions": {
        const u = this.auth.user(sessionOf(req));
        if (!u) {
          reply(res, 401, { error: "not signed in" });
          return true;
        }
        const bots = new Bots(this.store.tenant(u.id), u.tier, this.now);
        try {
          if (route === "/bots/create") reply(res, 200, { bot: bots.create(body) });
          else if (route === "/bots/update") reply(res, 200, { bot: bots.update(body.id, body) });
          else if (route === "/bots/versions") reply(res, 200, { versions: bots.versions(body.id) });
          else {
            const gone = bots.find(body.id);
            bots.remove(gone.id);
            this.store.removePortrait(u.id, gone.id);
            reply(res, 200, { ok: true });
          }
        } catch (e) {
          if (e instanceof BotError) reply(res, e.status, { error: e.message });
          else throw e;
        }
        return true;
      }
      case "/ai/design":
      case "/ai/portrait": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        const ai = this.memberAi(u);
        try {
          if (route === "/ai/design") return this.send(res, 200, { draft: await ai.design(body.description) });
          const bots = new Bots(this.store.tenant(u.id), u.tier, this.now);
          const bot = bots.find(body.id);
          this.store.savePortrait(u.id, bot.id, await ai.paint(bot));
          bots.setImage(bot.id, true);
          return this.send(res, 200, { bot: bots.find(bot.id), ai: ai.status() });
        } catch (e) {
          if (e instanceof AiError || e instanceof BotError) return this.send(res, e.status, { error: e.message });
          throw e;
        }
      }
      case "/account/delete": {
        const u = this.auth.user(sessionOf(req));
        if (!u) reply(res, 401, { error: "not signed in" });
        else if (body.confirm !== u.email) reply(res, 400, { error: "Type your e-mail address to confirm." });
        else {
          this.store.deleteUser(u.id, this.now());
          reply(res, 200, { ok: true }, { "set-cookie": this.cookie("", 0) });
        }
        return true;
      }
      default:
        reply(res, 404, { error: "not found" });
        return true;
    }
  }
}
