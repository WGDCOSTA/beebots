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
  "You are the decision model of a paper-trading bunny in a game (simulated money, real prices). Each turn you see the bunny's " +
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
      name: "bunny_move",
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
