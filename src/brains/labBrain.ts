// The lab's own brain (GPT by default): it studies everything the brains already know and keeps the coin book
// (lab/coinBook.ts) evolving without anyone pressing a button.
//
// Every LAB_BRAIN_INTERVAL_MIN it reads one dossier:
//   - the coin book (each coin's rules, lab tests, live results, the log);
//   - the latest scalp lab report;
//   - the 1-hour skill ranking;
//   - every bunny's memory (graph/hive-mind.ts contextFor: lessons, research, record, adopted skills);
//   - research notes the owner approved;
//   - what the Rat, Owl and Pig said;
//   - live P&L per coin;
//   - why each bunny is not trading (bunnyProfile.ts blockers);
//   - the market mood;
//   - its own previous studies.
// It writes a study, files new rules (the scalp DSL, lab/scalpDsl.ts) or existing ones per coin, retires what the
// evidence says is dead, and names the coins the next lab run should focus on.
//
// Then one bunny per round proposes up to two rules for its own coins with its own brain. Those enter the book as
// "bunny:<slot>". When anything new is queued, the lab is asked to run sooner (autolab.ts request).
//
// The brain never trades and never opens the gate: a rule it writes only reaches the live scalper after the
// walk-forward lab passes it on real data, and live results can demote it again.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { KnowledgeGraph } from "../graph/graph.js";
import { beeNode, contextFor } from "../graph/hive-mind.js";
import { BookError, type BookSource, type CoinBook } from "../lab/coinBook.js";
import { coinOfSet, SCALP_RULES, type ScalpReport } from "../lab/scalp.js";
import { TRADE_BOUNDS } from "../lab/scalpDsl.js";
import type { Ranking } from "../lab/tournament.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import type { CouncilBee } from "./council.js";
import type { LlmClient } from "./llm.js";
import type { NoteBook } from "./notes.js";

export interface LabBrainOpts {
  book: CoinBook;
  graph: KnowledgeGraph;
  /** The lab's brain (GPT unless LAB_BRAIN names another); null = no study, the book still evolves from lab and live results. */
  brain: () => LlmClient | null;
  /** Each bunny's own brain, for its proposals. */
  bunnyBrain: (bee: CouncilBee) => LlmClient | null;
  bees: () => CouncilBee[];
  report: () => ScalpReport | null;
  ranking: () => Ranking | null;
  notes?: NoteBook;
  market?: () => Record<string, unknown> | null;
  /** The live crypto universe, most liquid first, with what the feed knows. */
  universe: () => Array<Record<string, unknown> & { coin: string }>;
  /** Realised P&L per bunny and coin over the last days (fills). */
  livePnl: () => Array<{ bee: string; coin: string; trades: number; netUsd: number }>;
  /** Why each bunny is (not) trading (bunnyProfile.ts blockers). */
  blockers: (slot: string) => unknown;
  /** What the crew said lately (the Rat's brief, the Owl's notes, the Pig's alerts). */
  crew?: () => Array<{ who: string; text: string; at: number }>;
  /** Ask the autonomous lab to test the queued rules sooner (autolab.ts request). */
  requestLab: () => boolean;
  /** Where studies are kept (<LAB_DIR>/lab-brain.json). */
  path: string;
  intervalMin: number;
  maxCallsPerDay: number;
  startDelayMin?: number;
  now?: () => number;
}

export interface Study {
  at: number;
  trigger: "scheduled" | "manual" | "startup";
  brain: string;
  model: string;
  summary: string;
  findings: Array<{ coin: string; text: string }>;
  applied: Array<{ coin: string; ruleId: string | null; action: "proposed" | "retired" | "rejected"; source: BookSource; note: string }>;
  focus: string[];
  bunny: { slot: string; brain: string; proposed: number; note: string } | null;
  labRequested: boolean;
}

const Proposal = z.object({
  coin: z.string().max(24),
  ruleId: z.string().max(48),
  specJson: z.string().max(6000),
  reason: z.string().max(400),
});
const StudyAnswer = z.object({
  summary: z.string().max(2400),
  findings: z.array(z.object({ coin: z.string().max(24), text: z.string().max(400) })).max(12),
  proposals: z.array(Proposal).max(6),
  retire: z.array(z.object({ coin: z.string().max(24), ruleId: z.string().max(48), reason: z.string().max(300) })).max(6),
  focus: z.array(z.string().max(24)).max(8),
});
const BunnyAnswer = z.object({ note: z.string().max(400), proposals: z.array(Proposal).max(2) });

const str = { type: "string" } as const;
const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["coin", "ruleId", "specJson", "reason"],
  properties: {
    coin: { type: "string", description: 'A coin symbol like "BTC", or "*" to sweep the rule across every coin the lab tests next' },
    ruleId: { type: "string", description: 'An existing rule id to queue for this coin; "" when specJson writes a new rule' },
    specJson: { type: "string", description: 'A new rule in the scalp DSL, as a JSON string; "" when ruleId names an existing rule' },
    reason: { type: "string", description: "The evidence from the dossier behind it, citing numbers" },
  },
} as const;
const STUDY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "findings", "proposals", "retire", "focus"],
  properties: {
    summary: { type: "string", description: "The study: what the evidence says about where an edge after costs may exist, and what to test next" },
    findings: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["coin", "text"], properties: { coin: str, text: str } } },
    proposals: { type: "array", maxItems: 6, items: PROPOSAL_SCHEMA },
    retire: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["coin", "ruleId", "reason"], properties: { coin: str, ruleId: str, reason: str } } },
    focus: { type: "array", maxItems: 8, items: str },
  },
} as const;
const BUNNY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["note", "proposals"],
  properties: { note: str, proposals: { type: "array", maxItems: 2, items: PROPOSAL_SCHEMA } },
} as const;

/** The scalp DSL, told to a brain in a few lines. */
export const DSL_GUIDE = [
  "A scalp rule is JSON: {id, name, description, params, trade, long?, short?}.",
  'id: lowercase letters, digits and _ (2-40). params: {"<name>": {"default": n, "grid": [up to 4 values]}}, referenced as "$<name>" in conditions.',
  "long / short: {\"entry\": [conditions]}; all must hold, and the rule fires on the bar they BECOME true. A condition is {left, op, right} or {any: [conditions]}.",
  "op: < <= > >= crosses_above crosses_below. Operands: numbers, $params, close open high low volume, sma(n) ema(n) rsi(n) atr(n) atr_pct(n) roc(n) zscore(n) stoch(n) highest(n) lowest(n) (prior n bars) bb_upper(n,k) bb_mid(n) bb_lower(n,k) bb_pctb(n,k) macd_hist(f,s,g) supertrend(n,m) adx(n) plus_di(n) minus_di(n) cci(n) mfi(n) willr(n) stoch_d(n,d) volume_sma(n). Arguments are numbers or $params; no arithmetic, no negative $params (use a negative default instead).",
  `trade: the exit, same {default, grid} shape: ${Object.entries(TRADE_BOUNDS).map(([k, [lo, hi]]) => `${k} ${lo}..${hi}`).join(", ")}. targetAtr/stopAtr are ATR(14) multiples on 1-minute bars; holdBars is a time stop in minutes; makerEntry/makerTarget 1 = resting maker limits (cheaper), 0 = taker.`,
  "Bars are 1-minute candles. Costs: maker ~2 bp per side, taker ~5 bp plus slippage and spread. A target must be worth at least costGateMult x its round trip, so tiny targets never trade. At most 512 grid combinations.",
  'Example: {"id":"rsi_snap","name":"RSI snap","description":"Fade RSI(7) extremes above the 100 EMA","params":{"lo":{"default":20,"grid":[15,25]}},"trade":{"targetAtr":{"default":1,"grid":[0.8,1.4]},"stopAtr":{"default":1.6},"holdBars":{"default":12}},"long":{"entry":[{"left":"rsi(7)","op":"<","right":"$lo"},{"left":"close","op":">","right":"ema(100)"}]}}',
].join("\n");

const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const DAY = 86_400_000;

export class LabBrain {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly now: () => number;
  private studies: Study[] = [];

  constructor(private readonly o: LabBrainOpts) {
    this.now = o.now ?? Date.now;
    try {
      const raw = JSON.parse(readFileSync(o.path, "utf8")) as { studies?: Study[] };
      this.studies = Array.isArray(raw.studies) ? raw.studies.slice(-20) : [];
    } catch {
      this.studies = [];
    }
  }

  get enabled(): boolean {
    return !!this.o.brain();
  }

  busy(): boolean {
    return this.running;
  }

  last(): Study | null {
    return this.studies[this.studies.length - 1] ?? null;
  }

  status() {
    const b = this.o.brain();
    const l = this.last();
    return {
      enabled: !!b,
      brain: b ? `${b.brain}:${b.model}` : null,
      running: this.running,
      intervalMin: this.o.intervalMin,
      callsToday: this.callsToday(),
      maxCallsPerDay: this.o.maxCallsPerDay,
      lastAt: l?.at ?? null,
      nextAt: l ? l.at + this.o.intervalMin * 60_000 : null,
      studies: this.studies.slice(-8).reverse(),
    };
  }

  start(): void {
    if (this.timer || this.o.intervalMin <= 0) return;
    const loop = (ms: number) => {
      this.timer = setTimeout(() => {
        void this.due().finally(() => loop(10 * 60_000));
      }, ms);
      this.timer.unref?.();
    };
    loop((this.o.startDelayMin ?? 10) * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a study when the last one is older than the interval. */
  async due(): Promise<Study | null> {
    const l = this.last();
    if (l && this.now() - l.at < this.o.intervalMin * 60_000) return null;
    try {
      return await this.study(l ? "scheduled" : "startup");
    } catch (err) {
      log.warn("lab brain: study failed", { err: safeError(err) });
      return null;
    }
  }

  private callsToday(): number {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.o.book.getMeta("lab_brain_day") === day ? Number(this.o.book.getMeta("lab_brain_calls") ?? 0) : 0;
  }

  private spend(): boolean {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const n = this.callsToday();
    if (n >= this.o.maxCallsPerDay) return false;
    // Reserved before the call, so a crash cannot replay it for free.
    this.o.book.setMeta("lab_brain_day", day);
    this.o.book.setMeta("lab_brain_calls", n + 1);
    return true;
  }

  /** Everything the brains know, bounded. */
  dossier() {
    const at = this.now();
    this.o.book.refresh(at);
    const book = this.o.book.view(true, at);
    const report = this.o.report();
    const rank = this.o.ranking();
    const bees = this.o.bees();
    return {
      at: new Date(at).toISOString(),
      builtInRules: SCALP_RULES.map((r) => ({ id: r.id, name: r.name, description: r.description, grid: r.grid })),
      book: {
        totals: book.totals,
        writtenRules: book.rules.filter((r) => r.source !== "builtin").slice(-40),
        coins: book.coins.slice(0, 40).map((c) => ({ coin: c.coin, rules: c.candidates.map((x) => ({ ruleId: x.ruleId, status: x.status, source: x.source, tests: x.tests, lab: x.lastTest, live: x.live, pinned: x.pinned, blocked: x.blocked })) })),
        recentLog: book.log.slice(0, 30),
      },
      scalpLab: report
        ? {
            at: new Date(report.createdAt).toISOString(),
            ageDays: round((at - report.createdAt) / DAY, 1),
            source: report.source,
            verdict: report.verdict.note,
            results: report.results.slice(0, 80).map((r) => ({
              coin: coinOfSet(r.dataset),
              rule: r.ruleId,
              oosTrades: r.oos.trades,
              netBps: round(r.oos.netExpectancyBps),
              grossBps: round(r.oos.grossExpectancyBps),
              grossNoCostsBps: round(r.oosGrossBps),
              feesBps: round(r.oos.feesBpsPerTrade),
              winPct: Math.round(r.oos.winRatePct),
              fillPct: Math.round(r.oos.fillRatePct),
              folds: `${r.positiveFolds}/${r.folds.length}`,
              plateauPct: Math.round(r.plateauPct),
              edge: r.edge,
              why: r.why,
            })),
          }
        : null,
      hourlyRanking: rank
        ? { at: new Date(rank.createdAt).toISOString(), top: rank.results.slice(0, 12).map((r) => ({ skill: r.name, family: r.family, score: round(r.score), oosReturnPct: round(r.oos.returnPct, 1), buyHoldPct: round(r.oos.benchmarkPct, 1), stabilityPct: Math.round(r.stabilityPct) })) }
        : null,
      bunnies: bees.map((b) => {
        const ctx = contextFor(this.o.graph, b.slot);
        return { slot: b.slot, name: b.name, style: b.style, coins: b.coins, memory: { lessons: ctx.myLessons, consolidated: ctx.memory, research: ctx.research, record: ctx.tradeRecord, adopted: ctx.adopted, background: ctx.background?.notes ?? null }, notTrading: this.o.blockers(b.slot) };
      }),
      approvedNotes: (this.o.notes?.all() ?? []).filter((n) => n.status === "approved").slice(0, 20).map((n) => ({ bee: n.bee, title: n.title, text: n.text, coins: n.coins, confidence: n.confidence })),
      labLessons: this.o.graph.lessons("run:lab", 5).map((l) => l.text),
      crew: (this.o.crew?.() ?? []).slice(0, 12),
      livePnl: this.o.livePnl().slice(0, 40),
      market: this.o.market?.() ?? null,
      universe: this.o.universe().slice(0, 30),
      previousStudies: this.studies.slice(-3).map((s) => ({ at: new Date(s.at).toISOString(), summary: s.summary.slice(0, 600), applied: s.applied.slice(0, 8) })),
    };
  }

  /**
   * One study: the lab brain over the whole dossier, then one bunny's proposals. Returns the study, or throws when no
   * brain or no budget is left.
   */
  async study(trigger: Study["trigger"] = "manual"): Promise<Study> {
    if (this.running) throw new Error("a study is already running");
    const brain = this.o.brain();
    if (!brain) throw new Error("no lab brain: add an OpenAI key (or set LAB_BRAIN to a brain with a key)");
    if (!this.spend()) throw new Error(`the lab brain's ${this.o.maxCallsPerDay} calls for today are used`);
    this.running = true;
    try {
      const pack = this.dossier();
      const system = [
        "You are the strategy lab's research brain for a paper/demo crypto trading app on OKX perpetual futures. You run the lab: you do not trade.",
        "Study the whole dossier: the coin book (each coin's scalp rules with lab tests and live results), the latest 1-minute scalp lab report, the 1-hour skill ranking, every bunny's memory and record, why bunnies are not trading, approved research notes, the crew's briefs, live P&L and the market.",
        "Your job: keep each coin's rules evolving toward an edge that survives costs.",
        "- Write a study: where an edge after costs might exist, which coins and conditions, and why the current rules fail (fees? too few trades? no gross edge?). Cite numbers from the dossier.",
        "- Propose up to 6 rules: an existing rule for a coin (ruleId), or a NEW rule in the scalp DSL (specJson) that addresses a measured failure, e.g. wider targets where fees eat a small gross edge, filters where the win rate is low, other conditions where there is no gross edge. Prefer variations of what came closest. Never re-propose what the log shows retired recently unless the evidence changed.",
        "- Retire up to 6 rules per coin that the evidence shows are dead (repeated negative gross edge). Never retire a pinned or owner (manual) rule.",
        "- Name up to 8 focus coins for the next lab run.",
        "Rules only trade after the walk-forward lab passes them on real data; be bold in what you propose and strict in what you claim. No invented data. Paper research, not financial advice.",
        "",
        DSL_GUIDE,
      ].join("\n");
      const r = await brain.json({ system, user: JSON.stringify(pack), schema: STUDY_SCHEMA, name: "lab_study", validate: StudyAnswer, maxTokens: 9000, effort: "high" });
      const applied: Study["applied"] = [];
      for (const p of r.data.proposals) applied.push(this.apply(p, "lab-brain"));
      for (const x of r.data.retire) applied.push(this.retire(x.coin, x.ruleId, x.reason));
      const focus = [...new Set(r.data.focus.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z0-9]{1,20}$/.test(c)))].slice(0, 8);
      if (focus.length) this.o.book.setMeta("lab_brain_focus", JSON.stringify({ at: this.now(), coins: focus }));
      const bunny = await this.bunnyRound().catch((err) => {
        log.warn("lab brain: bunny round failed", { err: safeError(err) });
        return null;
      });
      if (bunny) applied.push(...bunny.applied);
      const queued = applied.some((a) => a.action === "proposed");
      const labRequested = queued ? this.o.requestLab() : false;
      const s: Study = {
        at: this.now(),
        trigger,
        brain: r.brain,
        model: r.model,
        summary: r.data.summary,
        findings: r.data.findings.map((f) => ({ coin: f.coin.toUpperCase(), text: f.text })),
        applied,
        focus,
        bunny: bunny ? bunny.info : null,
        labRequested,
      };
      this.remember(s);
      log.info("lab brain: study done", { proposed: applied.filter((a) => a.action === "proposed").length, retired: applied.filter((a) => a.action === "retired").length, rejected: applied.filter((a) => a.action === "rejected").length, labRequested });
      return s;
    } finally {
      this.running = false;
    }
  }

  /** The focus coins of the last study, while fresh (a day). */
  focus(): string[] {
    try {
      const f = JSON.parse(String(this.o.book.getMeta("lab_brain_focus") ?? "")) as { at: number; coins: string[] };
      return this.now() - f.at < DAY ? f.coins : [];
    } catch {
      return [];
    }
  }

  private apply(p: z.infer<typeof Proposal>, source: BookSource): Study["applied"][number] {
    const coin = p.coin.trim().toUpperCase();
    try {
      let spec: unknown;
      if (p.specJson.trim()) {
        try {
          spec = JSON.parse(p.specJson);
        } catch {
          throw new BookError("specJson is not JSON");
        }
      }
      const r = this.o.book.propose({ coin, ...(spec === undefined ? { ruleId: p.ruleId } : { spec }), source, reason: p.reason });
      return { coin, ruleId: r.ruleId, action: "proposed", source, note: r.note };
    } catch (err) {
      return { coin, ruleId: p.ruleId || null, action: "rejected", source, note: (err as Error).message.slice(0, 300) };
    }
  }

  private retire(coin: string, ruleId: string, reason: string): Study["applied"][number] {
    const k = coin.trim().toUpperCase();
    try {
      this.o.book.retire(k, ruleId, "lab-brain", reason);
      return { coin: k, ruleId, action: "retired", source: "lab-brain", note: reason.slice(0, 300) };
    } catch (err) {
      return { coin: k, ruleId, action: "rejected", source: "lab-brain", note: (err as Error).message.slice(0, 300) };
    }
  }

  /** One bunny, in rotation, proposes up to two rules for its own coins with its own brain. */
  private async bunnyRound(): Promise<{ applied: Study["applied"]; info: NonNullable<Study["bunny"]> } | null> {
    const bees = this.o.bees().filter((b) => this.o.bunnyBrain(b));
    if (!bees.length || this.callsToday() >= this.o.maxCallsPerDay) return null;
    const cursor = Number(this.o.book.getMeta("lab_brain_bunny_cursor") ?? 0) || 0;
    const bee = bees[cursor % bees.length]!;
    this.o.book.setMeta("lab_brain_bunny_cursor", cursor + 1);
    const client = this.o.bunnyBrain(bee)!;
    if (!this.spend()) return null;
    const pack = this.dossier();
    const coins = new Set(bee.coins.map((c) => c.toUpperCase()));
    const mine = {
      you: pack.bunnies.find((b) => b.slot === bee.slot),
      yourCoins: [...coins],
      book: pack.book.coins.filter((c) => coins.has(c.coin) || c.coin === "*"),
      writtenRules: pack.book.writtenRules,
      scalpLab: pack.scalpLab ? { ...pack.scalpLab, results: pack.scalpLab.results.filter((r) => coins.has(r.coin)).slice(0, 30) } : null,
      latestStudy: this.last()?.summary ?? null,
      builtInRules: pack.builtInRules,
    };
    const system = [
      `You are the brain of ${bee.name}, a ${bee.style} bunny trading ${[...coins].join(", ") || "crypto"} on paper/demo. The strategy lab asks you for up to 2 scalp rules for YOUR coins.`,
      "Read your memory, your record, the lab's tests of your coins and the lab's latest study. Propose what YOU have seen work or think the lab missed: an existing rule for one of your coins, or a new rule in the scalp DSL. Cite your evidence. Empty is fine.",
      "Your rules only trade after the walk-forward lab passes them on real data. No invented data.",
      "",
      DSL_GUIDE,
    ].join("\n");
    const r = await client.json({ system, user: JSON.stringify(mine), schema: BUNNY_SCHEMA, name: "bunny_rules", validate: BunnyAnswer, maxTokens: 4000, effort: "medium" });
    const source = `bunny:${bee.slot}` as BookSource;
    const applied = r.data.proposals.map((p) => this.apply(p, source));
    const proposed = applied.filter((a) => a.action === "proposed");
    if (proposed.length) this.o.graph.post(beeNode(bee.slot), "hive", `Proposed to the lab: ${proposed.map((a) => `${a.ruleId} on ${a.coin}`).join(", ")}. ${r.data.note}`.slice(0, 600), { source: "lab" });
    return { applied, info: { slot: bee.slot, brain: `${r.brain}:${r.model}`, proposed: proposed.length, note: r.data.note } };
  }

  private remember(s: Study): void {
    this.studies.push(s);
    this.studies = this.studies.slice(-20);
    try {
      mkdirSync(dirname(this.o.path), { recursive: true });
      writeFileSync(this.o.path, JSON.stringify({ studies: this.studies }));
    } catch (err) {
      log.warn("lab brain: could not save the study", { err: safeError(err) });
    }
    const node = this.o.graph.upsert("run", "lab-brain", "Lab brain", { kind: "lab" });
    this.o.graph.learn(node, `Lab study: ${s.summary}`.slice(0, 600), [], { source: "lab-brain", brain: s.brain });
  }
}
