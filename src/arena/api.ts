// The Arena's HTTP API. Every state-changing call is a POST with the x-arena header (a cross-site form cannot set it),
// the session is an HttpOnly SameSite=Lax cookie, and nothing here can name another user: the only user a call can reach
// is the one its own session belongs to.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson } from "../gate.js";
import { clientAddr } from "../visitors.js";
import { ArenaAuth, SESSION_TTL_MS } from "./auth.js";
import { AiError, MemberAi, type AiService } from "./ai.js";
import { BotError, Bots, COINS, LIMITS, type BotView } from "./bots.js";
import type { Leaderboard } from "./ranking.js";
import type { RunStatus } from "./runner.js";
import { isLocale } from "./locales.js";
import { CONSENT_ITEMS, CONSENT_VERSION } from "./store.js";
import { Billing, BillingError } from "./billing.js";
import { PLAN_PRICES } from "./plans.js";
import { TEMPLATES } from "./templates.js";
import { PROVIDERS, DEFAULT_MODEL, MAX_KEYS, VaultError, type Vault } from "./vault.js";
import { THEMES } from "./themes.js";
import type { Insights } from "./insights.js";
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
  /** The key vault for members' own model keys (null = closed). */
  vault?: Vault | null;
  /** Plans and payment (null = payments are not open: everyone is on Free). */
  billing?: Billing | null;
  /** Runs members' bots on paper (null = nothing runs them: bots are only stored). */
  runner?: {
    update(userId: string): Promise<void>;
    forget(userId: string): Promise<void>;
    status(userId: string, botIds: string[]): Record<string, RunStatus>;
    styleLog?(userId: string, bot: BotView): Array<{ ts: number; style: string; reason: string; changed: boolean }>;
    insights?(userId: string, bot: BotView, opts?: { decisions?: number; trades?: number; points?: number }): Insights | null;
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

  /** The billing service, or a closed one when payments are not set up. */
  private billing(): Billing {
    return this.opts.billing ?? new Billing(this.store, null, null, () => {}, this.now);
  }

  /** The member's keys, or null while the vault is closed. */
  private keysOf(u: ArenaUser) {
    return this.opts.vault?.open ? this.opts.vault.for(this.store.tenant(u.id), u.id, this.now) : null;
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
      else reply(res, 200, { user: view(u), limits: LIMITS[u.tier], consent: { needed: this.store.consentNeeded(u.id), version: CONSENT_VERSION, items: CONSENT_ITEMS }, billing: this.billing().view(u) });
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
    if (req.method === "GET" && route === "/billing/plans") {
      // Public, like the catalogue: what each plan includes and costs.
      const me = this.auth.user(sessionOf(req));
      const plans = (["free", "pro", "premium"] as const).map((id) => ({ id, price: id === "free" ? null : PLAN_PRICES[id], limits: LIMITS[id] }));
      return this.send(res, 200, { open: this.billing().open, plans, current: me ? this.billing().view(me) : null });
    }
    if (req.method === "GET" && route === "/keys") {
      // Never the secret: provider, name, model, the last four characters.
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      const keys = this.keysOf(u);
      return this.send(res, 200, { open: !!keys, max: MAX_KEYS, providers: PROVIDERS.map((id) => ({ id, model: DEFAULT_MODEL[id] })), keys: keys?.list() ?? [] });
    }
    if (req.method === "GET" && route === "/templates") {
      // Starter agents: examples to edit, never advice. Public, like the catalogue.
      reply(res, 200, { templates: TEMPLATES });
      return true;
    }
    if (req.method === "GET" && route === "/bots/insights") {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      if (this.blockedByConsent(res, u)) return true;
      try {
        const id = new URL(req.url ?? "/", "http://localhost").searchParams.get("id");
        const bot = new Bots(this.store.tenant(u.id), u.tier, this.now).find(id);
        return this.send(res, 200, { bot, insights: this.opts.runner?.insights?.(u.id, bot) ?? null, styleLog: this.opts.runner?.styleLog?.(u.id, bot) ?? [] });
      } catch (e) {
        if (e instanceof BotError) return this.send(res, e.status, { error: e.message });
        throw e;
      }
    }
    if (req.method === "GET" && route === "/bots") {
      const u = this.auth.user(sessionOf(req));
      if (!u) reply(res, 401, { error: "not signed in" });
      else {
        const bots = new Bots(this.store.tenant(u.id), u.tier, this.now).list();
        // The small equity curve on each card comes with the list, so the Home needs one call.
        const curves: Record<string, number[]> = {};
        for (const b of bots) {
          const c = this.opts.runner?.insights?.(u.id, b, { decisions: 0, trades: 0, points: 30 })?.equity;
          if (c && c.length > 1) curves[b.id] = c.map((p) => p[1]);
        }
        reply(res, 200, { bots, curves, runner: this.opts.runner ? { enabled: true, runs: this.opts.runner.status(u.id, bots.map((b) => b.id)) } : { enabled: false, runs: {} } });
      }
      return true;
    }
    if (req.method !== "POST") {
      reply(res, 405, { error: "method not allowed" });
      return true;
    }
    if (route === "/billing/webhook") {
      // Stripe calls this, so it has no x-arena header and no cookie: the signature over the exact bytes is the whole proof.
      let raw = "";
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > 512 * 1024) throw new Error("too large");
          chunks.push(c as Buffer);
        }
        raw = Buffer.concat(chunks).toString("utf8");
        await this.billing().webhook(raw, typeof req.headers["stripe-signature"] === "string" ? req.headers["stripe-signature"] : undefined);
        return this.send(res, 200, { received: true });
      } catch (e) {
        if (e instanceof BillingError) return this.send(res, e.status, { error: e.message });
        return this.send(res, 400, { error: "bad request" });
      }
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
      case "/bots/versions":
      case "/bots/state":
      case "/bots/state-all": {
        const u = this.auth.user(sessionOf(req));
        if (!u) {
          reply(res, 401, { error: "not signed in" });
          return true;
        }
        if (this.blockedByConsent(res, u)) return true;
        const bots = new Bots(this.store.tenant(u.id), u.tier, this.now);
        // A model key an agent is set to must be the member's own: the page names it by id, and the id is checked here.
        if (route === "/bots/create" || route === "/bots/update") {
          if (body.brainKey === "" ) body.brainKey = null;
          if (typeof body.brainKey === "string" && !this.keysOf(u)?.has(body.brainKey)) return this.send(res, 400, { error: "That model key is not yours, or it no longer exists." });
        }
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
          else if (route === "/bots/state") {
            // pause: keeps positions under their stops, opens nothing new. stop: closes positions and ends the run.
            const to = { pause: "paused", resume: "running", stop: "stopped" }[String(body.to)];
            const bot = body.to === "again" ? bots.startAgain(body.id) : to ? bots.setState(body.id, to as "paused" | "running" | "stopped") : null;
            if (!bot) return this.send(res, 400, { error: "Unknown action." });
            await this.opts.runner?.update(u.id);
            reply(res, 200, { bot });
          } else if (route === "/bots/state-all") {
            if (body.to !== "pause" && body.to !== "resume") return this.send(res, 400, { error: "Unknown action." });
            const changed = bots.setAll(body.to === "pause" ? "paused" : "running");
            await this.opts.runner?.update(u.id);
            reply(res, 200, { changed });
          }
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
      case "/keys/add":
      case "/keys/delete": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        if (this.blockedByConsent(res, u)) return true;
        const keys = this.keysOf(u);
        if (!keys) return this.send(res, 503, { error: "Your own model keys are not open yet." });
        try {
          if (route === "/keys/add") {
            // Each add calls the provider once to prove the key works, so it is rate limited.
            if (this.store.tooMany(`keys:${u.id}`, 10, this.now())) return this.send(res, 429, { error: "Too many tries. Wait a little and try again." });
            return this.send(res, 200, { key: await keys.add(body) });
          }
          const id = typeof body.id === "string" ? body.id : "";
          // A key that an agent thinks with cannot be removed from under it.
          const using = new Bots(this.store.tenant(u.id), u.tier, this.now).list().filter((b) => b.brainKey === id);
          if (using.length) return this.send(res, 409, { error: `Agents still use this key: ${using.map((b) => b.name).join(", ")}. Switch them to the platform model first.` });
          keys.remove(id);
          return this.send(res, 200, { ok: true });
        } catch (e) {
          if (e instanceof VaultError) return this.send(res, e.status, { error: e.message });
          throw e;
        }
      }
      case "/billing/checkout":
      case "/billing/portal": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        if (this.blockedByConsent(res, u)) return true;
        try {
          const url = route === "/billing/checkout" ? await this.billing().checkout(u, body.plan, u.locale) : await this.billing().portal(u);
          return this.send(res, 200, { url });
        } catch (e) {
          if (e instanceof BillingError) return this.send(res, e.status, { error: e.message });
          return this.send(res, 502, { error: "Could not reach the payment service. Try again in a minute." });
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
          // A subscription must not outlive the account: if Stripe cannot be told, the account stays and the member can retry.
          if (!(await this.billing().cancelFor(u.id))) return this.send(res, 502, { error: "Could not cancel your subscription. Try again in a minute, or cancel it from Manage billing first." });
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
