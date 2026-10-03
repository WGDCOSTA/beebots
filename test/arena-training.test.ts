import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import { CandleStore, HistoricalApi, HBAR_MS, syncHistory } from "../src/arena/history.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import { backtestSkill, Trainer, TRAININGS_PER_DAY, type TrainingView } from "../src/arena/training.js";
import { BUILTIN_SKILLS } from "../src/lab/skills/index.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import type { Candle, Instrument } from "../src/market/types.js";
import { NOW } from "./fixtures.js";

const DAY = 86_400_000;
const BTC: Instrument = { instId: "BTC-USD_UM_XPERP-310404", coin: "BTC", kind: "crypto", ctVal: 0.0001, lotSz: 1, minSz: 1, tickSz: 0.1, state: "live" };
const ETH: Instrument = { instId: "ETH-USD_UM_XPERP-310404", coin: "ETH", kind: "crypto", ctVal: 0.001, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live" };

/** Synthetic 15-minute candles (a slow climb with waves), and the 1H and 4H bars made from them. Never real prices. */
function synth(px0: number, days: number, end = NOW): Record<"15m" | "1H" | "4H", Candle[]> {
  const n = (days * DAY) / HBAR_MS["15m"];
  const m15: Candle[] = [];
  let px = px0;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + 0.00012 + Math.sin(i / 37) * 0.0012);
    m15.push({ ts: end - (n - i) * HBAR_MS["15m"], o, h: Math.max(o, px) * 1.0006, l: Math.min(o, px) * 0.9994, c: px, volUsd: 2_000_000, confirmed: true });
  }
  const agg = (ms: number) => {
    const out: Candle[] = [];
    for (const x of m15) {
      const ts = Math.floor(x.ts / ms) * ms;
      const last = out[out.length - 1];
      if (last && last.ts === ts) Object.assign(last, { h: Math.max(last.h, x.h), l: Math.min(last.l, x.l), c: x.c, volUsd: last.volUsd + x.volUsd });
      else out.push({ ...x, ts });
    }
    return out;
  };
  return { "15m": m15, "1H": agg(HBAR_MS["1H"]), "4H": agg(HBAR_MS["4H"]) };
}

function history(days = 70): CandleStore {
  const h = new CandleStore(":memory:");
  h.setInstruments([BTC, ETH]);
  for (const [inst, px] of [[BTC, 60_000], [ETH, 3_000]] as const) {
    const s = synth(px, days);
    for (const bar of ["15m", "1H", "4H"] as const) h.put(inst.instId, bar, s[bar]);
  }
  return h;
}

/** A model that always goes long when it can, else holds: enough to see the replay trade. */
class Longer implements LlmClient {
  readonly brain = "openai";
  readonly model = "fake";
  asked = 0;
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked++;
    const labels = Object.keys((JSON.parse(ask.user) as { menu: Record<string, unknown> }).menu);
    const choice = labels.find((l) => /(^|_)LONG(_|$)/.test(l)) ?? labels.find((l) => l.startsWith("HOLD")) ?? labels[0]!;
    return { data: ask.validate.parse({ choice, confidence: 0.8, conviction: 3 }), brain: "openai", model: "fake", inputTokens: 1000, outputTokens: 50, latencyMs: 1 };
  }
}

function world(tier: "free" | "pro" | "premium" = "pro", budget = 5) {
  const root = mkdtempSync(join(tmpdir(), "arena-train-"));
  const store = new ArenaStore(root);
  const u = store.createUser("a".repeat(32), "ana@example.com", 1);
  store.setTier(u.id, tier);
  const llm = new Longer();
  const runner = new ArenaRunner({ store, root, feed: {} as MarketFeed, decider: new LlmSystemOne(llm), now: () => NOW, library: BUILTIN_SKILLS });
  const h = history();
  const trainer = new Trainer({ store, root, history: h, runner, now: () => NOW, platformBudgetUsd: budget, breathe: async () => {} });
  const bots = new Bots(store.tenant(u.id), tier, () => NOW);
  return { root, store, u, llm, runner, h, trainer, bots };
}
const agent = { name: "Climber", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." };
async function done(w: ReturnType<typeof world>, id: string): Promise<TrainingView> {
  for (let i = 0; i < 2000; i++) {
    const t = w.trainer.get(w.u.id, id)!;
    if (t.status !== "queued" && t.status !== "running") return t;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("training did not finish");
}

describe("the historical API is frozen at its clock", () => {
  it("shows only bars that had closed, and a ticker from the last 15-minute close", async () => {
    const h = history(10);
    let t = NOW - 3 * DAY + 7 * 60_000; // 7 minutes into a 15-minute bar
    const api = new HistoricalApi(h, () => t);
    const c = await api.candles(BTC.instId, "15m", 5);
    expect(c.at(-1)!.ts + HBAR_MS["15m"]).toBeLessThanOrEqual(t);
    const tk = (await api.tickers()).get(BTC.instId)!;
    expect(tk.last).toBe(c.at(-1)!.c);
    expect(tk.ask).toBeGreaterThan(tk.bid);
    t += DAY;
    expect((await api.candles(BTC.instId, "1H", 1))[0]!.ts).toBeGreaterThan(c.at(-1)!.ts);
    expect(await api.candles(BTC.instId, "1m", 5)).toEqual([]);
    await expect(api.funding()).rejects.toThrow();
  });
  it("syncs only what is missing, from the live instrument list, and prunes the old end", async () => {
    const h = new CandleStore(":memory:");
    const asked: Array<{ bar: string; after: number }> = [];
    const day = synth(100, 2);
    const rest = {
      stats: { sent: 0, shared: 0, retries: 0, rateLimited: 0 },
      async get<T>(_p: string, q: Record<string, string | number>): Promise<T> {
        asked.push({ bar: String(q.bar), after: Number(q.after) });
        const rows = day[q.bar as "1H"].filter((x) => x.ts < Number(q.after)).slice(-100);
        return rows.reverse().map((x) => [String(x.ts), String(x.o), String(x.h), String(x.l), String(x.c), "0", "0", String(x.volUsd), "1"]) as T;
      },
    };
    const r = await syncHistory(h, { rest, instruments: async () => [BTC, { ...ETH, state: "suspend" }] }, ["BTC", "ETH"], NOW);
    expect(r.failed).toEqual([]);
    expect(h.instruments().map((i) => i.coin)).toEqual(["BTC"]);
    expect(h.coverage(BTC.instId, "1H")!.bars).toBe(48);
    expect(h.lastSyncAt).toBe(NOW);
  });
});

describe("simulated training", () => {
  it("replays the agent over history with its own engine and model, and keeps the result apart", async () => {
    const w = world();
    const b = w.bots.create(agent);
    const t0 = w.trainer.start(w.u.id, "pro", b, 7);
    expect(t0).toMatchObject({ status: "queued", days: 7, startUsd: 1000 });
    const t = await done(w, t0.id);
    expect(t.status).toBe("done");
    expect(t.decisions).toBeGreaterThan(100); // one step an hour for 7 days
    expect(w.llm.asked).toBeGreaterThan(50);
    expect(t.equityUsd).not.toBeNull();
    expect(t.benchmarkCoin).toBe("BTC");
    expect(t.toTs - t.fromTs).toBe(7 * DAY);
    const ins = w.trainer.insights(w.u.id, t)!;
    expect(ins.equity.length).toBeGreaterThan(10);
    // everything happened inside the window of history, not "now"
    for (const [ts] of ins.equity) expect(ts).toBeLessThanOrEqual(t.toTs);
    expect(ins.equity[0]![0]).toBeGreaterThanOrEqual(t.fromTs);
    // apart from the paper account
    expect(existsSync(join(w.root, "tenants", w.u.id, "paper"))).toBe(false);
  });
  it("is Pro and Premium only, counts per day, one at a time per agent, and needs history for every coin", async () => {
    const free = world("free");
    expect(() => free.trainer.start(free.u.id, "free", free.bots.create(agent), 7)).toThrow(/Pro and Premium/);
    const w = world();
    const b = w.bots.create(agent);
    expect(() => w.trainer.start(w.u.id, "pro", b, 9)).toThrow(/7, 14 or 30/);
    expect(() => w.trainer.start(w.u.id, "pro", { ...b, coins: ["SOL"] }, 7)).toThrow(/No history yet for SOL/);
    const first = w.trainer.start(w.u.id, "pro", b, 7);
    expect(() => w.trainer.start(w.u.id, "pro", b, 7)).toThrow(/already training/);
    await done(w, first.id);
    for (let i = 1; i < TRAININGS_PER_DAY.pro; i++) await done(w, w.trainer.start(w.u.id, "pro", b, 7).id);
    expect(() => w.trainer.start(w.u.id, "pro", b, 7)).toThrow(/today's trainings/);
  });
  it("stops early at the model budget, and can be cancelled", async () => {
    const w = world("pro", 0.0005);
    const b = w.bots.create(agent);
    const t = await done(w, w.trainer.start(w.u.id, "pro", b, 7).id);
    expect(t.status).toBe("budget");
    expect(t.progress).toBeLessThan(1);
    const c = world();
    const id = c.trainer.start(c.u.id, "pro", c.bots.create(agent), 30).id;
    c.trainer.cancel(c.u.id, id);
    expect((await done(c, id)).status).toBe("cancelled");
  });
  it("a training a restart interrupted says so, and deleting the agent removes its trainings", async () => {
    const w = world();
    const b = w.bots.create(agent);
    const t = await done(w, w.trainer.start(w.u.id, "pro", b, 7).id);
    w.store.tenant(w.u.id).prepare("UPDATE trainings SET status = 'running' WHERE id = ?").run(t.id);
    expect(w.trainer.list(w.u.id, b.id)[0]).toMatchObject({ status: "failed", error: /restart/ });
    w.trainer.forgetBot(w.u.id, b.id);
    expect(w.trainer.list(w.u.id, b.id)).toEqual([]);
    expect(existsSync(w.trainer.fileOf(w.u.id, t))).toBe(false);
  });
});

describe("a skill's backtest", () => {
  it("runs the Lab's simulator on stored hourly history and says what it assumes", () => {
    const h = history();
    const r = backtestSkill(h, BUILTIN_SKILLS.find((s) => s.id === "sma_cross") ?? BUILTIN_SKILLS[0]!, "BTC", 30, NOW);
    expect(r.equity.length).toBeGreaterThan(20);
    expect(r.equity[0]![0]).toBeGreaterThanOrEqual(NOW - 30 * DAY - 3_600_000);
    expect(r.metrics.benchmarkPct).toBeGreaterThan(0); // the synthetic market climbs
    expect(r.assumptions).toMatchObject({ feePct: 0.05, leverage: 1 });
    expect(() => backtestSkill(h, BUILTIN_SKILLS[0]!, "DOGE", 7, NOW)).toThrow(/No history yet for DOGE/);
  });
});

// ---------- HTTP ----------
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import type { Mailer } from "../src/arena/mailer.js";

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

describe("HTTP: history, backtests and training", () => {
  async function setup(tier: "free" | "pro") {
    const w = world(tier);
    const inbox = new Inbox();
    const auth = new ArenaAuth(w.store, inbox, { baseUrl: "https://x.test" });
    const api = new ArenaApi(auth, w.store, { secureCookie: true, now: () => NOW, history: w.h, trainer: w.trainer, library: BUILTIN_SKILLS });
    await auth.requestLink("ana@example.com", "1.1.1.1");
    const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
    w.store.acceptConsent(v.user.id, 1);
    return { ...w, api, cookie: `arena_session=${v.session}` };
  }
  it("lists the coins with history, and refuses Free with a clear code", async () => {
    const f = await setup("free");
    const h = await http(f.api, "GET", "/arena/history", undefined, f.cookie);
    expect(h.body).toMatchObject({ open: true, allowed: false });
    expect(h.body.coins.map((c: Json) => c.coin)).toEqual(["BTC", "ETH"]);
    const b = f.bots.create(agent);
    expect((await http(f.api, "POST", "/arena/bots/train/start", { id: b.id, days: 7 }, f.cookie)).body.code).toBe("plan");
    expect((await http(f.api, "POST", "/arena/skills/backtest", { skill: "x", coin: "BTC", days: 7 }, f.cookie)).body.code).toBe("plan");
  });
  it("backtests a skill in the member's slots, trains an agent and shows the result", async () => {
    const w = await setup("pro");
    const slot = (await http(w.api, "POST", "/arena/skills/add", { from: BUILTIN_SKILLS[0]!.id }, w.cookie)).body.skill.id as string;
    const bt = await http(w.api, "POST", "/arena/skills/backtest", { skill: slot, coin: "btc", days: 14 }, w.cookie);
    expect(bt.status).toBe(200);
    expect(bt.body.result.coin).toBe("BTC");
    expect((await http(w.api, "POST", "/arena/skills/backtest", { skill: "nope", coin: "BTC", days: 14 }, w.cookie)).status).toBe(404);
    const b = w.bots.create(agent);
    const st = await http(w.api, "POST", "/arena/bots/train/start", { id: b.id, days: 7 }, w.cookie);
    expect(st.status).toBe(200);
    const t = await done(w, st.body.training.id);
    const list = await http(w.api, "GET", `/arena/bots/train?id=${b.id}`, undefined, w.cookie);
    expect(list.body).toMatchObject({ allowed: true, perDay: TRAININGS_PER_DAY.pro, used: 1 });
    expect(list.body.trainings[0].status).toBe("done");
    const d = await http(w.api, "GET", `/arena/bots/train/detail?id=${t.id}`, undefined, w.cookie);
    expect(d.body.insights.equity.length).toBeGreaterThan(10);
    // deleting the agent deletes its trainings
    await http(w.api, "POST", "/arena/bots/delete", { id: b.id }, w.cookie);
    expect(w.trainer.list(w.u.id, b.id)).toEqual([]);
  });
});
