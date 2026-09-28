// The multi-strategy gold breakout research harness, from the command line. Simulation and research only: there is no
// execution here, live trading is refused, and nothing touches an exchange or a broker.
//
//   pnpm gold run         --csv XAUUSD_M5.csv --base M5 [--frequency MODERATE] [--strategies S1,S2] [--from 2020-01-01] [--to 2025-01-01]
//   pnpm gold walkforward ...same data...  [--train 36] [--validate 12] [--step 12] [--strategies S4,S5]
//   pnpm gold montecarlo  ...same data...  [--runs 1000] [--seed 1]
//   pnpm gold ablation    ...same data...  [--strategies S4]
//   pnpm gold stability   ...same data...  --strategy S4 [--dims arm,sl,tp,fake]
//   pnpm gold fit         ...same data...  --trades public_trades.csv [--evaluations 120]
//   pnpm gold plan        [--frequency MODERATE]            an MT5 implementation plan for the configuration
//   pnpm gold init        [--dir skills/multi-strategy-gold-breakout/config]   write the default JSON configs
//   pnpm gold demo                                          a synthetic run (proves nothing about gold)
//
// data:   --csv <MT5 export>  [--utc-offset 2] [--point 0.01]   or   --inst NAME --bar 5m (from `pnpm lab fetch`)
// config: --config engine.json  --profiles <dir with s1.json..s9.json>  --news events.csv  --balance 10000  --spread 0.3
//         --timezone Europe/Athens  --seed 1  --out <dir>   (reports go to <LAB_DIR>/gold/reports by default)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labEnv, withOverrides } from "../config.js";
import { loadOverrides, loadSettings } from "../settings.js";
import { deepMerge, loadEngineConfig, loadProfiles, parseNewsCsv, parseTradesCsv, SKILL_DIR, writeDefaultConfigs } from "../lab/gold/config.js";
import { BAR_MS, parseMt5Csv, readCache, type Bar, type Mt5Bar } from "../lab/history.js";
import { runAblation } from "../lab/gold/research/ablation.js";
import { fitObserved } from "../lab/gold/research/blackbox.js";
import { runMetrics } from "../lab/gold/research/metrics.js";
import { DEFAULT_MC, monteCarlo } from "../lab/gold/research/montecarlo.js";
import { coarseToFine, score } from "../lab/gold/research/optimizer.js";
import { applyChoice } from "../lab/gold/research/params.js";
import { buildReport, renderReport } from "../lab/gold/research/report.js";
import { mt5Plan } from "../lab/gold/research/mt5plan.js";
import { walkForward } from "../lab/gold/research/walkforward.js";
import { runGold, type GoldData } from "../lab/gold/sim.js";
import { FREQUENCIES, STRATEGY_IDS, type Frequency, type StrategyId } from "../lab/gold/types.js";
import { isTf, type Tf } from "../lab/resample.js";
import { walk as syntheticWalk } from "../lab/gold/research/synthetic.js";

function flags(argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) f[a.slice(2)] = argv[++i]!;
      else f[a.slice(2)] = "true";
    } else pos.push(a);
  }
  return { pos, f };
}

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
const settings = (() => {
  try {
    return loadSettings(SETTINGS_PATH);
  } catch {
    return null;
  }
})();
const env = labEnv(withOverrides(process.env, loadOverrides(SETTINGS_PATH)), settings);
const reportsDir = (f: Record<string, string>) => f.out ?? join(env.dir, "gold", "reports");

const TF_OF_BAR: Record<string, Tf> = { "1m": "M1", "5m": "M5", "15m": "M15", "30m": "M30", "1H": "H1", "4H": "H4", "1D": "D1" };

function loadData(f: Record<string, string>): { data: GoldData; source: string; synthetic: boolean } {
  const base = (f.base as Tf | undefined) ?? (f.bar ? TF_OF_BAR[f.bar] : undefined) ?? "M5";
  if (!isTf(base)) throw new Error(`--base must be one of M1 M5 M15 M30 H1 H4 D1`);
  if (f.csv) {
    const bars = parseMt5Csv(readFileSync(f.csv, "utf8"), { utcOffsetHours: Number(f["utc-offset"] ?? 0), pointSize: Number(f.point ?? 0.01) });
    if (!bars.length) throw new Error(`no bars in ${f.csv}`);
    return { data: { base: bars, baseTf: base }, source: `MT5 CSV ${f.csv} (${bars.length} bars${bars.some((b) => b.spread !== undefined) ? ", with spread history" : ""})`, synthetic: false };
  }
  if (f.inst) {
    const bar = (Object.entries(TF_OF_BAR).find(([, v]) => v === base)?.[0] ?? "5m") as Bar;
    const c = readCache(join(env.dir, "history"), f.inst, bar);
    if (!c?.length) throw new Error(`no cached ${bar} history for ${f.inst}: run "pnpm lab fetch --inst ${f.inst} --bar ${bar}" or use --csv`);
    void BAR_MS;
    return { data: { base: c as Mt5Bar[], baseTf: base }, source: `lab cache ${f.inst} ${bar} (${c.length} bars, no spread history)`, synthetic: false };
  }
  if (f.synthetic || f.cmd === "demo") {
    const bars = Number(f.synthetic && f.synthetic !== "true" ? f.synthetic : 40_000);
    return { data: { base: syntheticWalk(7, bars, 7, 0.05, BAR_MS["5m"], 2500, Date.UTC(2024, 0, 1)) as Mt5Bar[], baseTf: "M5" }, source: `SYNTHETIC random walk (${bars} M5 bars): exercises the code, proves nothing about gold`, synthetic: true };
  }
  throw new Error("give the data: --csv <MT5 export>, or --inst NAME --bar 5m (from `pnpm lab fetch`), or --synthetic");
}

function engineConfig(f: Record<string, string>, base: Tf) {
  const over: Record<string, unknown> = { base_timeframe: base };
  if (f.frequency) {
    if (!(FREQUENCIES as readonly string[]).includes(f.frequency)) throw new Error(`--frequency must be one of ${FREQUENCIES.join(", ")}`);
    over.frequency = f.frequency as Frequency;
  }
  if (f.balance) over.account = { initial_balance: Number(f.balance) };
  if (f.timezone) over.timezone = f.timezone;
  if (f.seed) over.seed = Number(f.seed);
  if (f.spread) over.costs = { spread: { kind: "fixed", value: Number(f.spread) } };
  let cfg = deepMerge({}, over);
  if (f.config) cfg = deepMerge(JSON.parse(readFileSync(f.config, "utf8")), cfg);
  if (f.news) cfg = deepMerge(cfg, { filters: { news: { enabled: true, events: parseNewsCsv(readFileSync(f.news, "utf8")) } } });
  return loadEngineConfig(existsSync(SKILL_DIR) && !f.config ? join(SKILL_DIR, "config") : undefined, cfg);
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
})();

function strategiesOf(f: Record<string, string>, fallback?: StrategyId[]): StrategyId[] | undefined {
  if (!f.strategies) return fallback;
  const ids = f.strategies.split(",").map((s) => s.trim().toUpperCase());
  const bad = ids.filter((i) => !(STRATEGY_IDS as readonly string[]).includes(i));
  if (bad.length) throw new Error(`unknown strategy ${bad.join(", ")} (S1..S9)`);
  return ids as StrategyId[];
}

const day = (s?: string) => (s ? Date.parse(`${s}T00:00:00Z`) : undefined);

function save(name: string, body: string, json: unknown, f: Record<string, string>) {
  const dir = reportsDir(f);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(json));
  console.log(`\nreport -> ${join(dir, `${name}.md`)}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { f } = flags(rest);
  if (!cmd || cmd === "help") return console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n").replace(/^\/\/ ?/gm, ""));
  if (cmd === "init") {
    const files = writeDefaultConfigs(f.dir ?? join(SKILL_DIR, "config"));
    return console.log(`wrote ${files.length} files:\n${files.join("\n")}`);
  }
  const profDir = f.profiles ?? (existsSync(join(SKILL_DIR, "config")) ? join(SKILL_DIR, "config") : undefined);
  if (cmd === "plan") {
    const cfg = engineConfig(f, (f.base as Tf) ?? "M5");
    const profiles = loadProfiles(profDir).filter((p) => cfg.frequency && p.enabled);
    return console.log(mt5Plan(cfg, profiles));
  }
  if (cmd === "demo") f.synthetic = f.synthetic ?? "true";
  const { data, source, synthetic } = loadData(f);
  const cfg = engineConfig(f, data.baseTf);
  const profiles = loadProfiles(profDir);
  const strategies = strategiesOf(f);
  const from = day(f.from);
  const to = day(f.to);
  const opts = { profiles, ...(strategies ? { strategies } : {}), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), commit };
  const notes = synthetic ? ["SYNTHETIC DATA: nothing below says anything about gold."] : [];

  if (cmd === "run" || cmd === "demo") {
    const run = runGold(cfg, data, opts);
    const rep = buildReport(run, { dataSource: source, notes });
    const md = renderReport(rep);
    console.log(md);
    return save(`run-${run.meta.run_id}`, md, rep, f);
  }
  if (cmd === "montecarlo") {
    const run = runGold(cfg, data, opts);
    const m = runMetrics(run).portfolio;
    const mc = monteCarlo(run.trades, { ...DEFAULT_MC, runs: Number(f.runs ?? 1000), seed: Number(f.seed ?? 1), initial: cfg.account.initial_balance, years: m.years, contract: cfg.contract });
    const rep = buildReport(run, { dataSource: source, monteCarlo: mc, notes });
    const md = renderReport(rep);
    console.log(md);
    return save(`montecarlo-${run.meta.run_id}`, md, rep, f);
  }
  if (cmd === "ablation") {
    const ids = strategies ?? (["S4"] as StrategyId[]);
    const rows = runAblation(cfg, data, profiles, ids, { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}), commit });
    const run = runGold(cfg, data, { ...opts, strategies: ids });
    const rep = buildReport(run, { dataSource: source, ablation: rows, notes });
    const md = renderReport(rep);
    console.log(md);
    return save(`ablation-${run.meta.run_id}`, md, rep, f);
  }
  if (cmd === "walkforward") {
    const ids = strategies ?? (["S4", "S5"] as StrategyId[]);
    const wf = walkForward(cfg, data, profiles, ids, { trainMonths: Number(f.train ?? 36), validateMonths: Number(f.validate ?? 12), stepMonths: Number(f.step ?? 12), commit }, { commit });
    const run = runGold(cfg, data, { ...opts, strategies: ids });
    const rep = buildReport(run, { dataSource: source, walkForward: wf, notes });
    const md = renderReport(rep);
    console.log(md);
    return save(`walkforward-${run.meta.run_id}`, md, rep, f);
  }
  if (cmd === "stability") {
    const id = (f.strategy ?? "S4").toUpperCase() as StrategyId;
    const base = profiles.find((p) => p.id === id);
    if (!base) throw new Error(`unknown strategy ${id}`);
    const dims = (f.dims ?? "arm,sl,tp,fake").split(",");
    const minTrades = Number(f["min-trades"] ?? 30);
    const res = coarseToFine(
      (c) => {
        const m = runMetrics(runGold(cfg, data, { ...opts, profiles: [applyChoice(base, c)], strategies: [id] })).portfolio;
        return { score: score(m, minTrades), trades: m.trades };
      },
      { dims, minTrades },
    );
    const run = runGold(cfg, data, { ...opts, strategies: [id] });
    const rep = buildReport(run, { dataSource: source, stability: res.stability, notes: [...notes, `${res.evaluations} runs; best stable point: ${JSON.stringify(res.best?.choice ?? "none")}`] });
    const md = renderReport(rep);
    console.log(md);
    return save(`stability-${id}-${run.meta.run_id}`, md, rep, f);
  }
  if (cmd === "fit") {
    if (!f.trades) throw new Error("usage: pnpm gold fit --trades public_trades.csv (entry_time,entry_price,direction[,exit_time,exit_price]) + the data flags");
    const obs = parseTradesCsv(readFileSync(f.trades, "utf8"));
    const res = fitObserved(cfg, data, obs, { evaluations: Number(f.evaluations ?? 120), seed: Number(f.seed ?? 1) });
    console.log(res.disclaimer, "\n");
    for (const c of res.candidates) console.log(`score ${c.fit.score.toFixed(2)} [entry ${c.fit.entryMatch.toFixed(2)} dir ${c.fit.directionMatch.toFixed(2)} timing ${c.fit.timingMatch.toFixed(2)} level ${c.fit.levelMatch.toFixed(2)}] ESTIMATED ${JSON.stringify(c.params)}`);
    return save(`fit-${Date.now()}`, `# Black-box fit (estimated)\n\n${res.disclaimer}\n\n${res.candidates.map((c) => `- score ${c.fit.score.toFixed(2)} ESTIMATED ${JSON.stringify(c.params)}`).join("\n")}\n`, res, f);
  }
  throw new Error(`unknown command "${cmd}"; try: pnpm gold help`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
