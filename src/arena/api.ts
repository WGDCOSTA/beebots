// The Arena's HTTP API. Every state-changing call is a POST with the x-arena header (a cross-site form cannot set it),
// the session is an HttpOnly SameSite=Lax cookie, and nothing here can name another user: the only user a call can reach
// is the one its own session belongs to.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson } from "../gate.js";
import { clientAddr } from "../visitors.js";
import { ArenaAuth, SESSION_TTL_MS } from "./auth.js";
import { AiError, MemberAi, type AiService } from "./ai.js";
import { BotError, Bots, COINS, LIMITS, PLATFORM, type BotView } from "./bots.js";
import type { Leaderboard } from "./ranking.js";
import type { RunStatus } from "./runner.js";
import { isLocale } from "./locales.js";
import { CONSENT_ITEMS, CONSENT_VERSION } from "./store.js";
import { Billing, BillingError } from "./billing.js";
import { PLAN_PRICES } from "./plans.js";
import { TEMPLATES } from "./templates.js";
import type { Skill } from "../lab/skills/index.js";
import { libraryOf, SkillBank, SkillError } from "./skills.js";
import { PROVIDERS, DEFAULT_MODEL, MAX_KEYS, VaultError, type Vault } from "./vault.js";
import { THEMES } from "./themes.js";
import type { Insights } from "./insights.js";
import { AgentChat, ChatLog, type ChatAgent, type ChatMarket, type OwnContext } from "./chat.js";
import { PublicChat } from "../publicChat.js";
import type { LlmClient } from "../brains/llm.js";
import type { CandleStore } from "./history.js";
import { BACKTESTS_PER_DAY, backtestSkill, TrainError, TRAININGS_PER_DAY, TRAIN_DAYS, usage, type Trainer } from "./training.js";
import type { ArenaStore, ArenaUser } from "./store.js";

export interface Operator {
  name?: string;
  address?: string;
  companyNo?: string;
  vat?: string;
  email?: string;
  privacyEmail?: string;
  /** The date counsel signed the legal texts off (YYYY-MM-DD). While it is empty the pages say they are drafts. */
  reviewedOn?: string;
}

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
  /** Who operates the Arena, for the legal pages. Fields not set stay empty and the pages show them as missing. */
  operator?: Operator;
  /** The platform's skill library members can keep in their slots. */
  library?: readonly Skill[];
  /** The key vault for members' own model keys (null = closed). */
  vault?: Vault | null;
  /** Plans and payment (null = payments are not open: everyone is on Free). */
  billing?: Billing | null;
  /** The agent chat: real market candles and the platform's model (null = chat is off). */
  chat?: { market: ChatMarket; llm: LlmClient | null; dailyLimit?: number; publicPerHour?: number; publicDailyLimit?: number } | null;
  /** Stored historical candles (null = none: backtests and training are off). */
  history?: CandleStore | null;
  /** Replays agents over history (null = training is off). */
  trainer?: Trainer | null;
  /** Runs members' bots on paper (null = nothing runs them: bots are only stored). */
  runner?: {
    update(userId: string): Promise<void>;
    forget(userId: string): Promise<void>;
    status(userId: string, botIds: string[]): Record<string, RunStatus>;
    styleLog?(userId: string, bot: BotView): Array<{ ts: number; style: string; reason: string; changed: boolean }>;
    insights?(userId: string, bot: BotView, opts?: { decisions?: number; trades?: number; points?: number }): Insights | null;
    /** The member's running agents as the live board draws a bunny (runner.live). */
    live?(userId: string, botIds: string[]): Record<string, { bee: unknown; curve: Array<[number, number]>; decisions: unknown[] }>;
    /** One running agent's full profile (runner.profile). */
    profile?(userId: string, botId: string, days?: number): unknown | null;
  } | null;
}

/** The platform's own accounts whose agents are shown in full on the Arena's live board (ARENA_HOUSE_HANDLES). */
const HOUSE_HANDLES = (process.env.ARENA_HOUSE_HANDLES ?? "glitchbunny,glitchbunny-labs").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);

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

/** An agent's own record, as the chat sees it. */
function ownContextOf(ins: Insights): OwnContext {
  const last = ins.decisions[0];
  return {
    equity: ins.equity,
    position: last?.did.kind && last.did.kind !== "none" ? `${last.did.kind} ${last.did.coin ?? ""}`.trim() : null,
    pnlPct: ins.equity.length > 1 && ins.equity[0]![1] > 0 ? Number((((ins.equity[ins.equity.length - 1]![1] - ins.equity[0]![1]) / ins.equity[0]![1]) * 100).toFixed(2)) : null,
    decisions: ins.decisions.map((d) => ({ ts: d.ts, did: d.did.kind, choice: d.choice, confidencePct: d.confidence === null ? null : Math.round(d.confidence * 100), rule: d.vetoedBy ?? d.forcedBy })),
    trades: ins.trades.map((t) => ({ ts: t.ts, coin: t.coin, side: t.side, sizeUsd: t.sizeUsd, realisedUsd: t.realisedUsd })),
  };
}

export class ArenaApi {
  private readonly now: () => number;
  /** The live board's answer, shared by every visitor for 5 s (it is public, so a crowd costs one read). */
  private showcase: { at: number; body: unknown } | null = null;

  /** The house accounts' ids, by their public names. */
  private houseIds(): string[] {
    return this.store.allUserIds().filter((id) => HOUSE_HANDLES.includes(this.store.userById(id)?.handle ?? ""));
  }
  /** Visitors' chat with the house agents (publicChat.ts): the platform's model, read-only, nothing stored. */
  private readonly houseChat: PublicChat | null;

  constructor(private readonly auth: ArenaAuth, private readonly store: ArenaStore, private readonly opts: ApiOpts) {
    this.now = opts.now ?? Date.now;
    const c = opts.chat;
    this.houseChat = c
      ? new PublicChat({
          market: c.market,
          agent: (id) => this.houseBot(id)?.agent ?? null,
          llm: (id) => (this.houseBot(id) ? c.llm : null),
          own: (id) => {
            const h = this.houseBot(id);
            const ins = h ? (this.opts.runner?.insights?.(h.uid, h.bot, { decisions: 12, trades: 12, points: 120 }) ?? null) : null;
            return ins ? ownContextOf(ins) : null;
          },
          perHour: c.publicPerHour ?? 5,
          dailyLimit: c.publicDailyLimit ?? 300,
          now: this.now,
        })
      : null;
  }

  /** A house agent that is shown on the live board, with its owner, or null. */
  private houseBot(id: string): { uid: string; bot: BotView; agent: ChatAgent } | null {
    for (const uid of this.houseIds()) {
      const u = this.store.userById(uid);
      if (!u) continue;
      const bot = new Bots(this.store.tenant(uid), u.tier, this.now).list().find((b) => b.id === id && b.listed);
      if (bot) return { uid, bot, agent: { name: bot.name, tagline: bot.tagline, style: bot.style, mode: bot.mode, rules: bot.rules, coins: bot.coins, state: bot.state } };
    }
    return null;
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

  /** Historical data (Pro and Premium): what is stored, a skill's backtest, and an agent's simulated trainings. */
  private async history(req: IncomingMessage, res: ServerResponse, route: string, u: ArenaUser): Promise<true> {
    const h = this.opts.history ?? null;
    const trainer = this.opts.trainer ?? null;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const db = this.store.tenant(u.id);
    const allowed = LIMITS[u.tier].history;
    const q = new URL(req.url ?? "/", "http://x").searchParams;
    try {
      if (req.method === "GET") {
        if (route === "/history") {
          const coins = new Map<string, { coin: string; from: number; to: number }>();
          for (const c of h?.summary() ?? []) if (c.bar === "1H") coins.set(c.coin, { coin: c.coin, from: c.from, to: c.to });
          return this.send(res, 200, { open: !!h, allowed, days: TRAIN_DAYS, coins: [...coins.values()], syncedAt: h?.lastSyncAt ?? 0, backtests: { perDay: BACKTESTS_PER_DAY[u.tier], used: usage(db, day, "backtest") } });
        }
        if (route === "/bots/train") {
          const bot = new Bots(db, u.tier, this.now).find(q.get("id"));
          return this.send(res, 200, { open: !!trainer, allowed, days: TRAIN_DAYS, perDay: TRAININGS_PER_DAY[u.tier], used: usage(db, day, "train"), trainings: trainer?.list(u.id, bot.id) ?? [] });
        }
        if (route === "/bots/train/detail") {
          const t = trainer?.get(u.id, q.get("id") ?? "") ?? null;
          if (!t) return this.send(res, 404, { error: "No such training." });
          return this.send(res, 200, { training: t, insights: trainer!.insights(u.id, t) });
        }
        return this.send(res, 404, { error: "not found" });
      }
      if (req.method !== "POST" || req.headers["x-arena"] !== "1") return this.send(res, 403, { error: "bad request" });
      const body = (await readJson(req, MAX_BODY)) as { id?: unknown; days?: unknown; skill?: unknown; coin?: unknown };
      if (!allowed) return this.send(res, 403, { error: "Historical data is part of Pro and Premium.", code: "plan" });
      if (route === "/skills/backtest") {
        if (!h) return this.send(res, 503, { error: "Historical data is not available right now.", code: "closed" });
        if (usage(db, day, "backtest") >= BACKTESTS_PER_DAY[u.tier]) return this.send(res, 429, { error: "You have used today's backtests for your plan.", code: "backtest_limit" });
        const skill = new SkillBank(db, u.tier, this.opts.library ?? [], this.now).resolve(typeof body.skill === "string" ? body.skill : "");
        if (!skill) return this.send(res, 404, { error: "That skill is not in your slots." });
        const result = backtestSkill(h, skill, typeof body.coin === "string" ? body.coin.toUpperCase() : "", Number(body.days), this.now());
        usage(db, day, "backtest", 1);
        return this.send(res, 200, { result, used: usage(db, day, "backtest") });
      }
      if (!trainer) return this.send(res, 503, { error: "Training is not available right now.", code: "closed" });
      if (route === "/bots/train/start") {
        const bot = new Bots(db, u.tier, this.now).find(typeof body.id === "string" ? body.id : null);
        return this.send(res, 200, { training: trainer.start(u.id, u.tier, bot, Number(body.days)), used: usage(db, day, "train") });
      }
      if (route === "/bots/train/cancel") {
        trainer.cancel(u.id, typeof body.id === "string" ? body.id : "");
        return this.send(res, 200, { ok: true });
      }
      return this.send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof TrainError) return this.send(res, e.status, { error: e.message, code: e.code });
      if (e instanceof BotError) return this.send(res, e.status, { error: e.message });
      throw e;
    }
  }

  /** Chat with one of the member's own agents. Read-only: it can look at markets and talk, never trade or change anything. */
  private async chat(req: IncomingMessage, res: ServerResponse, route: string, u: ArenaUser): Promise<true> {
    const cfg = this.opts.chat;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const log = new ChatLog(this.store.tenant(u.id));
    const limit = LIMITS[u.tier].chatPerDay;
    try {
      if (req.method === "GET") {
        const bot = new Bots(this.store.tenant(u.id), u.tier, this.now).find(new URL(req.url ?? "/", "http://x").searchParams.get("id"));
        return this.send(res, 200, { open: !!cfg, limit, used: log.usedToday(day), messages: log.list(bot.id) });
      }
      if (req.method !== "POST" || req.headers["x-arena"] !== "1") return this.send(res, 403, { error: "bad request" });
      const body = (await readJson(req, MAX_BODY)) as { id?: unknown; text?: unknown };
      const bot = new Bots(this.store.tenant(u.id), u.tier, this.now).find(typeof body.id === "string" ? body.id : null);
      if (route === "/bots/chat/clear") {
        log.clear(bot.id);
        return this.send(res, 200, { messages: [] });
      }
      if (!cfg) return this.send(res, 503, { error: "Chat is not open right now.", code: "chat_closed" });
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
      if (!text) return this.send(res, 400, { error: "Write a question first." });
      if (log.usedToday(day) >= limit) return this.send(res, 429, { error: "You have used today's chat messages for your plan.", code: "chat_limit" });
      // The model is the agent's first brain: the platform's, or the member's own key. An own key that is gone never falls back.
      const first = bot.brains[0] ?? PLATFORM;
      let llm: LlmClient | null = cfg.llm;
      let own = false;
      if (first !== PLATFORM) {
        const k = this.keysOf(u)?.secret(first);
        if (!k) return this.send(res, 409, { error: "This agent's own model key is not available.", code: "no_key" });
        llm = this.opts.vault!.brain(k.provider, k.secret, k.model);
        own = true;
      }
      if (!llm) return this.send(res, 503, { error: "Chat is not open right now.", code: "chat_closed" });
      const cap = cfg.dailyLimit ?? 2000;
      if (!own && this.store.aiToday("chat:" + day) >= cap) return this.send(res, 429, { error: "Chat is busy today. Try again tomorrow.", code: "chat_busy" });
      log.spend(day);
      if (!own) this.store.aiToday("chat:" + day, 1);
      const ins = this.opts.runner?.insights?.(u.id, bot, { decisions: 12, trades: 12, points: 120 }) ?? null;
      const ownCtx: OwnContext | null = ins ? ownContextOf(ins) : null;
      const history = log.list(bot.id).slice(-8).map((m) => ({ role: m.role, text: m.text || m.report?.headline || "" }));
      const asked = log.add(bot.id, "you", this.now(), text);
      let msg;
      try {
        const r = await new AgentChat({ llm, market: cfg.market, now: this.now }).reply({ agent: { name: bot.name, tagline: bot.tagline, style: bot.style, mode: bot.mode, rules: bot.rules, coins: bot.coins, state: bot.state }, text, history, locale: u.locale, own: ownCtx });
        msg = log.add(bot.id, "agent", this.now(), r.text, r.report, r.unavailable);
      } catch {
        log.remove(asked.id); // nothing came back: the question is not kept without an answer
        return this.send(res, 502, { error: "The agent could not answer just now. Try again.", code: "chat_failed" });
      }
      return this.send(res, 200, { message: msg, used: log.usedToday(day), limit });
    } catch (e) {
      if (e instanceof BotError) return this.send(res, e.status, { error: e.message });
      throw e;
    }
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
    if (req.method === "GET" && route === "/operator") {
      // Public: the legal pages name the operator and the contact addresses. Nothing here is about a member.
      const o = this.opts.operator ?? {};
      return this.send(res, 200, { name: o.name ?? "", address: o.address ?? "", companyNo: o.companyNo ?? "", vat: o.vat ?? "", email: o.email ?? "", privacyEmail: o.privacyEmail ?? o.email ?? "", reviewedOn: /^\d{4}-\d{2}-\d{2}$/.test(o.reviewedOn ?? "") ? o.reviewedOn : "" });
    }
    if (req.method === "GET" && route === "/skills") {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      const bank = new SkillBank(this.store.tenant(u.id), u.tier, this.opts.library ?? [], this.now);
      const bots = new Bots(this.store.tenant(u.id), u.tier, this.now).list();
      const skills = bank.list().map((s) => ({ ...s, usedBy: bots.filter((b) => b.skill === s.id).map((b) => ({ id: b.id, name: b.name })) }));
      return this.send(res, 200, { slots: bank.slots, skills, library: libraryOf(this.opts.library ?? []) });
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
    if (route === "/history" || route.startsWith("/bots/train") || route === "/skills/backtest") {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      if (this.blockedByConsent(res, u)) return true;
      return this.history(req, res, route, u);
    }
    if (route === "/bots/chat" || route === "/bots/chat/send" || route === "/bots/chat/clear") {
      const u = this.auth.user(sessionOf(req));
      if (!u) return this.send(res, 401, { error: "not signed in" });
      if (this.blockedByConsent(res, u)) return true;
      return this.chat(req, res, route, u);
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
    // The platform's own example agents (the "house"), shown in full to everyone: the Arena's live board. Members' agents
    // are never here; their results reach the public only through the leaderboard.
    if (req.method === "GET" && route === "/showcase") {
      const now = this.now();
      if (!this.showcase || now - this.showcase.at > 5_000) {
        const agents: unknown[] = [];
        for (const uid of this.houseIds()) {
          const u = this.store.userById(uid);
          if (!u) continue;
          const bots = new Bots(this.store.tenant(uid), u.tier, this.now).list().filter((b) => b.listed);
          const live = this.opts.runner?.live?.(uid, bots.map((b) => b.id)) ?? {};
          for (const b of bots) agents.push({ bot: { id: b.id, name: b.name, tagline: b.tagline, theme: b.theme, avatar: b.avatar, style: b.style, mode: b.mode, coins: b.coins, rules: b.rules, image: b.image, state: b.state, handle: u.handle }, live: live[b.id] ?? null });
        }
        this.showcase = { at: now, body: { agents } };
      }
      reply(res, 200, this.showcase.body);
      return true;
    }
    if (route === "/showcase/chat" || route === "/showcase/chat/send") {
      // Anyone may ask a house agent; the page keeps the conversation, the server keeps nothing of it.
      if (!this.houseChat) return this.send(res, 503, { error: "Chat is not open right now.", code: "chat_closed" });
      const addr = clientAddr(req.headers["x-forwarded-for"], req.socket.remoteAddress);
      if (req.method === "GET") {
        const r = this.houseChat.info(addr, new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "");
        return this.send(res, r.status, r.body);
      }
      if (req.method !== "POST" || req.headers["x-arena"] !== "1") return this.send(res, 403, { error: "bad request" });
      const body = (await readJson(req, MAX_BODY * 2)) as Record<string, unknown>;
      const r = await this.houseChat.ask(addr, typeof body.id === "string" ? body.id : "", body);
      return this.send(res, r.status, r.body);
    }
    if (req.method === "GET" && route.startsWith("/showcase-image/")) {
      const id = route.slice("/showcase-image/".length);
      for (const uid of this.houseIds()) {
        let jpg: Buffer | null = null;
        try {
          jpg = this.store.readPortrait(uid, id);
        } catch {
          jpg = null;
        }
        if (jpg) {
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" });
          res.end(jpg);
          return true;
        }
      }
      return this.send(res, 404, { error: "no portrait" });
    }
    if (req.method === "GET" && (route === "/bots/profile" || route === "/showcase/profile")) {
      // An agent's full record: the member's own agents, or a house agent for anyone.
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const id = q.get("id") ?? "";
      const days = Math.max(1, Math.min(60, Number(q.get("days") ?? 7) || 7));
      const owners = route === "/showcase/profile" ? this.houseIds() : [this.auth.user(sessionOf(req))?.id].filter((x): x is string => !!x);
      if (!owners.length) return this.send(res, 401, { error: "not signed in" });
      for (const uid of owners) {
        const p = this.opts.runner?.profile?.(uid, id, days);
        if (p) return this.send(res, 200, p);
      }
      return this.send(res, 404, { error: "This agent is not running right now." });
    }
    if (req.method === "GET" && route === "/bots/live") {
      // The member's own agents as the live board draws a bunny: engine view, curve with times, latest decisions.
      const u = this.auth.user(sessionOf(req));
      if (!u) reply(res, 401, { error: "not signed in" });
      else {
        const ids = new Bots(this.store.tenant(u.id), u.tier, this.now).list().map((b) => b.id);
        reply(res, 200, { live: this.opts.runner?.live?.(u.id, ids) ?? {} });
      }
      return true;
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
          // The page names the models by id; every id must be one of the member's own keys (or the platform's model).
          const named = Array.isArray(body.brains) ? body.brains : typeof body.brainKey === "string" && body.brainKey ? [body.brainKey] : [];
          if (named.some((k) => typeof k === "string" && k !== PLATFORM && !this.keysOf(u)?.has(k))) return this.send(res, 400, { error: "One of those model keys is not yours, or it no longer exists." });
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
            this.opts.trainer?.forgetBot(u.id, gone.id);
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
      case "/skills/add":
      case "/skills/delete": {
        const u = this.auth.user(sessionOf(req));
        if (!u) return this.send(res, 401, { error: "not signed in" });
        if (this.blockedByConsent(res, u)) return true;
        const bank = new SkillBank(this.store.tenant(u.id), u.tier, this.opts.library ?? [], this.now);
        try {
          if (route === "/skills/add") {
            if (this.store.tooMany(`skills:${u.id}`, 60, this.now())) return this.send(res, 429, { error: "Too many tries. Wait a little and try again." });
            return this.send(res, 200, { skill: body.from !== undefined ? bank.addFromLibrary(body.from) : bank.addOwn(body.spec) });
          }
          const id = typeof body.id === "string" ? body.id : "";
          // A skill an agent trades by cannot be removed from under it.
          const using = new Bots(this.store.tenant(u.id), u.tier, this.now).list().filter((b) => b.skill === id);
          if (using.length) return this.send(res, 409, { error: `Agents still trade by this skill: ${using.map((b) => b.name).join(", ")}. Change them first.` });
          bank.remove(id);
          return this.send(res, 200, { ok: true });
        } catch (e) {
          if (e instanceof SkillError) return this.send(res, e.status, { error: e.message });
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
          const using = new Bots(this.store.tenant(u.id), u.tier, this.now).list().filter((b) => b.brains.includes(id));
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
