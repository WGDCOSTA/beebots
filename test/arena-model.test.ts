import { describe, expect, it } from "vitest";
import { arenaView, draftProblem, looksLikeEmail, memberSince, resendIn, toggleCoin } from "../dashboard/src/arenaModel.js";

describe("arenaView", () => {
  it("reads the e-mailed link", () => {
    expect(arenaView("#/arena/verify?token=abc123")).toEqual({ kind: "verify", token: "abc123" });
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
  const ok = { name: "Fluffy", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Trade carefully always.", tagline: "", look: "" };
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
    expect(draftProblem({ ...ok, rules: "x".repeat(2001) }, 3)).toMatch(/2000/);
  });
});

describe("toggleCoin", () => {
  it("adds, removes and stops at the limit", () => {
    expect(toggleCoin(["BTC"], "ETH", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "SOL", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "BTC", 2)).toEqual(["ETH"]);
  });
});
