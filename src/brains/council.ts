// The council: after a lab run, each main bee's brain (ChatGPT, Claude, Kimi) reads the ranking and what the hive mind
// remembers, and picks the skills its bee should lean on. Bees speak in turn, so each one reads what the previous one
// just told the hive: that is how they communicate. A bee whose brain has no key gets a rules-based pick.
import { z } from "zod";
import { brainNode, contextFor, registerBees, skillNode, type BeeProfile } from "../graph/hive-mind.js";
import { nodeId, type KnowledgeGraph } from "../graph/graph.js";
import type { Ranking, SkillResult } from "../lab/tournament.js";
import { log } from "../log.js";
import { BRAIN_INFO, type BrainId, type LlmClient } from "./llm.js";
import { NATURAL_FAMILY, type BeePlan, type Playbook, type PlaybookSkill } from "./playbook.js";

export interface CouncilBee extends BeeProfile {
  brain: BrainId;
}

const Answer = z.object({
  skills: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1), reason: z.string().max(400) })).min(1).max(4),
  lessons: z.array(z.string().max(300)).max(3),
  message: z.string().max(400),
});
type AnswerT = z.infer<typeof Answer>;

export const COUNCIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skills", "lessons", "message"],
  properties: {
    skills: {
      type: "array",
      description: "1 to 4 skills from the candidate list, with weights in 0..1 (they are normalised to sum to 1)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "weight", "reason"],
        properties: { id: { type: "string" }, weight: { type: "number" }, reason: { type: "string" } },
      },
    },
    lessons: { type: "array", description: "Up to 3 short lessons worth remembering (max 300 chars each)", items: { type: "string" } },
    message: { type: "string", description: "One message to the other bees (max 400 chars)" },
  },
} as const;

/** The candidates a bee may pick from: the overall leaders plus the best of its natural family. No benchmark. */
export function candidatesFor(r: Ranking, style: string, top = 12): SkillResult[] {
  const usable = r.results.filter((s) => s.family !== "benchmark");
  const fam = NATURAL_FAMILY[style];
  const picked = new Map<string, SkillResult>();
  for (const s of usable.slice(0, top)) picked.set(s.skillId, s);
  for (const s of usable.filter((x) => x.family === fam).slice(0, 3)) picked.set(s.skillId, s);
  return [...picked.values()].sort((a, b) => a.rank - b.rank);
}

const compact = (s: SkillResult) => ({
  id: s.skillId,
  family: s.family,
  rank: s.rank,
  score: +s.score.toFixed(2),
  oosReturnPct: +s.oos.returnPct.toFixed(1),
  buyHoldPct: +s.oos.benchmarkPct.toFixed(1),
  sharpe: +s.oos.sharpe.toFixed(2),
  maxDrawdownPct: +s.oos.maxDrawdownPct.toFixed(1),
  trades: s.oos.trades,
  stabilityPct: Math.round(s.stabilityPct),
  overfitGap: +s.overfitGap.toFixed(2),
  what: s.description,
});

/** No LLM: the best positive-score skills of the bee's natural family, else the best positive overall. */
export function rulesPick(cands: SkillResult[], style: string): AnswerT {
  const pos = cands.filter((s) => s.score > 0);
  const fam = pos.filter((s) => s.family === NATURAL_FAMILY[style]);
  const pick = (fam.length ? fam : pos).slice(0, 3);
  return {
    skills: pick.map((s) => ({ id: s.skillId, weight: 1, reason: `rank ${s.rank}, score ${s.score.toFixed(2)} out of sample` })),
    lessons: pick.length ? [] : ["No skill beat the costs out of sample in the last lab run; stay with the built-in style."],
    message: pick.length ? `Leaning on ${pick.map((s) => s.skillId).join(", ")} (rules pick).` : "Nothing in the lab earned a place this round.",
  };
}

export function systemPrompt(bee: CouncilBee): string {
  const b = BRAIN_INFO[bee.brain];
  return [
    `You are ${b.label} (${b.vendor}), the strategic brain of ${bee.name}, one of three AI trading bees that race each other on OKX perpetual futures with PAPER money.`,
    `${bee.name} trades the "${bee.style}" style${bee.coins.length ? ` on ${bee.coins.join(", ")}` : ""}.${bee.rules ? ` Owner's rules: ${bee.rules}` : ""}`,
    "Every tick a fast decision model (Jev) picks the bee's next move and a code risk layer can veto it. Your job is slower and strategic:",
    "choose 1-4 skills from the CANDIDATES (backtested trading rules, ranked on walk-forward out-of-sample results) whose live votes Jev will see as a tiebreaker.",
    "Judge robustness over raw return: prefer high stability, a small overfit gap, enough trades, drawdown the bee can survive, and a fit with its style.",
    "A skill with score <= 0 did not beat its costs out of sample; only pick one with a concrete reason. Diversify across families when it helps.",
    "Use the hive context: your past lessons, the bee's real trade record, and what the other bees said. Write lessons that will still be useful next round,",
    "and a short message to the other bees (share what you learned, challenge them, or propose a division of labour).",
    "Only use skill ids from the candidate list. This is a game on paper, not financial advice.",
  ].join("\n");
}

function normalise(skills: AnswerT["skills"], known: Map<string, SkillResult>): PlaybookSkill[] {
  const ok = skills.filter((s) => known.has(s.id) && s.weight > 0);
  const seen = new Set<string>();
  const uniq = ok.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const total = uniq.reduce((a, s) => a + s.weight, 0) || 1;
  return uniq.map((s) => {
    const r = known.get(s.id)!;
    return { id: s.id, params: r.params, weight: +(s.weight / total).toFixed(3), reason: s.reason, score: +r.score.toFixed(3) };
  });
}

export interface CouncilResult {
  playbook: Playbook;
  log: Array<{ bee: string; brain: string; ok: boolean; error?: string; picked: string[] }>;
}

export async function runCouncil(opts: {
  graph: KnowledgeGraph;
  ranking: Ranking;
  bees: CouncilBee[];
  clients: Partial<Record<BrainId, LlmClient>>;
  previous?: Playbook | null;
  now?: () => number;
}): Promise<CouncilResult> {
  const { graph, ranking, bees, clients } = opts;
  const now = opts.now ?? Date.now;
  registerBees(graph, bees);
  const playbook: Playbook = { version: 1, updatedAt: now(), rankingAt: ranking.createdAt, bees: { ...(opts.previous?.bees ?? {}) } };
  const out: CouncilResult["log"] = [];

  for (const bee of bees) {
    const cands = candidatesFor(ranking, bee.style);
    const known = new Map(cands.map((c) => [c.skillId, c]));
    const client = clients[bee.brain];
    let answer: AnswerT;
    let brain: BeePlan["brain"] = bee.brain;
    let model = client?.model ?? "rules";
    let error: string | undefined;
    if (client) {
      try {
        const user = JSON.stringify({
          bee: { name: bee.name, style: bee.style, coins: bee.coins, rules: bee.rules },
          lab: { datasets: ranking.datasets.map((d) => d.id), folds: ranking.opts.folds, feeRatePerSide: ranking.opts.sim.feeRate, leverage: ranking.opts.sim.leverage },
          candidates: cands.map(compact),
          hive: contextFor(graph, bee.slot),
        });
        const r = await client.json({ system: systemPrompt(bee), user, schema: COUNCIL_SCHEMA, name: "council_pick", validate: Answer });
        answer = r.data;
        model = r.model;
        if (!normalise(answer.skills, known).length) throw new Error("picked no known skill");
      } catch (err) {
        error = (err as Error).message;
        log.warn("council: brain failed, using the rules pick", { bee: bee.slot, brain: bee.brain, error });
        answer = rulesPick(cands, bee.style);
        brain = "rules";
        model = "rules";
      }
    } else {
      answer = rulesPick(cands, bee.style);
      brain = "rules";
    }

    const skills = normalise(answer.skills, known);
    const beeId = nodeId("bee", bee.slot);
    graph.unlink(beeId, "adopts");
    for (const s of skills) {
      graph.link(beeId, "adopts", skillNode(s.id), s.weight, { reason: s.reason, params: s.params });
      if (brain !== "rules") graph.link(brainNode(brain), "recommends", skillNode(s.id), s.weight, { for: bee.slot, reason: s.reason });
    }
    for (const l of answer.lessons) graph.learn(beeId, l, skills.map((s) => skillNode(s.id)), { brain, source: "council" });
    if (answer.message) graph.post(beeId, "hive", answer.message, { brain, source: "council" });

    playbook.bees[bee.slot] = { brain, model, skills, lessons: answer.lessons, message: answer.message, decidedAt: now() };
    out.push({ bee: bee.slot, brain, ok: !error && brain !== "rules", ...(error ? { error } : {}), picked: skills.map((s) => s.id) });
  }
  playbook.updatedAt = now();
  return { playbook, log: out };
}
