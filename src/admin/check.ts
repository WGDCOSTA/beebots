// The "real-data check": everything the roteiro asks you to type, as one background job the Admin panel starts.
// It places no orders and needs no exchange account: public candles, the lab, the council. This file is the pure part
// (the plan of steps, the preflight, the verdicts read back from the reports); LabJobs.startCheck runs the plan.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadScalpReport, scalpGate } from "../lab/scalp.js";
import { validationGates, type Gate } from "../lab/gold/research/report.js";

export const CHECK_STAGES = ["skills", "scalper", "gold", "council", "report"] as const;
export type CheckStage = (typeof CHECK_STAGES)[number];

export interface CheckStep {
  id: string;
  stage: CheckStage;
  label: string;
  tool: "lab" | "gold";
  argv: string[];
  /** Why this step will not run (nothing to run it on): shown, not an error. */
  skip?: string;
}

export interface CheckOpts {
  labDir: string;
  /** A brain has a key: the council needs one. */
  hasBrain: boolean;
  /** Research balance for the gold engine (small accounts cannot size the slow strategies). */
  goldBalance?: number;
  goldBase?: "M1" | "M5" | "M15" | "M30" | "H1";
}

/** MT5 "Export bars" CSVs the owner dropped into <LAB_DIR>/gold/data. */
export function goldCsvs(labDir: string): string[] {
  const dir = join(labDir, "gold", "data");
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export function checkPlan(stages: readonly CheckStage[], o: CheckOpts): CheckStep[] {
  const want = new Set(stages);
  const steps: CheckStep[] = [];
  if (want.has("skills")) {
    steps.push({ id: "skills-fetch", stage: "skills", label: "Download 1H history (365 days)", tool: "lab", argv: ["fetch", "--bar", "1H", "--days", "365"] });
    steps.push({ id: "skills-run", stage: "skills", label: "Rank every skill, walk-forward", tool: "lab", argv: ["run", "--bar", "1H", "--folds", "3"] });
  }
  if (want.has("scalper")) {
    steps.push({ id: "scalp-fetch", stage: "scalper", label: "Download 1-minute history (14 days)", tool: "lab", argv: ["fetch", "--bar", "1m", "--days", "14"] });
    steps.push({ id: "scalp-run", stage: "scalper", label: "Does a 1m scalp survive its costs?", tool: "lab", argv: ["scalp", "--folds", "4"] });
  }
  if (want.has("gold")) {
    const csv = goldCsvs(o.labDir)[0];
    const skip = csv ? undefined : `no MT5 export found: put a bar CSV of XAUUSD in ${join(o.labDir, "gold", "data")}`;
    const base = o.goldBase ?? "M5";
    const common = (csv ? ["--csv", csv] : []).concat(["--base", base, "--balance", String(o.goldBalance ?? 500_000)]);
    const step = (id: string, label: string, argv: string[]): CheckStep => ({ id, stage: "gold", label, tool: "gold", argv: [...argv, ...common], ...(skip ? { skip } : {}) });
    steps.push(step("gold-wf", "Gold walk-forward", ["walkforward", "--strategies", "S4,S5"]));
    steps.push(step("gold-mc", "Gold Monte Carlo", ["montecarlo", "--strategies", "S4,S5", "--runs", "1000"]));
    steps.push(step("gold-st", "Gold parameter stability", ["stability", "--strategy", "S4", "--dims", "arm,sl,tp"]));
  }
  if (want.has("council")) {
    steps.push({
      id: "council",
      stage: "council",
      label: "Council: each bee's brain picks skills",
      tool: "lab",
      argv: ["council"],
      ...(o.hasBrain ? {} : { skip: "no brain has a key yet (Admin → API keys)" }),
    });
  }
  if (want.has("report")) steps.push({ id: "report", stage: "report", label: "Hive mind report", tool: "lab", argv: ["report"] });
  return steps;
}

export interface PreflightItem {
  id: string;
  label: string;
  ok: boolean;
  /** Must be ok for the check to mean something; the rest only narrow it. */
  required: boolean;
  note: string;
}

export function preflight(a: { mode: string; keys: Record<string, { set: boolean }>; hasBees: boolean; labDir: string }): PreflightItem[] {
  const brains = ["jev", "openai", "anthropic", "kimi"].filter((k) => a.keys[k]?.set);
  const csv = goldCsvs(a.labDir);
  return [
    { id: "paper", label: "Paper mode", ok: a.mode === "dry", required: false, note: a.mode === "dry" ? "No real orders anywhere. The check places none in any mode." : `The engine runs in ${a.mode} mode. The check itself still places no orders.` },
    { id: "brains", label: "A brain has a key", ok: brains.length > 0, required: false, note: brains.length ? brains.join(", ") : "The council will be skipped until a brain has a key." },
    { id: "cmc", label: "CoinMarketCap key", ok: !!a.keys.coinmarketcap?.set, required: false, note: a.keys.coinmarketcap?.set ? "Market context on." : "Optional: only the market context needs it." },
    { id: "bees", label: "Bees configured", ok: a.hasBees, required: false, note: a.hasBees ? "Their playbooks are what the council fills." : "Run Setup to create the bees first." },
    { id: "gold", label: "Gold data (MT5 export)", ok: csv.length > 0, required: false, note: csv.length ? csv.map((f) => f.split("/").pop()).join(", ") : `Optional: drop an XAUUSD bar CSV in ${join(a.labDir, "gold", "data")}` },
  ];
}

export type VerdictStatus = "pass" | "fail" | "none" | "stale" | "incomplete";
export interface StageVerdict {
  stage: "skills" | "scalper" | "gold" | "hive";
  title: string;
  status: VerdictStatus;
  headline: string;
  details: string[];
  at: number | null;
}

const DAY = 86_400_000;
const readJson = <T,>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
  } catch {
    return null;
  }
};

interface RankingLite {
  createdAt: number;
  datasets: Array<{ source: string }>;
  results: Array<{ skillId: string; name: string; family: string; stabilityPct: number; oos: { returnPct: number; benchmarkPct: number; trades: number } }>;
}

function skillsVerdict(labDir: string, now: number, maxAgeDays: number): StageVerdict {
  const base = { stage: "skills" as const, title: "Skills (hourly, walk-forward)" };
  const r = readJson<RankingLite>(join(labDir, "ranking.json"));
  if (!r) return { ...base, status: "none", headline: "No ranking yet.", details: [], at: null };
  const real = r.datasets.filter((d) => d.source !== "synthetic").length;
  if (!real) return { ...base, status: "none", headline: "The last ranking used only synthetic data, which says nothing about markets.", details: [], at: r.createdAt };
  const cands = r.results.filter((x) => x.family !== "benchmark" && x.oos.trades > 0);
  const beat = cands.filter((x) => x.oos.returnPct > 0 && x.oos.returnPct > x.oos.benchmarkPct && x.stabilityPct >= 60).sort((a, b) => b.oos.returnPct - a.oos.returnPct);
  const details = beat.slice(0, 5).map((x) => `${x.name}: ${x.oos.returnPct.toFixed(1)}% out of sample vs ${x.oos.benchmarkPct.toFixed(1)}% buy-and-hold, positive in ${x.stabilityPct.toFixed(0)}% of folds`);
  const age = (now - r.createdAt) / DAY;
  if (age > maxAgeDays) return { ...base, status: "stale", headline: `The ranking is ${age.toFixed(0)} days old. Run the check again.`, details, at: r.createdAt };
  return beat.length
    ? { ...base, status: "pass", headline: `${beat.length} of ${cands.length} skills beat buy-and-hold out of sample, positive in at least 60% of folds, on ${real} real dataset${real > 1 ? "s" : ""}.`, details, at: r.createdAt }
    : { ...base, status: "fail", headline: `None of ${cands.length} skills beat buy-and-hold out of sample on ${real} real dataset${real > 1 ? "s" : ""}. That is an answer: do not expect these skills to add value.`, details, at: r.createdAt };
}

function scalperVerdict(labDir: string, now: number, maxAgeDays: number): StageVerdict {
  const base = { stage: "scalper" as const, title: "Scalper (1-minute, after costs)" };
  const rep = loadScalpReport(labDir);
  if (!rep) return { ...base, status: "none", headline: "No scalper report yet.", details: [], at: null };
  if (rep.source !== "real") return { ...base, status: "none", headline: "The last scalper report used synthetic data. It never opens the gate.", details: [], at: rep.createdAt };
  const gate = scalpGate(rep, now, maxAgeDays);
  const details = rep.verdict.passing.slice(0, 5).map((p) => `${p.dataset} ${p.ruleId}: ${p.netBps.toFixed(2)} bps per trade net of costs over ${p.trades} trades`);
  if (gate.open) return { ...base, status: "pass", headline: `Edge after costs on ${rep.verdict.passing.length} rule/instrument pair${rep.verdict.passing.length > 1 ? "s" : ""}. The gate is open (the scalper stays off until you switch it on).`, details, at: rep.createdAt };
  if (rep.verdict.edge) return { ...base, status: "stale", headline: gate.reason, details, at: rep.createdAt };
  return { ...base, status: "fail", headline: `No edge after costs (${rep.verdict.note.replace(/\.$/, "")}). Keep the scalper off.`, details, at: rep.createdAt };
}

interface GoldRep {
  portfolioMetrics: Parameters<typeof validationGates>[0];
  walkForward: Parameters<typeof validationGates>[1]["walkForward"] | null;
  monteCarlo: Parameters<typeof validationGates>[1]["monteCarlo"] | null;
  parameterStability: Parameters<typeof validationGates>[1]["stability"] | null;
  reproducibility?: { data_hash?: string };
}

function newest(dir: string, prefix: string): { rep: GoldRep; at: number } | null {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    const top = files[0];
    const rep = top ? readJson<GoldRep>(join(dir, top.f)) : null;
    return top && rep ? { rep, at: top.t } : null;
  } catch {
    return null;
  }
}

function goldVerdict(labDir: string): StageVerdict {
  const base = { stage: "gold" as const, title: "Gold breakout (research only)" };
  const dir = join(labDir, "gold", "reports");
  const wf = newest(dir, "walkforward-");
  const mc = newest(dir, "montecarlo-");
  const st = newest(dir, "stability-");
  if (!wf && !mc && !st) return { ...base, status: "none", headline: "No gold report yet.", details: [], at: null };
  const head = (wf ?? mc ?? st)!;
  const gates: Gate[] = validationGates(head.rep.portfolioMetrics, {
    ...(wf?.rep.walkForward ? { walkForward: wf.rep.walkForward } : {}),
    ...(mc?.rep.monteCarlo ? { monteCarlo: mc.rep.monteCarlo } : {}),
    ...(st?.rep.parameterStability ? { stability: st.rep.parameterStability } : {}),
  });
  const details = gates.map((g) => `${g.status === "pass" ? "pass" : g.status === "fail" ? "FAIL" : "not run"}: ${g.name} (${g.detail})`);
  const failed = gates.filter((g) => g.status === "fail").length;
  const notRun = gates.filter((g) => g.status === "not run").length;
  const at = Math.max(wf?.at ?? 0, mc?.at ?? 0, st?.at ?? 0);
  if (failed) return { ...base, status: "fail", headline: `${failed} of ${gates.length} validation gates failed. The engine stays research only.`, details, at };
  if (notRun) return { ...base, status: "incomplete", headline: `${notRun} gate${notRun > 1 ? "s were" : " was"} not run; a gate that did not run is not passed.`, details, at };
  return { ...base, status: "pass", headline: "All validation gates passed on this data. That is a reason to paper trade it, not evidence of future profit.", details, at };
}

export function verdicts(labDir: string, o: { now: number; maxAgeDays: number; graph: Record<string, number> }): StageVerdict[] {
  const kinds = Object.entries(o.graph).filter(([k]) => k !== "edges");
  const nodes = kinds.reduce((a, [, v]) => a + v, 0);
  return [
    skillsVerdict(labDir, o.now, o.maxAgeDays),
    scalperVerdict(labDir, o.now, o.maxAgeDays),
    goldVerdict(labDir),
    { stage: "hive", title: "Hive mind", status: nodes ? "pass" : "none", headline: nodes ? `${nodes} items in memory (${kinds.map(([k, v]) => `${v} ${k}`).join(", ")}; ${o.graph.edges ?? 0} links).` : "The hive mind is empty until the lab and the council run.", details: [], at: null },
  ];
}
