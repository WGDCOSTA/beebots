// A bee's brain drafts research notes. It works only from what the app already holds (the lab ranking, the bee's own
// trades and lessons, what its peers said, the market mood, the live coins): no web, no external tool. Every note must
// cite evidence taken from that pack, and lands as "pending" until the owner approves it (brains/notes.ts). Capped per day.
import { z } from "zod";
import type { BeeId } from "../config.js";
import type { KnowledgeGraph } from "../graph/graph.js";
import { contextFor } from "../graph/hive-mind.js";
import type { Ranking } from "../lab/tournament.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { CouncilBee } from "./council.js";
import { brainInfo, type BrainId, type LlmClient } from "./llm.js";
import { NoteError, type NoteBook } from "./notes.js";
import { loadPlaybook } from "./playbook.js";
import type { CoinInfo } from "./watchlist.js";

const MAX_PENDING = 6;
const COOLDOWN_MS = 30 * 60_000;

const Answer = z.object({
  notes: z
    .array(
      z.object({
        title: z.string().min(3).max(80),
        claim: z.string().min(10).max(700),
        evidence: z.array(z.string().max(220)).max(5),
        coins: z.array(z.string().max(20)).max(6),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(3),
});

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["notes"],
  properties: {
    notes: {
      type: "array",
      description: "0 to 3 research notes; an empty list is fine when the evidence says nothing new",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "claim", "evidence", "coins", "confidence"],
        properties: {
          title: { type: "string", description: "Short title (max 80 chars)" },
          claim: { type: "string", description: "What you conclude and why it matters for this bee (max 700 chars)" },
          evidence: { type: "array", items: { type: "string" }, description: "1 to 5 items, each quoting a number or fact from the evidence pack" },
          coins: { type: "array", items: { type: "string" }, description: "Coins the note is about, if any" },
          confidence: { type: "string", enum: ["low", "medium", "high"], description: "high only when measured facts in the pack support it" },
        },
      },
    },
  },
} as const;

export interface ResearchOpts {
  graph: KnowledgeGraph;
  notes: NoteBook;
  clients: Partial<Record<BrainId, LlmClient>>;
  bees: () => CouncilBee[];
  playbookPath: string;
  ranking: () => Ranking | null;
  market?: () => Record<string, unknown> | null;
  universe?: () => CoinInfo[];
  maxCallsPerDay: number;
  now?: () => number;
}

export interface ResearchResult {
  drafted: number;
  note: string;
}

export class Researcher {
  private calls = { day: "", n: 0 };
  private last = new Map<string, number>();
  private running = new Set<string>();
  private now: () => number;

  constructor(private o: ResearchOpts) {
    this.now = o.now ?? Date.now;
  }

  busy(): string[] {
    return [...this.running];
  }

  /** Why this bee cannot research right now, or null. */
  blocked(slot: BeeId): string | null {
    const bee = this.o.bees().find((b) => b.slot === slot);
    if (!bee) return "that bee is not running";
    if (!this.o.clients[bee.brain]) return `${brainInfo(bee.brain).label} has no key (Admin → API keys)`;
    if (this.running.has(slot)) return "already researching";
    if (this.o.notes.pendingCount(slot) >= MAX_PENDING) return `${MAX_PENDING} notes are waiting for your review`;
    const at = this.last.get(slot);
    const since = at === undefined ? Infinity : this.now() - at;
    if (since < COOLDOWN_MS) return `it researched ${Math.round(since / 60_000)} min ago; wait ${Math.ceil((COOLDOWN_MS - since) / 60_000)} min`;
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d === this.calls.day && this.calls.n >= this.o.maxCallsPerDay) return "the daily brain-call cap is used up";
    return null;
  }

  /** What the brain may cite: nothing that is not in here. */
  evidencePack(bee: CouncilBee) {
    const rank = this.o.ranking();
    const plan = loadPlaybook(this.o.playbookPath)?.bees[bee.slot];
    const coins = new Set([...bee.coins, ...(plan?.watchlist ?? []).map((w) => w.coin)]);
    const skills = (rank?.results ?? [])
      .filter((r) => r.family !== "benchmark")
      .slice(0, 6)
      .map((r) => ({ skill: r.name, score: +r.score.toFixed(2), outOfSamplePct: +r.oos.returnPct.toFixed(1), buyHoldPct: +r.oos.benchmarkPct.toFixed(1), stabilityPct: Math.round(r.stabilityPct) }));
    const live = (this.o.universe?.() ?? []).slice(0, 15).map((c) => ({ coin: c.coin }));
    return {
      bee: { name: bee.name, style: bee.style, coins: [...coins], adopted: (plan?.skills ?? []).map((s) => s.id) },
      labRanking: rank ? { at: new Date(rank.createdAt).toISOString().slice(0, 10), datasets: rank.datasets.map((d) => `${d.id} (${d.source})`), topSkills: skills } : null,
      hive: contextFor(this.o.graph, bee.slot),
      market: this.o.market?.() ?? null,
      liveCoins: live,
      alreadyWritten: this.o.notes.all().filter((n) => n.bee === bee.slot || n.bee === "hive").slice(0, 12).map((n) => n.title),
    };
  }

  async research(slot: BeeId): Promise<ResearchResult> {
    const why = this.blocked(slot);
    if (why) throw new NoteError(`Cannot research now: ${why}.`);
    const bee = this.o.bees().find((b) => b.slot === slot)!;
    const client = this.o.clients[bee.brain]!;
    const b = brainInfo(bee.brain);
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.calls.day) this.calls = { day: d, n: 0 };
    this.calls.n++;
    this.last.set(slot, this.now());
    this.running.add(slot);
    try {
      const pack = this.evidencePack(bee);
      const system = [
        `You are ${b.label} (${b.vendor}), the brain of ${bee.name}, a paper-trading bee on OKX perpetual futures (style: ${bee.style}).`,
        "Write up to 3 research notes: things worth knowing that the bee's own numbers and the lab suggest. You work ONLY from the evidence pack; you have no web access and must not invent data.",
        "Every note cites 1 to 5 pieces of evidence, each quoting a number or fact from the pack. A note without evidence from the pack is dropped.",
        "State hypotheses, not facts. Never predict a price, never recommend an order or a size: a note informs; the bee's risk layer and Jev decide. Do not repeat alreadyWritten titles.",
        "Use confidence 'high' only when measured facts (tradeRecord, labRanking) support it. Small samples are 'low'. Paper only, not financial advice.",
      ].join("\n");
      const r = await client.json({ system, user: JSON.stringify(pack), schema: SCHEMA, name: "research_notes", validate: Answer, maxTokens: 6000, effort: "low" });
      let drafted = 0;
      const seen = new Set(pack.alreadyWritten.map((t) => t.toLowerCase()));
      for (const n of r.data.notes) {
        if (!n.evidence.some((e) => e.trim().length >= 8)) continue;
        if (seen.has(n.title.toLowerCase())) continue;
        seen.add(n.title.toLowerCase());
        try {
          this.o.notes.add({ bee: slot, kind: "research", author: slot, brain: bee.brain, title: n.title, text: n.claim, evidence: n.evidence, coins: n.coins, confidence: n.confidence });
          drafted++;
        } catch (err) {
          if (err instanceof NoteError) break;
          throw err;
        }
      }
      log.info("research: notes drafted", { bee: slot, brain: bee.brain, drafted });
      return { drafted, note: drafted ? `${drafted} note${drafted > 1 ? "s" : ""} drafted; they wait for your review.` : "Nothing new worth writing down from the evidence." };
    } catch (err) {
      log.warn("research failed", { bee: slot, err: safeError(err) });
      throw err;
    } finally {
      this.running.delete(slot);
    }
  }
}
