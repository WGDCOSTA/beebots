import { describe, expect, it } from "vitest";
import { arenaView, looksLikeEmail, memberSince, resendIn } from "../dashboard/src/arenaModel.js";

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
