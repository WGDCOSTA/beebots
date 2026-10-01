import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../src/lab/skills/index.js";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Bots, LIMITS } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { SkillBank, SkillError, libraryOf, MAX_SPEC_BYTES } from "../src/arena/skills.js";
import { ArenaStore } from "../src/arena/store.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { Candle } from "../src/market/types.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const own = (id = "dip_buyer", extra: Record<string, unknown> = {}) => ({ id, name: "Dip buyer " + id, family: "mean_reversion", description: "Buy when RSI(2) is washed out.", params: { lo: { default: 20 } }, long: { entry: [{ left: "rsi(2)", op: "<", right: "$lo" }], exit: [{ left: "rsi(2)", op: ">", right: 70 }] }, ...extra });
/** A skill that wants a long whenever the close is above its 5-bar average: true all along in a steady climb. */
const climber = { id: "climber", name: "Climber", family: "trend", description: "Long above the 5 average.", params: {}, long: { entry: [{ left: "close", op: ">", right: "sma(5)" }], exit: [{ left: "close", op: "<", right: "sma(5)" }] } };

const agent = (name: string, extra: Record<string, unknown> = {}) => ({ name, theme: "bunnies", avatar: "scout", coins: ["BTC"], rules: "Trade by my skill, nothing else.", mode: "skill", ...extra });

function member(tier: "free" | "pro" | "premium" = "free") {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-skills-")));
  const u = store.createUser("a".repeat(32), "ana@example.com", 1);
  store.setTier(u.id, tier);
  let t = 1000;
  const clock = () => (t += 1000);
  return { store, u, bank: (tr = tier) => new SkillBank(store.tenant(u.id), tr, BUILTIN_SKILLS, clock), bots: (tr = tier) => new Bots(store.tenant(u.id), tr, clock) };
}
const fails = (fn: () => unknown, status?: number) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SkillError);
    if (status) expect((e as SkillError).status).toBe(status);
    return (e as Error).message;
  }
  throw new Error("did not fail");
};

describe("the library", () => {
  it("lists what a person needs to choose, never code", () => {
    const lib = libraryOf(BUILTIN_SKILLS);
    expect(lib.length).toBeGreaterThan(5);
    expect(Object.keys(lib[0]!).sort()).toEqual(["description", "family", "id", "name"]);
  });
});

describe("slots", () => {
  it("are 5 on Free and 30 on Pro and Premium", () => {
    expect([LIMITS.free.skillSlots, LIMITS.pro.skillSlots, LIMITS.premium.skillSlots]).toEqual([5, 30, 30]);
  });
  it("keep a skill from the library once, and stop at the limit", () => {
    const m = member("free");
    const ids = BUILTIN_SKILLS.slice(0, 6).map((s) => s.id);
    for (const id of ids.slice(0, 5)) m.bank().addFromLibrary(id);
    expect(fails(() => m.bank().addFromLibrary(ids[5]), 403)).toMatch(/5 skill slots/);
    expect(fails(() => m.bank().addFromLibrary(ids[0]), 409)).toMatch(/already/);
    expect(fails(() => m.bank().addFromLibrary("not_a_skill"), 404)).toMatch(/not in the library/);
    expect(fails(() => m.bank().addOwn(own()), 403)).toMatch(/slots/);
  });
  it("free a slot when a skill is removed", () => {
    const m = member("free");
    for (let i = 0; i < 5; i++) m.bank().addOwn(own(`s${i}`));
    const first = m.bank().list()[0]!;
    m.bank().remove(first.id);
    expect(m.bank().list()).toHaveLength(4);
    m.bank().addOwn(own("again"));
    expect(() => m.bank().remove("nope")).toThrow(/not found/);
  });
});

describe("the member's own skills", () => {
  it("are validated by the lab's rule language, from text or an object", () => {
    const m = member("pro");
    expect(m.bank().addOwn(JSON.stringify(own("from_text")))).toMatchObject({ kind: "own", name: "Dip buyer from_text", locked: false });
    expect(m.bank().addOwn(own("from_object"))).toMatchObject({ kind: "own" });
    for (const bad of ["not json", "[]", "42", { ...own("x1"), long: { entry: [{ left: "nonsense(3)", op: "<", right: 1 }], exit: [{ left: "close", op: ">", right: 1 }] } }, { ...own("x2"), id: "Has Spaces" }, { ...own("x3"), extra: 1 }, { id: "x4" }]) {
      expect(() => m.bank().addOwn(bad)).toThrow(SkillError);
    }
  });
  it("are data, never code: a function-looking operand is refused", () => {
    const m = member("pro");
    for (const evil of ["constructor.constructor('return process')()", "process.exit(1)", "(() => 1)()", "require('fs')"]) {
      expect(() => m.bank().addOwn({ ...own("evil"), long: { entry: [{ left: evil, op: "<", right: 1 }], exit: [{ left: "close", op: ">", right: 1 }] } })).toThrow(SkillError);
    }
  });
  it("refuse a huge document and a repeated name", () => {
    const m = member("pro");
    expect(fails(() => m.bank().addOwn("x".repeat(MAX_SPEC_BYTES + 1)))).toMatch(/too long/);
    m.bank().addOwn(own("one"));
    expect(fails(() => m.bank().addOwn({ ...own("two"), name: "dip buyer one" }), 409)).toMatch(/already/);
  });
  it("compile for the runner, with the row's id", () => {
    const m = member("pro");
    const s = m.bank().addOwn(climber);
    const c = m.bank().resolve(s.id)!;
    expect(c.id).toBe("climber");
    expect(typeof c.signal).toBe("function");
    const lib = m.bank().addFromLibrary("sma_cross");
    expect(m.bank().resolve(lib.id)!.id).toBe("sma_cross");
  });
});

describe("a downgrade", () => {
  it("keeps the oldest skills usable and locks the rest, and an upgrade unlocks them", () => {
    const m = member("pro");
    for (let i = 0; i < 7; i++) m.bank("pro").addOwn(own(`s${i}`));
    const all = m.bank("pro").list();
    expect(all.every((s) => !s.locked)).toBe(true);
    const free = m.bank("free").list();
    expect(free.map((s) => s.locked)).toEqual([false, false, false, false, false, true, true]);
    expect(m.bank("free").resolve(all[6]!.id)).toBeNull();
    expect(m.bank("free").resolve(all[6]!.id, { allowLocked: true })).not.toBeNull();
    expect(m.bank("pro").list().every((s) => !s.locked)).toBe(true);
  });
  it("puts an agent that trades by a locked skill in quarantine, and restores it on an upgrade", () => {
    const m = member("pro");
    for (let i = 0; i < 6; i++) m.bank("pro").addOwn(own(`s${i}`));
    const last = m.bank("pro").list()[5]!;
    const a = m.bots("pro").create(agent("Skilled", { skill: last.id }));
    expect(a).toMatchObject({ mode: "skill", skill: last.id, style: "boozy" });
    const free = m.bots("free");
    expect(free.reconcile(9000).quarantined).toEqual([a.id]);
    expect(m.bots("pro").reconcile(9500).restored).toEqual([a.id]);
  });
});

describe("agents that trade by a skill", () => {
  it("need one of the member's usable skills, and any coins the plan allows", () => {
    const m = member("pro");
    expect(() => m.bots().create(agent("NoSkill"))).toThrow(/Pick one of your skills/);
    expect(() => m.bots().create(agent("Nope", { skill: "abcdef123456" }))).toThrow(/Pick one of your skills/);
    const s = m.bank().addOwn(own("ok"));
    // XRP is outside Trend's coins, but a skill agent is not bound to a style's coins
    expect(m.bots().create(agent("Fine", { skill: s.id, coins: ["XRP", "SOL"] }))).toMatchObject({ mode: "skill", coins: ["XRP", "SOL"] });
    expect(() => m.bots().create(agent("Nine", { skill: s.id, coins: [] }))).toThrow(/at least one coin/);
  });
  it("can change its skill (a new version) but never its mode", () => {
    const m = member("pro");
    const s1 = m.bank().addOwn(own("one"));
    const s2 = m.bank().addOwn(own("two"));
    const a = m.bots().create(agent("Skilled", { skill: s1.id }));
    expect(m.bots().update(a.id, agent("Skilled", { skill: s1.id }))).toMatchObject({ version: 1 });
    expect(m.bots().update(a.id, agent("Skilled"))).toMatchObject({ version: 1, skill: s1.id }); // not sent: kept
    expect(m.bots().update(a.id, agent("Skilled", { skill: s2.id }))).toMatchObject({ version: 2, skill: s2.id });
    expect(m.bots().update(a.id, { ...agent("Skilled", { skill: s2.id }), mode: "fixed", style: "breezy" })).toMatchObject({ mode: "skill" });
  });
});

class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path.split("?")[0]!);
  return { status, body: JSON.parse(text || "{}") as Json };
}

describe("HTTP: skills", () => {
  async function setup() {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-skills-http-")));
    const inbox = new Inbox();
    const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, store, { secureCookie: true, library: BUILTIN_SKILLS, now: () => NOW });
    await auth.requestLink("ana@example.com", "1.1.1.1");
    const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
    store.acceptConsent(v.user.id, 1);
    return { api, cookie: `arena_session=${v.session}` };
  }
  it("lists the slots, the member's skills and the library, and needs a session", async () => {
    const w = await setup();
    expect((await http(w.api, "GET", "/arena/skills")).status).toBe(401);
    const r = await http(w.api, "GET", "/arena/skills", undefined, w.cookie);
    expect(r.body).toMatchObject({ slots: 5, skills: [] });
    expect(r.body.library.length).toBeGreaterThan(5);
    expect(JSON.stringify(r.body.library)).not.toContain("signal");
  });
  it("adds from the library and writes its own, and says what is wrong with a bad one", async () => {
    const w = await setup();
    const a = await http(w.api, "POST", "/arena/skills/add", { from: "sma_cross" }, w.cookie);
    expect(a.status).toBe(200);
    const b = await http(w.api, "POST", "/arena/skills/add", { spec: JSON.stringify(climber) }, w.cookie);
    expect(b.status).toBe(200);
    const bad = await http(w.api, "POST", "/arena/skills/add", { spec: "{" }, w.cookie);
    expect(bad.status).toBe(400);
    expect((await http(w.api, "POST", "/arena/skills/add", { from: "sma_cross" }, w.cookie)).status).toBe(409);
    const list = await http(w.api, "GET", "/arena/skills", undefined, w.cookie);
    expect(list.body.skills).toHaveLength(2);
  });
  it("does not let a skill be removed while an agent trades by it", async () => {
    const w = await setup();
    const s = (await http(w.api, "POST", "/arena/skills/add", { spec: climber }, w.cookie)).body.skill;
    const made = await http(w.api, "POST", "/arena/bots/create", agent("Skilled", { skill: s.id }), w.cookie);
    expect(made.status).toBe(200);
    const del = await http(w.api, "POST", "/arena/skills/delete", { id: s.id }, w.cookie);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("Skilled");
    await http(w.api, "POST", "/arena/bots/delete", { id: made.body.bot.id }, w.cookie);
    expect((await http(w.api, "POST", "/arena/skills/delete", { id: s.id }, w.cookie)).status).toBe(200);
  });
});

describe("the runner and an agent that trades by a skill", () => {
  const live: ArenaRunner[] = [];
  afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));
  const bars = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ ts: NOW - (n - i) * 3_600_000, o: 90_000 + i * 100, h: 90_100 + i * 100, l: 89_900 + i * 100, c: 90_000 + i * 100 + 50, volUsd: 1e6, confirmed: true }));
  const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
  const feed = (history: Candle[]) => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => history, candles1m: () => [] }) as unknown as MarketFeed;
  const llm: LlmClient & { menus: string[][] } = {
    brain: "openai",
    model: "fake",
    menus: [],
    async json<T>(a: JsonAsk<T>): Promise<JsonAnswer<T>> {
      const labels = Object.keys((JSON.parse(a.user) as { menu: Record<string, unknown> }).menu);
      this.menus.push(labels);
      return { data: a.validate.parse({ choice: labels.find((l) => /(^|_)LONG(_|$)/.test(l)) ?? labels[0], confidence: 0.9, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 100, outputTokens: 10, latencyMs: 1 };
    },
  };
  function world(history: Candle[]) {
    const root = mkdtempSync(join(tmpdir(), "arena-skills-run-"));
    const store = new ArenaStore(root);
    const u = store.createUser("a".repeat(32), "ana@example.com", 1);
    store.setTier(u.id, "pro");
    llm.menus = [];
    const runner = new ArenaRunner({ store, root, feed: feed(history), decider: new LlmSystemOne(llm), now: () => NOW, tickMs: 1000, library: BUILTIN_SKILLS });
    live.push(runner);
    return { store, u, runner, bank: new SkillBank(store.tenant(u.id), "pro", BUILTIN_SKILLS, () => NOW), bots: new Bots(store.tenant(u.id), "pro", () => NOW) };
  }

  it("offers the model the skill's move on a coin where the skill wants a position, and trades it", async () => {
    const w = world(bars(80));
    const s = w.bank.addOwn(climber);
    const b = w.bots.create(agent("Skilled", { skill: s.id }));
    await w.runner.update(w.u.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(llm.menus.flat()).toContain("CLIMBER_LONG_BTC");
    expect(w.runner.status(w.u.id, [b.id])[b.id]).toMatchObject({ state: "running", position: { coin: "BTC", side: "long" } });
  });
  it("stays out when the skill does not want a position (no history, so no signal)", async () => {
    const w = world([]);
    const s = w.bank.addOwn(climber);
    const b = w.bots.create(agent("Skilled", { skill: s.id }));
    await w.runner.update(w.u.id);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.runner.status(w.u.id, [b.id])[b.id]!.position).toBeNull();
  });
  it("does not start when its skill is gone, and ranks in the skill league", async () => {
    const w = world(bars(80));
    const s = w.bank.addOwn(climber);
    const b = w.bots.create(agent("Skilled", { skill: s.id }));
    w.bank.remove(s.id);
    await w.runner.update(w.u.id);
    expect(w.runner.running).toBe(0);
    expect(w.runner.status(w.u.id, [b.id])[b.id]!.state).toBe("error");
    const w2 = world(bars(80));
    const s2 = w2.bank.addOwn(climber);
    const b2 = w2.bots.create(agent("Skilled", { skill: s2.id }));
    await w2.runner.update(w2.u.id);
    expect(w2.runner.running).toBe(1);
    expect(b2.mode).toBe("skill");
  });
});
