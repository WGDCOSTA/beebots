// Survival and rewards: every bunny knows it can die.
//
// Health is equity as a % of the bunny's start. Below SURVIVAL_DANGER_PCT a bunny is in danger, below
// SURVIVAL_CRITICAL_PCT it is critical, and at BEE_RETIRE_AT_PCT it dies (the risk layer's "retired" cap: it trades
// no more until the owner revives it). A bunny in trouble trades smaller, is told in every Jev snapshot how close death
// is, and its tier change wakes a survival council (brains/survival.ts) where several LLM brains combine to rescue it,
// and may write and backtest new skills.
//
// Profitable bunnies earn points (each UTC day's gain, a bonus for the day's best bunny, a point for surviving the day).
// Points make levels, and levels unlock prizes: more skills in the playbook, the right to write new skills, extra
// brains in its councils, and a bounded boost of its trade and size limits. Leverage is never raised (hard rule), and
// in live mode the limit boost is off unless REWARDS_IN_LIVE is set.
import type { BeeState } from "./bees/types.js";
import type { BeeId } from "./config.js";

export const TIERS = ["thriving", "healthy", "danger", "critical", "dead"] as const;
export type Tier = (typeof TIERS)[number];

/** Points needed for each level (index = level). */
export const LEVELS = [0, 50, 150, 300, 500, 800] as const;

export interface EvolutionOpts {
  survival: boolean;
  rewards: boolean;
  dangerPct: number;
  criticalPct: number;
  /** BEE_RETIRE_AT_PCT: at or below it the bunny dies. */
  deathPct: number;
  /** Largest share a reward may add to a bunny's max position (0.5 = +50%). */
  maxLimitBoost: number;
  /** Limit boosts also apply with real money. */
  boostLimits: boolean;
  startEquityUsd: number;
  /** A bunny's own start (its wallet), when bunnies start with different money; default startEquityUsd. */
  startOf?: (id: BeeId) => number;
  /** Most positions a bunny may hold at once (MAX_POSITIONS_PER_BEE). */
  maxPositions?: number;
}

export interface Perks {
  /** Skills the bunny's playbook may hold. */
  skillSlots: number;
  /** Its brain may write, backtest and adopt new skills (also granted in danger). */
  canAuthorSkills: boolean;
  /** Extra brains consulted in its councils on top of its own. */
  extraBrains: number;
  /** Fraction added to max position size (never to leverage). */
  limitBoost: number;
  /** Extra opens per UTC day. */
  extraTrades: number;
  /** Positions it may hold at once: 3 at level zero, plus 3 for every level, capped by MAX_POSITIONS_PER_BEE. */
  positions: number;
}

export interface BeeEvolution {
  points: number;
  level: number;
  deaths: number;
  tier: Tier;
  health: number;
  peakEquityUsd: number;
  dayKey: string;
  dayStartEquityUsd: number;
  /** Skills this bunny wrote that passed their backtest. */
  skillsAuthored: number;
  /** Last days, newest first. */
  history: Array<{ day: string; pnlPct: number; points: number; bonus: string | null }>;
  lastCouncilAt: number;
}

export type EvolutionEvent =
  | { kind: "tier"; bee: BeeId; from: Tier; to: Tier; health: number }
  | { kind: "level"; bee: BeeId; from: number; to: number; points: number }
  | { kind: "day"; bee: BeeId; day: string; pnlPct: number; points: number; bonus: string | null };

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function levelFor(points: number): number {
  let l = 0;
  LEVELS.forEach((need, i) => {
    if (points >= need) l = i;
  });
  return l;
}

export function perksFor(level: number, o: Pick<EvolutionOpts, "rewards" | "maxLimitBoost" | "boostLimits"> & { maxPositions?: number }): Perks {
  const positions = Math.max(1, Math.min(o.maxPositions ?? 18, 3 * (Math.max(0, level) + 1)));
  if (!o.rewards) return { skillSlots: 4, canAuthorSkills: true, extraBrains: 0, limitBoost: 0, extraTrades: 0, positions };
  return {
    skillSlots: Math.min(6, 3 + level),
    // Research is a base capability. Adoption still requires a compiling skill and positive walk-forward evidence.
    canAuthorSkills: true,
    extraBrains: level >= 5 ? 2 : level >= 3 ? 1 : 0,
    limitBoost: o.boostLimits ? Math.min(o.maxLimitBoost, Math.round(level * 10) / 100) : 0,
    extraTrades: o.boostLimits ? Math.min(3, Math.floor(level / 2)) : 0,
    // Position count is independent of size rewards. Every slot shares the same aggregate leverage/notional cap.
    positions,
  };
}

export function tierFor(health: number, retired: boolean, o: Pick<EvolutionOpts, "dangerPct" | "criticalPct" | "deathPct">): Tier {
  if (retired || health <= o.deathPct) return "dead";
  if (health < o.criticalPct) return "critical";
  if (health < o.dangerPct) return "danger";
  return health >= 110 ? "thriving" : "healthy";
}

/** Position-size factor survival mode applies: a bunny in trouble trades smaller. */
export function survivalSizeFactor(tier: Tier): number {
  return tier === "critical" ? 0.35 : tier === "danger" ? 0.6 : 1;
}

export const SURVIVAL_NOTE =
  "state.survival: your health is equity as % of your start; at deathAt you die and trade no more. In danger or critical, protect capital first: skip weak setups, cut losers early, prefer holding cash to a low-conviction trade.";

export class Evolution {
  readonly bees = {} as Record<BeeId, BeeEvolution>;

  constructor(
    private o: EvolutionOpts,
    saved: Partial<Record<BeeId, BeeEvolution>> = {},
    private onEvent: (e: EvolutionEvent) => void = () => {},
  ) {
    for (const [id, v] of Object.entries(saved)) if (v) this.bees[id as BeeId] = { ...v, history: v.history ?? [] };
  }

  get opts(): EvolutionOpts {
    return this.o;
  }

  private start(id: BeeId): number {
    return this.o.startOf?.(id) ?? this.o.startEquityUsd;
  }

  private ensure(id: BeeId, bee: BeeState, now: number): BeeEvolution {
    this.bees[id] ??= {
      points: 0,
      level: 0,
      deaths: 0,
      tier: "healthy",
      health: 100,
      peakEquityUsd: bee.equityUsd,
      dayKey: dayKey(now),
      dayStartEquityUsd: bee.equityUsd,
      skillsAuthored: 0,
      history: [],
      lastCouncilAt: 0,
    };
    return this.bees[id];
  }

  perks(id: BeeId): Perks {
    return perksFor(this.bees[id]?.level ?? 0, this.o);
  }

  /** Survival size factor for a bunny (1 when survival mode is off). */
  sizeFactor(id: BeeId): number {
    return this.o.survival ? survivalSizeFactor(this.bees[id]?.tier ?? "healthy") : 1;
  }

  /** What Jev sees about its own survival (null when survival mode is off). */
  state(id: BeeId): { health: number; tier: Tier; deathAt: number } | null {
    const e = this.bees[id];
    if (!this.o.survival || !e) return null;
    return { health: Math.round(e.health), tier: e.tier, deathAt: this.o.deathPct };
  }

  /**
   * Once per tick with every bunny: health and tier, then (on a new UTC day) the day's points for each bunny, the day's
   * best bunny bonus and level-ups. Returns true when something worth saving changed.
   */
  tick(all: Array<[BeeId, BeeState]>, now: number): boolean {
    let changed = false;
    const today = dayKey(now);
    const rolled: Array<{ id: BeeId; e: BeeEvolution; pnlPct: number; day: string }> = [];
    for (const [id, bee] of all) {
      const e = this.ensure(id, bee, now);
      e.health = (bee.equityUsd / this.start(id)) * 100;
      e.peakEquityUsd = Math.max(e.peakEquityUsd, bee.equityUsd);
      const tier = tierFor(e.health, bee.cap === "retired", this.o);
      if (tier !== e.tier) {
        const from = e.tier;
        e.tier = tier;
        if (tier === "dead") e.deaths++;
        this.onEvent({ kind: "tier", bee: id, from, to: tier, health: e.health });
        changed = true;
      }
      if (e.dayKey !== today) {
        const pnlPct = e.dayStartEquityUsd > 0 ? ((bee.equityUsd - e.dayStartEquityUsd) / e.dayStartEquityUsd) * 100 : 0;
        rolled.push({ id, e, pnlPct, day: e.dayKey });
        e.dayKey = today;
        e.dayStartEquityUsd = bee.equityUsd;
      }
    }
    if (rolled.length && this.o.rewards) {
      const best = rolled.filter((r) => r.e.tier !== "dead").sort((a, b) => b.pnlPct - a.pnlPct)[0];
      for (const r of rolled) {
        if (r.e.tier === "dead") continue;
        // Gains earn 10 points per 1%; losses cost half that rate; surviving the day earns 1. Never below 0.
        let pts = r.pnlPct >= 0 ? Math.round(r.pnlPct * 10) : Math.round(r.pnlPct * 5);
        pts += 1;
        let bonus: string | null = null;
        if (best && r === best && r.pnlPct > 0 && rolled.length > 1) {
          pts += 5;
          bonus = "best bunny of the day";
        }
        r.e.points = Math.max(0, r.e.points + pts);
        r.e.history = [{ day: r.day, pnlPct: Math.round(r.pnlPct * 100) / 100, points: pts, bonus }, ...r.e.history].slice(0, 30);
        this.onEvent({ kind: "day", bee: r.id, day: r.day, pnlPct: r.pnlPct, points: pts, bonus });
        const lvl = levelFor(r.e.points);
        if (lvl !== r.e.level) {
          const from = r.e.level;
          r.e.level = lvl;
          this.onEvent({ kind: "level", bee: r.id, from, to: lvl, points: r.e.points });
        }
      }
    }
    return changed || rolled.length > 0;
  }

  /** The owner revived a dead bunny: fresh money, half its points, its lessons kept (they live in the warren memory). */
  revive(id: BeeId, equityUsd: number, now: number): void {
    const e = this.bees[id];
    if (!e) return;
    e.points = Math.floor(e.points / 2);
    e.level = levelFor(e.points);
    e.tier = "healthy";
    e.health = (equityUsd / this.start(id)) * 100;
    e.peakEquityUsd = equityUsd;
    e.dayKey = dayKey(now);
    e.dayStartEquityUsd = equityUsd;
  }

  /** Public view for the dashboard, ranked by points. */
  board(names: Partial<Record<BeeId, string>> = {}) {
    return (Object.entries(this.bees) as Array<[BeeId, BeeEvolution]>)
      .map(([id, e]) => ({
        bee: id,
        name: names[id] ?? id,
        points: e.points,
        level: e.level,
        nextLevelAt: LEVELS[e.level + 1] ?? null,
        tier: e.tier,
        health: Math.round(e.health * 10) / 10,
        deaths: e.deaths,
        skillsAuthored: e.skillsAuthored,
        perks: this.perks(id),
        history: e.history.slice(0, 7),
      }))
      .sort((a, b) => b.points - a.points || b.health - a.health);
  }
}
