import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPlan, preflight, verdicts } from "../src/admin/check.js";
import { LabJobs } from "../src/admin/jobs.js";
import type { ScalpReport } from "../src/lab/scalp.js";

const dir = () => mkdtempSync(join(tmpdir(), "check-"));
const NOW = Date.UTC(2026, 8, 29);

describe("real-data check plan", () => {
  it("builds the roteiro's steps and skips what has nothing to run on", () => {
    const d = dir();
    const plan = checkPlan(["skills", "scalper", "gold", "council", "report"], { labDir: d, hasBrain: false });
    expect(plan.map((p) => p.id)).toEqual(["skills-fetch", "skills-run", "scalp-fetch", "scalp-run", "gold-wf", "gold-mc", "gold-st", "council", "report"]);
    expect(plan.find((p) => p.id === "skills-fetch")!.argv).toEqual(["fetch", "--bar", "1H", "--days", "365"]);
    expect(plan.find((p) => p.id === "scalp-fetch")!.argv).toEqual(["fetch", "--bar", "1m", "--days", "14"]);
    expect(plan.find((p) => p.id === "gold-wf")!.skip).toMatch(/no MT5 export/);
    expect(plan.find((p) => p.id === "council")!.skip).toMatch(/no brain/);
    mkdirSync(join(d, "gold", "data"), { recursive: true });
    writeFileSync(join(d, "gold", "data", "XAUUSD_M5.csv"), "x");
    const g = checkPlan(["gold", "council"], { labDir: d, hasBrain: true }).filter((p) => p.stage === "gold");
    expect(g.every((p) => !p.skip)).toBe(true);
    expect(g[0]!.argv).toContain(join(d, "gold", "data", "XAUUSD_M5.csv"));
    expect(g[0]!.argv).toEqual(expect.arrayContaining(["--base", "M5", "--balance", "500000"]));
    expect(checkPlan(["council"], { labDir: d, hasBrain: true })[0]!.skip).toBeUndefined();
  });

  it("reports what is ready, never a key", () => {
    const p = preflight({ mode: "dry", keys: { jev: { set: true }, coinmarketcap: { set: false } }, hasBees: true, labDir: dir() });
    expect(p.find((i) => i.id === "brains")).toMatchObject({ ok: true, note: "jev" });
    expect(p.find((i) => i.id === "cmc")!.ok).toBe(false);
    expect(p.find((i) => i.id === "gold")!.ok).toBe(false);
    expect(p.find((i) => i.id === "paper")!.ok).toBe(true);
  });
});

describe("real-data verdicts", () => {
  const graph = { skill: 3, edges: 5 };
  it("says none when nothing ran", () => {
    const v = verdicts(dir(), { now: NOW, maxAgeDays: 14, graph: {} });
    expect(v.map((x) => x.status)).toEqual(["none", "none", "none", "none"]);
  });

  it("judges the ranking on real data only, against buy-and-hold", () => {
    const d = dir();
    const res = (skillId: string, ret: number, bench: number, stab: number, family = "trend") => ({ skillId, name: skillId, family, stabilityPct: stab, oos: { returnPct: ret, benchmarkPct: bench, trades: 20 } });
    writeFileSync(join(d, "ranking.json"), JSON.stringify({ createdAt: NOW - 86_400_000, datasets: [{ source: "okx" }], results: [res("a", 12, 5, 75), res("b", 4, 5, 90), res("c", 9, 1, 40), res("buy_hold", 5, 5, 100, "benchmark")] }));
    const s = verdicts(d, { now: NOW, maxAgeDays: 14, graph })[0]!;
    expect(s.status).toBe("pass");
    expect(s.headline).toMatch(/^1 of 3 skills beat buy-and-hold/);
    writeFileSync(join(d, "ranking.json"), JSON.stringify({ createdAt: NOW - 86_400_000, datasets: [{ source: "okx" }], results: [res("b", 4, 5, 90)] }));
    expect(verdicts(d, { now: NOW, maxAgeDays: 14, graph })[0]!.status).toBe("fail");
    writeFileSync(join(d, "ranking.json"), JSON.stringify({ createdAt: NOW - 30 * 86_400_000, datasets: [{ source: "okx" }], results: [res("a", 12, 5, 75)] }));
    expect(verdicts(d, { now: NOW, maxAgeDays: 14, graph })[0]!.status).toBe("stale");
    writeFileSync(join(d, "ranking.json"), JSON.stringify({ createdAt: NOW, datasets: [{ source: "synthetic" }], results: [res("a", 12, 5, 75)] }));
    expect(verdicts(d, { now: NOW, maxAgeDays: 14, graph })[0]!.status).toBe("none");
  });

  it("opens the scalper verdict only for a real, fresh edge", () => {
    const d = dir();
    const rep = (source: "real" | "synthetic", edge: boolean, age = 1): ScalpReport =>
      ({ createdAt: NOW - age * 86_400_000, costs: {}, opts: {}, source, datasets: [], results: [], verdict: { edge, note: "nothing cleared 3x costs", passing: edge ? [{ dataset: "BTC 1m", ruleId: "micro_breakout", params: {}, netBps: 1.4, trades: 120 }] : [] } }) as unknown as ScalpReport;
    const put = (r: ScalpReport) => writeFileSync(join(d, "scalp-report.json"), JSON.stringify(r));
    const at = () => verdicts(d, { now: NOW, maxAgeDays: 14, graph: {} })[1]!;
    put(rep("real", true));
    expect(at().status).toBe("pass");
    put(rep("real", false));
    expect(at()).toMatchObject({ status: "fail" });
    put(rep("real", true, 30));
    expect(at().status).toBe("stale");
    put(rep("synthetic", true));
    expect(at().status).toBe("none");
  });

  it("counts a gold gate that did not run as not passed", () => {
    const d = dir();
    const reports = join(d, "gold", "reports");
    mkdirSync(reports, { recursive: true });
    const metrics = { profitFactor: 1.4 };
    writeFileSync(join(reports, "walkforward-a.json"), JSON.stringify({ portfolioMetrics: metrics, walkForward: { totalWindows: 5, positiveWindows: 4, oos: { expectancyR: 0.2, trades: 90 } } }));
    const g = verdicts(d, { now: NOW, maxAgeDays: 14, graph: {} })[2]!;
    expect(g.status).toBe("incomplete");
    expect(g.details.some((l) => l.startsWith("not run: Monte Carlo"))).toBe(true);
    writeFileSync(join(reports, "walkforward-a.json"), JSON.stringify({ portfolioMetrics: metrics, walkForward: { totalWindows: 5, positiveWindows: 1, oos: { expectancyR: -0.2, trades: 90 } } }));
    expect(verdicts(d, { now: NOW, maxAgeDays: 14, graph: {} })[2]!.status).toBe("fail");
  });

  it("summarises the hive mind without counting links as nodes", () => {
    expect(verdicts(dir(), { now: NOW, maxAgeDays: 14, graph: { skill: 3, bee: 2, edges: 9 } })[3]!.headline).toMatch(/^5 items/);
  });
});

describe("running the check", () => {
  function rig() {
    const d = dir();
    const script = join(d, "lab.ts");
    writeFileSync(script, "");
    writeFileSync(join(d, "gold.ts"), "");
    const runs: Array<{ file: string; argv: string[]; child: EventEmitter & { stdout: EventEmitter } }> = [];
    const spawnFn = ((_: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
      runs.push({ file: args.find((a) => a.endsWith(".ts"))!, argv: args.slice(args.findIndex((a) => a.endsWith(".ts")) + 1), child });
      return child;
    }) as never;
    let done = 0;
    const jobs = new LabJobs(() => ({}), () => done++, spawnFn, script);
    const finish = async (i: number, code: number, out = "") => {
      await new Promise((r) => setImmediate(r));
      if (out) runs[i]!.child.stdout.emit("data", Buffer.from(out));
      runs[i]!.child.emit("close", code);
      await new Promise((r) => setImmediate(r));
    };
    return { d, jobs, runs, finish, done: () => done };
  }

  it("runs the steps in order and marks a soft-failed download", async () => {
    const { d, jobs, runs, finish, done } = rig();
    const j = jobs.startCheck(["skills", "report"], { labDir: d, hasBrain: true });
    expect(j).toMatchObject({ command: "check", state: "running" });
    expect(() => jobs.startCheck(["report"], { labDir: d, hasBrain: true })).toThrow(/already running/);
    await finish(0, 0, "fetching BTC-USDT-SWAP 1H (365 days)... failed: timeout\n");
    await finish(1, 0);
    await finish(2, 0);
    expect(runs.map((r) => r.argv[0])).toEqual(["fetch", "run", "report"]);
    expect(j.steps!.map((s) => s.state)).toEqual(["done", "done", "done"]);
    expect(j.steps![0]!.note).toMatch(/1 download failed/);
    expect(j).toMatchObject({ state: "done", exitCode: 0 });
    expect(done()).toBe(1);
  });

  it("skips the rest of a stage after a failure but still runs the others", async () => {
    const { d, jobs, runs, finish } = rig();
    const j = jobs.startCheck(["skills", "report"], { labDir: d, hasBrain: true });
    await finish(0, 1, "boom\n");
    await finish(1, 0);
    expect(runs.map((r) => r.argv[0])).toEqual(["fetch", "report"]);
    expect(j.steps!.map((s) => s.state)).toEqual(["failed", "skipped", "done"]);
    expect(j.state).toBe("failed");
  });

  it("runs gold steps with the gold tool and skips them without data", async () => {
    const { d, jobs, runs, finish } = rig();
    const j = jobs.startCheck(["gold", "report"], { labDir: d, hasBrain: true });
    await finish(0, 0);
    expect(j.steps!.filter((s) => s.stage === "gold").every((s) => s.state === "skipped")).toBe(true);
    expect(runs).toHaveLength(1);
    mkdirSync(join(d, "gold", "data"), { recursive: true });
    writeFileSync(join(d, "gold", "data", "x.csv"), "x");
    const j2 = jobs.startCheck(["gold"], { labDir: d, hasBrain: true });
    await finish(1, 0);
    expect(runs[1]!.file.endsWith("gold.ts")).toBe(true);
    expect(runs[1]!.argv[0]).toBe("walkforward");
    await finish(2, 0);
    await finish(3, 0);
    expect(j2.state).toBe("done");
  });

  it("stop abandons what is left", async () => {
    const { d, jobs, finish } = rig();
    const j = jobs.startCheck(["skills", "scalper"], { labDir: d, hasBrain: true });
    await new Promise((r) => setImmediate(r));
    jobs.stop();
    await finish(0, 143);
    expect(j.state).toBe("failed");
    expect(j.steps!.slice(1).every((s) => s.state === "skipped")).toBe(true);
  });
});
