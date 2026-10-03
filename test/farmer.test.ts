import { describe, expect, it } from "vitest";
import { Farmer, farmerStats, MAX_RULES, type FarmerBee } from "../src/brains/farmer.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { Db } from "../src/db.js";
import { Visitors, cleanTz } from "../src/visitors.js";
import { landDots, placesOf, project, radius } from "../dashboard/src/mapModel.js";

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 3, 12);

class Brain implements LlmClient {
  readonly brain = "claude";
  readonly model = "fake-farmer";
  asked: Array<JsonAsk<unknown>> = [];
  constructor(public answer: () => unknown) {}
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asked.push(ask as JsonAsk<unknown>);
    return { data: ask.validate.parse(this.answer()), brain: "claude", model: "fake-farmer", inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}
const bees = (): FarmerBee[] => [
  { slot: "bee1", name: "Breezy", style: "breezy", coins: ["BTC"], rules: "Follow the trend." },
  { slot: "bee2", name: "Bizzy", style: "bizzy", coins: [], rules: "" },
];
function farm(answer: () => unknown, mode: "apply" | "advise" = "apply") {
  const db = new Db(":memory:");
  let t = NOW;
  const applied: Array<[string, string]> = [];
  const brain = new Brain(answer);
  const f = new Farmer({ db: db.raw, llm: brain, mode, bees, stats: () => null, setRules: (s, r) => void applied.push([s, r]), now: () => t });
  return { db, f, brain, applied, at: (x: number) => (t = x) };
}
const rewrite = (bee = "bee1", rules = "Only trade BTC when the 4-hour trend is up; after two losses in a day, stop until tomorrow.") => ({ say: "Breezy keeps bleeding. Tightening her up.", verdicts: [{ bee, action: "rewrite", reason: "Down 4% in a day with 3 losing trades.", rules }] });

describe("the Farmer", () => {
  it("says one line each round, and the card shows it", async () => {
    const w = farm(() => ({ say: "All quiet. Hands off.", verdicts: [{ bee: "bee1", action: "keep", reason: "Fine.", rules: "" }] }));
    const r = await w.f.round();
    expect(r).toMatchObject({ said: "All quiet. Hands off.", rewrites: [] });
    const s = w.f.summary();
    expect(s.recent[0]).toMatchObject({ kind: "say", text: "All quiet. Hands off." });
    expect(s).toMatchObject({ rewrites: 0, everyMin: 120, model: "fake-farmer", nextAt: NOW + 120 * 60_000 });
    expect(w.applied).toEqual([]);
  });
  it("rewrites a bunny's rules, keeps the old ones in the log, and only once a day per bunny", async () => {
    const w = farm(() => rewrite());
    await w.f.round();
    expect(w.applied).toHaveLength(1);
    const e = w.f.entries().find((x) => x.kind === "rewrite")!;
    expect(e).toMatchObject({ bee: "bee1", oldRules: "Follow the trend.", reason: "Down 4% in a day with 3 losing trades." });
    w.at(NOW + 2 * H);
    await w.f.round();
    expect(w.applied).toHaveLength(1); // not again the same day
    w.at(NOW + 25 * H);
    await w.f.round();
    expect(w.applied).toHaveLength(2);
    expect(w.f.summary().rewrites).toBe(2);
  });
  it("tells the model which bunnies it may rewrite today", async () => {
    const w = farm(() => rewrite());
    await w.f.round();
    w.at(NOW + H);
    await w.f.round();
    const input = JSON.parse(w.brain.asked[1]!.user) as { bunnies: Array<{ slot: string; canRewrite: boolean }> };
    expect(input.bunnies.find((b) => b.slot === "bee1")!.canRewrite).toBe(false);
    expect(input.bunnies.find((b) => b.slot === "bee2")!.canRewrite).toBe(true);
  });
  it("with real money only suggests: nothing is applied", async () => {
    const w = farm(() => rewrite(), "advise");
    await w.f.round();
    expect(w.applied).toEqual([]);
    expect(w.f.entries().find((x) => x.kind === "suggest")).toMatchObject({ bee: "bee1" });
  });
  it("ignores an unknown bunny, empty or unchanged rules, and cuts long ones", async () => {
    const w = farm(() => ({ say: "x", verdicts: [{ bee: "bee9", action: "rewrite", reason: "r", rules: "Something long enough to count as rules." }, { bee: "bee2", action: "rewrite", reason: "r", rules: "short" }, { bee: "bee1", action: "rewrite", reason: "r", rules: "Follow the trend." }] }));
    await w.f.round();
    expect(w.applied).toEqual([]);
    const long = farm(() => rewrite("bee2", "Be careful. ".repeat(54)));
    await long.f.round();
    expect(long.applied[0]![1].length).toBeLessThanOrEqual(MAX_RULES);
  });
  it("a failed call skips the round and keeps nothing", async () => {
    const w = farm(() => ({ nope: true }));
    expect(await w.f.round()).toBeNull();
    expect(w.f.entries()).toEqual([]);
  });
  it("is off without a model", () => {
    const db = new Db(":memory:");
    const f = new Farmer({ db: db.raw, llm: null, mode: "apply", bees, stats: () => null, setRules: () => {} });
    expect(f.enabled).toBe(false);
    expect(f.summary().nextAt).toBeNull();
  });
  it("reads a bunny's day change, week drawdown and day's trades from the engine's books", () => {
    const db = new Db(":memory:");
    const ins = db.raw.prepare("INSERT INTO equity_snapshots (bee, ts, equity_usd) VALUES (?, ?, ?)");
    ins.run("bee1", NOW - 30 * H, 340);
    ins.run("bee1", NOW - 24 * H, 350);
    ins.run("bee1", NOW - 10 * H, 330);
    ins.run("bee1", NOW, 336);
    const s = farmerStats(db.raw, "bee1", NOW, 333, "long BTC")!;
    expect(s.equityUsd).toBe(336);
    expect(s.dayPct).toBeCloseTo(-4, 1);
    expect(s.weekDrawdownPct).toBeCloseTo((20 / 350) * 100, 1);
    expect(farmerStats(db.raw, "bee2", NOW, 333, null)).toBeNull();
  });
});

describe("the visitors' map", () => {
  it("counts a visitor's time zone once a day, and only real zone names", () => {
    const db = new Db(":memory:");
    const v = new Visitors(db, () => NOW);
    v.visit("1.1.1.1", "Europe/Lisbon");
    v.visit("1.1.1.1", "Europe/Lisbon");
    v.visit("2.2.2.2", "America/Sao_Paulo");
    v.visit("3.3.3.3", "Not/AZone");
    v.visit("4.4.4.4", "<script>");
    expect(v.total).toBe(4);
    expect(v.placeCounts()).toEqual([["Europe/Lisbon", 1], ["America/Sao_Paulo", 1]]);
    expect(new Visitors(db, () => NOW).placeCounts()).toHaveLength(2); // kept across restarts
    expect(cleanTz("Asia/Calcutta")).toBe("Asia/Calcutta");
    expect(cleanTz("../../etc")).toBeNull();
  });
  it("places zones at their city and draws land", () => {
    const { places, unplaced } = placesOf([["Europe/Lisbon", 3], ["Asia/Calcutta", 2], ["Etc/UTC", 1]]);
    expect(places.map((p) => p.city)).toEqual(["Lisbon", "Calcutta"]);
    expect(unplaced).toBe(1);
    const [x, y] = project(places[0]!.lat, places[0]!.lon, 360, 180);
    expect(x).toBeGreaterThan(170);
    expect(x).toBeLessThan(180);
    expect(y).toBeGreaterThan(30);
    expect(landDots().length).toBeGreaterThan(1500);
    expect(radius(1, 100)).toBeLessThan(radius(100, 100));
  });
});
