// The skill agent: describe a strategy in words and one of the registered brains drafts it in the JSON rule language.
// It works like a careful colleague, not an autopilot: the draft is compiled here, a broken one is sent back once with
// the compiler's complaints, and whatever comes out lands in the skill workshop as a DRAFT. It is never published by this
// code: the owner backtests it and decides (lab/workspace.ts). The brain has no market data and no tools, so it cannot
// know how its idea performs; the answer says so.
import { z } from "zod";
import { DSL_GUIDE } from "../brains/survival.js";
import { brainInfo, type BrainId, type JsonAnswer, type LlmClient } from "../brains/llm.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { BUILTIN_SKILLS } from "./skills/index.js";
import { validateSkill } from "./workspace.js";

const Answer = z.object({ skill: z.string().min(2).max(30_000), explanation: z.string().max(900) });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skill", "explanation"],
  properties: {
    skill: { type: "string", description: "The skill as ONE JSON object in the rule language, serialised as text" },
    explanation: { type: "string", description: "2 to 4 sentences: the idea, what it assumes, and its main risk. No performance claims: you have no data." },
  },
} as const;

export const MAX_PROMPT = 2000;
/** Which brain answers when the owner does not pick one: the ones that follow a long rule language best come first. */
const PREFERENCE = ["claude", "openai", "zai", "kimi"];

export interface AgentOpts {
  clients: () => Partial<Record<BrainId, LlmClient>>;
  maxCallsPerDay: number;
  now?: () => number;
}

export interface AgentResult {
  brain: BrainId;
  brainLabel: string;
  model: string;
  json: string;
  explanation: string;
  valid: boolean;
  errors: string[];
  attempts: number;
}

export class AgentError extends Error {}

export class SkillAgent {
  private calls = { day: "", n: 0 };
  private now: () => number;

  constructor(private o: AgentOpts) {
    this.now = o.now ?? Date.now;
  }

  /** The brains that can be asked (registered, with a key or a local endpoint), in the order the panel offers them. */
  available(): Array<{ id: BrainId; label: string }> {
    const ids = Object.keys(this.o.clients());
    const ordered = [...PREFERENCE.filter((i) => ids.includes(i)), ...ids.filter((i) => !PREFERENCE.includes(i))];
    return ordered.map((id) => ({ id, label: brainInfo(id).label }));
  }

  private spend(): boolean {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (d !== this.calls.day) this.calls = { day: d, n: 0 };
    if (this.calls.n >= this.o.maxCallsPerDay) return false;
    this.calls.n++;
    return true;
  }

  private system(revise: boolean): string {
    const builtins = BUILTIN_SKILLS.map((s) => s.id).join(", ");
    return [
      "You write trading skills for a strategy lab, in a small JSON rule language. The owner describes a strategy in plain words; you turn it into ONE valid skill.",
      DSL_GUIDE,
      `Rules: the id is lowercase letters, digits and _, and must not be one of these built-in ids: ${builtins}.`,
      "Use only the indicators and operators listed above; do not invent functions. Prefer few parameters and small grids (at most 5 values) so the walk-forward backtest cannot simply fit noise.",
      "Signals are read at a bar's close and filled at the next open: never rely on the current bar's future. Add a stop (stopAtr or stoploss) unless the owner says otherwise. Long only unless the owner asks for shorts.",
      revise ? "The owner gives you the current skill and asks for a change: keep what works, change what was asked, and keep the same id." : "Pick a clear id and name.",
      "You have no market data and no tools, so you cannot know how this performs: say so plainly in the explanation, name the idea's main risk, and never promise results. The owner will backtest it before it can go live.",
    ].join("\n");
  }

  /** Draft a skill (or revise `current`). Never publishes; never throws for a draft that does not compile (it comes back invalid). */
  async draft(a: { prompt: string; brain?: BrainId; current?: string }): Promise<AgentResult> {
    const prompt = a.prompt.trim().slice(0, MAX_PROMPT);
    if (prompt.length < 8) throw new AgentError("Describe the strategy in a sentence or two.");
    const clients = this.o.clients();
    const avail = this.available();
    if (!avail.length) throw new AgentError("No brain can answer yet: add a key under API keys (or a custom brain).");
    const id = a.brain ?? avail[0]!.id;
    const client = clients[id];
    if (!client) throw new AgentError(`${brainInfo(id).label} cannot answer: it has no key here.`);
    let previous: { skill: string; errors: string[] } | null = null;
    let last: { skill: string; explanation: string; errors: string[]; model: string } | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (!this.spend()) {
        if (last) break;
        throw new AgentError("The daily brain-call cap is used up. It resets at 00:00 UTC.");
      }
      const user: string = JSON.stringify({ request: prompt, ...(a.current ? { currentSkill: a.current } : {}), ...(previous ? { yourLastAttempt: previous.skill, compilerErrors: previous.errors, fix: "Return a corrected skill that compiles." } : {}) });
      let out: JsonAnswer<z.infer<typeof Answer>>;
      try {
        out = await client.json({ system: this.system(!!a.current), user, schema: SCHEMA, name: "skill_draft", validate: Answer, maxTokens: 6000, effort: "medium" });
      } catch (err) {
        log.warn("skill agent: brain failed", { brain: id, err: safeError(err) });
        if (last) break;
        throw new AgentError(`${brainInfo(id).label} could not answer: ${safeError(err).message}`);
      }
      const text: string = out.data.skill.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim();
      const v = validateSkill(text);
      last = { skill: text, explanation: out.data.explanation, errors: v.ok ? [] : v.errors, model: out.model };
      if (v.ok) break;
      previous = { skill: text, errors: v.errors };
    }
    const l = last!;
    log.info("skill agent: drafted", { brain: id, valid: l.errors.length === 0 });
    return { brain: id, brainLabel: brainInfo(id).label, model: l.model, json: l.skill, explanation: l.explanation, valid: l.errors.length === 0, errors: l.errors, attempts: previous ? 2 : 1 };
  }
}
