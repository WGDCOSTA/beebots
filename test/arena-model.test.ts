import { describe, expect, it } from "vitest";
import { arenaView, draftProblem, handleProblem, leagueLabel, looksLikeEmail, memberSince, pctText, resendIn, runSummary, seasonEnds, toggleCoin } from "../dashboard/src/arenaModel.js";

describe("arenaView", () => {
  it("reads the e-mailed link", () => {
    expect(arenaView("#/arena/verify?token=abc123")).toEqual({ kind: "verify", token: "abc123" });
  });
  it("knows the leaderboard page", () => {
    expect(arenaView("#/arena/ranking")).toEqual({ kind: "ranking" });
  });
  it("falls back to the account page", () => {
    expect(arenaView("#/arena")).toEqual({ kind: "account" });
    expect(arenaView("#/arena/verify")).toEqual({ kind: "account" });
    expect(arenaView("#/arena/verify?token=")).toEqual({ kind: "account" });
    expect(arenaView("#/arena/other?token=x")).toEqual({ kind: "account" });
  });
});

describe("looksLikeEmail", () => {
  it("accepts ordinary addresses and rejects obvious mistakes", () => {
    expect(looksLikeEmail(" ana@example.com ")).toBe(true);
    for (const bad of ["", "ana", "ana@", "ana@b", "a b@c.com", "@c.com"]) expect(looksLikeEmail(bad)).toBe(false);
    expect(looksLikeEmail(`${"a".repeat(250)}@b.com`)).toBe(false);
  });
});

describe("resendIn", () => {
  it("counts down and never goes negative", () => {
    expect(resendIn(1000, 1000)).toBe(30);
    expect(resendIn(1000, 16_000)).toBe(15);
    expect(resendIn(1000, 999_999)).toBe(0);
  });
});

describe("memberSince", () => {
  it("words the join date in UTC", () => {
    expect(memberSince(Date.UTC(2026, 8, 30, 23, 59))).toBe("Member since 30 Sep 2026");
  });
});

describe("draftProblem", () => {
  const ok = { name: "Fluffy", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Trade carefully always.", tagline: "", look: "", listed: true };
  it("accepts a complete draft", () => expect(draftProblem(ok, 3)).toBeNull());
  it("says what is missing, one thing at a time", () => {
    expect(draftProblem({ ...ok, name: " a " }, 3)).toMatch(/name/);
    expect(draftProblem({ ...ok, avatar: "" }, 3)).toMatch(/avatar/);
    expect(draftProblem({ ...ok, style: "" }, 3)).toMatch(/style/);
    expect(draftProblem({ ...ok, coins: [] }, 3)).toMatch(/coin/);
    expect(draftProblem({ ...ok, coins: ["BTC", "ETH", "SOL", "HYPE"] }, 3)).toMatch(/up to 3/);
    expect(draftProblem({ ...ok, coins: ["BTC", "SOL"] }, 3)).toMatch(/only trades BTC, ETH/);
    expect(draftProblem({ ...ok, style: "boozy", coins: ["XRP"] }, 3)).toBeNull();
    expect(draftProblem({ ...ok, rules: "short" }, 3)).toMatch(/8 characters/);
    expect(draftProblem({ ...ok, rules: "x".repeat(501) }, 3)).toMatch(/500/);
  });
});

describe("toggleCoin", () => {
  it("adds, removes and stops at the limit", () => {
    expect(toggleCoin(["BTC"], "ETH", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "SOL", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "BTC", 2)).toEqual(["ETH"]);
  });
});

describe("runSummary", () => {
  const run = { state: "running" as const, equityUsd: 1012.5, pnlUsd: 12.5, pnlPct: 1.25, decisions: 40, position: null, last: { choice: "HOLD_WINNER", confidence: 0.82, status: "ok", ts: 1 } };
  it("explains a bot that is not trading, in words", () => {
    expect(runSummary(false, undefined).headline).toMatch(/not trading yet/);
    expect(runSummary(true, undefined).headline).toMatch(/Waiting for a place/);
    expect(runSummary(true, { state: "error" })).toMatchObject({ headline: "Could not start", tone: "bad" });
  });
  it("shows the paper account, the position and the last call", () => {
    const s = runSummary(true, run);
    expect(s.headline).toBe("Paper account $1,012.50 (+$12.50, +1.25%)");
    expect(s.detail).toBe("Flat, waiting for a setup. 40 decisions. Last call: Hold the winner (82% sure).");
    expect(s.tone).toBe("good");
    const p = runSummary(true, { ...run, pnlUsd: -3, pnlPct: -0.3, equityUsd: 997, position: { coin: "BTC", side: "long", sizeUsd: 500, uplUsd: -3, minutesHeld: 5 }, capped: true });
    expect(p.headline).toBe("Paper account $997.00 (-$3.00, -0.30%)");
    expect(p.detail).toContain("LONG BTC $500.00, -$3.00 open");
    expect(p.detail).toContain("holds until 00:00 UTC");
    expect(p.tone).toBe("bad");
  });
});


describe("leaderboard words", () => {
  it("names a league by plan and style", () => {
    expect(leagueLabel("free:breezy")).toBe("Free · Trend");
    expect(leagueLabel("pro:boozy")).toBe("Pro · Momentum");
  });
  it("says when a season ends", () => {
    const now = Date.UTC(2026, 8, 30, 12);
    expect(seasonEnds(now + 2 * 86_400_000 + 5 * 3_600_000, now)).toBe("Ends in 2d 5h");
    expect(seasonEnds(now + 3 * 3_600_000, now)).toBe("Ends in 3h");
    expect(seasonEnds(now + 60_000, now)).toBe("Ends in 1h");
    expect(seasonEnds(now - 1, now)).toBe("Ended");
  });
  it("signs percentages", () => {
    expect(pctText(3.456)).toBe("+3.46%");
    expect(pctText(-0.5)).toBe("-0.50%");
  });
  it("checks a public name the way the server does", () => {
    expect(handleProblem("fast-ana")).toBeNull();
    for (const bad of ["", "ab", "a".repeat(21), "no spaces", "-x-"]) expect(handleProblem(bad)).not.toBeNull();
  });
});
