// Loading and writing the skill's configuration files. JSON, not YAML: the repo has no YAML dependency and the lab
// already imports its skills as JSON. `default.json` holds the engine config; `s1.json`..`s9.json` one profile each.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultEngine, defaultProfiles } from "./profiles.js";
import { EngineSchema, NewsEvent, STRATEGY_IDS, StrategySchema, type EngineConfig, type StrategyProfile } from "./types.js";

export const SKILL_DIR = "skills/multi-strategy-gold-breakout";

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as unknown;

/** The engine config in `dir`/default.json (if any) with `over` merged on top, validated. */
export function loadEngineConfig(dir?: string, over: Record<string, unknown> = {}): EngineConfig {
  const file = dir ? join(dir, "default.json") : "";
  const base = file && existsSync(file) ? (read(file) as Record<string, unknown>) : {};
  return EngineSchema.parse(deepMerge(base, over));
}

/** Profiles: the built-in nine, each replaced by `dir`/sN.json when that file exists. Bad files are errors, not skips. */
export function loadProfiles(dir?: string): StrategyProfile[] {
  return defaultProfiles().map((d) => {
    const f = dir ? join(dir, `${d.id.toLowerCase()}.json`) : "";
    return f && existsSync(f) ? StrategySchema.parse(read(f)) : d;
  });
}

/** Write the built-in configuration as JSON files, so they can be edited. Returns the paths. */
export function writeDefaultConfigs(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const put = (name: string, v: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
    out.push(p);
  };
  put("default.json", defaultEngine());
  for (const p of defaultProfiles()) put(`${p.id.toLowerCase()}.json`, p);
  return out;
}

export function deepMerge(a: unknown, b: unknown): Record<string, unknown> {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  const out: Record<string, unknown> = isObj(a) ? { ...a } : {};
  if (!isObj(b)) return out;
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/**
 * A news calendar from CSV: `time,name,impact` with an ISO time (UTC unless it ends in an offset). No calendar is
 * bundled with the skill: hard-coding "NFP is the first Friday" is wrong often enough to be worse than no filter.
 */
export function parseNewsCsv(text: string): NewsEvent[] {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift()!.toLowerCase().split(",").map((h) => h.trim());
  const iT = head.indexOf("time");
  const iN = head.indexOf("name");
  const iI = head.indexOf("impact");
  if (iT < 0) throw new Error("the news CSV needs a `time` column (ISO, UTC), optionally `name` and `impact`");
  const out: NewsEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split(",");
    const raw = f[iT]!.trim();
    const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`);
    if (Number.isFinite(t)) out.push(NewsEvent.parse({ time: t, name: iN >= 0 ? f[iN]!.trim() : "event", impact: iI >= 0 && f[iI] ? f[iI]!.trim().toLowerCase() : "high" }));
  }
  return out.sort((x, y) => x.time - y.time);
}

/** Public trade records for the black-box fit: `entry_time,entry_price,direction[,exit_time,exit_price]`. */
export function parseTradesCsv(text: string): Array<{ entryTs: number; entryPx: number; direction: "BUY" | "SELL"; exitTs?: number; exitPx?: number }> {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.shift()!.toLowerCase().split(",").map((h) => h.trim());
  const ix = (n: string) => head.indexOf(n);
  const [iT, iP, iD, iXT, iXP] = [ix("entry_time"), ix("entry_price"), ix("direction"), ix("exit_time"), ix("exit_price")];
  if (iT < 0 || iP < 0 || iD < 0) throw new Error("the trades CSV needs entry_time, entry_price and direction (buy/sell); exit_time and exit_price are optional");
  const ts = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s.trim()) ? s.trim() : `${s.trim()}Z`);
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split(",");
    const d = f[iD]!.trim().toUpperCase();
    const t = { entryTs: ts(f[iT]!), entryPx: Number(f[iP]), direction: (d.startsWith("B") || d === "LONG" ? "BUY" : "SELL") as "BUY" | "SELL", ...(iXT >= 0 && f[iXT] ? { exitTs: ts(f[iXT]!) } : {}), ...(iXP >= 0 && f[iXP] ? { exitPx: Number(f[iXP]) } : {}) };
    if (Number.isFinite(t.entryTs) && Number.isFinite(t.entryPx)) out.push(t);
  }
  return out;
}

export { STRATEGY_IDS };
