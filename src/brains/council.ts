// The council: after a lab run, each main bee's brain (ChatGPT, Claude, Kimi) reads the ranking and what the hive mind
// remembers, and picks the skills its bee should lean on. Bees speak in turn, so each one reads what the previous one
// just told the hive: that is how they communicate. A bee whose brain has no key gets a rules-based pick.
import { z } from "zod";
import { brainNode, contextFor, registerBees, skillNode, type BeeProfile } from "../graph/hive-mind.js";
import { nodeId, type KnowledgeGraph } from "../graph/graph.js";
import type { Ranking, SkillResult } from "../lab/tournament.js";
import { log } from "../log.js";
import type { BeeId } from "../config.js";
import { BRAIN_INFO, type BrainId, type LlmClient } from "./llm.js";
import { NATURAL_FAMILY, type BeePlan, type Playbook, type PlaybookSkill } from "./playbook.js";
import { methodOptions, resolvePick, SPECIALIZATION_PROMPT, SPECIALIZATION_SCHEMA, SpecializationPick } from "./specialization.js";
import { normaliseWatchlist, rulesWatchlist, watchInput, WATCHLIST_PROMPT, WATCHLIST_SCHEMA, WatchPicks, type CoinInfo } from "./watchlist.js";

export interface CouncilBee extends BeeProfile {
  slot: BeeId;
  brain: BrainId;
}

const Answer = z.object({
  skills: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1), reason: z.string().max(400) })).min(1).max(4),
  lessons: z.array(z.string().max(300)).max(3),
  message: z.string().max(400),
  coins: WatchPicks.default([]),
  specialization: SpecializationPick.optional(),
});
type AnswerT = z.infer<typeof Answer>;

export const COUNCIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skills", "lessons", "message", "coins", "specialization"],
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
    coins: WATCHLIST_SCHEMA,
    specialization: SPECIALIZATION_SCHEMA,
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
  sqn: +(s.oos.sqn ?? 0).toFixed(2),
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
    coins: [],
  };
}

export function systemPrompt(bee: CouncilBee): string {
  const b = BRAIN_INFO[bee.brain];
  return [
    `You are ${b.label} (${b.vendor}), the strategic brain of ${bee.name}, one of three AI trading bees that race each other on OKX perpetual futures with PAPER money.`,
    `${bee.name} trades the "${bee.style}" style${bee.coins.length ? ` on ${bee.coins.join(", ")}` : ""}.${bee.rules ? ` Owner's rules: ${bee.rules}` : ""}`,
    bee.market && bee.market !== "crypto"
      ? `${bee.name} belongs to the MACRO SQUAD: it trades ${bee.market === "macro" ? "stocks and commodities" : bee.market} X-Perps (gold, oil, stocks, ETFs), which follow their market's session hours and can gap when it is shut. Favour liquid names and skills that respect sessions.`
      : "",
    "Every tick a fast decision model (Jev) picks the bee's next move and a code risk layer can veto it. Your job is slower and strategic:",
    "choose 1-4 skills from the CANDIDATES (backtested trading rules, ranked on walk-forward out-of-sample results) whose live votes Jev will see as a tiebreaker.",
    "Judge robustness over raw return: prefer high stability, a small overfit gap, enough trades, drawdown the bee can survive, and a fit with its style.",
    "A skill with score <= 0 did not beat its costs out of sample; only pick one with a concrete reason. Diversify across families when it helps.",
    "Use the hive context: your past lessons, the bee's real trade record, and what the other bees said. Write lessons that will still be useful next round,",
    "and a short message to the other bees (share what you learned, challenge them, or propose a division of labour).",
    WATCHLIST_PROMPT,
    SPECIALIZATION_PROMPT,
    "Only use skill ids from the candidate list. This is a game on paper, not financial advice.",
  ]
    .filter(Boolean)
    .join("\n");
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
  log: Array<{ bee: string; brain: string; ok: boolean; error?: string; picked: string[]; coins: string[] }>;
}

export async function runCouncil(opts: {
  graph: KnowledgeGraph;
  ranking: Ranking;
  bees: CouncilBee[];
  clients: Partial<Record<BrainId, LlmClient>>;
  previous?: Playbook | null;
  now?: () => number;
  /** Live coins (engine market view) for the watchlist; [] = candidates come from the lab, the record and the owner. */
  universe?: CoinInfo[];
  /** The market mood (CoinMarketCap: Fear & Greed, dominance, market cap move), or null. */
  market?: Record<string, unknown> | null;
  /** The scalper is on offer as a method (its lab gate is open). */
  scalp?: boolean;
  /** Let the brains choose each bee's coins (BRAIN_WATCHLIST). Off = the previous watchlist is kept. */
  pickCoins?: boolean;
  /** How many coins a bee may hold (grows with its level, 3 in danger). */
  watchSize?: (slot: BeeId) => number;
  /** SPECIALIZATION: the brains also choose each bee's method (a style or any lab skill). Off = the previous one stays. */
  pickMethod?: boolean;
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
    const hive = contextFor(graph, bee.slot);
    const pickCoins = opts.pickCoins ?? true;
    const pickMethod = opts.pickMethod ?? true;
    const prevSpec = opts.previous?.bees[bee.slot]?.specialization;
    const methods = methodOptions({
      market: bee.market ?? "crypto",
      current: prevSpec ? { kind: prevSpec.kind, id: prevSpec.id } : { kind: "own", id: (bee.market ?? "crypto") === "crypto" ? bee.style : "macro" },
      ranking,
      extraStyles: opts.scalp ? ["scalp"] : [],
    });
    const size = opts.watchSize?.(bee.slot) ?? 3;
    const watch = watchInput({
      style: bee.style,
      market: bee.market,
      ownerCoins: bee.coins,
      universe: opts.universe ?? [],
      ranking,
      adoptedSkills: [...known.keys()],
      record: hive.tradeRecord,
    });
    if (client) {
      try {
        const user = JSON.stringify({
          bee: { name: bee.name, style: bee.style, coins: bee.coins, rules: bee.rules },
          lab: { datasets: ranking.datasets.map((d) => d.id), folds: ranking.opts.folds, feeRatePerSide: ranking.opts.sim.feeRate, leverage: ranking.opts.sim.leverage },
          candidates: cands.map(compact),
          ...(pickCoins ? { watchlistSize: size, coinCandidates: watch.evidence } : {}),
          ...(pickMethod ? { methodOptions: methods } : {}),
          ...(opts.market ? { market: opts.market } : {}),
          hive,
        });
        const r = await client.json({ system: systemPrompt(bee), user, schema: COUNCIL_SCHEMA, name: "council_pick", validate: Answer });
        answer = { ...r.data, coins: r.data.coins ?? [] };
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

    // Coins: the brain's pick (only candidates), else a rules pick on the evidence of the skills just adopted.
    let watchlist = opts.previous?.bees[bee.slot]?.watchlist;
    if (pickCoins && watch.candidates.length) {
      const picked = normaliseWatchlist(answer.coins, watch.candidates, size, now());
      if (picked.length) watchlist = picked;
      else {
        const adopted = new Set(skills.map((s) => s.id));
        const ev = watchInput({ style: bee.style, market: bee.market, ownerCoins: bee.coins, universe: opts.universe ?? [], ranking, adoptedSkills: [...adopted], record: hive.tradeRecord });
        watchlist = rulesWatchlist(ev.evidence, size, now());
      }
      graph.unlink(beeId, "watches");
      for (const w of watchlist) graph.link(beeId, "watches", graph.upsert("coin", w.coin, w.coin), 1, { reason: w.reason, brain });
    }

    // Specialisation: the brain's pick when it is on offer; "keep" (or no brain) keeps the previous choice.
    const picked = pickMethod ? resolvePick(answer.specialization, methods, now()) : null;
    const specialization = picked ?? prevSpec;
    if (picked) {
      graph.unlink(beeId, "specialises_in");
      graph.link(beeId, "specialises_in", picked.kind === "skill" ? skillNode(picked.id) : graph.upsert("style", picked.id, picked.id), 1, { reason: picked.reason, brain });
      graph.learn(beeId, `Specialisation: ${picked.kind} ${picked.id}. ${picked.reason}`, [], { brain, source: "council", kind: "diary" });
    }

    playbook.bees[bee.slot] = {
      brain,
      model,
      skills,
      lessons: answer.lessons,
      message: answer.message,
      decidedAt: now(),
      ...(watchlist ? { watchlist } : {}),
      ...(specialization ? { specialization } : {}),
    };
    out.push({ bee: bee.slot, brain, ok: !error && brain !== "rules", ...(error ? { error } : {}), picked: skills.map((s) => s.id), coins: watchlist?.map((w) => w.coin) ?? [] });
  }
  playbook.updatedAt = now();
  return { playbook, log: out };
}
