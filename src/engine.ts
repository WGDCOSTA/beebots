import { customBrain } from "./bees/custom.js";
import { BRAINS } from "./bees/index.js";
import { brainInfo } from "./brains/llm.js";
import { macro } from "./bees/macro.js";
import { skillBrain } from "./bees/skill.js";
import type { Skill } from "./lab/skills/types.js";
import { STYLES } from "./settings.js";
import { dynamicRatchetStop } from "./bees/ratchet.js";
import { allPositions, maxNotionalUsd, minutesSince, positionNotional, profitLockStop, uplUsd } from "./bees/common.js";
import { coinOf, type Action, type BeeBrain, type BeeContext, type BeeState, type Menu, type Position, type Side } from "./bees/types.js";
import { startEquityOf, type BeeId, type Config } from "./config.js";
import type { Alerts } from "./alerts.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import { JEV_QUESTION_SCHEMA_VERSION, type Jev, type JevAnswer, type JevResult } from "./jev.js";
import { applyFill, applyFunding, freshBee, mark, promoteLeg, rollDay, sizedRiskUsd } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { SURVIVAL_NOTE, type Evolution } from "./evolution.js";
import { effectiveWatchlist, watchlistLine, type WatchItem } from "./brains/watchlist.js";
import { altSeasonLabel, CMC_NOTE, jevMarketLine, type CmcState } from "./market/cmc.js";
import { isScalpBrain, scalpBrain, type GateRule, type ScalpDeps } from "./bees/scalp.js";
import { DEFAULT_COSTS, type CostModel, type ScalpGate } from "./lab/scalp.js";
import { UNFILLED } from "./exec/executor.js";
import { marketKinds, mayOpen, sessionInfo, sessionLabel, SESSION_NOTE, type SessionCalendar } from "./market/sessions.js";
import type { MarketView } from "./market/types.js";
import { applyRisk, type JevStatus, type Proposal } from "./risk.js";
import { buildSnapshot } from "./snapshot.js";
import { distributionMetrics, fingerprint, POLICY_DESCRIPTOR_VERSION, type ExperimentArm, type PolicyDescriptor } from "./experiments.js";
import { OutcomeCollector } from "./outcomes.js";
import { ShadowRunner } from "./shadow.js";
import { ExperimentEvaluator } from "./evaluator.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often a benched bee gets a live P&L row in the stream. */
const PULSE_MS = 4_000;
/** How long a bee opens nothing after the exchange rejects one of its new orders. */
/** Told to Jev when its menu carries multi-order options. */
export const MULTI_ORDER_NOTE =
  "LEG_* options open an extra position on another coin next to the one you hold; level 0 starts with up to 3 slots and each level adds 3. Every position shares one leverage cap and keeps its own code stop. CLOSE_LEG_<coin> closes an extra position. Only add a leg for a setup as good as a fresh entry.";

export const ORDER_REJECT_PAUSE_MS = 10 * 60_000;
const EQUITY_SNAPSHOT_MS = 10_000;

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  now?: () => number;
  /** True once someone asked to end the experiment (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Paused: positions stay under their stops, but nothing new is opened (the Arena's Pause). */
  paused?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
  /**
   * LAB_SIGNALS: the bee's playbook skills' vote per coin in its snapshot (coin -> -1..+1), or null. Shown to Jev as
   * `lab` with a one-line note; the menu and the risk layer do not change.
   */
  labVotes?: (id: BeeId, instIds: string[]) => Record<string, number> | null;
  labNote?: string;
  /** CoinMarketCap context (market/cmc.ts), or null when off or stale. Crypto bees see its `mkt` line (CMC_IN_JEV). */
  cmc?: () => CmcState | null;
  /** The strategy lab's verdict on the scalper (lab/scalp.ts scalpGate): what it may trade, or closed. */
  scalpGate?: () => ScalpGate;
  /** A live scalp closed (lab/coinBook.ts recordLive): how the lab's rule really did on that coin. */
  scalpClosed?: (r: { coin: string; ruleId: string; netUsd: number; notionalUsd: number }) => void;
  /** Survival and rewards (evolution.ts): size factor, limit boosts, the survival line in Jev's state. */
  evolution?: Evolution;
  /**
   * BRAIN_WATCHLIST: the coins the bee's brains chose (playbook), or null. The engine narrows the bee's market to them
   * after the owner's coins, the style and the survival tier (brains/watchlist.ts); probation coins trade at half size.
   */
  watchlist?: (id: BeeId) => WatchItem[] | null | undefined;
  /**
   * The trading-hours calendar learned from the market (market/sessions.ts). Macro bees (stocks, commodities) may only
   * open a coin whose session is verified open and stays open SESSION_NO_OPEN_MIN more; no calendar = nothing opens.
   */
  sessions?: () => SessionCalendar | null;
  /**
   * SPECIALIZATION: the method each bee's brains chose (playbook), and the lab skills by id. The engine switches the
   * bee to it when it is flat (never mid-position) and not more often than SPECIALIZE_MIN_HOURS.
   */
  specialization?: (id: BeeId) => { kind: "style" | "skill"; id: string; params?: Record<string, number> } | null | undefined;
  skillById?: (id: string) => Skill | undefined;
  /** A later phase may attach the real decision to an active experiment. No assignment means the baseline arm. */
  experiment?: (id: BeeId, policyVersionId: string) => { experimentId: string; arm: ExperimentArm } | null | undefined;
  /** Separate Jev client and budget for challengers. Shadow answers are recorded but can never reach execution. */
  shadowJev?: Jev;
}

/** The method a bee trades right now when its brains chose one (null = its own style). */
interface ActiveSpec {
  kind: "style" | "skill";
  id: string;
  params: Record<string, number>;
  key: string;
  since: number;
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
}

/** Move a stop only in the position's favour. */
function ratchetStop(p: Position, cand: number): void {
  if (p.stopPx === null) p.stopPx = cand;
  else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
}

/** The answer when the menu leaves one legal hold: no Jev call, no cost. */
function requiredAnswer(label: string, requestedModel: string): JevAnswer {
  const answer = { type: "choice", choice: label, confidence: 1, probabilities: { [label]: 1 } };
  return {
    ok: true,
    choice: label,
    probabilities: { [label]: 1 },
    confidence: 1,
    conviction: 0,
    convictionRaw: 0,
    inputTokens: 0,
    costUsd: 0,
    latencyMs: 0,
    model: "rules",
    trace: {
      questionSchemaVersion: JEV_QUESTION_SCHEMA_VERSION,
      requestedModel,
      answeredModel: "rules",
      questions: {},
      answers: { action: answer, conviction: { type: "score", score: 0, confidence: 1, probabilities: {} } },
    },
  };
}

export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last = {} as Partial<Record<BeeId, LastDecision>>;
  private orderPauseUntil = {} as Partial<Record<BeeId, number>>;
  private now: () => number;
  private ticking = false;
  /** Bees being worked on right now (the slow tick or the scalp loop): the other leaves them alone. */
  private beeBusy = new Set<BeeId>();
  private scalping = false;
  /** Why each scalping bee did or did not enter on its last look (the dashboard's status line). */
  private scalpNote = {} as Partial<Record<BeeId, string>>;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt: Partial<Record<BeeId, number>> = {};
  private lastChipUsd: Partial<Record<BeeId, number>> = {};
  startedAt: number;
  private experimentStartedAt = 0;
  /** Experiment closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeAnnounced = false;
  private outcomes: OutcomeCollector;
  private shadow: ShadowRunner | null;
  private experimentEvaluator: ExperimentEvaluator;

  /** Every bee this engine runs (the four main agents plus extras), in slot order. */
  private get ids(): BeeId[] {
    return this.d.cfg.beeIds;
  }

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
    this.outcomes = new OutcomeCollector(d.db);
    this.shadow = d.shadowJev ? new ShadowRunner(d.db, d.shadowJev) : null;
    this.experimentEvaluator = new ExperimentEvaluator(d.db);
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    for (const id of this.ids) {
      this.bees[id] = db.loadBee(id) ?? freshBee(id, startEquityOf(cfg, id), this.now());
      await this.d.exec.init(id);
      try {
        const saved = JSON.parse(db.getMeta(`spec_${id}`) ?? "null") as ActiveSpec | null;
        if (saved) this.spec[id] = saved;
      } catch {
        /* no specialisation remembered */
      }
    }

    await this.refreshMarket();
    this.advanceExperiments(this.now());
    if (this.d.exec.kind === "okx") await this.reconcile();

    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    this.d.alerts.send(`engine started (MODE=${cfg.mode})`);

    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    // The scalper's fast loop (code only, no Jev call per trade). Off unless SCALP=true.
    if (cfg.scalp.enabled) this.loop(() => this.scalpTick(), cfg.scalp.tickMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => this.d.db.pruneEvents(this.now() - 3 * 86_400_000), 3_600_000));
    // Decisions older than 30 days keep their outcome but lose their bulky inputs (state, menu, probabilities).
    const compact = () => {
      const n = this.d.db.compactDecisions(this.now() - 30 * 86_400_000);
      if (n) log.info("old decision inputs dropped", { compacted: n });
    };
    compact();
    this.timers.push(setInterval(compact, 86_400_000));
  }

  saveEvolution(): void {
    if (this.d.evolution) this.d.db.setMeta("evolution", JSON.stringify(this.d.evolution.bees));
  }

  /**
   * The owner revives a dead (retired) bee from the admin panel: a fresh book at the start equity. Refused while it
   * still holds a position. Its lessons stay in the hive mind; it keeps half its points.
   */
  respawn(id: BeeId): void {
    if (!this.ids.includes(id)) throw new Error("no such bunny");
    const b = this.bees[id];
    if (b.position) throw new Error("This bunny still holds a position; it must be flat before it can be revived.");
    const now = this.now();
    this.bees[id] = freshBee(id, startEquityOf(this.d.cfg, id), now);
    this.d.db.saveBee(this.bees[id], now);
    this.d.evolution?.revive(id, this.bees[id].equityUsd, now);
    this.saveEvolution();
    this.d.bus.emit("cap", { bee: id, cap: null, detail: "revived by the owner: fresh paper money, lessons kept" }, now);
    log.info("bee revived", { bee: id });
  }

  stop(): void {
    this.saveEvolution();
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const id of this.ids) this.d.db.saveBee(this.bees[id], this.now());
  }

  async flushShadow(): Promise<void> {
    await this.shadow?.flush();
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankBoozyHourly();
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      for (const id of this.ids) this.markBee(id, now);
      try {
        const settled = this.outcomes.settle(this.d.feed.view(), now);
        if (settled.outcomes > 0) {
          log.info("decision outcomes settled", settled);
          this.advanceExperiments(now);
        }
      } catch (err) {
        log.warn("decision outcome settlement failed", { err: safeError(err) });
      }
      if (this.d.evolution?.tick(this.ids.map((id) => [id, this.bees[id]]), now)) this.saveEvolution();
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (this.d.exec.kind === "sim") this.simulateFunding(now);

      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else
        await Promise.all(
          this.ids.map(async (id) => {
            // The scalp loop may be working this bee right now: it and this tick never act on it at the same time.
            if (this.beeBusy.has(id)) return;
            this.beeBusy.add(id);
            try {
              // A newly chosen method (only while flat), legs' code exits, the decision, then a leg steps up if the
              // main position closed.
              this.adoptSpecialization(id, now);
              await this.manageLegs(id, now);
              await this.decide(id, now);
              if (promoteLeg(this.bees[id])) this.d.db.saveBee(this.bees[id], now);
            } catch (err) {
              log.error("decision failed", { bee: id, err: safeError(err) });
            } finally {
              this.beeBusy.delete(id);
            }
          }),
        );

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        for (const id of this.ids) {
          const b = this.bees[id];
          this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
        }
      }
      this.d.bus.emit("equity", { bees: this.ids.map((id) => this.publicBee(id)) }, now);
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
    } finally {
      this.ticking = false;
    }
  }

  private ctx(id: BeeId, now: number): BeeContext {
    const bee = this.bees[id];
    const p = bee.position;
    const boost = this.d.evolution?.perks(id).limitBoost ?? 0;
    // A reward may raise this bee's max position size (never leverage: maxNotionalUsd still caps by MAX_LEVERAGE).
    const cfg = boost > 0 ? { ...this.d.cfg, risk: { ...this.d.cfg.risk, maxNotionalUsdPerBee: this.d.cfg.risk.maxNotionalUsdPerBee * (1 + boost) } } : this.d.cfg;
    // With legs, the bee's own P&L line is the main position's (uplR, a brain's "losing?" checks); legs are separate.
    const mainUpl = bee.legs?.length ? (bee.mainUplUsd ?? bee.uplUsd) : bee.uplUsd;
    return {
      bee: mainUpl === bee.uplUsd ? bee : { ...bee, uplUsd: mainUpl },
      view: this.viewFor(id, now),
      cfg,
      knobs: this.knobs(id),
      now,
      uplR: p && p.riskUsd > 0 ? mainUpl / p.riskUsd : null,
      slots: this.slots(id),
      candles: (instId: string) => (typeof this.d.feed.candles1h === "function" ? this.d.feed.candles1h(instId) : []),
      candles1m: (instId: string) => (typeof this.d.feed.candles1m === "function" ? this.d.feed.candles1m(instId) : []),
      ...(this.d.cfg.slots[id].market !== "crypto" ? { session: (coin: string) => sessionInfo(this.d.sessions?.() ?? null, coin, now) } : {}),
    };
  }

  private advanceExperiments(now: number): void {
    for (const promoted of this.experimentEvaluator.evaluateActive(now)) {
      log.info("experiment advanced to shadow-only canary", { experiment: promoted.experiment.id, samples: promoted.evidence.independentSamples });
      this.d.bus.emit("experiment", { id: promoted.experiment.id, status: "canary", evidence: promoted.evidence }, now);
    }
  }

  /**
   * Multi-orders: how many positions this bee may hold now. Level zero starts at three and each level adds three;
   * every position still shares one aggregate notional/leverage cap. A bee in danger or worse is back to one.
   */
  private slots(id: BeeId): number {
    if (this.spec[id]?.kind === "style" && this.spec[id]?.id === "scalp") return 1; // a scalper holds one position
    const ev = this.d.evolution;
    if (!ev) return Math.min(3, this.d.cfg.evolution.maxPositions);
    const tier = ev.bees[id]?.tier;
    if (tier === "danger" || tier === "critical" || tier === "dead") return 1;
    return Math.max(1, ev.perks(id).positions);
  }

  /**
   * Multi-orders menu: with a main position and a free slot, the openings the brain would offer if the bee were flat,
   * on coins it does not hold yet, as LEG_*; and CLOSE_LEG_<coin> for each leg it holds.
   */
  private legMenu(id: BeeId, ctx: BeeContext): Menu {
    const bee = ctx.bee;
    const m: Menu = {};
    if (!bee.position) return m;
    for (const l of bee.legs ?? []) m[`CLOSE_LEG_${l.coin}`] = { desc: "close this extra position", intent: { kind: "leg_close", instId: l.instId, reason: "jev_close_leg" } };
    const slots = ctx.slots ?? 1;
    if (slots <= 1 || allPositions(bee).length >= slots || bee.cap) return m;
    const held = new Set(allPositions(bee).map((p) => p.instId));
    const flat = this.brain(id).menu({ ...ctx, bee: { ...bee, position: null, legs: [], uplUsd: 0 }, uplR: null });
    for (const [label, opt] of Object.entries(flat)) {
      const i = opt.intent;
      if (i.kind !== "open" || held.has(i.instId)) continue;
      m[`LEG_${label}`] = { desc: opt.desc ? `extra position: ${opt.desc}` : "extra position", intent: { kind: "leg_open", instId: i.instId, side: i.side, sizeFrac: i.sizeFrac, setup: i.setup } };
    }
    return m;
  }

  /** A leg seen through the brain as if it were the bee's main position (trailing, stops, session close). */
  private legCtx(id: BeeId, leg: Position, now: number): BeeContext {
    const base = this.ctx(id, now);
    const view = base.view;
    const m = view.tickers.get(leg.instId)?.mid;
    const c = view.instruments.get(leg.instId)?.ctVal;
    const upl = m && c ? uplUsd(leg, m, c) : 0;
    return { ...base, bee: { ...base.bee, position: leg, legs: [], uplUsd: upl }, uplR: leg.riskUsd > 0 ? upl / leg.riskUsd : null };
  }

  /**
   * Code exits for legs, every tick and whatever Jev says: the stop, a brain's forced close (a macro session ending),
   * its time stop, and the bee's retire / daily loss stop. Jev can also close a leg from its menu (CLOSE_LEG_*).
   */
  private async manageLegs(id: BeeId, now: number): Promise<void> {
    const bee = this.bees[id];
    if (!bee.legs?.length) return;
    const brain = this.brain(id);
    for (const leg of [...bee.legs]) {
      const ctx = this.legCtx(id, leg, now);
      const mid = ctx.view.stats.get(leg.instId)?.mid ?? ctx.view.tickers.get(leg.instId)?.mid;
      const stopHit = mid !== undefined && leg.stopPx !== null && (leg.side === "long" ? mid <= leg.stopPx : mid >= leg.stopPx);
      const ts = brain.timeStopMinutes?.(ctx);
      const why =
        bee.cap === "retired" || bee.cap === "loss_stop"
          ? bee.cap
          : stopHit
            ? "stop"
            : (brain.forcedClose?.(ctx) ?? (ts !== undefined && minutesSince(leg.openedAt, now) >= ts ? "time_stop" : null));
      if (!why) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "leg_close", instId: leg.instId, reason: why }, vetoedBy: null, forcedBy: why, status: `${why.replace(/_/g, " ")}: closing leg ${leg.coin}`,
      });
      await this.order(id, decisionId, leg.instId, leg.side === "long" ? "sell" : "buy", leg.contracts, true, `leg_${why}`);
    }
    this.d.db.saveBee(bee, now);
  }

  /**
   * What a bee may trade. Crypto bees: the crypto universe. Macro bees: the gated stocks/commodities of their market
   * whose session is open right now (and only with ALLOW_NON_CRYPTO); the coin they hold stays in their stats.
   */
  private viewFor(id: BeeId, now: number): MarketView {
    const v = this.d.feed.view();
    const s = this.d.cfg.slots[id];
    if (s.market === "crypto") return v;
    const kinds = marketKinds(s.market);
    const cal = this.d.sessions?.() ?? null;
    const gated = this.d.cfg.universe.allowNonCrypto
      ? v.macro.filter((instId) => {
          const inst = v.instruments.get(instId);
          return !!inst && kinds.includes(inst.kind) && mayOpen(sessionInfo(cal, inst.coin, now), this.d.cfg.macro.noOpenMin);
        })
      : [];
    return { ...v, gated, spreadBlocked: [] };
  }

  /** Macro bees: each coin's session for Jev (the coins it sees and the one it holds). */
  private sessionState(id: BeeId, coins: string[], now: number): Record<string, string> | null {
    if (this.d.cfg.slots[id].market === "crypto") return null;
    const cal = this.d.sessions?.() ?? null;
    const held = this.bees[id].position?.instId.split("-")[0];
    const all = [...new Set([...coins, ...(held ? [held] : [])])];
    return all.length ? Object.fromEntries(all.map((c) => [c, sessionLabel(sessionInfo(cal, c, now))])) : null;
  }

  /** Mark every position at the current mids, the one just filled at its fill price. */
  private remark(id: BeeId, instId: string, px: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const pxOf = (i: string) => (i === instId ? px : view.tickers.get(i)?.mid);
    let legsUpl = 0;
    for (const l of bee.legs ?? []) {
      const m = pxOf(l.instId);
      const c = view.instruments.get(l.instId)?.ctVal;
      legsUpl += m && c ? uplUsd(l, m, c) : 0;
    }
    const p = bee.position;
    mark(bee, p ? pxOf(p.instId) : undefined, p ? view.instruments.get(p.instId)?.ctVal : undefined, legsUpl);
  }

  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const p = bee.position;
    const t = p ? view.tickers.get(p.instId) : undefined;
    const ctVal = p ? view.instruments.get(p.instId)?.ctVal : undefined;
    // Legs (multi-orders) are marked at their own prices.
    let legsUpl = 0;
    for (const l of bee.legs ?? []) {
      const lm = view.tickers.get(l.instId)?.mid;
      const lc = view.instruments.get(l.instId)?.ctVal;
      legsUpl += lm && lc ? uplUsd(l, lm, lc) : 0;
    }
    mark(bee, t?.mid, ctVal, legsUpl);
    // Positions opened before initialStopPx existed: their stop has never trailed past entry, so it is the entry stop.
    // Re-size R once from it (R used to stay at the first fill's risk after adds).
    if (p && p.initialStopPx === undefined && p.stopPx !== null && ctVal) {
      const lossSide = p.side === "long" ? p.stopPx < p.entryPx : p.stopPx > p.entryPx;
      p.initialStopPx = lossSide ? p.stopPx : null;
      if (lossSide) p.riskUsd = sizedRiskUsd(p.contracts, ctVal, p.entryPx, p.stopPx);
    }
    if (rollDay(bee, now)) {
      this.d.bus.emit("cap", { bee: id, cap: null, detail: "new UTC day: counters and caps reset" }, now);
    }
    // Trailing stop: only ever ratchets in the position's favour.
    const brain = this.brain(id);
    if (p && brain.trail) {
      const cand = brain.trail(this.ctx(id, now));
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
    // Profit lock: track the best price since entry; past a rung the stop keeps part of that move.
    if (p && brain.profitLock && t?.mid) {
      const better = p.peakPx == null || (p.side === "long" ? t.mid > p.peakPx : t.mid < p.peakPx);
      if (better) p.peakPx = t.mid;
      const cand = profitLockStop(p.side, p.entryPx, p.peakPx!, brain.profitLock);
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
    // Dynamic profit-locking ratchet (bees/ratchet.ts): hard floor plus ATR runner hug, for the opted-in styles.
    const rc = this.d.cfg.ratchet;
    const ratchetOn = rc.enabled && rc.styles.includes(brain.id);
    if (p && ratchetOn && t?.mid) this.applyRatchet(p, t.mid);
    // The same trailing and profit lock for every leg, each seen by the brain as if it were the main position.
    for (const l of bee.legs ?? []) {
      const lm0 = view.tickers.get(l.instId)?.mid;
      if (ratchetOn && lm0) this.applyRatchet(l, lm0);
      const lm = view.tickers.get(l.instId)?.mid;
      if (brain.trail) {
        const cand = brain.trail(this.legCtx(id, l, now));
        if (cand !== null && Number.isFinite(cand)) ratchetStop(l, cand);
      }
      if (brain.profitLock && lm) {
        if (l.peakPx == null || (l.side === "long" ? lm > l.peakPx : lm < l.peakPx)) l.peakPx = lm;
        const cand = profitLockStop(l.side, l.entryPx, l.peakPx!, brain.profitLock);
        if (cand !== null && Number.isFinite(cand)) ratchetStop(l, cand);
      }
    }
  }

  /** Track the peak and tighten the stop to the ratchet's candidate, if any. */
  private applyRatchet(p: Position, mid: number): void {
    const rc = this.d.cfg.ratchet;
    if (p.peakPx == null || (p.side === "long" ? mid > p.peakPx : mid < p.peakPx)) p.peakPx = mid;
    const atr = this.d.feed.view().stats.get(p.instId)?.atr14Pct ?? null;
    const cand = dynamicRatchetStop(p.side, p.entryPx, p.peakPx, atr, rc.lock, rc.hug);
    if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
  }

  private async decide(id: BeeId, now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain(id);
    const bee = this.bees[id];
    // Benched (trade cap or fee budget): the bee rides whatever it holds. Jev is not asked, because nothing it
    // chose could be acted on; only code can close the position (stop, time stop, loss stop) until 00:00 UTC.
    if (bee.cap === "trade_cap" || bee.cap === "fee_budget") return this.decideBenched(id, now);
    if (this.d.paused?.()) return this.decideBenched(id, now, true);
    const ctx = this.ctx(id, now);
    const menu = brain.menu(ctx);
    const legOptions = this.legMenu(id, ctx);
    Object.assign(menu, legOptions);
    let lab: Record<string, number> | null = null;
    try {
      lab = this.d.labVotes?.(id, brain.snapshotCoins(ctx)) ?? null;
    } catch (err) {
      log.warn("lab votes failed", { bee: id, err: safeError(err) });
    }
    const survival = this.d.evolution?.state(id) ?? null;
    const session = this.sessionState(id, brain.snapshotCoins(ctx).map((i) => i.split("-")[0]!), now);
    const mkt = this.d.cfg.cmc.inJev && this.d.cfg.slots[id].squad === "crypto" ? jevMarketLine(this.d.cmc?.() ?? null) : null;
    const extra = { ...(lab ? { lab } : {}), ...(survival ? { survival } : {}), ...(session ? { session } : {}), ...(mkt ? { mkt } : {}) };
    const snap = buildSnapshot(brain, ctx, Object.keys(extra).length ? extra : null, cfg.jev.tech !== false);
    if (brain.id === "boozy" && bee.top1.coin) snap.state.top1 = `${bee.top1.coin} x${bee.top1.streak}`;
    const active = this.spec[id];
    const method: PolicyDescriptor["method"] = active
      ? { kind: active.kind, id: active.id, params: active.params }
      : { kind: brain.id === "skill" ? "skill" : "style", id: brain.id, params: {} };
    const policy = db.experiments.ensurePolicy({
      version: POLICY_DESCRIPTOR_VERSION,
      bee: id,
      mode: cfg.mode,
      method,
      strategy: brain.strategy,
      ownerRules: cfg.slots[id].rules,
      requestedModel: cfg.jev.model,
      questionSchemaVersion: JEV_QUESTION_SCHEMA_VERSION,
      convictionCriteria: brain.convictionLabels,
      risk: {
        appVersion: cfg.update.version,
        maxLeverage: cfg.risk.maxLeverage,
        maxNotionalUsdPerBee: cfg.risk.maxNotionalUsdPerBee,
        dailyLossStopPct: cfg.risk.dailyLossStopPct,
        retireAtPct: cfg.risk.retireAtPct,
        knobs: ctx.knobs,
        openGate: brain.openGate ? { minConviction: brain.openGate.minConviction, minProbability: brain.openGate.minProb(ctx) } : null,
        requiresStrictSetup: !!brain.requiresStrictSetup,
        neverForce: !!brain.neverForce,
      },
    }, now);
    const activeExperiment = db.experiments.activeFor(id, policy.id);
    const assignment = this.d.experiment?.(id, policy.id) ?? (activeExperiment ? { experimentId: activeExperiment.id, arm: "champion" as const } : null);

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    // One legal move and it is "keep what you hold" (a Momentum bee inside its 24h lock): asking Jev buys nothing, so
    // the rules make the call. Only for a hold: a lone open or close still goes to Jev.
    const labels = Object.keys(menu);
    const required = labels.length === 1 && menu[labels[0]!]!.intent.kind === "hold";
    const instructionSuffix = [lab && this.d.labNote ? this.d.labNote : null, survival ? SURVIVAL_NOTE : null, session ? SESSION_NOTE : null, mkt ? CMC_NOTE : null, Object.keys(legOptions).length ? MULTI_ORDER_NOTE : null].filter(Boolean).join(" ");
    const strategy = [brain.strategy, instructionSuffix].filter(Boolean).join(" ");
    if (jev.capTripped) jevStatus = "daily_cap";
    else if (labels.length === 0) jevStatus = "no_options";
    else if (required) r = requiredAnswer(labels[0]!, cfg.jev.model);
    else {
      r = await jev.decide({ strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
      // Only a real Jev answer: the scalper turns SCALP_ON_* into a mandate, and any answer restarts its ask timer.
      else brain.onChoice?.(r.choice, ctx);
    }
    const proposal: Proposal | null =
      r && r.ok ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction } : null;

    // A coin on probation (added by the coach, not yet proven) trades at half size.
    const probationIds = this.watch(id)?.probation ?? [];
    const target = proposal && (proposal.intent.kind === "open" || proposal.intent.kind === "switch") ? proposal.intent.instId : null;
    const onProbation = target !== null && probationIds.includes(target.split("-")[0]!.toUpperCase());
    const risk = applyRisk({
      ctx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(now, id) * (onProbation ? 0.5 : 1),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });

    if (risk.capTripped) {
      const detail = risk.status;
      db.insertCap(id, now, risk.capTripped, detail);
      bus.emit("cap", { bee: id, cap: risk.capTripped, detail }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    bee.cap = risk.cap;
    // A rules-only hold that the risk layer left alone (a stop or cap still overrides it and shows as usual).
    const ruled = required && risk.action.kind === "none" && !risk.forcedBy;
    const status = ruled ? `${labels[0]}: required by rules, Jev not asked` : risk.status;

    // Hard rule 10: recorded before it is acted on.
    const costUsd = r && r.ok ? r.costUsd : 0;
    const dist = r && r.ok ? distributionMetrics(r.probabilities) : null;
    const evaluationMetrics = {
      source: required ? "rules" : r?.ok ? "jev" : r ? "jev_failure" : "no_answer",
      jevStatus,
      required,
      actionConfidence: r && r.ok ? r.confidence : null,
      conviction: r && r.ok ? r.convictionRaw : null,
      ...(dist ?? { entropy: null, margin: null, topProbability: null, options: labels.length }),
    };
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(menu),
      choice: r && r.ok ? r.choice : null,
      probabilities: r && r.ok ? r.probabilities : null,
      confidence: r && r.ok ? r.confidence : null,
      conviction: r && r.ok ? r.convictionRaw : null,
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      action: risk.action,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status,
      evaluation: {
        ts: now,
        experimentId: assignment?.experimentId ?? null,
        arm: assignment?.arm ?? "baseline",
        policyVersionId: policy.id,
        method: `${method.kind}:${method.id}`,
        strategyId: method.id,
        stateHash: snap.hash,
        menuHash: fingerprint(menu, "menu_"),
        questionSchemaVersion: r?.trace.questionSchemaVersion ?? JEV_QUESTION_SCHEMA_VERSION,
        requestedModel: r?.trace.requestedModel ?? cfg.jev.model,
        answeredModel: r?.trace.answeredModel ?? null,
        questions: r?.trace.questions ?? {},
        answers: r?.trace.answers ?? null,
        metrics: evaluationMetrics,
      },
    });
    if (r?.ok && !required) {
      this.outcomes.schedule({ decisionId, bee: id, ts: now, menu, state: bee, view: ctx.view });
      this.shadow?.enqueue({
        decisionId,
        bee: id,
        ts: now,
        championPolicyId: policy.id,
        stateHash: snap.hash,
        state: snap.state,
        menu,
        instructionSuffix,
      });
    }
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;

    const top3 = r && r.ok ? (Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>) : [];
    this.last[id] = { choice: r && r.ok ? r.choice : null, top3: ruled ? [] : top3, confidence: r && r.ok && !ruled ? r.confidence : null, latencyMs: ruled ? null : r ? r.latencyMs : null, status, ts: now, ...(ruled ? { required: true } : {}) };
    // Flat and nothing to ask Jev (bizzy waiting for her breakout): a live "watching" row every PULSE_MS instead of a
    // "no call" row every tick, so the stream shows how close the trigger is.
    const watching = jevStatus === "no_options" && !bee.position && !!brain.idleStatus && risk.action.kind === "none";
    // Same for a rules-only hold: a row every PULSE_MS, not every tick.
    if ((watching || ruled) && now - (this.lastPulseAt[id] ?? 0) < PULSE_MS) {
      db.saveBee(bee, now);
      return;
    }
    if (watching || ruled) this.lastPulseAt[id] = now;
    bus.emit(
      "decision",
      {
        bee: id,
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : null,
        ...(watching ? { watch: risk.status } : {}),
        probabilities: ruled ? [] : top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        ...(ruled ? { required: true } : {}),
        confidence: r && r.ok && !ruled ? Number(r.confidence.toFixed(3)) : null,
        conviction: r && r.ok && !ruled ? brain.convictionLabels[r.conviction] : null,
        latencyMs: ruled ? null : r ? r.latencyMs : null,
        tokens: r && r.ok && !ruled ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(risk.action),
        vetoedBy: risk.vetoedBy,
        forcedBy: risk.forcedBy,
        status,
        jev: jevStatus,
        ...this.liveChip(id),
      },
      now,
    );

    if (risk.action.kind !== "none") await this.execute(id, risk.action, decisionId, ctx, proposal?.conviction ?? 0);
    db.saveBee(bee, now);
  }

  // ---------- the scalp loop ----------

  /**
   * The scalper's fast clock (SCALP_TICK_MS, code only): refresh the coins' tickers and 1-minute candles, then for each
   * scalping bee manage its position or look for its next entry. Jev is not involved; it set the mandate.
   */
  async scalpTick(): Promise<void> {
    if (this.scalping || this.closedAt !== null) return;
    const ids = this.ids.filter((id) => isScalpBrain(this.brain(id)));
    if (!ids.length) return;
    this.scalping = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("scalp: ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      const follow = new Set<string>();
      for (const id of ids) {
        const sb = this.brain(id);
        if (!isScalpBrain(sb)) continue;
        const m = sb.scalp.mandate(now);
        if (m) follow.add(m.instId);
        const held = this.bees[id].position?.instId;
        if (held) follow.add(held);
      }
      if (follow.size) await this.d.feed.refreshScalp?.([...follow], now);
      await Promise.all(ids.map((id) => this.scalpStep(id, this.now())));
    } catch (err) {
      log.error("scalp loop error", { err: safeError(err) });
    } finally {
      this.scalping = false;
    }
  }

  private async scalpStep(id: BeeId, now: number): Promise<void> {
    if (this.beeBusy.has(id)) return;
    this.beeBusy.add(id);
    try {
      const brain = this.brain(id);
      if (!isScalpBrain(brain)) return;
      this.markBee(id, now);
      const bee = this.bees[id];
      // Holding: stops, the time stop, the target and every cap run through the same risk layer as everything else.
      if (bee.position) return await this.decideBenched(id, now);
      if (bee.cap === "retired" || bee.cap === "loss_stop") return;
      const ctx = this.ctx(id, now);
      const plan = brain.scalp.entry(ctx);
      if ("why" in plan) {
        this.scalpNote[id] = plan.why;
        return;
      }
      if (plan.maker && !this.d.exec.limit) {
        this.scalpNote[id] = "this executor cannot place maker orders";
        return;
      }
      const { db, bus } = this.d;
      const risk = applyRisk({
        ctx,
        brain,
        proposal: { label: plan.label, intent: plan.intent, prob: 1, conviction: 2 },
        jev: "ok",
        sizeMult: this.sizeMult(now, id),
        dataAgeMs: now - this.d.feed.lastRefreshAt,
        maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
      });
      if (risk.capTripped) {
        db.insertCap(id, now, risk.capTripped, risk.status);
        bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
        this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
      }
      bee.cap = risk.cap;
      this.scalpNote[id] = risk.action.kind === "open" ? plan.label : `${plan.label}: ${risk.status}`;
      // Recorded before it is acted on (hard rule 10), with the plan behind it.
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "scalp", stateJson: JSON.stringify({ plan: { ...plan, intent: undefined } }), menuJson: JSON.stringify([plan.label]),
        choice: plan.label, probabilities: { [plan.label]: 1 }, confidence: 1, conviction: 2, latencyMs: 0, inputTokens: 0, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: risk.vetoedBy, forcedBy: risk.forcedBy, status: risk.status,
      });
      bee.totals.decisions++;
      bus.emit("decision", {
        bee: id, choice: plan.label, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null, jevUsd: 0,
        action: describeAction(risk.action), vetoedBy: risk.vetoedBy, forcedBy: risk.forcedBy, status: risk.status, jev: "scalp", required: true,
        ...this.liveChip(id),
      }, now);
      if (risk.action.kind === "open") {
        brain.scalp.begin(plan);
        await this.openPosition(id, decisionId, risk.action.instId, risk.action.side, risk.action.notionalUsd, false, plan.maker ? { px: plan.limitPx, waitMs: this.d.cfg.scalp.makerWaitMs } : undefined);
      }
      db.saveBee(bee, now);
    } catch (err) {
      log.error("scalp step failed", { bee: id, err: safeError(err) });
    } finally {
      this.beeBusy.delete(id);
    }
  }

  // ---------- benched: ride the position ----------

  private async decideBenched(id: BeeId, now: number, paused = false): Promise<void> {
    const { db } = this.d;
    const bee = this.bees[id];
    const ctx = this.ctx(id, now);
    let risk = applyRisk({
      ctx,
      brain: this.brain(id),
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now, id),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    // Paused: exits (stops, time stop, loss stop) still run, but no rule may open or add anything, not even the forced entry.
    if (paused && ["open", "switch", "add", "leg_open"].includes(risk.action.kind)) risk = { ...risk, action: { kind: "none" }, forcedBy: null, status: "paused: not opening anything new" };
    if (risk.capTripped) {
      db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
    }
    bee.cap = risk.cap;
    const prev = this.last[id];
    this.last[id] = { choice: null, top3: prev?.top3 ?? [], confidence: null, latencyMs: null, status: risk.status, ts: now };
    if (risk.action.kind !== "none") {
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status,
      });
      this.d.bus.emit("decision", {
        bee: id, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: describeAction(risk.action), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(id),
      }, now);
      await this.execute(id, risk.action, decisionId, ctx, 0);
    } else if (now - (this.lastPulseAt[id] ?? 0) >= PULSE_MS) {
      // Keep benched bees in the stream: a live row with the position's P&L ticking, no Jev call behind it.
      this.lastPulseAt[id] = now;
      const p = bee.position;
      this.d.bus.emit("decision", {
        bee: id, choice: paused ? (p ? `PAUSED, HOLDING ${p.coin}` : "PAUSED") : p ? `RIDING ${p.coin}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status: risk.status, jev: paused ? "paused" : "benched", pulse: true,
        ...this.liveChip(id),
      }, now);
    }
    db.saveBee(bee, now);
  }

  /** The bee's money right now, for the stream: open P&L (or total P&L when flat) and how it moved since its last row. */
  private liveChip(id: BeeId) {
    const b = this.bees[id];
    const p = b.position;
    const value = p ? b.uplUsd : b.equityUsd - startEquityOf(this.d.cfg, id);
    const prev = this.lastChipUsd[id];
    this.lastChipUsd[id] = value;
    return {
      live: {
        coin: p?.coin ?? null,
        side: p?.side ?? null,
        valueUsd: Number(value.toFixed(2)),
        kind: p ? "open" : "total",
        deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)),
      },
    };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched bee that is sitting flat
   * re-opens the last position it held (same coin, side and size, at today's price) and rides it. Not a trade
   * toward its cap. Refused outright in demo/live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    for (const id of this.ids) {
      const bee = this.bees[id];
      if (bee.position || (bee.cap !== "trade_cap" && bee.cap !== "fee_budget")) continue;
      const last = this.d.db.raw
        .prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE bee = ? AND reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`)
        .get(id) as { instId: string; side: "buy" | "sell"; contracts: number } | undefined;
      if (!last) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "open", instId: last.instId, side: last.side === "buy" ? "long" : "short" }, vetoedBy: null, forcedBy: "resume_last",
        status: "benched: back into its last position to ride it",
      });
      const ok = await this.order(id, decisionId, last.instId, last.side, last.contracts, false, "resume_last");
      const p = (this.bees[id] as BeeState).position; // re-read: order() just filled it
      if (!ok || !p) continue;
      const ctx = this.ctx(id, this.now());
      const inst = ctx.view.instruments.get(last.instId);
      p.stopPx = this.brain(id).stopFor(last.instId, p.side, p.entryPx, ctx);
      p.initialStopPx = p.stopPx;
      const notional = inst ? positionNotional(p, p.entryPx, inst.ctVal) : 0;
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      this.d.db.saveBee(bee, now);
      log.info("resumed last position", { bee: id, coin: p.coin, side: p.side });
    }
  }

  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("experiment close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Close whatever each bee holds (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      this.ids.map(async (id) => {
        const bee = this.bees[id];
        if (!allPositions(bee).length || now < (this.closeRetryAt[id] ?? 0)) return;
        // Legs first, then the main position.
        for (const p of [...(bee.legs ?? []), ...(bee.position ? [bee.position] : [])]) {
          const leg = p !== bee.position;
          const decisionId = this.d.db.insertDecision({
            bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
            conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
            action: leg ? { kind: "leg_close", instId: p.instId, reason: "experiment_closed" } : { kind: "close", reason: "experiment_closed" },
            vetoedBy: null, forcedBy: "experiment_closed", status: "experiment closed: closing position",
          });
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "experiment_close");
          if (!ok) this.closeRetryAt[id] = now + 10_000;
        }
        this.d.db.saveBee(bee, now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && this.ids.every((id) => !allPositions(this.bees[id]).length)) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: every bunny is flat");
    }
  }

  // ---------- execution ----------

  private async execute(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, _conviction: number): Promise<void> {
    const bee = this.bees[id];
    const p = bee.position;
    switch (action.kind) {
      case "close":
        if (!p) return;
        {
          const sb = this.brain(id);
          // A scalp's target rests as a maker limit at the touch; if it does not fill it is tried again next look
          // (the stop and the time stop still protect the trade). Everything else closes at the market.
          if (action.reason === "scalp_target" && isScalpBrain(sb) && sb.scalp.makerTarget() && this.d.exec.limit) {
            const t = this.d.feed.view().tickers.get(p.instId);
            const px = t ? (p.side === "long" ? t.ask : t.bid) : 0;
            if (px > 0) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "scalp_target", false, { px, waitMs: this.d.cfg.scalp.exitWaitMs });
            return;
          }
        }
        await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, action.reason);
        return;
      case "trim": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, "trim");
        else log.info("trim rounds to zero, skipped", { bee: id });
        return;
      }
      case "add": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const s = ctx.view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add");
          const q = this.bees[id].position;
          // An add raises the average entry; don't let it turn the position into a loser: stop to at least the new average.
          if (ok && q && this.brain(id).protectAdds) ratchetStop(q, q.entryPx);
        } else log.info("add rounds to zero contracts, skipped", { bee: id });
        return;
      }
      case "switch":
        if (p) {
          const ok = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "switch_close");
          if (!ok) return;
        }
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "leg_open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd, true);
        return;
      case "leg_close": {
        const l = bee.legs?.find((x) => x.instId === action.instId);
        if (l) await this.order(id, decisionId, l.instId, l.side === "long" ? "sell" : "buy", l.contracts, true, "leg_close");
        return;
      }
    }
  }

  private async openPosition(id: BeeId, decisionId: number, instId: string, side: Side, notionalUsd: number, leg = false, maker?: { px: number; waitMs: number }): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { bee: id, coin: inst.coin, notionalUsd });
      return;
    }
    const ok = await this.order(id, decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, leg ? "leg_open" : maker ? "scalp_open" : "open", leg, maker);
    const bee = this.bees[id];
    const p = leg ? bee.legs?.find((l) => l.instId === instId) : bee.position;
    if (!ok || !p) return;
    bee.tradesToday++;
    const ctx = leg ? this.legCtx(id, p, this.now()) : this.ctx(id, this.now());
    p.stopPx = this.brain(id).stopFor(instId, side, p.entryPx, ctx);
    p.initialStopPx = p.stopPx;
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
    if (s.trend) p.entryScore = s.trend.score;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(id: BeeId, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string, leg = false, maker?: { px: number; waitMs: number }): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return false;
    // After the exchange rejects a new order, this bee opens nothing for ORDER_REJECT_PAUSE_MS (it used to resend
    // every tick). Closes (reduceOnly) are never paused: stops must always try.
    if (!reduceOnly && now < (this.orderPauseUntil[id] ?? 0)) {
      log.info("new orders paused after an exchange rejection", { bee: id, coin: inst.coin, purpose, untilS: Math.round(((this.orderPauseUntil[id] ?? 0) - now) / 1000) });
      return false;
    }
    // Maker orders carry the scalper prefix, so a start after a crash can find and cancel any that were left resting.
    const clOrdId = `${maker ? "sc" : id.slice(0, 2)}${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    if (maker && !exec.limit) {
      log.warn("maker order needed but the executor cannot place limits: nothing sent", { bee: id, purpose });
      return false;
    }
    const orderId = db.insertOrder({ decisionId, bee: id, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const res = maker ? await exec.limit!(id, { instId, side, contracts, reduceOnly, clOrdId, px: maker.px, waitMs: maker.waitMs }) : await exec.market(id, { instId, side, contracts, reduceOnly, clOrdId });
    // A maker order that simply did not fill traded nothing and left nothing on the book: not an error, not a pause.
    if (!res.ok && res.error.code === UNFILLED) {
      db.updateOrder(orderId, "rejected", null, UNFILLED);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: "unfilled" });
      return false;
    }
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { bee: id, coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      if (!reduceOnly) {
        this.orderPauseUntil[id] = now + ORDER_REJECT_PAUSE_MS;
        this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${inst.coin} ${purpose} order rejected (${res.error.code} ${res.error.message}); new orders paused ${ORDER_REJECT_PAUSE_MS / 60_000} min`);
      }
      return false;
    }
    db.updateOrder(orderId, "filled", res.ordId, null);
    const bee = this.bees[id];
    const realised = applyFill(bee, { instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts, leg });
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.insertFill({ orderId, bee: id, ts: res.ts, instId, side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: realised });
    this.remark(id, instId, res.avgPx);
    // The scalper keeps its own books: a mandate's trade count, and the loss streak behind its circuit breaker.
    const sb = this.brain(id);
    if (isScalpBrain(sb) && !leg) {
      if (!reduceOnly) sb.scalp.opened(res.avgPx, res.feeUsd, now, notionalUsd);
      else if (this.bees[id].position === null) sb.scalp.closed(realised, res.feeUsd, now);
    }
    const dir = reduceOnly ? "CLOSE" : side === "buy" ? "LONG" : "SHORT";
    bus.emit("fill", {
      bee: id,
      coin: inst.coin,
      side,
      purpose,
      contracts: res.contracts,
      px: res.avgPx,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      feeUsd: Number(res.feeUsd.toFixed(4)),
      realisedUsd: Number(realised.toFixed(2)),
      label: `${this.d.cfg.slots[id].name} ${dir} ${inst.coin} $${notionalUsd.toFixed(0)}`,
    });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const id of this.ids) {
      const bee = this.bees[id];
      // Every position pays or earns funding: the main one and any legs.
      for (const p of allPositions(bee)) {
        const s = view.stats.get(p.instId);
        const inst = view.instruments.get(p.instId);
        if (!s || !inst || s.fundingPct === null) continue;
        const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
        const billId = p === bee.position ? `sim-${id}-${slot}` : `sim-${id}-${slot}-${p.coin}`;
        if (this.d.db.insertFunding(id, now, p.instId, amount, billId)) {
          applyFunding(bee, amount);
          this.d.bus.emit("funding", { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
        }
      }
    }
  }

  /** MODE=demo/live: record funding bills (type 8) as their own ledger rows. */
  private async pollFunding() {
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    for (const id of this.ids) {
      const bills = await this.d.exec.fundingBills(id);
      for (const b of bills ?? []) {
        if (b.ts < since) continue;
        if (this.d.db.insertFunding(id, b.ts, b.instId, b.amountUsd, b.billId)) {
          applyFunding(this.bees[id], b.amountUsd);
          this.d.bus.emit("funding", { bee: id, coin: b.instId?.split("-")[0] ?? null, amountUsd: b.amountUsd }, b.ts);
        }
      }
    }
  }

  /** Every 5 min (demo/live): our position and fees vs OKX. On mismatch, adopt OKX's position and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconAt = now;
    const view = this.d.feed.view();
    const diffs: string[] = [];
    for (const id of this.ids) {
      const bee = this.bees[id];
      const ex = await this.d.exec.positions(id);
      if (ex === null) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX positions`);
        continue;
      }
      // Every position we hold (main + legs) against every OKX position, by instrument and signed size.
      const ours = allPositions(bee);
      const signed = (p: Position) => (p.side === "long" ? 1 : -1) * p.contracts;
      const oursBy = new Map(ours.map((p) => [p.instId, signed(p)]));
      const theirsBy = new Map(ex.map((x) => [x.instId, x.pos]));
      const sameBooks = oursBy.size === theirsBy.size && [...theirsBy].every(([i, n]) => oursBy.has(i) && Math.abs(oursBy.get(i)! - n) < 1e-9);
      let ok = sameBooks;
      const fmt = (m: Map<string, number>) => (m.size ? [...m].map(([i, n]) => `${n} ${i.split("-")[0]}`).join(", ") : "flat");
      let detail = ok ? "match" : `ours ${fmt(oursBy)} vs OKX ${fmt(theirsBy)}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`)
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      if (rows.length) {
        const theirFees = await this.d.exec.feesFor(id, [...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
        if (theirFees) {
          const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((a, r) => a + r.fee, 0);
          const theirSum = [...theirFees.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(ourSum - theirSum) >= 0.005) {
            ok = false;
            detail += `; fees ours $${ourSum.toFixed(2)} vs OKX $${theirSum.toFixed(2)}`;
          }
        }
      }

      if (!sameBooks) {
        // OKX is the truth: rebuild every position from it, keeping our stops where the coin and side still match.
        const rebuilt: Position[] = ex.map((theirs) => {
          const mine = ours.find((p) => p.instId === theirs.instId);
          const inst = view.instruments.get(theirs.instId);
          const side: Side = theirs.pos > 0 ? "long" : "short";
          const keepStop = mine && mine.side === side ? mine.stopPx : null;
          const np: Position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: mine?.openedAt ?? now,
            stopPx: keepStop ?? this.brain(id).stopFor(theirs.instId, side, theirs.avgPx, this.ctx(id, now)),
            riskUsd: mine?.riskUsd ?? (inst ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01 : 0),
          };
          np.initialStopPx = keepStop !== null && mine ? (mine.initialStopPx ?? mine.stopPx) : np.stopPx;
          np.peakPx = keepStop !== null && mine ? (mine.peakPx ?? null) : null;
          if (inst && np.initialStopPx !== null && np.initialStopPx !== undefined) np.riskUsd = sizedRiskUsd(np.contracts, inst.ctVal, np.entryPx, np.initialStopPx);
          return np;
        });
        // The main position stays the main one if OKX still has it.
        const mainIdx = Math.max(0, rebuilt.findIndex((p) => p.instId === bee.position?.instId));
        bee.position = rebuilt[mainIdx] ?? null;
        bee.legs = rebuilt.filter((_, k) => k !== mainIdx);
        if (bee.position) bee.flatSince = null;
        else bee.flatSince ??= now;
      }
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = { ok, detail: ok ? "books match OKX" : diffs.join(" | "), ts: now };
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  /** Momentum bees: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankBoozyHourly() {
    const now = this.now();
    for (const id of this.ids) {
      if (this.d.cfg.slots[id].style !== "boozy") continue;
      const bee = this.bees[id];
      if (Math.floor(now / 3_600_000) === Math.floor(bee.top1.rankedAt / 3_600_000)) continue;
      // Each Momentum bee's own ranking: a coin-restricted bee only ranks its own coins.
      const topId = this.brain(id).universe(this.ctx(id, now))[0];
      if (!topId) continue;
      const coin = coinOf(topId);
      bee.top1 = { coin, streak: coin === bee.top1.coin ? bee.top1.streak + 1 : 1, rankedAt: now };
    }
  }

  private brains = {} as Record<BeeId, BeeBrain>;
  private spec = {} as Record<BeeId, ActiveSpec | undefined>;
  private watched = {} as Record<BeeId, { key: string; brain: BeeBrain }>;

  /**
   * The slot's style brain, narrowed to the owner's coins and carrying the owner's rules (bees/custom.ts), then
   * narrowed again to the watchlist its AI brains chose, when there is a usable one.
   */
  private brain(id: BeeId): BeeBrain {
    const s = this.d.cfg.slots[id];
    const owner = (this.brains[id] ??= customBrain(this.baseBrain(id), { coins: s.coins, rules: s.rules }));
    const w = this.watch(id);
    if (!w) return owner;
    const key = `${w.coins.join(",")}|${w.probation.join(",")}`;
    const hit = this.watched[id];
    if (hit?.key === key) return hit.brain;
    const brain = customBrain(owner, { coins: w.coins, rules: "", coinLine: watchlistLine(w.coins, w.probation) });
    this.watched[id] = { key, brain };
    return brain;
  }

  /**
   * The method the bee trades: the specialisation its brains chose (any style its market allows, or any lab skill),
   * else its own style. The macro squad runs the macro style by default (bees/macro.ts).
   */
  private baseBrain(id: BeeId): BeeBrain {
    const s = this.d.cfg.slots[id];
    const a = this.spec[id];
    if (a?.kind === "skill") {
      const skill = this.d.skillById?.(a.id);
      if (skill) return skillBrain({ skill, params: a.params });
    }
    if (a?.kind === "style") {
      if (s.market === "crypto" && a.id === "scalp" && this.scalpAvailable()) return scalpBrain(this.scalpDeps());
      if (s.market === "crypto" && (STYLES as readonly string[]).includes(a.id)) return BRAINS[a.id as keyof typeof BRAINS];
      if (s.market !== "crypto" && a.id === "macro") return macro;
    }
    // Degen's native method is the fast one-minute scalp engine. It remains flat while the evidence gate is closed;
    // turning SCALP off explicitly falls back to its slower short-horizon style instead of disabling the agent.
    if (s.market === "crypto" && s.style === "degen" && this.d.cfg.scalp.enabled) return scalpBrain(this.scalpDeps());
    return s.market === "crypto" ? BRAINS[s.style] : macro;
  }

  /** Whether a chosen method can run for this bee (a known skill, or a style its market allows). */
  private specValid(id: BeeId, w: { kind: "style" | "skill"; id: string }): boolean {
    const market = this.d.cfg.slots[id].market;
    if (w.kind === "skill") return !!this.d.skillById?.(w.id);
    return market === "crypto" ? (STYLES as readonly string[]).includes(w.id) || (w.id === "scalp" && this.scalpAvailable()) : w.id === "macro";
  }

  // ---------- the scalper: gate, deps ----------

  /** What the lab lets the scalper trade right now. With SCALP_REQUIRE_LAB off (never in live) default rules stand in. */
  private scalpRules(): GateRule[] {
    const sc = this.d.cfg.scalp;
    if (!sc.enabled) return [];
    const allowed = (coin: string) => sc.coins.includes("*") || sc.coins.includes(coin);
    if (!sc.requireLab) {
      const coins = sc.coins.includes("*")
        ? this.d.feed.view().gated.slice(0, sc.universeSize).map((id) => id.split("-")[0]!)
        : sc.coins;
      return coins.map((coin) => ({ coin, ruleId: "micro_breakout", params: {}, netBps: 0, trades: 0 }));
    }
    const g = this.d.scalpGate?.();
    return g?.open ? g.rules.filter((r) => allowed(r.coin)) : [];
  }
  private scalpAvailable = () => this.scalpRules().length > 0;
  private scalpCosts(): CostModel {
    const lab = this.d.scalpGate?.().costs ?? DEFAULT_COSTS;
    // Today's fees, the lab's slippage, spread and fill haircut.
    return { ...lab, makerFee: this.d.cfg.scalp.makerFee, takerFee: this.d.cfg.risk.takerFeeRate };
  }
  private scalpDeps(): ScalpDeps {
    return { rules: () => this.scalpRules(), costs: () => this.scalpCosts(), cfg: this.d.cfg.scalp, ...(this.d.scalpClosed ? { closed: this.d.scalpClosed } : {}) };
  }

  /**
   * Adopt the method the bee's brains chose, when it differs from the one it trades: only while it holds nothing, and
   * not sooner than SPECIALIZE_MIN_HOURS after its last switch (a new bee's first choice applies at once).
   */
  private adoptSpecialization(id: BeeId, now: number): void {
    if (!this.d.specialization || !this.d.cfg.lab.specialization) return;
    const want = this.d.specialization(id) ?? null;
    const valid = want && this.specValid(id, want) ? want : null;
    const key = valid ? `${valid.kind}:${valid.id}:${JSON.stringify(valid.params ?? {})}` : "";
    const cur = this.spec[id];
    if ((cur?.key ?? "") === key) return;
    if (allPositions(this.bees[id]).length) return; // never switch method mid-position
    if (cur && now - cur.since < this.d.cfg.lab.specializeMinHours * 3_600_000) return;
    this.spec[id] = valid ? { kind: valid.kind, id: valid.id, params: valid.params ?? {}, key, since: now } : undefined;
    delete this.brains[id];
    delete this.watched[id];
    this.d.db.setMeta(`spec_${id}`, JSON.stringify(this.spec[id] ?? null));
    const label = valid ? `${valid.kind === "skill" ? "skill" : "style"} ${valid.id}` : "its own style";
    log.info("bee specialised", { bee: id, method: label });
    this.d.bus.emit("status", { event: "specialization", bee: id, name: this.d.cfg.slots[id].name, method: label }, now);
  }

  /** The watchlist the engine applies right now (null = the style's normal coin choice). */
  private watch(id: BeeId): { coins: string[]; probation: string[]; items: Array<{ coin: string; reason: string; probation: boolean; addedAt: number | null }> } | null {
    if (!this.d.watchlist) return null;
    const s = this.d.cfg.slots[id];
    try {
      const picks = this.d.watchlist(id);
      const w = effectiveWatchlist({
        enabled: true,
        picks,
        style: s.style,
        market: s.market,
        ownerCoins: s.coins.map((c) => c.toUpperCase()),
        tier: this.d.evolution?.bees[id]?.tier ?? null,
        liquid: (s.market === "crypto" ? this.d.feed.view().gated : this.d.feed.view().macro).map((i) => i.split("-")[0]!.toUpperCase()),
      });
      if (!w) return null;
      // Why each coin is there, as the brains wrote it (the dashboard's Watchlists view).
      const why = new Map((picks ?? []).map((p) => [p.coin, p]));
      return { ...w, items: w.coins.map((c) => ({ coin: c, reason: why.get(c)?.reason ?? "", probation: w.probation.includes(c), addedAt: why.get(c)?.addedAt ?? null })) };
    } catch (err) {
      log.warn("watchlist failed", { bee: id, err: safeError(err) });
      return null;
    }
  }

  private knobs(id: BeeId) {
    const s = this.d.cfg.slots[id];
    const a = this.spec[id];
    const style = a?.kind === "style" && (STYLES as readonly string[]).includes(a.id) ? (a.id as keyof Config["bees"]) : s.style;
    const k = s.market !== "crypto" ? this.d.cfg.macro.knobs : a?.kind === "style" && a.id === "scalp" ? this.d.cfg.scalp.knobs : this.d.cfg.bees[style];
    const extra = this.d.evolution?.perks(id).extraTrades ?? 0;
    return extra > 0 ? { ...k, maxTradesPerDay: k.maxTradesPerDay + extra } : k;
  }

  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: all bunnies holding");
    }
  }

  private sizeMult(now: number, id?: BeeId): number {
    const { cfg } = this.d;
    // Survival: a bee in danger or critical trades smaller.
    const survival = id && this.d.evolution ? this.d.evolution.sizeFactor(id) : 1;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return survival;
    return survival * (now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1);
  }

  // ---------- read-only views for the dashboard ----------

  /**
   * The home page's market board: the most liquid gated coins (and macro instruments when a macro bee runs), with the
   * numbers the bees trade on and CoinMarketCap's rank and market cap when it is on.
   */
  private marketBoard() {
    const view = this.d.feed.view();
    const cmc = this.d.cmc?.() ?? null;
    const macro = this.ids.some((id) => this.d.cfg.slots[id].squad === "macro");
    const ids = [...view.gated.slice(0, 40), ...(macro ? view.macro.slice(0, 12) : [])];
    const r = (x: number | null | undefined, dp = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(dp)));
    const out = [];
    for (const instId of ids) {
      const s = view.stats.get(instId);
      if (!s) continue;
      const coin = s.coin.toUpperCase();
      const c = cmc?.coins.get(coin);
      out.push({
        coin,
        kind: view.instruments.get(instId)?.kind ?? "crypto",
        px: s.mid,
        ret1hPct: r(s.ret1hPct),
        ret24hPct: r(s.ret24hPct),
        ret7dPct: r(s.ret7dPct),
        vol24hUsd: Math.round(s.vol24hUsd),
        spreadBp: r(s.spreadBp, 1),
        atrPct: r(s.atr14Pct),
        rsi: r(s.rsi14, 0),
        fundingPct: r(s.fundingPct, 4),
        oiUsd: s.oiUsd === null ? null : Math.round(s.oiUsd),
        cmcRank: c?.rank ?? null,
        mcapUsd: c?.mcapUsd === null || c?.mcapUsd === undefined ? null : Math.round(c.mcapUsd),
      });
    }
    return out;
  }

  /** CoinMarketCap's market mood for the system bar (null when off or stale). */
  private cmcView() {
    const s = this.d.cmc?.() ?? null;
    if (!s) return null;
    const r = (x: number | null | undefined, dp = 1) => (x === null || x === undefined ? null : Number(x.toFixed(dp)));
    return {
      fearGreed: s.fearGreed ? { value: r(s.fearGreed.value, 0), label: s.fearGreed.label } : null,
      btcDominancePct: r(s.global?.btcDominancePct),
      mcapChange24hPct: r(s.global?.mcapChange24hPct, 2),
      totalMcapUsd: r(s.global?.totalMcapUsd, 0),
      altSeason: s.altSeason ? { index: r(s.altSeason.index, 0), label: altSeasonLabel(s.altSeason.index), yearlyHigh: s.altSeason.yearlyHigh, yearlyLow: s.altSeason.yearlyLow } : null,
      fearTrend: s.fearTrend ? { days: s.fearTrend.days.map((d) => d.value), change: s.fearTrend.change } : null,
      sectors: s.sectors ? { hot: s.sectors.hot.map((x) => ({ name: x.name, pct: r(x.mcapChange24hPct, 2) })), cold: s.sectors.cold.map((x) => ({ name: x.name, pct: r(x.mcapChange24hPct, 2) })) } : null,
      coins: s.coins.size,
      updatedAt: s.updatedAt,
    };
  }

  private publicBee(id: BeeId) {
    const b = this.bees[id];
    const view = this.d.feed.view();
    const p = b.position;
    const inst = p ? view.instruments.get(p.instId) : undefined;
    const mid = p ? view.tickers.get(p.instId)?.mid : undefined;
    const start = startEquityOf(this.d.cfg, id);
    const knobs = this.knobs(id);
    const r2 = (x: number) => Number(x.toFixed(2));
    return {
      bee: id,
      equityUsd: r2(b.equityUsd),
      startEquityUsd: r2(start),
      pnlUsd: r2(b.equityUsd - start),
      pnlPct: r2(((b.equityUsd - start) / start) * 100),
      position: p
        ? {
            coin: p.coin,
            side: p.side,
            sizeUsd: inst && mid ? r2(positionNotional(p, mid, inst.ctVal)) : null,
            entryPx: p.entryPx,
            markPx: mid ?? null,
            stopPx: p.stopPx,
            uplUsd: r2(b.legs?.length ? (b.mainUplUsd ?? b.uplUsd) : b.uplUsd),
            minutesHeld: Math.round(minutesSince(p.openedAt, this.now())),
          }
        : null,
      /** Which LLM brain plans for this bee (and whether it has a key or sign-in), what it trades, its exposure. */
      brain: (() => {
        const bid = this.d.cfg.brains.slots[id];
        const c = (this.d.cfg.brains.creds as Record<string, { model: string } | undefined>)[bid] ?? this.d.cfg.brains.creds.custom?.find((x) => x.id === bid);
        return { id: bid, label: brainInfo(bid).label, model: c?.model ?? null, online: !!c };
      })(),
      market: this.d.cfg.slots[id].market,
      squad: this.d.cfg.slots[id].squad,
      /** The method it trades: its brains' specialisation, or its own style. */
      method: (() => {
        const a = this.spec[id];
        if (a?.kind === "skill") return { kind: "skill", id: a.id, name: this.d.skillById?.(a.id)?.name ?? a.id, since: a.since };
        if (a?.kind === "style") return { kind: "style", id: a.id, name: a.id, since: a.since };
        return { kind: "own", id: this.d.cfg.slots[id].market === "crypto" ? this.d.cfg.slots[id].style : "macro", name: null, since: null };
      })(),
      exposureUsd: r2(allPositions(b).reduce((a, q) => {
        const qi = view.instruments.get(q.instId);
        const qm = view.tickers.get(q.instId)?.mid;
        return a + (qi && qm ? positionNotional(q, qm, qi.ctVal) : 0);
      }, 0)),
      uplR: p && p.riskUsd > 0 ? Number(((b.legs?.length ? (b.mainUplUsd ?? b.uplUsd) : b.uplUsd) / p.riskUsd).toFixed(2)) : null,
      /** Multi-orders: extra positions, and how many positions the bee may hold. */
      legs: (b.legs ?? []).map((l) => {
        const lm = view.tickers.get(l.instId)?.mid;
        const li = view.instruments.get(l.instId);
        return {
          coin: l.coin,
          side: l.side,
          sizeUsd: li && lm ? r2(positionNotional(l, lm, li.ctVal)) : null,
          entryPx: l.entryPx,
          markPx: lm ?? null,
          stopPx: l.stopPx,
          uplUsd: li && lm ? r2(uplUsd(l, lm, li.ctVal)) : null,
          minutesHeld: Math.round(minutesSince(l.openedAt, this.now())),
        };
      }),
      slots: this.slots(id),
      flatMinutes: p ? null : Math.round(minutesSince(b.flatSince, this.now())),
      tradesToday: b.tradesToday,
      maxTradesPerDay: knobs.maxTradesPerDay,
      feesTodayUsd: r2(b.feesTodayUsd),
      feeBudgetUsd: knobs.feeBudgetUsdDay,
      cap: b.cap,
      totals: { feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), jevUsd: Number(b.totals.jevUsd.toFixed(4)), realisedUsd: r2(b.totals.realisedUsd), decisions: b.totals.decisions, orders: b.totals.orders },
      maxNotionalUsd: r2(maxNotionalUsd(this.ctx(id, this.now()))),
      last: this.last[id] ?? null,
      evo: (() => {
        const e = this.d.evolution?.bees[id];
        return e ? { tier: e.tier, health: Math.round(e.health * 10) / 10, points: e.points, level: e.level, deaths: e.deaths } : null;
      })(),
      /** The AI-chosen coins the engine applies right now (null = the style's normal choice). */
      watchlist: this.watch(id),
      /** The scalper's mandate, circuit breaker and last look, when this bee scalps. */
      scalp: (() => {
        const sb = this.brain(id);
        if (!isScalpBrain(sb)) return null;
        const st = sb.scalp.status(this.now());
        return {
          gateOpen: st.gateOpen,
          note: st.note,
          last: this.scalpNote[id] ?? null,
          mandate: st.mandate ? { coin: st.mandate.coin, bias: st.mandate.bias, used: st.mandate.used, maxTrades: st.mandate.maxTrades, expiresAt: st.mandate.expiresAt } : null,
          pausedUntil: st.pausedUntil > this.now() ? st.pausedUntil : null,
          lossStreak: st.lossStreak,
        };
      })(),
    };
  }

  /**
   * New owner rules for a running bunny (The Farmer's rewrite): the next decision uses them. Its coins, style and money stay.
   * The caller saves them to the settings file so a restart keeps them.
   */
  setRules(id: BeeId, rules: string): void {
    const s = this.d.cfg.slots[id];
    if (!s || !this.ids.includes(id)) throw new Error("no such bunny");
    s.rules = rules;
    delete this.brains[id];
    delete this.watched[id];
  }

  snapshot() {
    const bees = this.ids.map((id) => this.publicBee(id));
    const sum = (f: (b: (typeof bees)[number]) => number) => Number(bees.reduce((a, b) => a + f(b), 0).toFixed(4));
    const view = this.d.feed.view();
    return {
      ts: this.now(),
      mode: this.d.cfg.mode,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: this.ids.every((id) => !allPositions(this.bees[id]).length) },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      tickMs: this.d.cfg.tickMs,
      /** Engine telemetry for the dashboard's system bar: which intelligence features are on. No secrets. */
      system: {
        jevModel: this.d.cfg.jev.model,
        // The four main agents always; GLM and the owner's custom brains only once they are set up.
        brains: (() => {
          const cr = this.d.cfg.brains.creds;
          const list = [
            ...(["openai", "claude", "kimi"] as const).map((bid) => ({ id: bid as string, model: cr[bid]?.model ?? null, online: !!cr[bid] })),
            ...(cr.zai ? [{ id: "zai", model: cr.zai.model, online: true }] : []),
            ...(cr.custom ?? []).map((b) => ({ id: b.id, model: b.model, online: true })),
          ];
          return list.map((b) => ({ ...b, label: brainInfo(b.id).label }));
        })(),
        labSignals: !!this.d.labVotes,
        cmc: this.cmcView(),
        scalp: { enabled: this.d.cfg.scalp.enabled, gateOpen: this.scalpAvailable(), reason: this.d.cfg.scalp.enabled ? (this.d.cfg.scalp.requireLab ? (this.d.scalpGate?.().reason ?? "no lab report") : "lab gate off (paper only)") : "SCALP is off", bees: this.ids.filter((id) => isScalpBrain(this.brain(id))).length },
        watchlist: !!this.d.watchlist,
        survival: this.d.evolution?.opts.survival ?? false,
        rewards: this.d.evolution?.opts.rewards ?? false,
        maxPositions: this.d.evolution?.opts.maxPositions ?? 1,
        macroTrading: this.d.cfg.universe.allowNonCrypto,
        macroBees: this.ids.filter((id) => this.d.cfg.slots[id].squad === "macro").length,
        maxLeverage: this.d.cfg.risk.maxLeverage,
      },
      bees,
      leaderboard: [...bees].sort((a, b) => b.equityUsd - a.equityUsd).map((b) => ({ bee: b.bee, equityUsd: b.equityUsd })),
      evolution: this.d.evolution
        ? { survival: this.d.evolution.opts.survival, rewards: this.d.evolution.opts.rewards, board: this.d.evolution.board(Object.fromEntries(this.ids.map((id) => [id, this.d.cfg.slots[id].name]))) }
        : null,
      totals: { feesUsd: sum((b) => b.totals.feesUsd), fundingUsd: sum((b) => b.totals.fundingUsd), jevUsd: sum((b) => b.totals.jevUsd), pnlUsd: sum((b) => b.pnlUsd) },
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null },
      recon: this.recon,
      market: {
        refreshedAt: view.ts,
        universe: view.gated.map((i) => i.split("-")[0]),
        spreadBlocked: view.spreadBlocked.map((i) => ({ coin: i.split("-")[0], spreadBp: Number((view.tickers.get(i)?.spreadBp ?? 0).toFixed(1)) })),
        attention: view.newsAvailable ? "news" : "volume",
        board: this.marketBoard(),
      },
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    return { ok: this.d.feed.lastRefreshAt > 0 && age < 5 * this.d.cfg.dataRefreshMs, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: this.ids.every((id) => !this.bees[id].position), marketAgeMs: age, uptimeS: Math.round((this.now() - this.startedAt) / 1000) };
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case "leg_open":
      return `leg ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "leg_close":
      return `close leg ${a.instId.split("-")[0]} (${a.reason})`;
    case "none":
      return "hold";
    case "close":
      return `close (${a.reason})`;
    case "trim":
      return `trim ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "switch":
      return `switch to ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
  }
}
