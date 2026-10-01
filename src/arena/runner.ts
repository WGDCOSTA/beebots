// Runs every member's bunnies on paper. One engine per BOT (the same Engine the owner's Warren uses), each with its own
// SQLite file and a single slot, all reading one shared market feed and deciding with the platform's default model.
// A new version of a bot starts a fresh paper account (new file, new book); a stopped agent keeps its file until it is started again as a new version or deleted; deleting a bot or an account removes its files.
// Nothing here can place a real order: the executor is the simulator and MODE is always dry.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Alerts } from "../alerts.js";
import { loadConfig, type BeeId, type Config } from "../config.js";
import { Db } from "../db.js";
import { Engine } from "../engine.js";
import { EventBus } from "../events.js";
import { SimExecutor } from "../exec/executor.js";
import { Jev, type SystemOne } from "../jev.js";
import { log } from "../log.js";
import type { MarketFeed } from "../market/data.js";
import { safeError } from "../redact.js";
import { BeeSchema, type Settings } from "../settings.js";
import { Bots, type BotView } from "./bots.js";
import { readInsights, type Insights } from "./insights.js";
import { LlmSystemOne } from "./decider.js";
import { EST_USD_PER_MTOK, type Vault } from "./vault.js";
import type { Leaderboard } from "./ranking.js";
import type { ArenaStore } from "./store.js";

const SLOT: BeeId = "bee1";

export interface RunnerOpts {
  store: ArenaStore;
  root: string;
  /** The shared market feed (feed.ts). */
  feed: MarketFeed;
  /** The decision model (decider.ts), or a fake in tests. */
  decider: SystemOne;
  /** How many bots may run at once; the rest wait their turn. */
  maxRunners?: number;
  tickMs?: number;
  startUsd?: number;
  /** Decision spend one bot may use per day, in USD. Past it the bot holds until 00:00 UTC. */
  dailyUsd?: number;
  /** Estimated cost per million tokens (input and output together), for the cap. */
  usdPerMTok?: number;
  now?: () => number;
  /** Where listed bots' equity samples go (ranking.ts). Without it nothing is ranked. */
  leaderboard?: Leaderboard;
  /** How often a running bot's paper equity is sampled for the ranking. */
  sampleMs?: number;
  /** The key vault: an agent set to think with its member's own key gets that key's model and the member's own daily ceiling. */
  vault?: Vault;
  /** The daily decision spend an agent on its member's own key may use when the member set no ceiling, in USD. */
  ownKeyDailyUsd?: number;
}

/** A stopped agent, or one in quarantine: no engine, no ranking, positions closed. */
const ended = (b: { state: string } | undefined): boolean => b?.state === "stopped" || b?.state === "quarantined";

export type RunState = "running" | "paused" | "stopping" | "stopped" | "queued" | "error";
export interface RunStatus {
  state: RunState;
  error?: string;
  startedAt?: number;
  equityUsd?: number;
  startEquityUsd?: number;
  pnlUsd?: number;
  pnlPct?: number;
  position?: { coin: string; side: string; sizeUsd: number | null; uplUsd: number; minutesHeld: number } | null;
  tradesToday?: number;
  decisions?: number;
  /** Orders the paper account has sent (the ranking's "trades"). */
  orders?: number;
  spentUsd?: number;
  capped?: boolean;
  last?: { choice: string | null; confidence: number | null; status: string; ts: number } | null;
}

interface Run {
  botId: string;
  userId: string;
  version: number;
  /** The bot as the member last saved it (name, avatar, listed...), kept fresh by update(). */
  bot: BotView;
  engine: Engine;
  db: Db;
  jev: Jev;
  file: string;
  startedAt: number;
  /** Read by the engine on every tick: what the member asked for. */
  ctl: { paused: boolean; closing: boolean };
}

export class ArenaRunner {
  private runs = new Map<string, Run>();
  private errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<RunnerOpts, "store" | "root" | "feed" | "decider" | "leaderboard" | "vault">> & Pick<RunnerOpts, "store" | "root" | "feed" | "decider" | "leaderboard" | "vault">;
  private timer: NodeJS.Timeout | null = null;
  private sampler: NodeJS.Timeout | null = null;
  private settler: NodeJS.Timeout | null = null;

  constructor(opts: RunnerOpts) {
    this.o = { maxRunners: 25, tickMs: 60_000, startUsd: 1000, dailyUsd: 0.5, usdPerMTok: 0.3, sampleMs: 600_000, ownKeyDailyUsd: 1000, now: Date.now, ...opts };
  }

  /** The positions every running bot holds, so the shared feed keeps their coins fresh. */
  held(): string[] {
    return [...this.runs.values()].map((r) => r.engine.bees[SLOT]?.position?.instId).filter((x): x is string => !!x);
  }

  private dir(userId: string): string {
    return join(this.o.root, "tenants", userId, "paper");
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  private config(bot: BotView, file: string, dailyUsd: number, usdPerMTok: number): Config {
    const t = this.o.now();
    const settings = {
      version: 1,
      jevKey: "arena-platform",
      acceptedRiskAt: t,
      bees: [BeeSchema.parse({ name: bot.name, style: bot.style, tagline: bot.tagline, rules: bot.rules, coins: bot.coins, look: bot.look || undefined, image: bot.image })],
      createdAt: t,
    } as unknown as Settings;
    const cfg = loadConfig(
      {
        TYPESAFE_API_KEY: "arena-platform",
        DRY_RUN: "true",
        TICK_MS: String(this.o.tickMs),
        BEE_START_EQUITY_USD: String(this.o.startUsd),
        JEV_DAILY_USD_CAP: String(dailyUsd),
        JEV_USD_PER_MTOK: String(usdPerMTok),
        DB_PATH: file,
        LOG_LEVEL: "warn",
      },
      settings,
    );
    // This engine runs one slot: this bot's. (The config builds the three main slots; the others simply never run.)
    return { ...cfg, beeIds: [SLOT] };
  }

  private async start(userId: string, bot: BotView): Promise<void> {
    mkdirSync(this.dir(userId), { recursive: true });
    const file = join(this.dir(userId), `${bot.id}-v${bot.version}.sqlite`);
    // The platform's model and its small daily ceiling, or the member's own key, its model and the member's own ceiling.
    // An agent set to its member's key never falls back to the platform's model: if the key is gone it does not start.
    let decider = this.o.decider;
    let dailyUsd = this.o.dailyUsd;
    let usdPerMTok = this.o.usdPerMTok;
    if (bot.brainKey) {
      const k = this.o.vault?.for(this.o.store.tenant(userId), userId, this.o.now).secret(bot.brainKey);
      if (!k) throw new Error("its own model key is not available");
      decider = new LlmSystemOne(this.o.vault!.brain(k.provider, k.secret, k.model), `own-${k.provider}`);
      dailyUsd = k.dailyUsd ?? this.o.ownKeyDailyUsd;
      usdPerMTok = EST_USD_PER_MTOK[k.provider];
    }
    const cfg = this.config(bot, file, dailyUsd, usdPerMTok);
    const db = new Db(file);
    const ctl = { paused: bot.state === "paused", closing: false };
    try {
      const jev = new Jev({ ...cfg.jev, client: decider, now: this.o.now });
      const engine = new Engine({
        cfg,
        db,
        feed: this.o.feed,
        jev,
        exec: new SimExecutor(() => this.o.feed.view(), cfg.risk.takerFeeRate),
        bus: new EventBus(db),
        alerts: new Alerts(undefined),
        now: this.o.now,
        paused: () => ctl.paused,
        closeRequested: () => ctl.closing,
      });
      await engine.start();
      this.runs.set(bot.id, { botId: bot.id, userId, version: bot.version, bot, engine, db, jev, file, startedAt: this.o.now(), ctl });
      this.errors.delete(bot.id);
    } catch (e) {
      db.close();
      rmSync(file, { force: true });
      throw e;
    }
  }

  private stopRun(r: Run, removeFiles: boolean): void {
    r.engine.stop();
    r.db.close();
    this.runs.delete(r.botId);
    if (removeFiles) for (const ext of ["", "-wal", "-shm"]) rmSync(`${r.file}${ext}`, { force: true });
  }

  /** Brings one member's running bots in line with their bots now: start, restart on a new version, stop what is gone. */
  update(userId: string): Promise<void> {
    return this.serial(async () => {
      const user = this.o.store.userById(userId);
      const bots = user ? new Bots(this.o.store.tenant(userId), user.tier, this.o.now).list() : [];
      const byId = new Map(bots.map((b) => [b.id, b]));
      for (const r of [...this.runs.values()].filter((x) => x.userId === userId)) {
        const b = byId.get(r.botId);
        if (!b || b.version !== r.version) this.stopRun(r, true);
        else {
          r.bot = b; // a cosmetic edit keeps the account, and the ranking shows the new name and avatar
          r.ctl.paused = b.state === "paused";
          if (ended(b)) r.ctl.closing = true; // close what it holds, then the run ends (settle)
        }
      }
      await this.settle(userId);
      // A bot that is gone, or that its owner took off the leaderboard, leaves it with every sample.
      for (const id of this.o.leaderboard?.listedBots(userId) ?? []) if (!byId.get(id)?.listed || ended(byId.get(id))) this.o.leaderboard?.remove(id);
      // Old versions' files are not needed once their engine is gone.
      if (user) this.prune(userId, bots);
      for (const b of bots) {
        if (this.runs.has(b.id) || ended(b)) continue;
        if (this.runs.size >= this.o.maxRunners) continue;
        try {
          await this.start(userId, b);
        } catch (e) {
          const why = safeError(e).message;
          this.errors.set(b.id, why);
          log.warn("arena: a bot could not start", { bot: b.id, error: why });
        }
      }
    });
  }

  /** A run that was asked to stop ends once it is flat: it closes its position through the normal ledger first. The file stays, for its record. */
  private async settle(userId?: string): Promise<void> {
    for (const r of [...this.runs.values()]) {
      if (!r.ctl.closing || (userId && r.userId !== userId)) continue;
      try {
        if (!r.engine.health().flat) await r.engine.tick();
      } catch (e) {
        log.warn("arena: closing an agent failed", { bot: r.botId, error: safeError(e).message });
      }
      if (r.engine.health().flat) this.stopRun(r, false);
    }
  }

  private prune(userId: string, bots: BotView[]): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir(userId));
    } catch {
      return;
    }
    // Keep only the file of each bot's current version; anything else belongs to a deleted bot or an old version.
    const keep = new Set(bots.map((b) => `${b.id}-v${b.version}.sqlite`));
    for (const f of files) if (!keep.has(f.replace(/-(wal|shm)$/, ""))) rmSync(join(this.dir(userId), f), { force: true });
  }

  /** Stops everything of a member (their account is going away). */
  forget(userId: string): Promise<void> {
    return this.serial(async () => {
      for (const r of [...this.runs.values()].filter((x) => x.userId === userId)) this.stopRun(r, true);
      for (const id of this.o.leaderboard?.listedBots(userId) ?? []) this.o.leaderboard?.remove(id);
    });
  }

  /** One sample of every running, listed bot's paper account for the ranking. */
  sample(ts = this.o.now()): void {
    const lb = this.o.leaderboard;
    if (!lb) return;
    for (const r of this.runs.values()) {
      if (!r.bot.listed || r.ctl.closing) continue;
      const user = this.o.store.userById(r.userId);
      const b = r.engine.snapshot().bees.find((x) => x.bee === SLOT);
      if (!user || !b) continue;
      lb.record({ botId: r.botId, userId: r.userId, handle: user.handle, name: r.bot.name, theme: r.bot.theme, avatar: r.bot.avatar, style: r.bot.style, tier: user.tier, version: r.version }, b.equityUsd, b.totals.orders, ts);
    }
    lb.prune(ts);
  }

  /** Every member with a bot: the periodic safety net, and the first pass at start-up. */
  syncAll(): Promise<void> {
    const ids = (this.o.store.dir.prepare("SELECT id FROM users ORDER BY created_at, id").all() as Array<{ id: string }>).map((r) => r.id);
    return ids.reduce<Promise<void>>((p, id) => p.then(() => this.update(id)), Promise.resolve());
  }

  begin(everyMs = 60_000): void {
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), everyMs);
    this.settler = setInterval(() => void this.serial(() => this.settle()), 10_000);
    if (this.o.leaderboard) this.sampler = setInterval(() => this.sample(), this.o.sampleMs);
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sampler) clearInterval(this.sampler);
    if (this.settler) clearInterval(this.settler);
    for (const r of [...this.runs.values()]) this.stopRun(r, false);
  }

  /** A running bot's engine, for diagnostics and tests. */
  engineOf(botId: string): Engine | undefined {
    return this.runs.get(botId)?.engine;
  }

  get running(): number {
    return this.runs.size;
  }

  private fileOf(userId: string, bot: { id: string; version: number }): string {
    return join(this.dir(userId), `${bot.id}-v${bot.version}.sqlite`);
  }

  /** A stopped agent has no engine; its last numbers come from its file. Undefined when the agent is not stopped. */
  private stoppedRun(userId: string, botId: string): RunStatus | undefined {
    const user = this.o.store.userById(userId);
    if (!user) return undefined;
    let bot: BotView;
    try {
      bot = new Bots(this.o.store.tenant(userId), user.tier, this.o.now).find(botId);
    } catch {
      return undefined;
    }
    if (!ended(bot)) return undefined;
    const ins = readInsights(this.fileOf(userId, bot), { decisions: 0, trades: 0 });
    const last = ins?.equity.at(-1)?.[1] ?? this.o.startUsd;
    return { state: "stopped", equityUsd: last, startEquityUsd: this.o.startUsd, pnlUsd: last - this.o.startUsd, pnlPct: ((last - this.o.startUsd) / this.o.startUsd) * 100, position: null, decisions: undefined };
  }

  /** What the agent page shows: the curve, the decisions with their facts, the trades. Null before the first sample. */
  insights(userId: string, bot: BotView, opts?: { decisions?: number; trades?: number; points?: number }): Insights | null {
    return readInsights(this.fileOf(userId, bot), opts);
  }

  /** Where each of a member's bots stands. */
  status(userId: string, botIds: string[]): Record<string, RunStatus> {
    const out: Record<string, RunStatus> = {};
    for (const id of botIds) {
      const r = this.runs.get(id);
      if (!r || r.userId !== userId) {
        const err = this.errors.get(id);
        const stopped = this.stoppedRun(userId, id);
        out[id] = stopped ?? (err ? { state: "error", error: "This agent could not start. It will be retried." } : { state: "queued" });
        continue;
      }
      const b = r.engine.snapshot().bees.find((x) => x.bee === SLOT);
      if (!b) {
        out[id] = { state: "queued" };
        continue;
      }
      out[id] = {
        state: r.ctl.closing ? "stopping" : r.ctl.paused ? "paused" : "running",
        startedAt: r.startedAt,
        equityUsd: b.equityUsd,
        startEquityUsd: b.startEquityUsd,
        pnlUsd: b.pnlUsd,
        pnlPct: b.pnlPct,
        position: b.position ? { coin: b.position.coin, side: b.position.side, sizeUsd: b.position.sizeUsd, uplUsd: b.position.uplUsd, minutesHeld: b.position.minutesHeld } : null,
        tradesToday: b.tradesToday,
        decisions: b.totals.decisions,
        orders: b.totals.orders,
        spentUsd: Number(r.jev.spentTodayUsd.toFixed(4)),
        capped: r.jev.capTripped,
        last: b.last ? { choice: b.last.choice, confidence: b.last.confidence, status: b.last.status, ts: b.last.ts } : null,
      };
    }
    return out;
  }
}
