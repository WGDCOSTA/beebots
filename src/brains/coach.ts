// Continuous learning while the engine runs. Two loops:
// - every few minutes, closed trades from the engine's books flow into the hive mind (bee -traded-> coin);
// - every COACH_INTERVAL_MIN, each bee's brain looks at how the bee actually did, what it learned before and what the
//   other bees said, then re-weights its adopted skills (it may drop one, never add one: new skills only come from a
//   lab run and the council) and writes a lesson and a message. It also reviews the bee's watchlist: it may drop coins
//   (never the last one) and add at most one candidate coin, which trades at half size (probation) until a later
//   review keeps it.
// LLM calls are capped per day. Nothing here trades.
import { z } from "zod";
import type { Db } from "../db.js";
import { beeNode, brainNode, contextFor, ingestFills, skillNode } from "../graph/hive-mind.js";
import { consolidate } from "../graph/memory.js";
import { methodOptions, resolvePick, SPECIALIZATION_PROMPT, SPECIALIZATION_SCHEMA, SpecializationPick } from "./specialization.js";
import type { KnowledgeGraph } from "../graph/graph.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { CouncilBee } from "./council.js";
import { BRAIN_INFO, type BrainId, type LlmClient } from "./llm.js";
import { loadPlaybook, savePlaybook, type BeePlan } from "./playbook.js";
import type { Ranking } from "../lab/tournament.js";
import type { BeeId } from "../config.js";
import { watchInput, type CoinInfo, type WatchItem } from "./watchlist.js";

const INGEST_MS = 5 * 60_000;
/** How often each bee's older lessons are folded into memories (graph/memory.ts). */
const CONSOLIDATE_MS = 6 * 3_600_000;

const MemoryAnswer = z.object({ memory: z.string().max(1200) });
const MEMORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["memory"],
  properties: { memory: { type: "string", description: "One compact memory (max 1200 chars) that keeps every lesson still useful, merges duplicates, drops what the newer lessons contradict" } },
} as const;
const DAY = 86_400_000;

const Answer = z.object({
  weights: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1) })).max(6),
  lesson: z.string().max(300),
  message: z.string().max(400),
  watchlist: z.object({ drop: z.array(z.string().max(20)).max(12), add: z.array(z.string().max(20)).max(3), reason: z.string().max(300) }).optional(),
  specialization: SpecializationPick.optional(),
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["weights", "lesson", "message", "watchlist", "specialization"],
  properties: {
    weights: {
      type: "array",
      description: "New weight (0..1) for each currently adopted skill; 0 drops it",
      items: { type: "object", additionalProperties: false, required: ["id", "weight"], properties: { id: { type: "string" }, weight: { type: "number" } } },
    },
    lesson: { type: "string", description: "One lesson from this period (max 300 chars), empty if nothing new" },
    message: { type: "string", description: "One message to the other bees (max 400 chars), empty to stay quiet" },
    specialization: SPECIALIZATION_SCHEMA,
    watchlist: {
      type: "object",
      additionalProperties: false,
      required: ["drop", "add", "reason"],
      description: "Watchlist review: coins to drop, and at most one coin from coinCandidates to add on probation (empty lists = keep it)",
      properties: { drop: { type: "array", items: { type: "string" } }, add: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
    },
  },
} as const;

/**
 * Applies a coach's watchlist review: drops never empty the list, one new candidate at most (on probation, and only
 * while there is room), and coins that survived a review on probation are kept for good.
 */
export function reviewWatchlist(current: WatchItem[], r: { drop: string[]; add: string[]; reason: string }, candidates: string[], size: number, now: number): WatchItem[] {
  const up = (c: string) => c.trim().toUpperCase().replace(/-.*$/, "");
  const drop = new Set(r.drop.map(up));
  let next = current.filter((w) => !drop.has(w.coin));
  if (!next.length) next = current.slice(0, 1);
  // Kept through a review: off probation.
  next = next.map((w) => (w.probation && !drop.has(w.coin) ? { ...w, probation: false } : w));
  const have = new Set(next.map((w) => w.coin));
  const add = r.add.map(up).find((c) => candidates.includes(c) && !have.has(c));
  if (add && next.length < size) next.push({ coin: add, reason: r.reason.slice(0, 300) || "added by the coach", probation: true, addedAt: now });
  return next.slice(0, size);
}

export interface CoachOpts {
  graph: KnowledgeGraph;
  db: Db;
  clients: Partial<Record<BrainId, LlmClient>>;
  bees: CouncilBee[];
  playbookPath: string;
  intervalMin: number;
  maxCallsPerDay: number;
  now?: () => number;
  /** BRAIN_WATCHLIST: review each bee's coins too. */
  watchlist?: boolean;
  /** Live coins (most liquid first) and the latest lab ranking, for the watchlist evidence. */
  universe?: () => CoinInfo[];
  ranking?: () => Ranking | null;
  /** How many coins a bee may hold. */
  watchSize?: (slot: BeeId) => number;
  /** SPECIALIZATION: the review may also switch the bee's method on its real results. */
  specialization?: boolean;
}

export class Coach {
  private timers: NodeJS.Timeout[] = [];
  private now: () => number;
  private calls = { day: "", n: 0 };
  private running = false;

  constructor(private o: CoachOpts) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    this.ingest();
    this.timers.push(setInterval(() => this.ingest(), INGEST_MS));
    this.timers.push(setInterval(() => void this.consolidateAll(), CONSOLIDATE_MS));
    if (this.o.intervalMin > 0) {
      this.timers.push(setInterval(() => void this.reflectAll(), this.o.intervalMin * 60_000));
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  /** Closed trades -> graph. The cursor lives in the engine DB so a restart does not count a trade twice. */
  ingest(): void {
    try {
      const cursor = Number(this.o.db.getMeta("graph_fill_cursor") ?? 0);
      const next = ingestFills(this.o.graph, this.o.db.raw, cursor);
      if (next > cursor) this.o.db.setMeta("graph_fill_cursor", String(next));
    } catch (err) {
      log.warn("hive mind: trade ingest failed", { err: safeError(err) });
    }
  }

  private budget(): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.calls.day) this.calls = { day: d, n: 0 };
    if (this.calls.n >= this.o.maxCallsPerDay) return false;
    this.calls.n++;
    return true;
  }

  /** What the bee actually did in the last 24 h, from the engine's books. */
  performance(slot: string) {
    const since = this.now() - DAY;
    const raw = this.o.db.raw;
    const f = raw
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(realised_usd),0) AS pnl, COALESCE(SUM(fee_usd),0) AS fees, SUM(CASE WHEN realised_usd > 0 THEN 1 ELSE 0 END) AS wins FROM fills WHERE bee = ? AND ts > ? AND realised_usd != 0")
      .get(slot, since) as { n: number; pnl: number; fees: number; wins: number | null };
    const eq = raw.prepare("SELECT equity_usd FROM equity_snapshots WHERE bee = ? AND ts > ? ORDER BY ts LIMIT 1").get(slot, since) as { equity_usd: number } | undefined;
    const eqNow = raw.prepare("SELECT equity_usd FROM equity_snapshots WHERE bee = ? ORDER BY ts DESC LIMIT 1").get(slot) as { equity_usd: number } | undefined;
    const vetoes = raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE bee = ? AND ts > ? AND vetoed_by IS NOT NULL").get(slot, since) as { n: number };
    return {
      closedTrades24h: f.n,
      wins24h: f.wins ?? 0,
      realisedUsd24h: +f.pnl.toFixed(2),
      feesUsd24h: +f.fees.toFixed(2),
      equityChangePct24h: eq && eqNow && eq.equity_usd > 0 ? +(((eqNow.equity_usd - eq.equity_usd) / eq.equity_usd) * 100).toFixed(2) : null,
      riskVetoes24h: vetoes.n,
    };
  }

  private syncWatches(slot: string, plan: BeePlan): void {
    const beeId = beeNode(slot);
    this.o.graph.unlink(beeId, "watches");
    for (const w of plan.watchlist ?? []) this.o.graph.link(beeId, "watches", this.o.graph.upsert("coin", w.coin, w.coin), 1, { reason: w.reason, probation: w.probation });
  }

  /**
   * Fold each bee's older lessons into memories so its context stays small without forgetting. Its own brain writes
   * the memory (low effort, within the daily cap); without one, a rules digest does.
   */
  async consolidateAll(): Promise<number> {
    let folded = 0;
    for (const bee of this.o.bees) {
      const client = this.o.clients[bee.brain];
      try {
        folded += await consolidate(this.o.graph, beeNode(bee.slot), {
          summarize:
            client && this.budget()
              ? async (previous, lessons) => {
                  const r = await client.json({
                    system: `You keep the long-term memory of ${bee.name}, a paper-trading bee. Merge its lessons into one compact memory it will read before every decision.`,
                    user: JSON.stringify({ previousMemory: previous, lessons }),
                    schema: MEMORY_SCHEMA,
                    name: "memory",
                    validate: MemoryAnswer,
                    maxTokens: 4000,
                    effort: "low",
                  });
                  return r.data.memory;
                }
              : undefined,
        });
      } catch (err) {
        log.warn("memory consolidation failed", { bee: bee.slot, err: safeError(err) });
      }
    }
    if (folded) log.info("hive mind: lessons folded into memories", { folded });
    return folded;
  }

  async reflectAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.ingest();
      for (const bee of this.o.bees) await this.reflect(bee);
      await this.consolidateAll();
    } finally {
      this.running = false;
    }
  }

  async reflect(bee: CouncilBee): Promise<boolean> {
    const client = this.o.clients[bee.brain];
    const pb = loadPlaybook(this.o.playbookPath);
    const plan = pb?.bees[bee.slot];
    if (!client || !pb || !plan?.skills.length) return false;
    if (!this.budget()) return false;
    const b = BRAIN_INFO[bee.brain];
    const hive = contextFor(this.o.graph, bee.slot);
    const size = this.o.watchSize?.(bee.slot) ?? 3;
    const watch = this.o.watchlist && plan.watchlist?.length
      ? watchInput({ style: bee.style, market: bee.market, ownerCoins: bee.coins, universe: this.o.universe?.() ?? [], ranking: this.o.ranking?.() ?? null, adoptedSkills: plan.skills.map((s) => s.id), record: hive.tradeRecord })
      : null;
    const methods = this.o.specialization
      ? methodOptions({
          market: bee.market ?? "crypto",
          current: plan.specialization ? { kind: plan.specialization.kind, id: plan.specialization.id } : { kind: "own", id: (bee.market ?? "crypto") === "crypto" ? bee.style : "macro" },
          ranking: this.o.ranking?.() ?? null,
        })
      : null;
    const system = [
      `You are ${b.label} (${b.vendor}), the strategic brain of ${bee.name}, a paper-trading bee on OKX perpetual futures (style: ${bee.style}).`,
      "This is a periodic review. Re-weight the skills the bee already uses, based on how the bee really did and what the hive knows.",
      "Small samples are noisy: move weights gradually unless the evidence is strong. You may drop a skill (weight 0); you cannot add new ones.",
      "Write at most one lesson worth remembering, and optionally one short message to the other bees. Paper only, not financial advice.",
      this.o.specialization
        ? `Self-management: judge the bee's current METHOD on its real results (last24h, tradeRecord, conflicts). ${SPECIALIZATION_PROMPT}`
        : "Set specialization.kind to 'keep'.",
      watch
        ? "Review the watchlist too: drop a coin that keeps losing or went illiquid; add at most one coin from coinCandidates with a concrete reason (it trades at half size until your next review keeps it). Leave both lists empty to keep it."
        : "Leave watchlist.drop and watchlist.add empty.",
    ].join("\n");
    const user = JSON.stringify({
      bee: { name: bee.name, style: bee.style, coins: bee.coins },
      adopted: plan.skills.map((s) => ({ id: s.id, weight: s.weight, labScore: s.score, why: s.reason })),
      last24h: this.performance(bee.slot),
      ...(watch && plan.watchlist ? { watchlist: plan.watchlist, watchlistSize: size, coinCandidates: watch.evidence } : {}),
      ...(methods ? { methodOptions: methods } : {}),
      hive,
    });
    try {
      const r = await client.json({ system, user, schema: SCHEMA, name: "coach_review", validate: Answer, maxTokens: 8000, effort: "low" });
      const next = new Map(r.data.weights.map((w) => [w.id, w.weight]));
      const kept = plan.skills.map((s) => ({ ...s, weight: next.has(s.id) ? next.get(s.id)! : s.weight })).filter((s) => s.weight > 0);
      if (kept.length) {
        const total = kept.reduce((a, s) => a + s.weight, 0);
        plan.skills = kept.map((s) => ({ ...s, weight: +(s.weight / total).toFixed(3) }));
      }
      const beeId = beeNode(bee.slot);
      this.o.graph.unlink(beeId, "adopts");
      for (const s of plan.skills) {
        this.o.graph.link(beeId, "adopts", skillNode(s.id), s.weight, { params: s.params, reason: s.reason });
        this.o.graph.link(brainNode(bee.brain), "recommends", skillNode(s.id), s.weight, { for: bee.slot });
      }
      if (r.data.lesson.trim()) {
        this.o.graph.learn(beeId, r.data.lesson.trim(), plan.skills.map((s) => skillNode(s.id)), { brain: bee.brain, source: "coach" });
        plan.lessons = [r.data.lesson.trim(), ...plan.lessons].slice(0, 10);
      }
      if (r.data.message.trim()) {
        this.o.graph.post(beeId, "hive", r.data.message.trim(), { brain: bee.brain, source: "coach" });
        plan.message = r.data.message.trim();
      }
      // Self-management: the brain may switch the bee's method on its real results (adopted when the bee is flat).
      const newSpec = methods ? resolvePick(r.data.specialization, methods, this.now()) : null;
      if (newSpec) {
        plan.specialization = newSpec;
        this.o.graph.unlink(beeNode(bee.slot), "specialises_in");
        this.o.graph.link(beeNode(bee.slot), "specialises_in", newSpec.kind === "skill" ? skillNode(newSpec.id) : this.o.graph.upsert("style", newSpec.id, newSpec.id), 1, { reason: newSpec.reason, source: "coach" });
        this.o.graph.learn(beeNode(bee.slot), `Specialisation: switched to ${newSpec.kind} ${newSpec.id}. ${newSpec.reason}`, [], { brain: bee.brain, source: "coach", kind: "diary" });
      }
      if (watch && plan.watchlist && r.data.watchlist) {
        plan.watchlist = reviewWatchlist(plan.watchlist, r.data.watchlist, watch.candidates, size, this.now());
        this.syncWatches(bee.slot, plan);
      }
      plan.decidedAt = this.now();
      // Re-read right before writing: the lab CLI may have written a new playbook while the model was thinking.
      const latest = loadPlaybook(this.o.playbookPath) ?? pb;
      if (latest.rankingAt === pb.rankingAt) {
        latest.bees[bee.slot] = plan;
        latest.updatedAt = this.now();
        savePlaybook(this.o.playbookPath, latest);
      }
      log.info("coach: bee reviewed", { bee: bee.slot, brain: bee.brain, skills: plan.skills.map((s) => `${s.id}:${s.weight}`).join(",") });
      return true;
    } catch (err) {
      log.warn("coach: review failed", { bee: bee.slot, brain: bee.brain, err: safeError(err) });
      return false;
    }
  }
}
