// Simulated training and skill backtests (Pro and Premium). Training replays an agent over real historical candles faster
// than real time: the same engine, the same rules and the same model(s) that run it on paper, fed by `HistoricalApi` frozen
// at a moving clock, one step an hour. Its result is kept as the agent's own record, apart from its paper account, and never
// reaches the leaderboard. A skill's backtest is the Lab's simulator on the same history: cheap, no model involved.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Alerts } from "../alerts.js";
import type { Config } from "../config.js";
import { Db } from "../db.js";
import { Engine } from "../engine.js";
import { EventBus } from "../events.js";
import { SimExecutor } from "../exec/executor.js";
import { Jev, type SystemOne } from "../jev.js";
import { metrics, simulate } from "../lab/backtest.js";
import type { Skill } from "../lab/skills/index.js";
import { log } from "../log.js";
import { MarketFeed } from "../market/data.js";
import { safeError } from "../redact.js";
import { LIMITS, PLATFORM, type BotView } from "./bots.js";
import { HBAR_MS, HistoricalApi, MAX_WINDOW_DAYS, type CandleStore } from "./history.js";
import { readInsights, type Insights } from "./insights.js";
import type { ArenaStore, Tier } from "./store.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const TRAIN_DAYS = [7, 14, 30] as const;
/** Trainings a member may start per day. Free has none: historical data is a Pro feature. Proposed numbers, to confirm. */
export const TRAININGS_PER_DAY: Record<Tier, number> = { free: 0, pro: 3, premium: 10 };
/** Backtests of a skill a member may run per day (they cost no model call, only server time). */
export const BACKTESTS_PER_DAY: Record<Tier, number> = { free: 0, pro: 50, premium: 200 };
/** Trainings kept per agent; older ones (and their files) are deleted. */
export const KEEP_TRAININGS = 10;

export class TrainError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "train_error",
  ) {
    super(message);
  }
}

export type TrainStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "budget";

export interface TrainingView {
  id: string;
  botId: string;
  version: number;
  createdAt: number;
  days: number;
  fromTs: number;
  toTs: number;
  status: TrainStatus;
  /** 0 to 1. */
  progress: number;
  startUsd: number;
  equityUsd: number | null;
  returnPct: number | null;
  maxDrawdownPct: number | null;
  trades: number;
  wins: number;
  decisions: number;
  /** Buy and hold of its first coin over the same window, for scale. */
  benchmarkPct: number | null;
  benchmarkCoin: string;
  spentUsd: number;
  /** The style an autonomous agent trained with (it does not change style during training). */
  style: string;
  error: string | null;
}

const SQL = `CREATE TABLE IF NOT EXISTS trainings (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, days INTEGER NOT NULL,
  from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, start_usd REAL NOT NULL,
  equity_usd REAL, return_pct REAL, max_dd_pct REAL, trades INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
  decisions INTEGER NOT NULL DEFAULT 0, benchmark_pct REAL, benchmark_coin TEXT NOT NULL DEFAULT '', spent_usd REAL NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT '', error TEXT);
CREATE TABLE IF NOT EXISTS usage_counts (day TEXT NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind));`;

interface Row {
  id: string;
  bot_id: string;
  version: number;
  created_at: number;
  days: number;
  from_ts: number;
  to_ts: number;
  status: string;
  progress: number;
  start_usd: number;
  equity_usd: number | null;
  return_pct: number | null;
  max_dd_pct: number | null;
  trades: number;
  wins: number;
  decisions: number;
  benchmark_pct: number | null;
  benchmark_coin: string;
  spent_usd: number;
  style: string;
  error: string | null;
}
const toView = (r: Row): TrainingView => ({
  id: r.id,
  botId: r.bot_id,
  version: r.version,
  createdAt: r.created_at,
  days: r.days,
  fromTs: r.from_ts,
  toTs: r.to_ts,
  status: r.status as TrainStatus,
  progress: r.progress,
  startUsd: r.start_usd,
  equityUsd: r.equity_usd,
  returnPct: r.return_pct,
  maxDrawdownPct: r.max_dd_pct,
  trades: r.trades,
  wins: r.wins,
  decisions: r.decisions,
  benchmarkPct: r.benchmark_pct,
  benchmarkCoin: r.benchmark_coin,
  spentUsd: r.spent_usd,
  style: r.style,
  error: r.error,
});

/** What the trainer needs from the paper runner: the same settings, models and skill an agent runs with. */
export interface TrainerRunner {
  config(bot: BotView, file: string, dailyUsd: number, usdPerMTok: number): Config;
  brainsOf(userId: string, bot: BotView): { decider: SystemOne; dailyUsd: number; usdPerMTok: number };
  skillOf(userId: string, bot: BotView): Skill;
}

export interface TrainerOpts {
  store: ArenaStore;
  root: string;
  history: CandleStore;
  runner: TrainerRunner;
  now?: () => number;
  /** What one training may spend on the platform's model, in USD (estimated from tokens, like the paper cap). */
  platformBudgetUsd?: number;
  /** Trainings running at once on the whole server; the rest wait in line. */
  maxParallel?: number;
  /** Lets the event loop breathe between steps (tests pass a no-op). */
  breathe?: () => Promise<void>;
}

/** Counts of the day's trainings and backtests, per member, in their own database. */
export function usage(db: DatabaseSync, day: string, kind: "train" | "backtest", add = 0): number {
  db.exec(SQL);
  if (add) db.prepare("INSERT INTO usage_counts (day, kind, n) VALUES (?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + ?").run(day, kind, add, add);
  if (add) db.prepare("DELETE FROM usage_counts WHERE day < ?").run(day);
  return (db.prepare("SELECT n FROM usage_counts WHERE day = ? AND kind = ?").get(day, kind) as { n: number } | undefined)?.n ?? 0;
}

/** The last bar every coin has closed by: training stops there, and never reads past it. */
function latestCommon(history: CandleStore, coins: string[], bar: "15m" | "1H"): number | null {
  let t = Infinity;
  for (const c of coins) {
    const i = history.instrumentOf(c);
    const cov = i ? history.coverage(i.instId, bar) : null;
    if (!cov) return null;
    t = Math.min(t, cov.to + HBAR_MS[bar]);
  }
  return Number.isFinite(t) ? t : null;
}

export class Trainer {
  private readonly o: Required<Omit<TrainerOpts, "store" | "root" | "history" | "runner">> & Pick<TrainerOpts, "store" | "root" | "history" | "runner">;
  /** Trainings this process is running or holding in line, by id: everything else marked running is a leftover of a restart. */
  private active = new Map<string, { cancel: boolean }>();
  private waiting: Array<() => void> = [];
  private busy = 0;

  constructor(opts: TrainerOpts) {
    this.o = { now: Date.now, platformBudgetUsd: 1, maxParallel: 2, breathe: () => new Promise((r) => setImmediate(r)), ...opts };
  }

  private db(userId: string): DatabaseSync {
    const db = this.o.store.tenant(userId);
    db.exec(SQL);
    return db;
  }

  private dir(userId: string): string {
    return join(this.o.root, "tenants", userId, "train");
  }

  fileOf(userId: string, t: { id: string; botId: string }): string {
    return join(this.dir(userId), `${t.botId}-${t.id}.sqlite`);
  }

  /** The agent's trainings, newest first. A training that a restart interrupted says so. */
  list(userId: string, botId: string): TrainingView[] {
    const db = this.db(userId);
    const rows = db.prepare("SELECT * FROM trainings WHERE bot_id = ? ORDER BY created_at DESC, id").all(botId) as unknown as Row[];
    for (const r of rows)
      if ((r.status === "running" || r.status === "queued") && !this.active.has(r.id)) {
        db.prepare("UPDATE trainings SET status = 'failed', error = ? WHERE id = ?").run("Interrupted by a server restart.", r.id);
        r.status = "failed";
        r.error = "Interrupted by a server restart.";
      }
    return rows.map(toView);
  }

  get(userId: string, id: string): TrainingView | null {
    const r = this.db(userId).prepare("SELECT * FROM trainings WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toView(r) : null;
  }

  /** A finished training's curve, decisions and trades, read from its own file. */
  insights(userId: string, t: TrainingView): Insights | null {
    if (t.status === "queued" || t.status === "running") return null;
    try {
      return readInsights(this.fileOf(userId, t), { decisions: 30, trades: 40, points: 200 });
    } catch {
      return null;
    }
  }

  cancel(userId: string, id: string): void {
    const t = this.get(userId, id);
    if (!t) throw new TrainError("No such training.", 404);
    const a = this.active.get(id);
    if (a) a.cancel = true;
  }

  /** Removes an agent's trainings and their files (the agent was deleted). */
  forgetBot(userId: string, botId: string): void {
    for (const t of this.list(userId, botId)) {
      const a = this.active.get(t.id);
      if (a) a.cancel = true;
      this.removeFiles(userId, t);
    }
    this.db(userId).prepare("DELETE FROM trainings WHERE bot_id = ?").run(botId);
  }

  private removeFiles(userId: string, t: { id: string; botId: string }): void {
    for (const ext of ["", "-wal", "-shm"]) rmSync(`${this.fileOf(userId, t)}${ext}`, { force: true });
  }

  /**
   * Queues a training of `bot` over the last `days` days. Refused on Free, past the day's count, while the agent already has
   * one under way, and when the history does not cover its coins. Returns at once; the training runs in the background.
   */
  start(userId: string, tier: Tier, bot: BotView, days: number): TrainingView {
    if (!LIMITS[tier].history) throw new TrainError("Simulated training is part of Pro and Premium.", 403, "plan");
    if (!(TRAIN_DAYS as readonly number[]).includes(days)) throw new TrainError("Pick 7, 14 or 30 days.");
    if (bot.state === "quarantined") throw new TrainError("This agent is in quarantine.", 409);
    const now = this.o.now();
    const db = this.db(userId);
    const day = new Date(now).toISOString().slice(0, 10);
    if (usage(db, day, "train") >= TRAININGS_PER_DAY[tier]) throw new TrainError("You have used today's trainings for your plan.", 429, "train_limit");
    if (this.list(userId, bot.id).some((t) => t.status === "running" || t.status === "queued")) throw new TrainError("This agent is already training.", 409, "busy");

    // Autonomous agents trade whatever has history; the others train on their own coins, and every one of them needs history.
    const coins = bot.mode === "autonomous" ? this.o.history.instruments().map((i) => i.coin) : bot.coins;
    const missing = coins.filter((c) => !this.o.history.instrumentOf(c));
    if (!coins.length || missing.length) throw new TrainError(`No history yet for ${missing.join(", ") || "its coins"}.`, 409, "no_history");
    const end = latestCommon(this.o.history, coins, "15m");
    if (end === null) throw new TrainError("No history yet for its coins.", 409, "no_history");
    const toTs = Math.floor(end / HOUR) * HOUR;
    const fromTs = toTs - Math.min(days, MAX_WINDOW_DAYS) * DAY;
    for (const c of coins) {
      const cov = this.o.history.coverage(this.o.history.instrumentOf(c)!.instId, "15m");
      if (!cov || cov.from > fromTs - DAY) throw new TrainError(`Not enough history yet for ${c} (${days} days are needed).`, 409, "no_history");
    }
    // The models and the skill are checked now, so a missing key or skill is an answer and not a failed training.
    try {
      this.o.runner.brainsOf(userId, bot);
      if (bot.mode === "skill") this.o.runner.skillOf(userId, bot);
    } catch (e) {
      throw new TrainError(`It cannot train: ${safeError(e).message}.`, 409, "not_ready");
    }

    usage(db, day, "train", 1);
    const id = randomBytes(6).toString("hex");
    const startUsd = 1000;
    const ctl = { cancel: false };
    this.active.set(id, ctl);
    db.prepare("INSERT INTO trainings (id, bot_id, version, created_at, days, from_ts, to_ts, status, start_usd, style) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)").run(id, bot.id, bot.version, now, days, fromTs, toTs, startUsd, bot.style);
    // Only the last trainings are kept, with their files.
    for (const old of this.list(userId, bot.id).slice(KEEP_TRAININGS)) {
      if (this.active.has(old.id)) continue;
      this.removeFiles(userId, old);
      db.prepare("DELETE FROM trainings WHERE id = ?").run(old.id);
    }
    void this.slot()
      .then(() => this.run(userId, bot, { id, botId: bot.id, fromTs, toTs, coins, startUsd }, ctl))
      .catch((e) => this.finish(userId, id, { status: "failed", error: safeError(e).message }))
      .finally(() => {
        this.active.delete(id);
        this.busy--;
        this.waiting.shift()?.();
      });
    return this.get(userId, id)!;
  }

  private slot(): Promise<void> {
    if (this.busy < this.o.maxParallel) {
      this.busy++;
      return Promise.resolve();
    }
    return new Promise((r) =>
      this.waiting.push(() => {
        this.busy++;
        r();
      }),
    );
  }

  private finish(userId: string, id: string, f: Partial<Row> & { status: TrainStatus }): void {
    const sets = Object.keys(f).map((k) => `${k} = ?`).join(", ");
    try {
      this.db(userId).prepare(`UPDATE trainings SET ${sets} WHERE id = ?`).run(...(Object.values(f) as Array<string | number | null>), id);
    } catch (e) {
      log.warn("arena: a training's record could not be saved", { id, error: safeError(e).message });
    }
  }

  private async run(userId: string, bot: BotView, t: { id: string; botId: string; fromTs: number; toTs: number; coins: string[]; startUsd: number }, ctl: { cancel: boolean }): Promise<void> {
    mkdirSync(this.dir(userId), { recursive: true });
    const file = this.fileOf(userId, t);
    this.removeFiles(userId, t);
    this.finish(userId, t.id, { status: "running" });
    let clock = t.fromTs;
    const now = () => clock;
    const api = new HistoricalApi(this.o.history, now, t.coins);
    // Every stored coin passes the gates: the agent's own coins (or, for an autonomous one, what has history) are all there is.
    const feed = new MarketFeed(api, { min24hVolUsd: 0, spreadGateBps: 1_000, trendCoins: t.coins, macro: { min24hVolUsd: 0, spreadGateBps: 1_000 } }, null, () => []);
    const { decider, dailyUsd, usdPerMTok } = this.o.runner.brainsOf(userId, bot);
    const skill = bot.mode === "skill" ? this.o.runner.skillOf(userId, bot) : null;
    // The engine's own loops never fire here: this replay drives it, one step an hour of history.
    const base = this.o.runner.config(bot, file, dailyUsd, usdPerMTok);
    const cfg: Config = { ...base, tickMs: 1e9, dataRefreshMs: 1e9 };
    // A training may spend the platform's per-run budget on the platform's model, plus one day's ceiling of each own key.
    const ownShare = bot.brains.filter((b) => b !== PLATFORM).length ? Math.max(0, dailyUsd) : 0;
    const budget = (bot.brains.includes(PLATFORM) ? this.o.platformBudgetUsd : 0) + ownShare;
    const db = new Db(file);
    let engine: Engine | null = null;
    let spent = 0;
    let status: TrainStatus = "done";
    try {
      const jev = new Jev({ ...cfg.jev, client: decider, now });
      engine = new Engine({
        cfg,
        db,
        feed,
        jev,
        exec: new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate, now),
        bus: new EventBus(db),
        alerts: new Alerts(undefined),
        now,
        specialization: bot.mode === "autonomous" ? () => ({ kind: "style" as const, id: bot.style }) : skill ? () => ({ kind: "skill" as const, id: bot.skill! }) : undefined,
        skillById: skill ? (sid: string) => (sid === bot.skill ? skill : undefined) : undefined,
      });
      await engine.start();
      const steps = Math.max(1, Math.round((t.toTs - t.fromTs) / HOUR));
      for (let k = 1; k <= steps; k++) {
        if (ctl.cancel) {
          status = "cancelled";
          break;
        }
        clock = t.fromTs + k * HOUR;
        const before = jev.spentTodayUsd;
        await engine.refreshMarket();
        await engine.tick();
        // The model's spend resets with each day of history; the training adds it up.
        spent += jev.spentTodayUsd >= before ? jev.spentTodayUsd - before : jev.spentTodayUsd;
        if (spent >= budget) {
          status = "budget";
          break;
        }
        if (k % 12 === 0 || k === steps) this.finish(userId, t.id, { status: "running", progress: Number((k / steps).toFixed(3)), spent_usd: Number(spent.toFixed(4)) });
        await this.o.breathe();
      }
    } finally {
      engine?.stop();
      db.close();
    }
    const ins = readInsights(file, { decisions: 0, trades: 0, points: 2 });
    const end = ins?.equity[ins.equity.length - 1]?.[1] ?? null;
    let decisions = 0;
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      decisions = Number((raw.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n);
    } finally {
      raw.close();
    }
    const first = t.coins[0]!;
    const inst = this.o.history.instrumentOf(first);
    const bars = inst ? this.o.history.range(inst.instId, "1H", t.fromTs, clock) : [];
    const bench = bars.length > 1 ? Number(((bars[bars.length - 1]!.c / bars[0]!.o - 1) * 100).toFixed(2)) : null;
    this.finish(userId, t.id, {
      status,
      progress: status === "done" ? 1 : Number(((clock - t.fromTs) / Math.max(1, t.toTs - t.fromTs)).toFixed(3)),
      to_ts: clock,
      equity_usd: end,
      return_pct: end !== null ? Number(((end / t.startUsd - 1) * 100).toFixed(2)) : null,
      max_dd_pct: ins?.maxDrawdownPct ?? null,
      trades: ins?.closedTrades ?? 0,
      wins: ins?.winningTrades ?? 0,
      decisions,
      benchmark_pct: bench,
      benchmark_coin: first,
      spent_usd: Number(spent.toFixed(4)),
      error: status === "budget" ? "Stopped early: it reached the training's model budget." : null,
    });
  }
}

// ---------- a skill's backtest ----------

export interface BacktestResult {
  skill: { id: string; name: string };
  coin: string;
  days: number;
  bar: "1H";
  fromTs: number;
  toTs: number;
  startUsd: number;
  metrics: {
    returnPct: number;
    maxDrawdownPct: number;
    trades: number;
    winRatePct: number;
    profitFactor: number;
    exposurePct: number;
    feesPct: number;
    sharpe: number;
    benchmarkPct: number;
  };
  /** At most 240 points, [ts, equity]. */
  equity: Array<[number, number]>;
  trades: Array<{ side: "long" | "short"; entryTs: number; exitTs: number; entryPx: number; exitPx: number; pnlUsd: number; retPct: number; reason: string }>;
  /** What the simulator assumes, said on the page. */
  assumptions: { feePct: number; slippageBps: number; fundingPer8hPct: number; leverage: number };
}

/** Bars of warm-up before the window, so indicators are ready at its first bar. */
const WARMUP = 200;

/** The Lab's simulator on stored hourly candles: one coin, the skill's own default parameters and exits, 1x, taker fees. */
export function backtestSkill(history: CandleStore, skill: Skill, coin: string, days: number, now: number): BacktestResult {
  if (!(TRAIN_DAYS as readonly number[]).includes(days)) throw new TrainError("Pick 7, 14 or 30 days.");
  const inst = history.instrumentOf(coin);
  if (!inst) throw new TrainError(`No history yet for ${coin}.`, 409, "no_history");
  const cov = history.coverage(inst.instId, "1H");
  if (!cov) throw new TrainError(`No history yet for ${coin}.`, 409, "no_history");
  const toTs = Math.min(now, cov.to + HOUR);
  const fromTs = toTs - days * DAY;
  if (cov.from > fromTs) throw new TrainError(`Not enough history yet for ${coin} (${days} days are needed).`, 409, "no_history");
  const c = history.range(inst.instId, "1H", fromTs - WARMUP * HOUR, toTs);
  const from = c.findIndex((x) => x.ts >= fromTs);
  if (from < 1 || c.length - from < 24) throw new TrainError(`Not enough history yet for ${coin}.`, 409, "no_history");
  const p = { ...skill.defaults };
  const stopAtr = typeof skill.stopAtr === "string" ? (p[skill.stopAtr] ?? 0) : (skill.stopAtr ?? 0);
  const sim = { feeRate: 0.0005, slippageBps: 2, leverage: 1, fundingPer8hPct: 0.01, startEquity: 1000 };
  const r = simulate(c, skill.signal(c, p), { ...sim, stopAtr, exits: skill.exits }, from, c.length);
  const m = metrics(r, c, from, c.length, sim.startEquity);
  const step = Math.max(1, Math.ceil(r.equity.length / 240));
  const equity: Array<[number, number]> = [];
  for (let i = 0; i < r.equity.length; i += step) equity.push([c[from + i]!.ts, Number(r.equity[i]!.toFixed(2))]);
  if (r.equity.length && equity[equity.length - 1]![0] !== c[c.length - 1]!.ts) equity.push([c[c.length - 1]!.ts, Number(r.equity[r.equity.length - 1]!.toFixed(2))]);
  const r2 = (x: number) => Number((Number.isFinite(x) ? x : 0).toFixed(2));
  return {
    skill: { id: skill.id, name: skill.name },
    coin: inst.coin,
    days,
    bar: "1H",
    fromTs: c[from]!.ts,
    toTs,
    startUsd: sim.startEquity,
    metrics: { returnPct: r2(m.totalReturnPct), maxDrawdownPct: r2(m.maxDrawdownPct), trades: m.trades, winRatePct: r2(m.winRatePct), profitFactor: r2(m.profitFactor), exposurePct: r2(m.exposurePct), feesPct: r2(m.feesPct), sharpe: r2(m.sharpe), benchmarkPct: r2(m.benchmarkPct) },
    equity,
    trades: r.trades.slice(-30).reverse().map((x) => ({ side: x.side === 1 ? "long" : "short", entryTs: x.entryTs, exitTs: x.exitTs, entryPx: x.entryPx, exitPx: x.exitPx, pnlUsd: r2(x.pnlUsd), retPct: r2(x.retPct), reason: x.reason })),
    assumptions: { feePct: sim.feeRate * 100, slippageBps: sim.slippageBps, fundingPer8hPct: sim.fundingPer8hPct, leverage: sim.leverage },
  };
}
