// The platform's default decision model for a member's bunny: the same question Jev is asked (pick one move from the menu,
// say how strong the signal is), answered by an ordinary chat model with a strict JSON schema, so the engine can run a
// member's bunny with no TypeSafe key. It plugs in where Jev's client goes (jev.ts SystemOne), so the engine's own
// guard rails are unchanged: a choice off the menu is rejected, a failure means hold, and the daily USD cap still applies.
import { z } from "zod";
import type { LlmClient } from "../brains/llm.js";
import type { SystemOne } from "../jev.js";

interface ChoiceQ {
  instructions: string;
  criteria: Record<string, string | null>;
}
interface ScoreQ {
  criteria: readonly string[];
}

const SYSTEM =
  "You are the decision model of a paper-trading agent in a game (simulated money, real prices). Each turn you see the agent's " +
  "strategy, its current state and a menu of legal moves. Choose exactly ONE move from the menu, exactly as spelled, and never " +
  "invent one. Prefer doing nothing when the state does not clearly support a move. Also rate the signal strength as a whole " +
  "number from 0 (none) up to the top level. Be honest about confidence: it is a number from 0 to 1. This is not financial advice.";

export class LlmSystemOne implements SystemOne {
  constructor(private readonly llm: LlmClient, private readonly label = "platform-default") {}

  systemOne(req: Parameters<SystemOne["systemOne"]>[0]): ReturnType<SystemOne["systemOne"]> {
    return this.run(req) as never;
  }

  private async run(req: Parameters<SystemOne["systemOne"]>[0]): Promise<unknown> {
    const q = req.questions as unknown as { action: ChoiceQ; conviction: ScoreQ };
    const labels = Object.keys(q.action.criteria);
    const levels = q.conviction.criteria;
    const answer = z.object({ choice: z.string(), confidence: z.number(), conviction: z.number() });
    const r = await this.llm.json({
      system: SYSTEM,
      user: JSON.stringify({ strategy: q.action.instructions, state: req.state, menu: q.action.criteria, signalLevels: levels }),
      name: "agent_move",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["choice", "confidence", "conviction"],
        properties: {
          choice: { type: "string", enum: labels },
          confidence: { type: "number" },
          conviction: { type: "integer" },
        },
      },
      validate: answer,
      maxTokens: 200,
      effort: "low",
    });
    const { choice, conviction } = r.data;
    const confidence = Math.max(0, Math.min(1, r.data.confidence));
    // The model gives one confidence; the rest of the probability is spread over the other moves.
    const others = labels.filter((l) => l !== choice);
    const probabilities: Record<string, number> = { [choice]: confidence };
    for (const l of others) probabilities[l] = others.length ? (1 - confidence) / others.length : 0;
    const score = Math.max(0, Math.min(levels.length - 1, Math.round(conviction)));
    return {
      model: `${this.label}:${r.model}`,
      usage: { input_tokens: r.inputTokens + r.outputTokens, output_tokens: 0 },
      answers: {
        action: { type: "choice", choice, confidence, probabilities },
        conviction: { type: "score", score, confidence, legend: {}, probabilities: {} },
      },
    };
  }
}

interface Answer {
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  answers: { action: { choice: string; confidence: number }; conviction: { score: number } };
}

/**
 * Several brains decide one move together (Pro up to 3, Premium up to 6): every brain is asked the same question, and the
 * move most of them chose wins. The odds the agent shows are the share of ALL its brains that voted for each move, so a
 * brain that fails or answers off the menu counts as an abstention and lowers the winner's share (the engine's own gates
 * then make a weak vote hold). A tie goes to HOLD when HOLD is among the tied moves, else to the move with the higher mean
 * confidence. When every brain fails, the call fails and the engine holds, as with a single brain.
 */
export class EnsembleSystemOne implements SystemOne {
  constructor(private readonly members: ReadonlyArray<{ sys: SystemOne; label: string }>) {}

  systemOne(req: Parameters<SystemOne["systemOne"]>[0]): ReturnType<SystemOne["systemOne"]> {
    return this.run(req) as never;
  }

  private async run(req: Parameters<SystemOne["systemOne"]>[0]): Promise<unknown> {
    const q = req.questions as unknown as { action: ChoiceQ; conviction: ScoreQ };
    const labels = Object.keys(q.action.criteria);
    const settled = await Promise.allSettled(this.members.map((m) => Promise.resolve(m.sys.systemOne(req)) as Promise<unknown>));
    const answers: Answer[] = [];
    let tokens = 0;
    let firstError: unknown = null;
    for (const s of settled) {
      if (s.status === "rejected") {
        firstError ??= s.reason;
        continue;
      }
      const a = s.value as Answer;
      tokens += (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0);
      if (labels.includes(a.answers?.action?.choice)) answers.push(a);
    }
    if (answers.length === 0) throw firstError ?? new Error("no brain gave an answer on the menu");
    const n = this.members.length;
    const votes = new Map<string, Answer[]>();
    for (const a of answers) votes.set(a.answers.action.choice, [...(votes.get(a.answers.action.choice) ?? []), a]);
    const top = Math.max(...[...votes.values()].map((v) => v.length));
    const tied = [...votes.entries()].filter(([, v]) => v.length === top);
    const mean = (v: Answer[]) => v.reduce((s, a) => s + a.answers.action.confidence, 0) / v.length;
    const choice = (tied.find(([l]) => /^HOLD/.test(l)) ?? tied.sort((x, y) => mean(y[1]) - mean(x[1]))[0]!)[0];
    const winners = votes.get(choice)!;
    const probabilities: Record<string, number> = {};
    for (const l of labels) probabilities[l] = (votes.get(l)?.length ?? 0) / n;
    const conviction = Math.round(winners.reduce((s, a) => s + a.answers.conviction.score, 0) / winners.length);
    const share = probabilities[choice]!;
    return {
      model: `ensemble:${answers.length}/${n}`,
      usage: { input_tokens: tokens, output_tokens: 0 },
      answers: {
        action: { type: "choice", choice, confidence: share, probabilities },
        conviction: { type: "score", score: conviction, confidence: share, legend: {}, probabilities: {} },
      },
    };
  }
}
