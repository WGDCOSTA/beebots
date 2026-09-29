// The three LLM brains: ChatGPT (OpenAI), Claude (Anthropic) and Kimi (Moonshot AI). Each one authenticates with its
// own API key (Claude may use an Anthropic Console sign-in instead) and answers in JSON that is checked against a
// schema before anything uses it. They never place orders: they pick and weigh backtested skills, write lessons into
// the hive mind and talk to each other (brains/council.ts, brains/coach.ts). Jev still makes every per-tick decision
// and the risk layer still has the last word.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { safeError } from "../redact.js";

/** The brains that ship with beebots. The owner can add any number more (Admin → API keys → Custom brains). */
export const BRAINS = ["openai", "claude", "kimi", "zai"] as const;
export type BuiltinBrain = (typeof BRAINS)[number];
/** A built-in brain's id, or the id of a custom brain the owner added. */
export type BrainId = string;

/** Ids the owner cannot give a custom brain: the built-ins, and the words a bee's brain field already uses. */
export const RESERVED_BRAIN_IDS: readonly string[] = [...BRAINS, "rules", "ensemble", "jev", "hive"];
export const BRAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;

export interface BrainInfo {
  label: string;
  vendor: string;
  keyEnv: string;
}

/** Labels for every brain that exists here. Custom brains are added by registerBrain when the app starts or the owner saves one. */
export const BRAIN_INFO: Record<BrainId, BrainInfo> = {
  openai: { label: "ChatGPT", vendor: "OpenAI", keyEnv: "OPENAI_API_KEY" },
  claude: { label: "Claude", vendor: "Anthropic", keyEnv: "ANTHROPIC_API_KEY" },
  kimi: { label: "Kimi", vendor: "Moonshot AI", keyEnv: "KIMI_API_KEY" },
  zai: { label: "GLM", vendor: "Z.ai", keyEnv: "ZAI_API_KEY" },
};

export function registerBrain(id: string, info: Pick<BrainInfo, "label" | "vendor">): void {
  if ((BRAINS as readonly string[]).includes(id)) return;
  BRAIN_INFO[id] = { label: info.label, vendor: info.vendor, keyEnv: "(saved in the admin panel)" };
}

/** A brain's labels; a brain that was removed since (its bees fall back to rules) is shown by its id. */
export function brainInfo(id: string): BrainInfo {
  return BRAIN_INFO[id] ?? { label: id, vendor: "Custom", keyEnv: "(saved in the admin panel)" };
}
export const brainLabel = (id: string): string => brainInfo(id).label;

/** Z.ai's OpenAI-compatible API (international). China: https://open.bigmodel.cn/api/paas/v4 */
export const ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";
export const ZAI_DEFAULT_MODEL = "glm-4.6";

/**
 * How a compatible server is asked for JSON: "schema" = OpenAI's strict json_schema, "object" = JSON mode with the
 * schema in the prompt (the widest support), "prompt" = no response_format at all (servers that reject both).
 */
export type JsonMode = "schema" | "object" | "prompt";

export interface CustomBrain {
  id: string;
  label: string;
  vendor: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  jsonMode: JsonMode;
}

/**
 * A base URL a key may be sent to: https anywhere, or plain http only to this machine (a local model server such as
 * Ollama or LM Studio). Returns an error message, or null.
 */
export function checkBaseUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "That is not a URL.";
  }
  if (u.username || u.password) return "Put the key in the key field, not in the URL.";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "host.docker.internal"].includes(u.hostname)) return null;
  return "Use https://… (plain http is only allowed for localhost or host.docker.internal).";
}

export interface BrainCreds {
  openai?: { apiKey: string; model: string };
  /**
   * An API key, or a sign-in with an Anthropic Console account: `profile` names an `ant auth login` profile (OAuth,
   * refreshed by the SDK) in ANTHROPIC_CONFIG_DIR. Never a claude.ai (Pro/Max) login: those are not for third-party apps.
   */
  claude?: { apiKey?: string; profile?: string; model: string; effort: "low" | "medium" | "high" };
  kimi?: { apiKey: string; model: string; baseUrl: string };
  zai?: { apiKey: string; model: string; baseUrl: string };
  /** Brains the owner added: any OpenAI-compatible chat API. */
  custom?: CustomBrain[];
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
  /** How hard to think for this call (Claude): routine upkeep low, rescue councils high. Default: the brain's setting. */
  effort?: "low" | "medium" | "high";
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
  readonly brain: BrainId = "openai";
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
 * Any OpenAI-compatible chat API (Kimi, Z.ai GLM, OpenRouter, Together, a local Ollama, ...). JSON mode guarantees JSON,
 * not a schema, so by default the schema goes in the system prompt and the answer is validated (one retry on a bad
 * answer). `jsonMode` "schema" uses OpenAI's strict json_schema instead; "prompt" sends no response_format at all.
 */
export class CompatBrain implements LlmClient {
  constructor(
    readonly brain: BrainId,
    private apiKey: string | undefined,
    readonly model: string,
    private base: string,
    private jsonMode: JsonMode = "object",
    private timeoutMs = 120_000,
  ) {}

  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    const t0 = Date.now();
    const system = this.jsonMode === "schema" ? ask.system : `${ask.system}\n\nAnswer with ONE JSON object that matches this JSON schema exactly, and nothing else:\n${JSON.stringify(ask.schema)}`;
    const format =
      this.jsonMode === "schema" ? { response_format: { type: "json_schema", json_schema: { name: ask.name, strict: true, schema: ask.schema } } } : this.jsonMode === "object" ? { response_format: { type: "json_object" } } : {};
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${this.base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: ask.user },
          ],
          ...format,
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

/** Kimi: Moonshot AI's compatible API. */
export class KimiBrain extends CompatBrain {
  constructor(apiKey: string, model: string, base = "https://api.moonshot.ai/v1", timeoutMs = 120_000) {
    super("kimi", apiKey, model, base, "object", timeoutMs);
  }
}

/** GLM: Z.ai's compatible API (the GLM models). */
export class ZaiBrain extends CompatBrain {
  constructor(apiKey: string, model = ZAI_DEFAULT_MODEL, base = ZAI_BASE_URL, timeoutMs = 180_000) {
    super("zai", apiKey, model, base, "object", timeoutMs);
  }
}

/**
 * Claude: the Anthropic SDK, structured output (output_config.format = json_schema), adaptive thinking, and
 * server-side fallbacks so a refused request is re-run on a fallback model instead of just stopping.
 */
export class ClaudeBrain implements LlmClient {
  readonly brain: BrainId = "claude";
  private client: Anthropic;
  constructor(
    auth: { apiKey?: string; profile?: string },
    readonly model: string,
    private effort: "low" | "medium" | "high" = "medium",
    timeoutMs = 180_000,
  ) {
    this.client = anthropicClient(auth, timeoutMs, 2);
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
        output_config: { effort: ask.effort ?? this.effort, format: { type: "json_schema", schema: ask.schema } },
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
  if (c.claude) out.claude = new ClaudeBrain(c.claude, c.claude.model, c.claude.effort);
  if (c.kimi) out.kimi = new KimiBrain(c.kimi.apiKey, c.kimi.model, c.kimi.baseUrl);
  if (c.zai) out.zai = new ZaiBrain(c.zai.apiKey, c.zai.model, c.zai.baseUrl);
  for (const b of c.custom ?? []) {
    registerBrain(b.id, b);
    if (!(RESERVED_BRAIN_IDS as readonly string[]).includes(b.id)) out[b.id] = new CompatBrain(b.id, b.apiKey, b.model, b.baseUrl, b.jsonMode);
  }
  return out;
}

// ---------- key checks (Setup page and `pnpm lab keys`) ----------

/**
 * An Anthropic client from a key or a login profile. With a profile, a stray ANTHROPIC_API_KEY in the environment
 * (compose passes "" for unset variables) must not shadow it, so the key is pinned to null.
 */
function anthropicClient(auth: { apiKey?: string; profile?: string }, timeout: number, maxRetries: number): Anthropic {
  return auth.apiKey ? new Anthropic({ apiKey: auth.apiKey, timeout, maxRetries }) : new Anthropic({ profile: auth.profile ?? ANTHROPIC_PROFILE, apiKey: null, authToken: null, timeout, maxRetries });
}

/** The `ant auth login` profile beebots signs in with (`ant --profile beebots auth login --no-browser`). */
export const ANTHROPIC_PROFILE = "beebots";

/** Where the Anthropic CLI and SDK keep profiles: ANTHROPIC_CONFIG_DIR, else the platform default. */
export function anthropicConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.ANTHROPIC_CONFIG_DIR?.trim();
  if (dir) return dir;
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "Anthropic");
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "anthropic");
}

/**
 * The command that signs Claude in: inside the Docker install it runs in the engine container (no browser there, so
 * `--no-browser` prints a link and takes the code back); on a machine with a browser, plain `ant auth login`.
 */
export function anthropicLoginCommand(profile = ANTHROPIC_PROFILE): string {
  return existsSync("/.dockerenv") ? `docker compose exec engine ant --profile ${profile} auth login --no-browser` : `ant --profile ${profile} auth login`;
}

/** True when `ant auth login` has written this profile (its config and credentials files exist). */
export function hasAnthropicLogin(profile = ANTHROPIC_PROFILE, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = anthropicConfigDir(env);
  return existsSync(join(dir, "configs", `${profile}.json`)) && existsSync(join(dir, "credentials", `${profile}.json`));
}

/** Lists one model: proves an Anthropic key (or login) works without spending tokens. Returns an error message or null. */
export async function checkClaudeKey(auth: string | { apiKey?: string; profile?: string }, timeoutMs = 10_000): Promise<string | null> {
  const a = typeof auth === "string" ? { apiKey: auth } : auth;
  if (!a.apiKey && !hasAnthropicLogin(a.profile)) return `No Anthropic login yet. Run: ant --profile ${a.profile ?? ANTHROPIC_PROFILE} auth login --no-browser`;
  try {
    await anthropicClient(a, timeoutMs, 0).models.list({ limit: 1 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return a.apiKey ? "Anthropic rejected that key. Copy it again from console.anthropic.com." : "Anthropic rejected the login. Sign in again with ant auth login.";
    }
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

/**
 * One tiny chat call to an OpenAI-compatible API: proves the address, the key and the model name work together
 * (Z.ai and most custom servers have no cheap "list models" call to lean on). Returns an error message or null.
 */
export async function checkCompatKey(baseUrl: string, apiKey: string | undefined, model: string, vendor = "The server", timeoutMs = 20_000): Promise<string | null> {
  const bad = checkBaseUrl(baseUrl);
  if (bad) return bad;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 8 }),
    });
    if (res.status === 401 || res.status === 403) return `${vendor} rejected that key.`;
    if (res.status === 404) return `${vendor} does not know that address or model ("${model}"). Check the base URL and the model name.`;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { message?: string } | string };
        const m = typeof j.error === "string" ? j.error : j.error?.message;
        if (m) msg += `: ${m.slice(0, 200)}`;
      } catch {
        /* not JSON */
      }
      return `${vendor} answered ${msg}`;
    }
    return null;
  } catch (err) {
    const e = safeError(err);
    return `Could not reach ${vendor} (${e.code}: ${e.message})`;
  }
}
