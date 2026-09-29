import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { brainCreds } from "../src/config.js";
import { BRAINS, BRAIN_INFO, brainInfo, checkBaseUrl, checkCompatKey, CompatBrain, makeClients, ZaiBrain, ZAI_BASE_URL } from "../src/brains/llm.js";
import { CustomBrainSchema, SettingsSchema } from "../src/settings.js";

const ask = { system: "sys", user: "usr", name: "answer", schema: { type: "object" }, validate: z.object({ ok: z.boolean() }) };
const reply = (content: string, status = 200) => new Response(JSON.stringify(status === 200 ? { choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, model: "m-1" } : { error: { message: content } }), { status, headers: { "content-type": "application/json" } });
const spy = (...rs: Response[]) => {
  const f = vi.fn(async () => rs.shift() ?? reply("{}", 500));
  vi.stubGlobal("fetch", f);
  return f;
};
const sent = (f: ReturnType<typeof spy>, i = 0) => {
  const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};
afterEach(() => vi.unstubAllGlobals());

describe("brains beyond the built-in three", () => {
  it("ships Z.ai's GLM as a built-in with its own label and key variable", () => {
    expect(BRAINS).toContain("zai");
    expect(BRAIN_INFO.zai).toMatchObject({ label: "GLM", vendor: "Z.ai", keyEnv: "ZAI_API_KEY" });
    expect(brainInfo("gone_brain")).toMatchObject({ label: "gone_brain" });
  });

  it("talks to Z.ai over its OpenAI-compatible API, asking for JSON and validating the answer", async () => {
    const f = spy(reply('{"ok":true}'));
    const out = await new ZaiBrain("zk-12345678", "glm-4.6").json(ask);
    expect(out).toMatchObject({ data: { ok: true }, brain: "zai", model: "m-1", inputTokens: 3, outputTokens: 2 });
    const r = sent(f);
    expect(r.url).toBe(`${ZAI_BASE_URL}/chat/completions`);
    expect(r.headers.authorization).toBe("Bearer zk-12345678");
    expect(r.body).toMatchObject({ model: "glm-4.6", response_format: { type: "json_object" } });
    expect(String((r.body.messages as Array<{ content: string }>)[0]!.content)).toContain("matches this JSON schema");
  });

  it("retries once on an answer that is not the schema, then gives up", async () => {
    const f = spy(reply("not json"), reply('{"ok":false}'));
    expect((await new ZaiBrain("k12345678").json(ask)).data.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(2);
    spy(reply("nope"), reply("nope again"));
    await expect(new ZaiBrain("k12345678").json(ask)).rejects.toThrow(/not JSON/);
  });

  it("supports the three JSON modes and a server without a key", async () => {
    let f = spy(reply('{"ok":true}'));
    await new CompatBrain("local", undefined, "llama3", "http://localhost:11434/v1/", "prompt").json(ask);
    let r = sent(f);
    expect(r.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(r.headers.authorization).toBeUndefined();
    expect(r.body.response_format).toBeUndefined();
    f = spy(reply('{"ok":true}'));
    await new CompatBrain("or", "k", "m", "https://openrouter.ai/api/v1", "schema").json(ask);
    r = sent(f);
    expect(r.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "answer", strict: true } });
    expect(String((r.body.messages as Array<{ content: string }>)[0]!.content)).toBe("sys");
  });

  it("surfaces an API error with the server's own message", async () => {
    spy(reply("model not found", 404));
    await expect(new CompatBrain("x", "k", "m", "https://h.example/v1").json(ask)).rejects.toMatchObject({ status: 404, message: "model not found" });
  });

  it("builds a client for Z.ai and for every custom brain, and never lets a custom brain shadow a built-in", () => {
    const c = makeClients({
      zai: { apiKey: "zk-12345678", model: "glm-4.6", baseUrl: ZAI_BASE_URL },
      openai: { apiKey: "sk-12345678", model: "gpt" },
      custom: [
        { id: "deepseek", label: "DeepSeek", vendor: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "dk-12345678", jsonMode: "object" },
        { id: "openai", label: "Impostor", vendor: "x", baseUrl: "https://evil.example/v1", model: "m", apiKey: "k12345678", jsonMode: "object" },
      ],
    });
    expect(Object.keys(c).sort()).toEqual(["deepseek", "openai", "zai"]);
    expect(c.openai!.model).toBe("gpt");
    expect(brainInfo("deepseek")).toMatchObject({ label: "DeepSeek", vendor: "DeepSeek" });
  });

  it("reads Z.ai's key from the environment or the Setup file, and hands custom brains through", () => {
    const e = { OPENAI_BRAIN_MODEL: "m", CLAUDE_MODEL: "c", CLAUDE_EFFORT: "medium" as const, KIMI_MODEL: "k", KIMI_BASE_URL: "https://k.example/v1" };
    expect(brainCreds({ ...e, ZAI_API_KEY: "zk-12345678" }, null).zai).toEqual({ apiKey: "zk-12345678", model: "glm-4.6", baseUrl: ZAI_BASE_URL });
    const settings = SettingsSchema.parse({
      version: 1, jevKey: "jev-key-12345678", zaiKey: "zs-12345678", acceptedRiskAt: 1, createdAt: 1,
      bees: [1, 2, 3].map((i) => ({ name: `Bee${i}`, style: "bizzy", coins: [] })),
      customBrains: [{ id: "my_llm", label: "My LLM", baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b" }],
    });
    const c = brainCreds({ ...e, ZAI_MODEL: "glm-4.5-air" }, settings);
    expect(c.zai).toMatchObject({ apiKey: "zs-12345678", model: "glm-4.5-air" });
    expect(c.custom).toHaveLength(1);
    expect(c.custom![0]).toMatchObject({ id: "my_llm", jsonMode: "object", vendor: "Custom" });
  });
});

describe("custom brain rules", () => {
  it("only sends a key to https, or to this machine", () => {
    expect(checkBaseUrl("https://api.example.com/v1")).toBeNull();
    expect(checkBaseUrl("http://localhost:11434/v1")).toBeNull();
    expect(checkBaseUrl("http://host.docker.internal:1234/v1")).toBeNull();
    expect(checkBaseUrl("http://api.example.com/v1")).toMatch(/https/);
    expect(checkBaseUrl("https://user:pw@api.example.com/v1")).toMatch(/key field/);
    expect(checkBaseUrl("ftp://x")).toMatch(/https/);
    expect(checkBaseUrl("not a url")).toMatch(/not a URL/);
  });

  it("refuses ids that would collide with a built-in or a word a bee's brain field uses", () => {
    const ok = { label: "X", baseUrl: "https://x.example/v1", model: "m" };
    for (const id of ["openai", "claude", "kimi", "zai", "rules", "ensemble", "jev", "hive"]) expect(CustomBrainSchema.safeParse({ ...ok, id }).success).toBe(false);
    expect(CustomBrainSchema.safeParse({ ...ok, id: "Bad Id" }).success).toBe(false);
    expect(CustomBrainSchema.safeParse({ ...ok, id: "good_id" }).success).toBe(true);
    expect(CustomBrainSchema.safeParse({ ...ok, id: "good_id", baseUrl: "http://evil.example/v1" }).success).toBe(false);
    expect(CustomBrainSchema.safeParse({ ...ok, id: "good_id", model: "a b; rm" }).success).toBe(false);
  });

  it("tests a connection with one tiny call and explains the usual failures", async () => {
    let f = spy(reply("ok"));
    expect(await checkCompatKey("https://api.z.ai/api/paas/v4", "k", "glm-4.6", "Z.ai")).toBeNull();
    expect(sent(f).body).toMatchObject({ model: "glm-4.6", max_tokens: 8 });
    f = spy(reply("bad key", 401));
    expect(await checkCompatKey("https://api.z.ai/api/paas/v4", "k", "glm-4.6", "Z.ai")).toBe("Z.ai rejected that key.");
    spy(reply("nope", 404));
    expect(await checkCompatKey("https://api.z.ai/api/paas/v4", "k", "glm-x", "Z.ai")).toMatch(/does not know that address or model \("glm-x"\)/);
    spy(reply("overloaded", 503));
    expect(await checkCompatKey("https://h.example/v1", "k", "m", "H")).toMatch(/HTTP 503: overloaded/);
    expect(await checkCompatKey("http://public.example/v1", "k", "m")).toMatch(/https/);
    expect(f).toHaveBeenCalled();
  });
});
