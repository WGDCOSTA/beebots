// The Arena's HTTP API. Every state-changing call is a POST with the x-arena header (a cross-site form cannot set it),
// the session is an HttpOnly SameSite=Lax cookie, and nothing here can name another user: the only user a call can reach
// is the one its own session belongs to.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson } from "../gate.js";
import { clientAddr } from "../visitors.js";
import { ArenaAuth, SESSION_TTL_MS } from "./auth.js";
import { AiError, MemberAi, type AiService } from "./ai.js";
import { BotError, Bots, COINS, LIMITS } from "./bots.js";
import type { Leaderboard } from "./ranking.js";
import type { RunStatus } from "./runner.js";
import { isLocale } from "./locales.js";
import { CONSENT_ITEMS, CONSENT_VERSION } from "./store.js";
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
  /** The public leaderboard (null = none). */
  leaderboard?: Leaderboard | null;
  /** Runs members' bots on paper (null = nothing runs them: bots are only stored). */
  runner?: {
    update(userId: string): Promise<void>;
    forget(userId: string): Promise<void>;
    status(userId: string, botIds: string[]): Record<string, RunStatus>;
  } | null;
}

const view = (u: ArenaUser) => ({ id: u.id, email: u.email, tier: u.tier, handle: u.handle, locale: u.locale, createdAt: u.createdAt });

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

  /** Stops an action until the member has accepted the current terms. True means the reply has been sent. */
  private blockedByConsent(res: ServerResponse, u: ArenaUser): boolean {
    if (!this.store.consentNeeded(u.id)) return false;
    reply(res, 403, { error: "Accept the Terms and the Privacy notice to continue.", code: "consent_required" });
    return true;
  }

  /** Returns false for a path that is not the Arena's. */
  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/arena/")) return false;
    const route = path.slice("/arena".length);

    if (req.method === "GET" && route === "/me") {
      const u = this.auth.user(sessionOf(req));
      if (!u) reply(res, 401, { error: "not signed in" });
      else reply(res, 200, { user: view(u), limits: LIMITS[u.tier], consent: { needed: this.store.consentNeeded(u.id), version: CONSENT_VERSION, items: CONSENT_ITEMS } });
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
    if (req.method === "GET" && route === "/leaderboard") {
      // Public: anyone can read the standings. A signed-in member also gets their own bots marked.
      const lb = this.opts.leaderboard;
      if (!lb) return this.send(res, 200, { enabled: false });
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const season = q.get("season");
      const league = q.get("league");
      const st = lb.standings(season && /^\d{4}-W\d{2}$/.test(season) ? season : undefined);
      const me = this.auth.user(sessionOf(req));
      const mine = me ? lb.ownedBy(me.id) : new Set<string>();
      const rows = st.rows.filter((r) => !league || r.league === league).map((r) => ({ ...r, mine: mine.has(r.botId) }));
      return this.send(res, 200, { enabled: true, ...st, rows });
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
      else {
        const bots = new Bots(this.store.tenant(u.id), u.tier, this.now).list();
        reply(res, 200, { bots, runner: this.opts.runner ? { enabled: true, runs: this.opts.runner.status(u.id, bots.map((b) => b.id)) } : { enabled: false, runs: {} } });
      }
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
        const r = await this.auth.requestLink(body.email, addr, body.locale);
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
        if (this.blockedByConsent(res, u)) return true;
        const bots = new Bots(this.store.tenant(u.id), u.tier, this.now);
        try {
          if (route === "/bots/create") {
            reply(res, 200, { bot: bots.create(body) });
            void this.opts.runner?.update(u.id);
          } else if (route === "/bots/update") {
            const bot = bots.update(body.id, body);
            // Taking a bot off the leaderboard is immediate, not at the next sample.
            if (!bot.listed) this.opts.leaderboard?.remove(bot.id);
            reply(res, 200, { bot });
            void this.opts.runner?.update(u.id);
          }
          else if (route === "/bots/versions") reply(res, 200, { versions: bots.versions(body.id) });
          else {
            const gone = bots.find(body.id);
            bots.remove(gone.id);
            this.opts.leaderboard?.remove(gone.id);
            this.store.removePortrait(u.id, gone.id);
            reply(res, 200, { ok: true });
            void this.opts.runner?.update(u.id);
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
        if (this.blockedByConsent(res, u)) return true;
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
      case "/account/consent": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        // Every item has to be ticked: a partial acceptance is no acceptance.
        if (!CONSENT_ITEMS.every((i) => body[i] === true)) return this.send(res, 400, { error: "Tick every box to continue.", code: "consent_incomplete" });
        this.store.acceptConsent(u.id, this.now());
        return this.send(res, 200, { consent: { needed: false, version: CONSENT_VERSION } });
      }
      case "/account/locale": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        if (!isLocale(body.locale)) return this.send(res, 400, { error: "Unknown language." });
        this.store.setLocale(u.id, body.locale);
        return this.send(res, 200, { locale: body.locale });
      }
      case "/account/handle": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        const bad = this.store.setHandle(u.id, body.handle);
        if (bad) return this.send(res, 400, { error: bad });
        const handle = this.store.userById(u.id)!.handle;
        this.opts.leaderboard?.rename(u.id, handle);
        return this.send(res, 200, { handle });
      }
      case "/account/delete": {
        const u = this.auth.user(sessionOf(req));
        if (!u) reply(res, 401, { error: "not signed in" });
        else if (body.confirm !== u.email) reply(res, 400, { error: "Type your e-mail address to confirm." });
        else {
          await this.opts.runner?.forget(u.id); // close the paper files before they are deleted
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
