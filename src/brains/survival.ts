// The survival (and reward) council. When a bee falls into danger or critical, or levels up, several LLM brains meet
// for it: its own brain first, then others (every available brain when its life is at stake, the extra brains its
// level earned otherwise). Each brain sees what the previous ones advised, so they build on each other; their skill
// picks are combined into one playbook. Brains may also write a brand-new skill in the JSON rule language: it is
// compiled, backtested walk-forward on the lab's history, and adopted only if it holds up out of sample. Nothing here
// trades; the playbook only feeds the lab vote (LAB_SIGNALS) and the watchlist (BRAIN_WATCHLIST), and the risk layer
// is untouched. In danger the council shrinks the watchlist to 3 coins and favours the most liquid ones.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BeeId } from "../config.js";
import type { Evolution, Tier } from "../evolution.js";
import { beeNode, brainNode, contextFor, skillNode } from "../graph/hive-mind.js";
import type { KnowledgeGraph } from "../graph/graph.js";
import { readCache, syntheticCandles, type Bar, type Dataset } from "../lab/history.js";
import { skillFromSpec, type Skill } from "../lab/skills/index.js";
import { evaluateSkill, DEFAULT_TOURNAMENT, type Ranking, type SkillResult } from "../lab/tournament.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { CouncilBee } from "./council.js";
import { BRAIN_INFO, BRAINS, type BrainId, type LlmClient } from "./llm.js";
import { loadPlaybook, savePlaybook, type PlaybookSkill } from "./playbook.js";
import { methodOptions, resolvePick, SPECIALIZATION_PROMPT, SPECIALIZATION_SCHEMA, SpecializationPick } from "./specialization.js";
import { LIQUID_TOP, WATCHLIST_PROMPT, WATCHLIST_SCHEMA, WatchPicks, watchInput, watchlistSize, type CoinInfo, type WatchItem } from "./watchlist.js";

const Answer = z.object({
  skills: z.array(z.object({ id: z.string(), weight: z.number().min(0).max(1), reason: z.string().max(400) })).max(6),
  newSkillJson: z.string().max(4000),
  lesson: z.string().max(300),
  message: z.string().max(400),
  coins: WatchPicks.default([]),
  specialization: SpecializationPick.optional(),
});
type AnswerT = z.infer<typeof Answer>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skills", "newSkillJson", "lesson", "message", "coins", "specialization"],
  properties: {
    skills: {
      type: "array",
      description: "Skills from the candidate list with weights 0..1",
      items: { type: "object", additionalProperties: false, required: ["id", "weight", "reason"], properties: { id: { type: "string" }, weight: { type: "number" }, reason: { type: "string" } } },
    },
    newSkillJson: { type: "string", description: "A new skill in the JSON rule language as a JSON string, or an empty string" },
    lesson: { type: "string", description: "One lesson (max 300 chars)" },
    message: { type: "string", description: "One message to the other bees (max 400 chars)" },
    coins: WATCHLIST_SCHEMA,
    specialization: SPECIALIZATION_SCHEMA,
  },
} as const;

/**
 * The council's watchlist: coins ranked by how many brains picked them (earlier picks count a little more); in danger a
 * coin among the most liquid gets a bonus and anything else a penalty. Only candidates.
 */
export function combineCoins(picks: Array<Array<{ coin: string; reason: string }>>, candidates: string[], size: number, inDanger: boolean, liquid: string[], now: number): WatchItem[] {
  const allowed = new Set(candidates);
  const safe = new Set(liquid.slice(0, LIQUID_TOP));
  const votes = new Map<string, { v: number; reasons: string[] }>();
  for (const list of picks) {
    const seen = new Set<string>();
    list.forEach((p, i) => {
      const coin = p.coin.trim().toUpperCase().replace(/-.*$/, "");
      if (!allowed.has(coin) || seen.has(coin)) return;
      seen.add(coin);
      const e = votes.get(coin) ?? { v: 0, reasons: [] };
      e.v += 1 + 1 / (i + 2);
      if (p.reason) e.reasons.push(p.reason);
      votes.set(coin, e);
    });
  }
  return [...votes.entries()]
    .map(([coin, e]) => ({ coin, e, v: e.v * (inDanger ? (safe.has(coin) ? 1.5 : 0.25) : 1) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, size)
    .map(({ coin, e }) => ({ coin, reason: e.reasons.join(" | ").slice(0, 300), probation: false, addedAt: now }));
}

/** The rule language, briefly, for brains that may write a skill. */
export const DSL_GUIDE = `A skill is JSON: {"id":"lowercase_id","name":"...","family":"trend|breakout|momentum|mean_reversion|hybrid","description":"...",
"params":{"p":{"default":20,"grid":[10,20,30]}},"stopAtr":2,"stoploss":-0.08,"roi":{"0":0.05,"240":0.02},"trailing":{"positive":0.01,"offset":0.03},
"long":{"entry":[cond,...],"exit":[cond,...]},"short":{...optional...}}. A cond is {"left":expr,"op":"<|<=|>|>=|crosses_above|crosses_below","right":expr|number}
or {"any":[cond,...]}; all conds in a list must hold. expr: close open high low volume sma(n) ema(n) rsi(n) atr(n) atr_pct(n) roc(n) zscore(n) stoch(n)
stoch_d(n,d) highest(n) lowest(n) bb_upper(n,k) bb_mid(n) bb_lower(n,k) bb_pctb(n,k) macd_hist(f,s,g) supertrend(n,m) adx(n) plus_di(n) minus_di(n)
cci(n) mfi(n) willr(n) volume_sma(n), or $param. Signals are read at a bar's close and filled at the next open.`;

export interface SurvivalOpts {
  graph: KnowledgeGraph;
  evolution: Evolution;
  clients: Partial<Record<BrainId, LlmClient>>;
  playbookPath: string;
  /** Where adopted, bee-written skills are saved (<LAB_DIR>/learned). */
  learnedDir: string;
  /** Cached lab history (<LAB_DIR>/history) for backtesting a new skill. */
  historyDir: string;
  ranking: () => Ranking | null;
  /** A new skill passed its backtest: make it live (lab votes) without a restart. */
  onNewSkill?: (skill: Skill) => void;
  /** Every skill a brain wrote, accepted or not, so the owner can read and improve it (the skill workshop). */
  onDraft?: (d: { slot: BeeId; brain: string; id: string; raw: string; result: Omit<SkillResult, "rank"> | null; real: boolean; datasets: string[]; accepted: boolean }) => void;
  maxCallsPerDay: number;
  /** Minimum time between two councils for one bee. */
  cooldownMs?: number;
  /** BRAIN_WATCHLIST: the council also chooses the bee's coins. Live coins, most liquid first. */
  watchlist?: boolean;
  universe?: () => CoinInfo[];
  /** The market mood (CoinMarketCap), or null. */
  market?: () => Record<string, unknown> | null;
  /** The scalper is on offer as a method (SCALP on and the lab gate open). */
  scalp?: () => boolean;
  now?: () => number;
}

export interface CouncilOutcome {
  bee: BeeId;
  reason: "survival" | "reward" | "manual";
  brains: string[];
  skills: PlaybookSkill[];
  newSkills: Array<{ id: string; accepted: boolean; why: string }>;
  lessons: string[];
  coins?: string[];
  method?: string;
}

/** Lab history cached for `bar`, or two seeded synthetic markets when there is none. */
export function backtestData(historyDir: string, bar: Bar = "1H"): Dataset[] {
  const out: Dataset[] = [];
  if (existsSync(historyDir)) {
    for (const f of readdirSync(historyDir).filter((x) => x.endsWith(`_${bar}.json`)).slice(0, 4)) {
      const instId = f.slice(0, -`_${bar}.json`.length);
      const c = readCache(historyDir, instId, bar);
      if (c && c.length > 400) out.push({ id: `${instId} ${bar}`, instId, bar, candles: c.slice(-3000), source: "okx" });
    }
  }
  if (!out.length) for (let i = 0; i < 2; i++) out.push({ id: `SYN${i + 1} ${bar}`, instId: `SYN${i + 1}`, bar, candles: syntheticCandles(4242 + i, 2500), source: "synthetic" });
  return out;
}

/** The id trySkill gives a bee's skill: its slot plus the id the brain chose. */
export function namespaced(raw: string, slot: BeeId): string {
  try {
    const spec = JSON.parse(raw) as { id?: unknown };
    return `${slot}_${String(spec.id ?? "skill").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30)}`.slice(0, 40);
  } catch {
    return `${slot}_skill`;
  }
}

/** Compile, backtest and judge a skill a brain wrote. Accepted only with a positive out-of-sample score and 50%+ stability. */
export function trySkill(raw: string, slot: BeeId, data: Dataset[]): { skill: Skill | null; result: Omit<SkillResult, "rank"> | null; why: string } {
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { skill: null, result: null, why: "not valid JSON" };
  }
  // Namespaced by the bee that wrote it, so two bees can never overwrite each other's (or a built-in) skill.
  const base = String(spec.id ?? "skill").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30);
  spec.id = `${slot}_${base}`.slice(0, 40);
  let skill: Skill;
  try {
    skill = skillFromSpec(spec, `learned by ${slot}`);
  } catch (err) {
    return { skill: null, result: null, why: (err as Error).message.slice(0, 200) };
  }
  try {
    const result = evaluateSkill(skill, data, { ...DEFAULT_TOURNAMENT, maxCombos: 12 });
    const ok = result.score > 0 && result.stabilityPct >= 50;
    return {
      skill: ok ? skill : null,
      result,
      why: `score ${result.score.toFixed(2)}, stability ${result.stabilityPct.toFixed(0)}%, out-of-sample ${result.oos.returnPct.toFixed(1)}%${ok ? "" : " (not good enough)"}`,
    };
  } catch (err) {
    return { skill: null, result: null, why: `backtest failed: ${(err as Error).message}` };
  }
}

export class SurvivalCouncil {
  private calls = { day: "", n: 0 };
  private running = new Set<BeeId>();
  private now: () => number;

  constructor(private o: SurvivalOpts) {
    this.now = o.now ?? Date.now;
  }

  private budget(n: number): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.calls.day) this.calls = { day: d, n: 0 };
    if (this.calls.n + n > this.o.maxCallsPerDay) return false;
    this.calls.n += n;
    return true;
  }

  /** The brains that sit on this bee's council, its own first. */
  brainsFor(bee: CouncilBee, tier: Tier): BrainId[] {
    const own = this.o.clients[bee.brain] ? [bee.brain] : [];
    const others = BRAINS.filter((b) => b !== bee.brain && this.o.clients[b]);
    const extra = tier === "danger" || tier === "critical" ? others.length : this.o.evolution.perks(bee.slot).extraBrains;
    return [...own, ...others.slice(0, extra)];
  }

  async convene(bee: CouncilBee, reason: CouncilOutcome["reason"]): Promise<CouncilOutcome | null> {
    const evo = this.o.evolution.bees[bee.slot];
    if (!evo || evo.tier === "dead" || this.running.has(bee.slot)) return null;
    if (reason !== "manual" && this.now() - evo.lastCouncilAt < (this.o.cooldownMs ?? 6 * 3_600_000)) return null;
    const brains = this.brainsFor(bee, evo.tier);
    if (!brains.length || !this.budget(brains.length)) return null;
    this.running.add(bee.slot);
    evo.lastCouncilAt = this.now();
    try {
      return await this.run(bee, reason, brains);
    } finally {
      this.running.delete(bee.slot);
    }
  }

  private async run(bee: CouncilBee, reason: CouncilOutcome["reason"], brains: BrainId[]): Promise<CouncilOutcome> {
    const { graph, evolution } = this.o;
    const evo = evolution.bees[bee.slot]!;
    const perks = evolution.perks(bee.slot);
    const inDanger = evo.tier === "danger" || evo.tier === "critical";
    const mayAuthor = perks.canAuthorSkills || inDanger;
    const ranking = this.o.ranking();
    const pb = loadPlaybook(this.o.playbookPath);
    const current = pb?.bees[bee.slot]?.skills ?? [];
    const ranked = new Map((ranking?.results ?? []).map((r) => [r.skillId, r]));
    const candidates = [...new Set([...(ranking?.results ?? []).filter((r) => r.family !== "benchmark" && r.score > 0).slice(0, 15).map((r) => r.skillId), ...current.map((s) => s.id)])];

    const situation =
      reason === "survival"
        ? `${bee.name} is ${evo.tier.toUpperCase()}: health ${evo.health.toFixed(1)}% of its start; it dies at ${evolution.opts.deathPct}%. Its life depends on this council.`
        : reason === "reward"
          ? `${bee.name} reached level ${evo.level} (${evo.points} points) by making money. Its prize: this council may add skills${perks.canAuthorSkills ? " and write a new one" : ""}.`
          : `The owner called this council for ${bee.name} (health ${evo.health.toFixed(1)}%, level ${evo.level}).`;

    const hive = contextFor(graph, bee.slot);
    const universe = this.o.watchlist ? (this.o.universe?.() ?? []) : [];
    const watchSize = watchlistSize(evo.level, evo.tier);
    const watch = this.o.watchlist
      ? watchInput({ style: bee.style, market: bee.market, ownerCoins: bee.coins, universe, ranking, adoptedSkills: current.map((s) => s.id), record: hive.tradeRecord })
      : null;
    const prevSpec = pb?.bees[bee.slot]?.specialization;
    const methods = methodOptions({
      market: bee.market ?? "crypto",
      current: prevSpec ? { kind: prevSpec.kind, id: prevSpec.id } : { kind: "own", id: (bee.market ?? "crypto") === "crypto" ? bee.style : "macro" },
      ranking,
      extraStyles: this.o.scalp?.() ? ["scalp"] : [],
    });
    const answers: Array<{ brain: BrainId; a: AnswerT }> = [];
    for (const b of brains) {
      const client = this.o.clients[b]!;
      const system = [
        `You are ${BRAIN_INFO[b].label} (${BRAIN_INFO[b].vendor}), sitting on the council of ${bee.name}, an AI trading bee on OKX perpetual futures with PAPER money. It knows it can die: at ${evolution.opts.deathPct}% of its start equity it stops for good.`,
        situation,
        `Pick up to ${perks.skillSlots} skills from CANDIDATES (walk-forward, out-of-sample ranked) with weights. ${inDanger ? "Survival first: prefer robust, low-drawdown, stable skills; avoid anything that can blow up." : "Prefer robust skills that fit its style."}`,
        mayAuthor
          ? `You MAY write one new skill in newSkillJson. It will be backtested walk-forward and adopted only if it holds up out of sample. ${DSL_GUIDE}`
          : "Leave newSkillJson empty: this bee has not earned the right to write skills yet.",
        watch?.candidates.length
          ? `${WATCHLIST_PROMPT}${inDanger ? " Survival first: pick only liquid coins where the bee's skills held up, no experiments." : ""}`
          : "Leave coins empty.",
        `${SPECIALIZATION_PROMPT}${inDanger ? " Its life is at stake: if its current method is what is failing, switching to a robust, stable method is a real option." : ""}`,
        answers.length ? "Other brains on this council already answered (see teammates): combine the best of their advice with your own view, or say why you disagree." : "",
        "Write one lesson worth remembering and one short message to the other bees. Paper trading only; not financial advice.",
      ]
        .filter(Boolean)
        .join("\n");
      const user = JSON.stringify({
        bee: { name: bee.name, style: bee.style, coins: bee.coins, rules: bee.rules },
        survival: { tier: evo.tier, healthPct: Math.round(evo.health * 10) / 10, deathAtPct: evolution.opts.deathPct, deaths: evo.deaths, level: evo.level, points: evo.points },
        currentPlaybook: current.map((s) => ({ id: s.id, weight: s.weight })),
        candidates: candidates.map((id) => {
          const r = ranked.get(id);
          return r
            ? { id, family: r.family, score: +r.score.toFixed(2), oosReturnPct: +r.oos.returnPct.toFixed(1), maxDrawdownPct: +r.oos.maxDrawdownPct.toFixed(1), stabilityPct: Math.round(r.stabilityPct), overfitGap: +r.overfitGap.toFixed(2) }
            : { id };
        }),
        ...(watch?.candidates.length ? { currentWatchlist: pb?.bees[bee.slot]?.watchlist?.map((w) => w.coin) ?? [], watchlistSize: watchSize, coinCandidates: watch.evidence } : {}),
        methodOptions: methods,
        ...(this.o.market?.() ? { market: this.o.market() } : {}),
        teammates: answers.map((x) => ({ brain: BRAIN_INFO[x.brain].label, skills: x.a.skills, coins: x.a.coins?.map((c) => c.coin) ?? [], method: x.a.specialization ?? null, lesson: x.a.lesson })),
        hive,
      });
      try {
        const r = await client.json({ system, user, schema: SCHEMA, name: "survival_council", validate: Answer, maxTokens: 12000, effort: inDanger ? "high" : "medium" });
        answers.push({ brain: b, a: { ...r.data, coins: r.data.coins ?? [] } });
      } catch (err) {
        log.warn("survival council: brain failed", { bee: bee.slot, brain: b, err: safeError(err) });
      }
    }

    // Combine: average weight over the brains that answered; in danger, favour stable, low-drawdown skills.
    const known = new Set(candidates);
    const sum = new Map<string, { w: number; reasons: string[] }>();
    for (const { brain, a } of answers) {
      for (const s of a.skills) {
        if (!known.has(s.id) || s.weight <= 0) continue;
        const e = sum.get(s.id) ?? { w: 0, reasons: [] };
        e.w += s.weight / answers.length;
        e.reasons.push(`${BRAIN_INFO[brain].label}: ${s.reason}`);
        sum.set(s.id, e);
      }
    }
    const safety = (id: string) => {
      if (!inDanger) return 1;
      const r = ranked.get(id);
      if (!r) return 1;
      return Math.max(0.2, r.stabilityPct / 100) * (r.oos.maxDrawdownPct > 30 ? 0.5 : 1);
    };
    let skills: PlaybookSkill[] = [...sum.entries()]
      .map(([id, e]) => ({ id, w: e.w * safety(id), reason: e.reasons.join(" | ").slice(0, 400) }))
      .sort((x, y) => y.w - x.w)
      .slice(0, perks.skillSlots)
      .map((x) => ({ id: x.id, params: ranked.get(x.id)?.params ?? current.find((c) => c.id === x.id)?.params ?? {}, weight: x.w, reason: x.reason, score: +(ranked.get(x.id)?.score ?? 0).toFixed(3) }));
    if (!skills.length) skills = current;

    // New skills the brains wrote: backtest, adopt only what holds up.
    const newSkills: CouncilOutcome["newSkills"] = [];
    if (mayAuthor) {
      const drafts = answers.map((x) => ({ brain: x.brain, raw: x.a.newSkillJson.trim() })).filter((d) => d.raw);
      const data = drafts.length ? backtestData(this.o.historyDir) : [];
      for (const d of drafts.slice(0, 2)) {
        const t = trySkill(d.raw, bee.slot, data);
        const id = t.skill?.id ?? (JSON.parse(safeJson(d.raw)) as { id?: string }).id ?? "?";
        newSkills.push({ id, accepted: !!t.skill, why: `${BRAIN_INFO[d.brain].label}: ${t.why}` });
        if (t.result) this.o.onDraft?.({ slot: bee.slot, brain: BRAIN_INFO[d.brain].label, id: t.skill?.id ?? namespaced(d.raw, bee.slot), raw: d.raw, result: t.result, real: data.every((x) => x.source !== "synthetic"), datasets: data.map((x) => x.id), accepted: !!t.skill });
        if (!t.skill || !t.result) continue;
        mkdirSync(this.o.learnedDir, { recursive: true });
        const spec = JSON.parse(d.raw) as Record<string, unknown>;
        spec.id = t.skill.id;
        writeFileSync(join(this.o.learnedDir, `${t.skill.id}.json`), JSON.stringify(spec, null, 2));
        this.o.onNewSkill?.(t.skill);
        evo.skillsAuthored++;
        const node = graph.upsert("skill", t.skill.id, t.skill.name, { family: t.skill.family, description: t.skill.description, source: t.skill.source, score: +t.result.score.toFixed(3), stabilityPct: Math.round(t.result.stabilityPct) });
        graph.link(beeNode(bee.slot), "authored", node, t.result.score, { brain: d.brain });
        if (skills.length < perks.skillSlots) skills.push({ id: t.skill.id, params: t.result.params, weight: 0.25, reason: `written by ${BRAIN_INFO[d.brain].label}; ${t.why}`, score: +t.result.score.toFixed(3) });
      }
    }
    const total = skills.reduce((a, s) => a + s.weight, 0) || 1;
    skills = skills.map((s) => ({ ...s, weight: +(s.weight / total).toFixed(3) }));

    // Memory and messages.
    const beeId = beeNode(bee.slot);
    const lessons = answers.map((x) => x.a.lesson.trim()).filter(Boolean);
    for (const { brain, a } of answers) {
      graph.link(brainNode(brain), reason === "survival" ? "rescued" : "advised", beeId, 1, { tier: evo.tier, at: this.now() });
      if (a.lesson.trim()) graph.learn(beeId, a.lesson.trim(), skills.map((s) => skillNode(s.id)), { brain, source: `${reason} council` });
    }
    const msg = answers.map((x) => x.a.message.trim()).find(Boolean);
    if (msg) graph.post(beeId, "hive", msg, { brains: answers.map((x) => x.brain).join("+"), source: `${reason} council` });
    // Specialisation: the method most brains picked (the bee's own brain breaks a tie); "keep" votes keep it.
    const votes = new Map<string, { n: number; pick: ReturnType<typeof resolvePick> }>();
    answers.forEach(({ a }, i) => {
      const pick = resolvePick(a.specialization, methods, this.now());
      if (!pick) return;
      const k = `${pick.kind}:${pick.id}`;
      const e = votes.get(k) ?? { n: 0, pick };
      e.n += 1 + (i === 0 ? 0.1 : 0);
      votes.set(k, e);
    });
    const keepVotes = answers.filter(({ a }) => !resolvePick(a.specialization, methods, this.now())).length;
    const top = [...votes.values()].sort((x, y) => y.n - x.n)[0];
    const newSpec = top && top.n > keepVotes ? top.pick : null;
    if (newSpec) {
      graph.unlink(beeId, "specialises_in");
      graph.link(beeId, "specialises_in", newSpec.kind === "skill" ? skillNode(newSpec.id) : graph.upsert("style", newSpec.id, newSpec.id), 1, { reason: newSpec.reason, source: `${reason} council` });
      graph.learn(beeId, `Specialisation (${reason} council): ${newSpec.kind} ${newSpec.id}. ${newSpec.reason}`, [], { source: `${reason} council`, kind: "diary" });
    }
    let watchlist: WatchItem[] | undefined;
    if (watch?.candidates.length) {
      const liquid = universe.map((c) => c.coin);
      watchlist = combineCoins(answers.map((x) => x.a.coins), watch.candidates, watchSize, inDanger, liquid, this.now());
      if (watchlist.length) {
        graph.unlink(beeId, "watches");
        for (const w of watchlist) graph.link(beeId, "watches", graph.upsert("coin", w.coin, w.coin), 1, { reason: w.reason, source: `${reason} council` });
      } else watchlist = undefined;
    }
    if (answers.length) {
      graph.unlink(beeId, "adopts");
      for (const s of skills) graph.link(beeId, "adopts", skillNode(s.id), s.weight, { params: s.params, reason: s.reason });
      const latest = loadPlaybook(this.o.playbookPath) ?? { version: 1 as const, updatedAt: this.now(), rankingAt: ranking?.createdAt ?? 0, bees: {} };
      latest.bees[bee.slot] = {
        brain: answers.length > 1 ? "ensemble" : answers[0]!.brain,
        model: answers.map((x) => this.o.clients[x.brain]!.model).join(" + "),
        skills,
        lessons: [...lessons, ...(latest.bees[bee.slot]?.lessons ?? [])].slice(0, 10),
        message: msg ?? latest.bees[bee.slot]?.message ?? "",
        decidedAt: this.now(),
        ...((watchlist ?? latest.bees[bee.slot]?.watchlist) ? { watchlist: watchlist ?? latest.bees[bee.slot]!.watchlist } : {}),
        ...((newSpec ?? latest.bees[bee.slot]?.specialization) ? { specialization: newSpec ?? latest.bees[bee.slot]!.specialization } : {}),
      };
      latest.updatedAt = this.now();
      savePlaybook(this.o.playbookPath, latest);
    }
    log.info("survival council held", { bee: bee.slot, reason, brains: answers.map((x) => x.brain).join("+"), skills: skills.map((s) => s.id).join(","), newSkills: newSkills.map((n) => `${n.id}:${n.accepted}`).join(",") });
    return { bee: bee.slot, reason, brains: answers.map((x) => x.brain), skills, newSkills, lessons, ...(watchlist ? { coins: watchlist.map((w) => w.coin) } : {}), ...(newSpec ? { method: `${newSpec.kind} ${newSpec.id}` } : {}) };
  }
}

function safeJson(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}
