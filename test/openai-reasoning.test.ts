import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { brainModelIds, OpenAiBrain, type JsonAsk } from "../src/brains/llm.js";
import { brainCreds, loadConfig } from "../src/config.js";

const ask = (effort?: JsonAsk<unknown>["effort"]): JsonAsk<{ ok: boolean }> => ({
  system: "s",
  user: "u",
  name: "t",
  schema: { type: "object" },
  validate: z.object({ ok: z.boolean() }),
  maxTokens: 1000,
  ...(effort ? { effort } : {}),
});
const answer = (body: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ status: "completed", model: "gpt-6-astra", output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }], usage: { input_tokens: 1, output_tokens: 2 }, ...body }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

function capture(...replies: Response[]) {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return replies.shift() ?? answer();
    }),
  );
  return bodies;
}

describe("GPT reasoning models (gpt-6-astra)", () => {
  it("sends reasoning.effort and leaves room to think before answering", async () => {
    const bodies = capture(answer());
    const r = await new OpenAiBrain("k", "gpt-6-astra", undefined, undefined, "max").json(ask("low"));
    expect(r.data).toEqual({ ok: true });
    expect(bodies[0]).toMatchObject({ model: "gpt-6-astra", reasoning: { effort: "max" }, max_output_tokens: 65_000 });
  });

  it("auto follows each call's own effort, and medium when it names none", async () => {
    const bodies = capture(answer(), answer());
    const b = new OpenAiBrain("k", "gpt-6-astra");
    await b.json(ask("high"));
    await b.json(ask());
    expect(bodies.map((x) => (x.reasoning as { effort: string }).effort)).toEqual(["high", "medium"]);
    expect(bodies[0]!.max_output_tokens).toBe(17_000);
  });

  it("never sends it when off", async () => {
    const bodies = capture(answer());
    await new OpenAiBrain("k", "gpt-6-astra", undefined, undefined, "off").json(ask("high"));
    expect(bodies[0]).not.toHaveProperty("reasoning");
    expect(bodies[0]!.max_output_tokens).toBe(1000);
  });

  it("asks again without reasoning when a model does not support it, and remembers", async () => {
    const bodies = capture(new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort' is not supported with this model." } }), { status: 400 }), answer(), answer());
    const b = new OpenAiBrain("k", "gpt-old-chat");
    await b.json(ask("high"));
    await b.json(ask("high"));
    expect(bodies.map((x) => "reasoning" in x)).toEqual([true, false, false]);
  });

  it("says plainly when the answer was cut off by thinking", async () => {
    capture(answer({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning" }] }));
    await expect(new OpenAiBrain("k", "gpt-6-astra", undefined, undefined, "low").json(ask())).rejects.toThrow(/cut off \(max_output_tokens\)/);
  });

  it("is listed as a brain model, is the default ChatGPT model, and takes its effort from the settings", () => {
    expect(brainModelIds("openai", ["gpt-6-astra", "gpt-6.1-sol", "gpt-image-2"])).toEqual(["gpt-6.1-sol", "gpt-6-astra"]);
    const cfg = loadConfig({ OPENAI_API_KEY: "k", TYPESAFE_API_KEY: "t" }, null);
    expect(cfg.brains.creds.openai).toMatchObject({ model: "gpt-6-astra", effort: "auto" });
    const base = { OPENAI_API_KEY: "k", OPENAI_BRAIN_MODEL: "gpt-6-astra", OPENAI_REASONING_EFFORT: "xhigh" as const, CLAUDE_MODEL: "c", CLAUDE_EFFORT: "medium" as const, KIMI_MODEL: "k", KIMI_BASE_URL: "https://k.example/v1" };
    expect(brainCreds(base, null).openai).toEqual({ apiKey: "k", model: "gpt-6-astra", effort: "xhigh" });
  });
});
