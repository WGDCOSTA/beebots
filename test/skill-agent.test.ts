import { describe, expect, it } from "vitest";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { AgentError, SkillAgent } from "../src/lab/skillAgent.js";

const GOOD = JSON.stringify({ id: "my_dip", name: "My dip", family: "mean_reversion", long: { entry: [{ left: "rsi(14)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } });
const BAD = JSON.stringify({ id: "my_dip", name: "My dip", family: "mean_reversion", long: { entry: [{ left: "magic(1)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } });

class Fake implements LlmClient {
  asked: JsonAsk<unknown>[] = [];
  constructor(
    readonly brain: string,
    private replies: Array<{ skill: string; explanation?: string } | Error>,
    readonly model = "m-1",
  ) {}
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    const r = this.replies.shift() ?? { skill: GOOD };
    if (r instanceof Error) throw r;
    return { data: ask.validate.parse({ explanation: "An idea. It assumes reversion. Main risk: trends. No data seen.", ...r }), brain: this.brain, model: this.model, inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}

const agent = (clients: Record<string, LlmClient>, max = 20) => new SkillAgent({ clients: () => clients, maxCallsPerDay: max, now: () => Date.UTC(2026, 8, 29) });

describe("skill agent", () => {
  it("offers the brains that can answer, the ones that follow the rule language best first, custom ones after", () => {
    const a = agent({ mine: new Fake("mine", []), kimi: new Fake("kimi", []), claude: new Fake("claude", []), zai: new Fake("zai", []) });
    expect(a.available().map((b) => b.id)).toEqual(["claude", "zai", "kimi", "mine"]);
    expect(agent({}).available()).toEqual([]);
  });

  it("drafts a valid skill from a description, and says what it was given", async () => {
    const brain = new Fake("claude", [{ skill: GOOD }]);
    const r = await agent({ claude: brain }).draft({ prompt: "Buy oversold dips with RSI, sell the bounce" });
    expect(r).toMatchObject({ brain: "claude", valid: true, errors: [], attempts: 1, model: "m-1" });
    expect(JSON.parse(r.json).id).toBe("my_dip");
    const ask = brain.asked[0]!;
    expect(JSON.parse(ask.user)).toEqual({ request: "Buy oversold dips with RSI, sell the bounce" });
    expect(ask.system).toMatch(/rule language/);
    expect(ask.system).toMatch(/built-in ids: .*buy_hold/);
    expect(ask.system).toMatch(/cannot know how this performs/);
  });

  it("sends a draft that does not compile back once with the compiler's complaints, and returns the fixed one", async () => {
    const brain = new Fake("openai", [{ skill: BAD }, { skill: `\`\`\`json\n${GOOD}\n\`\`\`` }]);
    const r = await agent({ openai: brain }).draft({ prompt: "Buy oversold dips with RSI", brain: "openai" });
    expect(r).toMatchObject({ valid: true, attempts: 2 });
    const second = JSON.parse(brain.asked[1]!.user);
    expect(second.compilerErrors.join(" ")).toMatch(/unknown indicator/);
    expect(second.yourLastAttempt).toBe(BAD);
  });

  it("gives back a draft that still does not compile after the retry, marked invalid", async () => {
    const r = await agent({ claude: new Fake("claude", [{ skill: BAD }, { skill: BAD }]) }).draft({ prompt: "Buy oversold dips with RSI" });
    expect(r).toMatchObject({ valid: false, attempts: 2 });
    expect(r.errors.join(" ")).toMatch(/unknown indicator/);
  });

  it("revises a skill it is given, and a colliding id is reported, not accepted", async () => {
    const brain = new Fake("claude", [{ skill: JSON.stringify({ ...JSON.parse(GOOD), id: "buy_hold" }) }, { skill: GOOD }]);
    const r = await agent({ claude: brain }).draft({ prompt: "Make the entry stricter", current: GOOD });
    expect(JSON.parse(brain.asked[0]!.user).currentSkill).toBe(GOOD);
    expect(brain.asked[0]!.system).toMatch(/keep the same id/);
    expect(JSON.parse(brain.asked[1]!.user).compilerErrors.join(" ")).toMatch(/built-in/);
    expect(r.valid).toBe(true);
  });

  it("explains itself when it cannot help", async () => {
    await expect(agent({}).draft({ prompt: "Buy oversold dips with RSI" })).rejects.toThrow(/No brain can answer/);
    await expect(agent({ claude: new Fake("claude", []) }).draft({ prompt: "short" })).rejects.toThrow(/sentence or two/);
    await expect(agent({ claude: new Fake("claude", []) }).draft({ prompt: "Buy oversold dips", brain: "zai" })).rejects.toThrow(/zai|GLM/);
    await expect(agent({ claude: new Fake("claude", [new Error("HTTP 500")]) }).draft({ prompt: "Buy oversold dips with RSI" })).rejects.toThrow(AgentError);
  });

  it("stops at the daily cap, and keeps the last draft if the cap hits during the retry", async () => {
    const a = agent({ claude: new Fake("claude", [{ skill: BAD }]) }, 1);
    const r = await a.draft({ prompt: "Buy oversold dips with RSI" });
    expect(r.valid).toBe(false);
    await expect(a.draft({ prompt: "Buy oversold dips with RSI" })).rejects.toThrow(/daily brain-call cap/);
  });
});
