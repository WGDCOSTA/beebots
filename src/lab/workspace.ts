// The skill workshop: drafts of trading skills with versions, a walk-forward backtest per version, and a publish step.
// A draft can be written by the owner or proposed by a bee. Nothing here reaches a bee until it is published, and
// publishing wants a passing backtest on REAL history (the same bar a bee's own skill must clear: positive
// out-of-sample score, at least 50% of folds positive) unless the owner overrides it, in so many words.
//
//   <LAB_DIR>/workspace/<key>.json     one file per draft: its versions, backtests and status
//   <LAB_DIR>/learned/<owner_|slot_><id>.json   what publishing writes (already loaded by every lab run)
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Dataset } from "./history.js";
import { BUILTIN_SKILLS, skillFromSpec, type Skill } from "./skills/index.js";
import { DEFAULT_TOURNAMENT, evaluateSkill, type SkillResult } from "./tournament.js";

const BUILTIN_IDS = new Set(BUILTIN_SKILLS.map((s) => s.id));

export const KEY_RE = /^[a-z0-9_]{2,40}$/;
const MAX_VERSIONS = 30;
const MAX_JSON = 30_000;

export type DraftStatus = "draft" | "proposed" | "published" | "discarded";

export interface BacktestSummary {
  at: number;
  /** "synthetic" = the lab had no cached real history: the numbers exercise the skill and say nothing about markets. */
  data: "real" | "synthetic";
  datasets: string[];
  score: number;
  returnPct: number;
  benchmarkPct: number;
  sharpe: number;
  stabilityPct: number;
  trades: number;
  maxDrawdownPct: number;
  overfitGap: number;
  /** Clears the bar a bee's own skill must clear. */
  pass: boolean;
  why: string;
}

export interface Version {
  n: number;
  at: number;
  author: string;
  note: string;
  json: string;
  valid: boolean;
  errors: string[];
  backtest: BacktestSummary | null;
}

export interface Draft {
  key: string;
  author: string;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  publishedVersion: number | null;
  versions: Version[];
}

export interface DraftSummary {
  key: string;
  name: string;
  family: string;
  author: string;
  status: DraftStatus;
  updatedAt: number;
  versions: number;
  publishedVersion: number | null;
  valid: boolean;
  errors: string[];
  backtest: BacktestSummary | null;
}

export class WorkspaceError extends Error {}

/** Parse and compile a skill; the reason on failure is meant for the person editing it. */
export function validateSkill(json: string): { ok: true; skill: Skill; spec: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (json.length > MAX_JSON) return { ok: false, errors: [`too long (max ${MAX_JSON} characters)`] };
  let spec: unknown;
  try {
    spec = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [`not valid JSON: ${(err as Error).message}`] };
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, errors: ["a draft holds one skill: a JSON object"] };
  try {
    const skill = skillFromSpec(spec, "workshop draft");
    if (BUILTIN_IDS.has(skill.id)) return { ok: false, errors: [`id "${skill.id}" is a built-in skill; pick another id so it cannot replace it`] };
    return { ok: true, skill, spec: spec as Record<string, unknown> };
  } catch (err) {
    return { ok: false, errors: (err as Error).message.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 8) };
  }
}

export function summarize(r: Omit<SkillResult, "rank">, data: "real" | "synthetic", datasets: string[], at: number): BacktestSummary {
  const pass = r.score > 0 && r.stabilityPct >= 50;
  return {
    at,
    data,
    datasets,
    score: +r.score.toFixed(3),
    returnPct: +r.oos.returnPct.toFixed(2),
    benchmarkPct: +r.oos.benchmarkPct.toFixed(2),
    sharpe: +r.oos.sharpe.toFixed(2),
    stabilityPct: Math.round(r.stabilityPct),
    trades: r.oos.trades,
    maxDrawdownPct: +r.oos.maxDrawdownPct.toFixed(1),
    overfitGap: +r.overfitGap.toFixed(2),
    pass,
    why: `score ${r.score.toFixed(2)}, stability ${r.stabilityPct.toFixed(0)}%, out-of-sample ${r.oos.returnPct.toFixed(1)}% vs buy-and-hold ${r.oos.benchmarkPct.toFixed(1)}%${pass ? "" : " (not good enough)"}`,
  };
}

export class Workspace {
  private dir: string;
  private learned: string;

  constructor(
    private labDir: string,
    private now: () => number = Date.now,
  ) {
    this.dir = join(labDir, "workspace");
    this.learned = join(labDir, "learned");
  }

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new WorkspaceError("id: lowercase letters, digits and _ only (2 to 40)");
    return join(this.dir, `${key}.json`);
  }

  get(key: string): Draft | null {
    try {
      const p = this.path(key);
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Draft) : null;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      return null;
    }
  }

  private put(d: Draft): void {
    mkdirSync(this.dir, { recursive: true });
    const p = this.path(d.key);
    writeFileSync(`${p}.tmp`, JSON.stringify(d));
    renameSync(`${p}.tmp`, p);
  }

  list(): DraftSummary[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: DraftSummary[] = [];
    for (const f of files) {
      let d: Draft;
      try {
        d = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Draft;
      } catch {
        continue;
      }
      if (d.status === "discarded") continue;
      const v = d.versions[d.versions.length - 1];
      if (!v) continue;
      const parsed = validateSkill(v.json);
      out.push({
        key: d.key,
        name: parsed.ok ? parsed.skill.name : d.key,
        family: parsed.ok ? parsed.skill.family : "",
        author: d.author,
        status: d.status,
        updatedAt: d.updatedAt,
        versions: d.versions.length,
        publishedVersion: d.publishedVersion,
        valid: v.valid,
        errors: v.errors,
        backtest: v.backtest,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Save the text as the draft's newest version (unchanged text adds nothing). Broken JSON is kept: it is work in progress. */
  save(a: { key?: string; json: string; note?: string; author?: string; status?: DraftStatus }): Draft {
    const v = validateSkill(a.json);
    let key = a.key;
    if (!key && v.ok) key = String(v.spec.id);
    if (!key) throw new WorkspaceError("give the draft an id (in the JSON, or in the id field)");
    const at = this.now();
    const author = a.author ?? "owner";
    const existing = this.get(key);
    if (existing && existing.status === "discarded") existing.status = "draft";
    const d: Draft = existing ?? { key, author, status: a.status ?? "draft", createdAt: at, updatedAt: at, publishedVersion: null, versions: [] };
    const last = d.versions[d.versions.length - 1];
    if (last && last.json === a.json) return d;
    const next: Version = { n: (last?.n ?? 0) + 1, at, author, note: (a.note ?? "").slice(0, 200), json: a.json, valid: v.ok, errors: v.ok ? [] : v.errors, backtest: null };
    d.versions.push(next);
    // Keep the history bounded, but never drop the version that is live.
    while (d.versions.length > MAX_VERSIONS) {
      const i = d.versions.findIndex((x) => x.n !== d.publishedVersion);
      d.versions.splice(i < 0 ? 0 : i, 1);
    }
    d.updatedAt = at;
    // Editing a published or proposed draft makes it a draft again; the live version stays live until re-published.
    if (d.status === "published" || d.status === "proposed") d.status = a.status ?? "draft";
    this.put(d);
    return d;
  }

  /** Walk-forward backtest of the newest version, stored on it. */
  backtest(key: string, data: Dataset[]): { draft: Draft; summary: BacktestSummary } {
    const d = this.get(key);
    const v = d?.versions[d.versions.length - 1];
    if (!d || !v) throw new WorkspaceError("no such draft");
    const parsed = validateSkill(v.json);
    if (!parsed.ok) throw new WorkspaceError(`fix the draft first: ${parsed.errors[0]}`);
    const real = data.length > 0 && data.every((x) => x.source !== "synthetic");
    const result = evaluateSkill(parsed.skill, data, { ...DEFAULT_TOURNAMENT, maxCombos: 12 });
    v.backtest = summarize(result, real ? "real" : "synthetic", data.map((x) => x.id), this.now());
    d.updatedAt = this.now();
    this.put(d);
    return { draft: d, summary: v.backtest };
  }

  /** Make the newest version a live skill. Refused without a passing backtest on real data, unless `force`. */
  publish(key: string, o: { force?: boolean } = {}): { draft: Draft; skill: Skill; file: string } {
    const d = this.get(key);
    const v = d?.versions[d.versions.length - 1];
    if (!d || !v) throw new WorkspaceError("no such draft");
    const parsed = validateSkill(v.json);
    if (!parsed.ok) throw new WorkspaceError(`fix the draft first: ${parsed.errors[0]}`);
    const b = v.backtest;
    if (!o.force) {
      if (!b) throw new WorkspaceError("run the backtest on this version first");
      if (b.data !== "real") throw new WorkspaceError("this backtest ran on synthetic data, which says nothing about markets. Fetch real history (Real-data check) and backtest again, or publish anyway.");
      if (!b.pass) throw new WorkspaceError(`the backtest did not clear the bar (${b.why}). Improve it, or publish anyway.`);
    }
    // A draft may not take a built-in's id (validateSkill), and its file is owner_<id>, so it never overwrites a bee's skill file.
    const spec = { ...parsed.spec, id: String(parsed.spec.id) };
    const file = join(this.learned, `owner_${spec.id}.json`);
    mkdirSync(this.learned, { recursive: true });
    writeFileSync(file, JSON.stringify(spec, null, 2));
    d.status = "published";
    d.publishedVersion = v.n;
    d.updatedAt = this.now();
    this.put(d);
    return { draft: d, skill: parsed.skill, file };
  }

  discard(key: string): void {
    const d = this.get(key);
    if (!d) throw new WorkspaceError("no such draft");
    d.status = "discarded";
    d.updatedAt = this.now();
    this.put(d);
  }

  /** A skill a bee wrote: kept as a draft the owner can read, improve and re-test (accepted ones are already live). */
  recordBee(a: { slot: string; brain: string; id: string; raw: string; result: Omit<SkillResult, "rank"> | null; real: boolean; datasets: string[]; accepted: boolean }): void {
    if (!KEY_RE.test(a.id)) return;
    let json = a.raw;
    try {
      json = JSON.stringify({ ...(JSON.parse(a.raw) as object), id: a.id }, null, 2);
    } catch {
      /* keep the raw text: it is still the bee's work */
    }
    const d = this.save({ key: a.id, json, author: a.slot, note: `written by ${a.brain}`, status: a.accepted ? "published" : "proposed" });
    const v = d.versions[d.versions.length - 1]!;
    if (a.result && !v.backtest) v.backtest = summarize(a.result, a.real ? "real" : "synthetic", a.datasets, this.now());
    if (a.accepted) d.publishedVersion = v.n;
    this.put(d);
  }
}

/** Starting points for a new draft. All long-only rules in the JSON rule language; they are examples, not recommendations. */
export const TEMPLATES: Array<{ id: string; label: string; json: string }> = [
  {
    id: "rsi_dip",
    label: "Dip in an uptrend (RSI)",
    json: JSON.stringify(
      {
        id: "my_rsi_dip",
        name: "My RSI dip",
        family: "mean_reversion",
        description: "Above the 100 EMA, buy an oversold RSI, sell the bounce.",
        params: { lo: { default: 30, grid: [20, 30, 35] } },
        stoploss: -0.06,
        long: { entry: [{ left: "close", op: ">", right: "ema(100)" }, { left: "rsi(14)", op: "<", right: "$lo" }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] },
      },
      null,
      2,
    ),
  },
  {
    id: "breakout",
    label: "Channel breakout",
    json: JSON.stringify(
      {
        id: "my_breakout",
        name: "My breakout",
        family: "breakout",
        description: "Buy a close above the prior 20-bar high, leave under the prior 10-bar low.",
        params: { n: { default: 20, grid: [10, 20, 40] } },
        stopAtr: 3,
        long: { entry: [{ left: "close", op: ">", right: "highest($n)" }], exit: [{ left: "close", op: "<", right: "lowest(10)" }] },
      },
      null,
      2,
    ),
  },
  {
    id: "ema_cross",
    label: "EMA crossover with a trend filter",
    json: JSON.stringify(
      {
        id: "my_ema_cross",
        name: "My EMA cross",
        family: "trend",
        description: "Fast EMA crosses above slow while ADX shows a trend.",
        params: { fast: { default: 12, grid: [8, 12, 20] } },
        stopAtr: 2.5,
        long: { entry: [{ left: "ema($fast)", op: "crosses_above", right: "ema(50)" }, { left: "adx(14)", op: ">", right: 20 }], exit: [{ left: "ema($fast)", op: "crosses_below", right: "ema(50)" }] },
      },
      null,
      2,
    ),
  },
];
