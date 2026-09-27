// The three LLM brains: ChatGPT (OpenAI), Claude (Anthropic) and Kimi (Moonshot AI). Each one authenticates with its
// own API key and answers in JSON that is checked against a schema before anything uses it. They never place orders:
// they pick and weigh backtested skills, write lessons into the hive mind and talk to each other (brains/council.ts,
// brains/coach.ts). Jev still makes every per-tick decision and the risk layer still has the last word.
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { safeError } from "../redact.js";

export const BRAINS = ["openai", "claude", "kimi"] as const;
export type BrainId = (typeof BRAINS)[number];

export const BRAIN_INFO: Record<BrainId, { label: string; vendor: string; keyEnv: string }> = {
  openai: { label: "ChatGPT", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  claude: { label: "Claude", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  kimi: { label: "Kimi", vendor: "Moonshot AI", keyEnv: "KIMI_API_KEY" },
};

export interface BrainCreds {
  openai?: { apiKey: string; model: string };
  claude?: { apiKey: string; model: string; effort: "low" | "medium" | "high" };
  kimi?: { apiKey: string; model: string; baseUrl: string };
}

export interface JsonAsk<T> {
  system: string;
  user: string;
  /** Strict JSON schema of the answer (additionalProperties: false everywhere). */
  schema: Record<string, unknown>;
  /** Short name for the schema (OpenAI requires one). */
  name: string;
  /** Final check; the schema alone is not trusted. */
  validate: z.ZodType<T>;
  maxTokens?: number;
}

export interface JsonAnswer<T> {
  data: T;
  brain: BrainId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export class BrainError extends Error {
  constructor(
    readonly brain: BrainId,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export interface LlmClient {
  readonly brain: BrainId;
  readonly model: string;
  json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>>;
}

function parseAndCheck<T>(brain: BrainId, raw: string | undefined, v: z.ZodType<T>): T {
  if (!raw) throw new BrainError(brain, 502, "empty answer");
  let j: unknown;
  try {
    // Some models wrap JSON in a fenced block even in JSON mode.
    j = JSON.parse(raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    throw new BrainError(brain, 502, "answer is not JSON");
  }
  const r = v.safeParse(j);
  if (!r.success) throw new BrainError(brain, 502, `answer failed validation: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ").slice(0, 300)}`);
  return r.data;
}

async function httpFail(brain: BrainId, res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string } | string };
    const m = typeof j.error === "string" ? j.error : j.error?.message;
    if (m) msg = m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  throw new BrainError(brain, res.status, msg);
}

type ChatBody = { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };

/** ChatGPT: OpenAI chat completions with a strict JSON schema. */
export class OpenAiBrain implements LlmClient {
  readonly brain = "openai" as const;
  constructor(
    private apiKey: string,
    readonly model: string,
    private timeoutMs = 90_000,
    private base = "https://api.openai.com/v1",
  ) {}

  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    const t0 = Date.now();
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: ask.system },
          { role: "user", content: ask.user },
        ],
        response_format: { type: "json_schema", json_schema: { name: ask.name, strict: true, schema: ask.schema } },
      }),
    });
    if (!res.ok) await httpFail(this.brain, res);
    const j = (await res.json()) as ChatBody;
    return {
      data: parseAndCheck(this.brain, j.choices?.[0]?.message?.content, ask.validate),
      brain: this.brain,
      model: j.model ?? this.model,
      inputTokens: j.usage?.prompt_tokens ?? 0,
      outputTokens: j.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    };
  }
}

/**
 * Kimi: Moonshot's OpenAI-compatible chat API. Its JSON mode guarantees JSON, not a schema, so the schema goes in the
 * system prompt and the answer is validated (one retry on a bad answer).
 */
export class KimiBrain implements LlmClient {
  readonly brain = "kimi" as const;
  constructor(
    private apiKey: string,
    readonly model: string,
    private base = "https://api.moonshot.ai/v1",
    private timeoutMs = 120_000,
  ) {}

  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    const t0 = Date.now();
    const system = `${ask.system}\n\nAnswer with ONE JSON object that matches this JSON schema exactly, and nothing else:\n${JSON.stringify(ask.schema)}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: ask.user },
          ],
          response_format: { type: "json_object" },
          max_tokens: ask.maxTokens ?? 4000,
        }),
      });
      if (!res.ok) await httpFail(this.brain, res);
      const j = (await res.json()) as ChatBody;
      try {
        return {
          data: parseAndCheck(this.brain, j.choices?.[0]?.message?.content, ask.validate),
          brain: this.brain,
          model: j.model ?? this.model,
          inputTokens: j.usage?.prompt_tokens ?? 0,
          outputTokens: j.usage?.completion_tokens ?? 0,
          latencyMs: Date.now() - t0,
        };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
}

/**
 * Claude: the Anthropic SDK, structured output (output_config.format = json_schema), adaptive thinking, and
 * server-side fallbacks so a refused request is re-run on a fallback model instead of just stopping.
 */
export class ClaudeBrain implements LlmClient {
  readonly brain = "claude" as const;
  private client: Anthropic;
  constructor(
    apiKey: string,
    readonly model: string,
    private effort: "low" | "medium" | "high" = "medium",
    timeoutMs = 180_000,
  ) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  }

  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    const t0 = Date.now();
    let msg;
    try {
      msg = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: ask.maxTokens ?? 16000,
        system: ask.system,
        messages: [{ role: "user", content: ask.user }],
        thinking: { type: "adaptive" },
        output_config: { effort: this.effort, format: { type: "json_schema", schema: ask.schema } },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new BrainError(this.brain, err.status ?? 500, safeError(err).message);
      throw err;
    }
    if (msg.stop_reason === "refusal") throw new BrainError(this.brain, 451, "Claude declined this request");
    if (msg.stop_reason === "max_tokens") throw new BrainError(this.brain, 502, "answer was cut off (max_tokens)");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return {
      data: parseAndCheck(this.brain, text, ask.validate),
      brain: this.brain,
      model: msg.model,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      latencyMs: Date.now() - t0,
    };
  }
}

/** One client per brain that has a key. Brains without a key are simply absent (their bees fall back to rules). */
export function makeClients(c: BrainCreds): Partial<Record<BrainId, LlmClient>> {
  const out: Partial<Record<BrainId, LlmClient>> = {};
  if (c.openai) out.openai = new OpenAiBrain(c.openai.apiKey, c.openai.model);
  if (c.claude) out.claude = new ClaudeBrain(c.claude.apiKey, c.claude.model, c.claude.effort);
  if (c.kimi) out.kimi = new KimiBrain(c.kimi.apiKey, c.kimi.model, c.kimi.baseUrl);
  return out;
}

// ---------- key checks (Setup page and `pnpm lab keys`) ----------

/** Lists one model: proves an Anthropic key works without spending tokens. Returns an error message or null. */
export async function checkClaudeKey(apiKey: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    await new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 }).models.list({ limit: 1 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return "Anthropic rejected that key. Copy it again from console.anthropic.com.";
    const e = safeError(err);
    return `Could not reach Anthropic (${e.code}: ${e.message})`;
  }
}

/** Lists models on Moonshot's API: proves a Kimi key works. Returns an error message or null. */
export async function checkKimiKey(apiKey: string, baseUrl = "https://api.moonshot.ai/v1", timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return "Moonshot rejected that key. Copy it again from platform.moonshot.ai.";
    if (!res.ok) return `Moonshot answered HTTP ${res.status}`;
    return null;
  } catch (err) {
    const e = safeError(err);
    return `Could not reach Moonshot (${e.code}: ${e.message})`;
  }
}
