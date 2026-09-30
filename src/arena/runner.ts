// Runs every member's bunnies on paper. One engine per BOT (the same Engine the owner's Warren uses), each with its own
// SQLite file and a single slot, all reading one shared market feed and deciding with the platform's default model.
// A new version of a bot starts a fresh paper account (new file, new book); deleting a bot or an account removes its files.
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
}

export type RunState = "running" | "queued" | "error";
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
  spentUsd?: number;
  capped?: boolean;
  last?: { choice: string | null; confidence: number | null; status: string; ts: number } | null;
}

interface Run {
  botId: string;
  userId: string;
  version: number;
  engine: Engine;
  db: Db;
  jev: Jev;
  file: string;
  startedAt: number;
}

export class ArenaRunner {
  private runs = new Map<string, Run>();
  private errors = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly o: Required<Omit<RunnerOpts, "store" | "root" | "feed" | "decider">> & Pick<RunnerOpts, "store" | "root" | "feed" | "decider">;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: RunnerOpts) {
    this.o = { maxRunners: 25, tickMs: 60_000, startUsd: 1000, dailyUsd: 0.5, usdPerMTok: 0.3, now: Date.now, ...opts };
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

  private config(bot: BotView, file: string): Config {
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
        JEV_DAILY_USD_CAP: String(this.o.dailyUsd),
        JEV_USD_PER_MTOK: String(this.o.usdPerMTok),
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
    const cfg = this.config(bot, file);
    const db = new Db(file);
    try {
      const jev = new Jev({ ...cfg.jev, client: this.o.decider, now: this.o.now });
      const engine = new Engine({
        cfg,
        db,
        feed: this.o.feed,
        jev,
        exec: new SimExecutor(() => this.o.feed.view(), cfg.risk.takerFeeRate),
        bus: new EventBus(db),
        alerts: new Alerts(undefined),
        now: this.o.now,
      });
      await engine.start();
      this.runs.set(bot.id, { botId: bot.id, userId, version: bot.version, engine, db, jev, file, startedAt: this.o.now() });
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
      }
      // Old versions' files are not needed once their engine is gone.
      if (user) this.prune(userId, bots);
      for (const b of bots) {
        if (this.runs.has(b.id)) continue;
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
    });
  }

  /** Every member with a bot: the periodic safety net, and the first pass at start-up. */
  syncAll(): Promise<void> {
    const ids = (this.o.store.dir.prepare("SELECT id FROM users ORDER BY created_at, id").all() as Array<{ id: string }>).map((r) => r.id);
    return ids.reduce<Promise<void>>((p, id) => p.then(() => this.update(id)), Promise.resolve());
  }

  begin(everyMs = 60_000): void {
    void this.syncAll();
    this.timer = setInterval(() => void this.syncAll(), everyMs);
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const r of [...this.runs.values()]) this.stopRun(r, false);
  }

  /** A running bot's engine, for diagnostics and tests. */
  engineOf(botId: string): Engine | undefined {
    return this.runs.get(botId)?.engine;
  }

  get running(): number {
    return this.runs.size;
  }

  /** Where each of a member's bots stands. */
  status(userId: string, botIds: string[]): Record<string, RunStatus> {
    const out: Record<string, RunStatus> = {};
    for (const id of botIds) {
      const r = this.runs.get(id);
      if (!r || r.userId !== userId) {
        const err = this.errors.get(id);
        out[id] = err ? { state: "error", error: "This bunny could not start. It will be retried." } : { state: "queued" };
        continue;
      }
      const b = r.engine.snapshot().bees.find((x) => x.bee === SLOT);
      if (!b) {
        out[id] = { state: "queued" };
        continue;
      }
      out[id] = {
        state: "running",
        startedAt: r.startedAt,
        equityUsd: b.equityUsd,
        startEquityUsd: b.startEquityUsd,
        pnlUsd: b.pnlUsd,
        pnlPct: b.pnlPct,
        position: b.position ? { coin: b.position.coin, side: b.position.side, sizeUsd: b.position.sizeUsd, uplUsd: b.position.uplUsd, minutesHeld: b.position.minutesHeld } : null,
        tradesToday: b.tradesToday,
        decisions: b.totals.decisions,
        spentUsd: Number(r.jev.spentTodayUsd.toFixed(4)),
        capped: r.jev.capTripped,
        last: b.last ? { choice: b.last.choice, confidence: b.last.confidence, status: b.last.status, ts: b.last.ts } : null,
      };
    }
    return out;
  }
}
