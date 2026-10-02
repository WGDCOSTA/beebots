import { describe, expect, it } from "vitest";
import { agoParts, arenaView, styleTitleKey, fmtPrice, planFeatures, quarantineDaysLeft, checklist, choiceText, coinFits, draftIssue, fmtPct, fmtUsd, handleIssue, leagueText, looksLikeEmail, needSays, pnlTone, resendIn, riskSay, seasonEndsSay, sparkPath, statePill, stepIssue, toggleCoin, withStyle } from "../dashboard/src/arenaModel.js";
import { en } from "../dashboard/src/i18n/en.js";

describe("arenaView", () => {
  it("reads the e-mailed link", () => {
    expect(arenaView("#/arena/verify?token=abc123")).toEqual({ kind: "verify", token: "abc123" });
  });
  it("knows every page of the Arena shell", () => {
    expect(arenaView("#/arena")).toEqual({ kind: "home" });
    expect(arenaView("#/arena/new")).toEqual({ kind: "new" });
    expect(arenaView("#/arena/me")).toEqual({ kind: "me" });
    expect(arenaView("#/arena/legal/terms")).toEqual({ kind: "legal", doc: "terms" });
    expect(arenaView("#/arena/legal/cookies")).toEqual({ kind: "legal", doc: "cookies" });
    expect(arenaView("#/arena/legal/nonsense")).toEqual({ kind: "home" });
  });
  it("knows the leaderboard page", () => {
    expect(arenaView("#/arena/ranking")).toEqual({ kind: "ranking" });
  });
  it("falls back to the account page", () => {
    expect(arenaView("#/arena")).toEqual({ kind: "home" });
    expect(arenaView("#/arena/verify")).toEqual({ kind: "home" });
    expect(arenaView("#/arena/verify?token=")).toEqual({ kind: "home" });
    expect(arenaView("#/arena/other?token=x")).toEqual({ kind: "home" });
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

describe("arenaView: an agent's page", () => {
  it("reads the agent id, and refuses anything that is not one", () => {
    expect(arenaView("#/arena/agent/ab12cd34ef56")).toEqual({ kind: "agent", id: "ab12cd34ef56" });
    expect(arenaView("#/arena/agent/")).toEqual({ kind: "home" });
    expect(arenaView("#/arena/agent/a b")).toEqual({ kind: "home" });
  });
});

describe("draftIssue", () => {
  const ok = { name: "Fluffy", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Trade carefully always.", tagline: "", look: "", listed: true };
  it("accepts a complete draft", () => expect(draftIssue(ok, 3)).toBeNull());
  it("says what is missing, one thing at a time, as keys to translate", () => {
    expect(draftIssue({ ...ok, name: " a " }, 3)?.key).toBe("prob.name");
    expect(draftIssue({ ...ok, avatar: "" }, 3)?.key).toBe("prob.avatar");
    expect(draftIssue({ ...ok, style: "" }, 3)?.key).toBe("prob.style");
    expect(draftIssue({ ...ok, coins: [] }, 3)?.key).toBe("prob.coins");
    expect(draftIssue({ ...ok, coins: ["BTC", "ETH", "SOL", "HYPE"] }, 3)).toEqual({ key: "prob.maxCoins", vars: { n: 3 } });
    expect(draftIssue({ ...ok, coins: ["BTC", "SOL"] }, 3, () => "Trend")).toEqual({ key: "prob.styleCoins", vars: { style: "Trend", coins: "BTC, ETH" } });
    expect(draftIssue({ ...ok, style: "boozy", coins: ["XRP"] }, 3)).toBeNull();
    expect(draftIssue({ ...ok, rules: "short" }, 3)?.key).toBe("prob.rulesShort");
    expect(draftIssue({ ...ok, rules: "x".repeat(501) }, 3)?.key).toBe("prob.rulesLong");
  });
  it("every message it can give exists in English", () => {
    for (const k of ["prob.name", "prob.avatar", "prob.style", "prob.coins", "prob.maxCoins", "prob.styleCoins", "prob.rulesShort", "prob.rulesLong"]) expect(en).toHaveProperty(k);
  });
});

describe("the wizard's steps", () => {
  const blank = { name: "", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "", tagline: "", look: "", listed: true };
  it("each step stops only for what it owns", () => {
    expect(stepIssue("start", blank, 3)).toBeNull();
    expect(stepIssue("look", blank, 3)?.key).toBe("prob.name");
    expect(stepIssue("style", blank, 3)).toBeNull(); // the name is a Look matter
    expect(stepIssue("rules", blank, 3)?.key).toBe("prob.rulesShort");
    expect(stepIssue("review", blank, 3)?.key).toBe("prob.name");
    expect(stepIssue("look", { ...blank, name: "Fluffy" }, 3)).toBeNull();
  });
});

describe("coins and styles", () => {
  it("toggles a coin, refusing the limit and a coin the style cannot trade", () => {
    expect(toggleCoin(["BTC"], "ETH", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "SOL", 2)).toEqual(["BTC", "ETH"]);
    expect(toggleCoin(["BTC", "ETH"], "BTC", 2)).toEqual(["ETH"]);
    expect(toggleCoin(["BTC"], "SOL", 3, "breezy")).toEqual(["BTC"]);
    expect(toggleCoin(["BTC"], "SOL", 3, "boozy")).toEqual(["BTC", "SOL"]);
  });
  it("knows which coins a style takes", () => {
    expect(coinFits("breezy", "BTC")).toBe(true);
    expect(coinFits("breezy", "SOL")).toBe(false);
    expect(coinFits("boozy", "DOGE")).toBe(true);
  });
  it("switching style drops the coins it cannot trade and keeps the draft valid", () => {
    const d = { name: "x", theme: "bunnies", avatar: "scout", style: "boozy", coins: ["BTC", "XRP"], rules: "", tagline: "", look: "", listed: true };
    expect(withStyle(d, "breezy").coins).toEqual(["BTC"]);
    expect(withStyle({ ...d, coins: ["XRP"] }, "breezy").coins).toEqual(["BTC"]);
  });
});

describe("statePill", () => {
  it("says what an agent is doing", () => {
    expect(statePill(false, "running", undefined).key).toBe("state.saved");
    expect(statePill(true, "running", undefined).key).toBe("state.waiting");
    expect(statePill(true, "running", { state: "queued" }).key).toBe("state.waiting");
    expect(statePill(true, "running", { state: "error" })).toEqual({ key: "state.error", tone: "bad" });
    expect(statePill(true, "running", { state: "running" })).toEqual({ key: "state.running", tone: "run" });
    expect(statePill(true, "paused", { state: "paused" }).key).toBe("state.paused");
    expect(statePill(true, "paused", undefined).key).toBe("state.paused");
    expect(statePill(true, "stopped", { state: "stopping" }).key).toBe("state.stopping");
    expect(statePill(true, "stopped", { state: "stopped" }).key).toBe("state.stopped");
  });
});

describe("numbers and curves", () => {
  it("tones a result", () => {
    expect(pnlTone(12)).toBe("good");
    expect(pnlTone(-3)).toBe("bad");
    expect(pnlTone(0)).toBe("flat");
    expect(pnlTone(undefined)).toBe("flat");
  });
  it("formats money and percentages in the member's language", () => {
    expect(fmtUsd(1012.5)).toBe("$1,012.50");
    expect(fmtUsd(-3, "en", true)).toBe("-$3.00");
    expect(fmtUsd(12.5, "en", true)).toBe("+$12.50");
    expect(fmtUsd(1012.5, "de")).toContain("1.012,50");
    expect(fmtPct(1.25)).toBe("+1.25%");
    expect(fmtPct(-0.3)).toBe("-0.30%");
  });
  it("draws a curve inside its box, and nothing for fewer than two points", () => {
    expect(sparkPath([1], 100, 20)).toBe("");
    const d = sparkPath([1, 3, 2], 100, 20, 2);
    expect(d.startsWith("M2.0 18.0")).toBe(true);
    expect(sparkPath([5, 5, 5], 100, 20)).toBe("M2.0 10.0 L50.0 10.0 L98.0 10.0");
    // a tiny move stays tiny: 0.01 on a 10-wide minimum span uses a thousandth of the height
    const flat = sparkPath([1000, 1000.01], 100, 20, 2, 10).match(/L98\.0 ([\d.]+)/)![1]!;
    expect(Math.abs(Number(flat) - 10)).toBeLessThan(0.1);
  });
  it("says how long ago", () => {
    expect(agoParts(1000, 31_000)).toEqual({ n: -30, unit: "second" });
    expect(agoParts(0, 5 * 60_000)).toEqual({ n: -5, unit: "minute" });
    expect(agoParts(0, 3 * 3_600_000)).toEqual({ n: -3, unit: "hour" });
    expect(agoParts(0, 2 * 86_400_000)).toEqual({ n: -2, unit: "day" });
  });
});

describe("words for what an agent did", () => {
  const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
  it("names a risk rule, and never hides an unknown one", () => {
    expect(riskSay("stop")).toEqual({ key: "risk.stop" });
    expect(riskSay("max_flat").key).toBe("risk.max_flat");
    expect(riskSay("some_new_rule")).toEqual({ key: "risk.other", vars: { name: "some new rule" } });
    for (const r of ["stop", "time_stop", "max_flat", "jev_unreachable", "jev_daily_cap", "loss_stop", "retired", "experiment_closed", "trade_cap", "fee_budget"]) expect(en).toHaveProperty(riskSay(r).key);
  });
  it("translates menu labels it knows and keeps the rest readable", () => {
    expect(choiceText("LONG_BTC", t as never)).toBe('choice.long{"coin":"BTC"}');
    expect(choiceText("SHORT_ETH", t as never)).toBe('choice.short{"coin":"ETH"}');
    expect(choiceText("SMA_CROSS_LONG_BTC", t as never)).toBe('choice.long{"coin":"BTC"}');
    expect(choiceText("HOLD_WINNER", t as never)).toBe("choice.hold");
    expect(choiceText("WAIT", t as never)).toMatch(/wait/i);
    expect(choiceText("FT_SOMETHING_ODD", t as never)).toMatch(/something odd/i);
  });
  it("ticks the getting-started list from real data", () => {
    expect(checklist(0, 0, false).map((s) => s.done)).toEqual([false, false, false]);
    expect(checklist(1, 0, false).map((s) => s.done)).toEqual([true, false, false]);
    expect(checklist(1, 5, true).map((s) => s.done)).toEqual([true, true, true]);
  });
  it("says when the season ends", () => {
    const now = Date.UTC(2026, 8, 30, 12);
    expect(seasonEndsSay(now + 2 * 86_400_000 + 5 * 3_600_000, now)).toEqual({ key: "season.endsDays", vars: { d: 2, h: 5 } });
    expect(seasonEndsSay(now + 60_000, now)).toEqual({ key: "season.endsHours", vars: { h: 1 } });
    expect(seasonEndsSay(now - 1, now)).toEqual({ key: "season.ended" });
  });
});

describe("leaderboard words", () => {
  const t = (k: string) => ({ "style.breezy.t": "Trend", "style.boozy.t": "Momentum", "league.autonomous": "Autonomous" })[k] ?? k;
  it("names a league by plan and style", () => {
    expect(leagueText("free:breezy", t as never)).toBe("Free · Trend");
    expect(leagueText("pro:boozy", t as never)).toBe("Pro · Momentum");
    expect(leagueText("premium:autonomous", t as never)).toBe("Premium · Autonomous");
  });
  it("words what an agent still needs, from numbers", () => {
    expect(needSays({ started: false, days: 3, trades: 3, history: true })).toEqual([{ key: "rank.need.started" }]);
    expect(needSays({ started: true, days: 2.5, trades: 0, history: false })).toEqual([{ key: "rank.need.days", vars: { n: "2.5" } }]);
    expect(needSays({ started: true, days: 0.5, trades: 3, history: true }).map((m) => m.key)).toEqual(["rank.need.days", "rank.need.trades", "rank.need.history"]);
  });
  it("checks a public name the way the server does", () => {
    expect(handleIssue("fast-ana")).toBeNull();
    for (const bad of ["", "ab", "a".repeat(21), "no spaces", "-x-"]) expect(handleIssue(bad)).toBe("me.handleRule");
  });
});

describe("plans and quarantine", () => {
  it("reads the plans page route", () => {
    expect(arenaView("#/arena/plans")).toEqual({ kind: "plans", paid: false });
    expect(arenaView("#/arena/plans?paid=1")).toEqual({ kind: "plans", paid: true });
  });
  it("shows quarantine as its own state, before anything else", () => {
    expect(statePill(true, "quarantined", { state: "stopped" })).toEqual({ key: "state.quarantined", tone: "stop" });
    expect(statePill(false, "quarantined", undefined).key).toBe("state.quarantined");
  });
  it("counts the days left in a quarantine, never below zero", () => {
    const t0 = Date.UTC(2026, 9, 1);
    expect(quarantineDaysLeft(t0, t0, 10)).toBe(10);
    expect(quarantineDaysLeft(t0, t0 + 3 * 86_400_000 + 1000, 10)).toBe(7);
    expect(quarantineDaysLeft(t0, t0 + 99 * 86_400_000, 10)).toBe(0);
    expect(quarantineDaysLeft(null, t0, 10)).toBe(10);
  });
  it("formats a price in the member's language", () => {
    expect(fmtPrice(999, "eur", "en")).toBe("€9.99");
    expect(fmtPrice(1599, "eur", "de")).toContain("15,99");
  });
  it("lists what a plan includes and marks what is not built yet, so it is never sold as working", () => {
    const free = planFeatures({ bots: 1, maxCoins: 3, styles: ["breezy", "bizzy"], proThemes: false, autonomy: false, brains: 1, skillSlots: 5, history: false });
    expect(free.map((f) => f.key)).toEqual(["plans.f.agents", "plans.f.coins", "plans.f.stylesBasic", "plans.f.packsFree", "plans.f.brains", "plans.f.skills"]);
    expect(free.find((f) => f.key === "plans.f.brains")!.soon).toBeFalsy();
    const premium = planFeatures({ bots: 20, maxCoins: 8, styles: ["breezy", "bizzy", "boozy"], proThemes: true, autonomy: true, brains: 6, skillSlots: 30, history: true });
    expect(premium.filter((f) => f.soon).map((f) => f.key)).toEqual(["plans.f.skills"]);
    expect(premium.find((f) => f.key === "plans.f.agents")).toEqual({ key: "plans.f.agents", vars: { n: 20 } });
  });
});

describe("autonomous agents in the pages", () => {
  const d = { name: "Free Spirit", theme: "bunnies", avatar: "scout", style: "breezy", coins: [] as string[], rules: "Protect capital first, then trade.", tagline: "", look: "", listed: true };
  it("needs no style or coins from the member, but still a name and guidance", () => {
    expect(draftIssue({ ...d, mode: "autonomous", style: "", coins: [] }, 8)).toBeNull();
    expect(draftIssue({ ...d, mode: "fixed", coins: [] }, 8)?.key).toBe("prob.coins");
    expect(draftIssue({ ...d, mode: "autonomous", name: "" }, 8)?.key).toBe("prob.name");
    expect(stepIssue("style", { ...d, mode: "autonomous", style: "" }, 8)).toBeNull();
  });
  it("names the mode, not a style, for an autonomous agent", () => {
    expect(styleTitleKey("autonomous", "boozy")).toBe("style.auto.t");
    expect(styleTitleKey("fixed", "bizzy")).toBe("style.bizzy.t");
    expect(styleTitleKey(undefined, "breezy")).toBe("style.breezy.t");
  });
  it("names the autonomous league", () => {
    const t = (k: string) => ({ "league.autonomous": "Autonomous" })[k] ?? k;
    expect(leagueText("premium:autonomous", t as never)).toBe("Premium · Autonomous");
  });
});
