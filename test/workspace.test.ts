import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_MS, syntheticCandles, type Dataset } from "../src/lab/history.js";
import { TEMPLATES, validateSkill, Workspace, WorkspaceError } from "../src/lab/workspace.js";

const dir = () => mkdtempSync(join(tmpdir(), "ws-"));
const skill = (id = "my_dip", extra: object = {}) =>
  JSON.stringify({ id, name: "My dip", family: "mean_reversion", long: { entry: [{ left: "rsi(14)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] }, ...extra });
const data = (source: Dataset["source"]): Dataset[] => [{ id: "T 1H", instId: "T", bar: "1H", candles: syntheticCandles(5, 2500, BAR_MS["1H"]), source }];

describe("skill workshop", () => {
  it("validates in plain words, and refuses a built-in's id", () => {
    expect(validateSkill("{nope").ok).toBe(false);
    expect(validateSkill("[1]")).toMatchObject({ ok: false });
    const bad = validateSkill(skill("my_dip", { long: { entry: [{ left: "magic(1)", op: ">", right: 1 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } }));
    expect(bad.ok ? "" : bad.errors.join(" ")).toMatch(/unknown indicator/);
    expect(validateSkill(skill("buy_hold"))).toMatchObject({ ok: false });
    expect(validateSkill(skill())).toMatchObject({ ok: true });
    for (const t of TEMPLATES) expect(validateSkill(t.json).ok).toBe(true);
  });

  it("keeps versions, ignores an unchanged save, and keeps broken work in progress", () => {
    const w = new Workspace(dir(), () => 1000);
    const d1 = w.save({ json: skill() });
    expect(d1).toMatchObject({ key: "my_dip", status: "draft", author: "owner" });
    expect(w.save({ json: skill() }).versions).toHaveLength(1);
    w.save({ json: skill("my_dip", { description: "v2" }), note: "tweak" });
    expect(w.get("my_dip")!.versions.map((v) => v.n)).toEqual([1, 2]);
    const broken = w.save({ key: "my_dip", json: "{ half a thought" });
    expect(broken.versions.at(-1)).toMatchObject({ valid: false });
    expect(() => w.save({ json: "{ half a thought" })).toThrow(/give the draft an id/);
    expect(() => w.get("../etc")).toThrow(WorkspaceError);
    expect(w.list()).toHaveLength(1);
    expect(w.list()[0]).toMatchObject({ key: "my_dip", valid: false, versions: 3 });
  });

  it("caps the history but never drops the live version", () => {
    const w = new Workspace(dir());
    w.save({ json: skill() });
    w.publish("my_dip", { force: true });
    for (let i = 0; i < 40; i++) w.save({ json: skill("my_dip", { description: `v${i}` }) });
    const d = w.get("my_dip")!;
    expect(d.versions.length).toBeLessThanOrEqual(30);
    expect(d.versions.some((v) => v.n === d.publishedVersion)).toBe(true);
  });

  it("publishes only after a backtest on real data that clears the bar, unless forced", () => {
    const root = dir();
    const w = new Workspace(root);
    w.save({ json: skill() });
    expect(() => w.publish("my_dip")).toThrow(/backtest on this version first/);
    const syn = w.backtest("my_dip", data("synthetic"));
    expect(syn.summary.data).toBe("synthetic");
    expect(() => w.publish("my_dip")).toThrow(/synthetic data/);
    const real = w.backtest("my_dip", data("okx"));
    expect(real.summary.data).toBe("real");
    if (real.summary.pass) {
      expect(w.publish("my_dip").draft.status).toBe("published");
    } else {
      expect(() => w.publish("my_dip")).toThrow(/did not clear the bar/);
      expect(existsSync(join(root, "learned", "owner_my_dip.json"))).toBe(false);
    }
    const forced = w.publish("my_dip", { force: true });
    expect(forced.skill.id).toBe("my_dip");
    expect(JSON.parse(readFileSync(join(root, "learned", "owner_my_dip.json"), "utf8")).id).toBe("my_dip");
    expect(w.get("my_dip")).toMatchObject({ status: "published", publishedVersion: 1 });
    // A new version invalidates the old backtest: it has to be tested again.
    w.save({ json: skill("my_dip", { description: "changed" }) });
    expect(w.get("my_dip")!.versions.at(-1)!.backtest).toBeNull();
    expect(() => w.publish("my_dip")).toThrow(/backtest on this version first/);
  });

  it("refuses to backtest or publish a broken draft", () => {
    const w = new Workspace(dir());
    w.save({ key: "half", json: "{ nope" });
    expect(() => w.backtest("half", data("okx"))).toThrow(/fix the draft first/);
    expect(() => w.publish("half", { force: true })).toThrow(/fix the draft first/);
  });

  it("hides discarded drafts, and a save brings one back", () => {
    const w = new Workspace(dir());
    w.save({ json: skill() });
    w.discard("my_dip");
    expect(w.list()).toHaveLength(0);
    w.save({ json: skill("my_dip", { description: "back" }) });
    expect(w.list()).toHaveLength(1);
    expect(() => w.discard("nothing_here")).toThrow(/no such draft/);
  });

  it("keeps what a bee wrote, accepted or proposed, with its backtest", () => {
    const w = new Workspace(dir(), () => 5);
    const result = { score: 0.4, stabilityPct: 66, overfitGap: 0.1, oos: { returnPct: 8, benchmarkPct: 3, sharpe: 1, trades: 30, maxDrawdownPct: 9 } } as never;
    w.recordBee({ slot: "bee1", brain: "Claude", id: "bee1_dip", raw: skill("dip"), result, real: true, datasets: ["BTC 1H"], accepted: true });
    w.recordBee({ slot: "bee2", brain: "ChatGPT", id: "bee2_weak", raw: skill("weak"), result: { ...(result as object), score: -1 } as never, real: false, datasets: ["SYN1 1H"], accepted: false });
    const list = w.list();
    expect(list.find((d) => d.key === "bee1_dip")).toMatchObject({ status: "published", author: "bee1", backtest: { pass: true, data: "real" } });
    expect(list.find((d) => d.key === "bee2_weak")).toMatchObject({ status: "proposed", backtest: { pass: false, data: "synthetic" } });
    expect(JSON.parse(w.get("bee1_dip")!.versions[0]!.json).id).toBe("bee1_dip");
  });
});
