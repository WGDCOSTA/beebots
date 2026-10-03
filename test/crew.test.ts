// The crew (brains/crew.ts) and its data tools (brains/crewData.ts): a round is logged and delivered, a failure is shown,
// and each member reads what its job needs.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { CREW, CrewMember } from "../src/brains/crew.js";
import { owlData, pigData, ratData, type CrewSnapshot } from "../src/brains/crewData.js";
import { Db } from "../src/db.js";

const NOW = 1_790_000_000_000;
const fakeLlm = (answer: unknown, fail = false) => ({
  brain: "openai" as const,
  model: "fake-model",
  async json() {
    if (fail) throw new Error("Your credit balance is too low");
    return { data: answer, brain: "openai", model: "fake-model", inputTokens: 120, outputTokens: 40, latencyMs: 900 } as never;
  },
});

const snap: CrewSnapshot = {
  startEquityUsd: 333,
  bees: [
    { bee: "bee1", equityUsd: 340, startEquityUsd: 333, pnlUsd: 7, pnlPct: 2.1, position: { coin: "BTC", side: "long", sizeUsd: 200, uplUsd: 3, minutesHeld: 40 }, tradesToday: 1, maxTradesPerDay: 3, feesTodayUsd: 0.2, feeBudgetUsd: 1, cap: null, totals: { feesUsd: 2, fundingUsd: -0.1, jevUsd: 0.5, realisedUsd: 9, decisions: 100, orders: 6 }, last: { choice: "HOLD", confidence: 0.8, status: "ok" } },
  ],
  jev: { spentTodayUsd: 0.4, dailyCapUsd: 2, capTripped: false, down: false },
  market: { board: [{ coin: "BTC", kind: "crypto", px: 80000, ret1hPct: 0.1, ret24hPct: 1.5, ret7dPct: 4, vol24hUsd: 5e9, spreadBp: 1, atrPct: 2, rsi: 55, fundingPct: 0.01, oiUsd: 1e9, cmcRank: 1 }, { coin: "DOGE", kind: "crypto", px: 0.1, ret1hPct: -0.5, ret24hPct: -3, ret7dPct: -9, vol24hUsd: 2e8, spreadBp: 3, atrPct: 5, rsi: 30, fundingPct: -0.05, oiUsd: 1e8, cmcRank: 9 }] },
};

describe("CrewMember", () => {
  it("logs a round, delivers its notes and shows them on its card", async () => {
    const raw = new DatabaseSync(":memory:");
    const delivered: unknown[] = [];
    const owl = new CrewMember(CREW.owl, {
      db: raw,
      llm: fakeLlm({ say: "Patience pays.", notes: [{ bee: "bee1", title: "Hold the winner", text: "Up 2.1%: let it run.", level: "info" }, { bee: "zzz", title: "x", text: "warren-wide", level: "watch" }] }),
      gather: () => ({}),
      deliver: (say, notes) => delivered.push({ say, notes }),
      now: () => NOW,
    });
    const r = await owl.round();
    expect(r?.say).toBe("Patience pays.");
    expect(r?.notes.map((n) => n.bee)).toEqual(["bee1", ""]); // an unknown slot becomes a warren-wide note
    expect(delivered).toHaveLength(1);
    const s = owl.summary();
    expect(s).toMatchObject({ id: "owl", name: "The Owl", model: "fake-model", error: null, said: { text: "Patience pays." } });
    expect(s.notes).toHaveLength(2);
    expect(owl.entries().map((e) => e.kind)).toEqual(["say", "note", "note"]);
    const dash = owl.dashboard();
    expect(dash.metrics).toMatchObject({ rounds: 1, okRounds: 1, successPct: 100, avgLatencyMs: 900, inTokens: 120, outTokens: 40, avgNotes: 2 });
    expect(dash.brain).toMatchObject({ model: "fake-model", brain: "openai" });
    expect(dash.levels.map((l) => l.level).sort()).toEqual(["info", "watch"]);
    expect(dash.input).toEqual({});
  });

  it("shows a failed round on its card and keeps working afterwards", async () => {
    const raw = new DatabaseSync(":memory:");
    const pig = new CrewMember(CREW.pig, { db: raw, llm: fakeLlm({}, true), gather: () => ({}), now: () => NOW });
    expect(await pig.round()).toBeNull();
    expect(pig.summary().error).toMatch(/credit balance/);
    expect(pig.entries()).toHaveLength(0);
    expect(pig.dashboard().metrics).toMatchObject({ rounds: 1, okRounds: 0, successPct: 0 });
    expect(pig.dashboard().rounds[0]).toMatchObject({ ok: 0, error: expect.stringMatching(/credit/) });
  });

  it("is off without a brain", () => {
    const m = new CrewMember(CREW.rat, { db: new DatabaseSync(":memory:"), llm: null, gather: () => ({}) });
    expect(m.enabled).toBe(false);
    expect(m.summary().nextAt).toBeNull();
  });
});

describe("crew data", () => {
  it("gives the Owl each bunny's calls and trades, the Rat the market, the Pig the books", () => {
    const db = new Db(":memory:");
    db.insertDecision({ bee: "bee1", ts: NOW - 3_600_000, stateHash: null, stateJson: null, menuJson: null, choice: "WAIT", probabilities: null, confidence: 0.7, conviction: 0.5, latencyMs: 500, inputTokens: 10, jevCostUsd: 0.002, jevError: null, action: { type: "hold" }, vetoedBy: "risk", forcedBy: null, status: "ok" } as never);
    const owl = owlData(db.raw, snap, [{ slot: "bee1", name: "Honey", style: "boozy", coins: ["BTC"], rules: "calm" }], NOW) as { bunnies: Array<{ callsLast24h: { total: number; vetoed: number; byKind: Record<string, number> }; position: string }> };
    expect(owl.bunnies[0]!.callsLast24h).toMatchObject({ total: 1, vetoed: 1, byKind: { WAIT: 1 } });
    expect(owl.bunnies[0]!.position).toMatch(/long BTC/);
    const rat = ratData(snap, null) as { okx: { breadth24h: { up: number; down: number }; strongest7d: Array<{ coin: string }>; lowestFunding: Array<{ coin: string }> } };
    expect(rat.okx.breadth24h).toEqual({ up: 1, down: 1 });
    expect(rat.okx.strongest7d[0]!.coin).toBe("BTC");
    expect(rat.okx.lowestFunding[0]!.coin).toBe("DOGE");
    const pig = pigData(db.raw, snap, { bee1: "Honey" }, NOW) as { warren: { feesUsd: number; modelUsd: number }; budgets: { jevDailyCapUsd: number }; bunnies: Array<{ last24h: { decisions: number } }> };
    expect(pig.warren).toMatchObject({ feesUsd: 2, modelUsd: 0.5 });
    expect(pig.budgets.jevDailyCapUsd).toBe(2);
    expect(pig.bunnies[0]!.last24h.decisions).toBe(1);
  });
});
