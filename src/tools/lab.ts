// The strategy lab, from the command line. Paper only: public market history, simulated money, no exchange account.
//
//   pnpm lab fetch   [--inst BTC-USDT-SWAP,ETH-USDT-SWAP] [--bar 1H] [--days 365] [--base https://www.okx.com]
//   pnpm lab fetch   --exchange binance --symbol BTC/USDT,ETH/USDT [--bar 1H] [--days 365]   any of CCXT's 100+ exchanges
//   pnpm lab import  <file.csv|file.json> --inst NAME [--bar 1H] CSV, or a Freqtrade data file (BTC_USDT-1h.json)
//   pnpm lab fetch   --bar 1m --days 14                          1-minute history for the scalper (5m: --days 60)
//   pnpm lab scalp   [--inst BTC-USDT-SWAP,ETH-USDT-SWAP] [--synthetic 2] [--maker-fee 0.0002] [--taker-fee 0.0005]
//                    [--slippage 1] [--half-spread 0.5] [--through 0.5] [--folds 4]   does a 1m scalp survive its costs?
//   pnpm lab skills                                              list every skill (built-in + ./skills/*.json)
//   pnpm lab run     [--bar 1H] [--inst ...] [--synthetic 4] [--folds 3] [--leverage 1] [--fee 0.0005] [--long-only]
//   pnpm lab council                                             each bee's brain picks skills from the last ranking
//   pnpm lab cycle   [run options]                               fetch what is missing, run, council
//   pnpm lab keys                                                check the ChatGPT / Claude / Kimi keys
//   pnpm lab graph   [--out data/lab/graph.json]                 export the hive mind (graphify node-link JSON)
//   pnpm lab ask     <bee1|bee2|bee3>                            what that bee's brain knows right now
//   pnpm lab query   "<question>"                               the slice of the hive mind about it (graphify-style)
//   pnpm lab path    <from> <to>                                how two things connect (e.g. bee3 SOL)
//   pnpm lab explain <node>                                     a node and its links, with confidence
//   pnpm lab report                                             HIVE_REPORT.md: god nodes, communities, conflicts, memories
//   pnpm lab remember                                           fold older lessons into memories now (rules digest)
import { loadMood } from "../market/cmc.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCouncil, type CouncilBee } from "../brains/council.js";
import { BRAIN_INFO, BRAINS, checkClaudeKey, checkKimiKey, makeClients } from "../brains/llm.js";
import { loadPlaybook, savePlaybook } from "../brains/playbook.js";
import { BEES, labEnv, MAX_BEES, slotId, withOverrides } from "../config.js";
import { KnowledgeGraph, nodeId } from "../graph/graph.js";
import { contextFor, ingestRanking } from "../graph/hive-mind.js";
import { consolidate, explain as memoryExplain, hiveReport, path as memoryPath, query as memoryQuery } from "../graph/memory.js";
import { buildScalpReport, loadScalpReport, saveScalpReport, scalpGate, scalpReportMarkdown, type CostModel } from "../lab/scalp.js";
import { BAR_MS, ccxtExchange, fetchHistory, fetchHistoryCcxt, parseCsv, parseFreqtradeJson, readCache, syntheticCandles, writeCache, type Bar, type Dataset } from "../lab/history.js";
import { skillRegistry, type Skill } from "../lab/skills/index.js";
import { rankingTable, runTournament, type Ranking } from "../lab/tournament.js";
import { checkOpenAiKey } from "../openai.js";
import { createOkxPublicRest } from "../okx/rest.js";
import { loadOverrides, loadSettings, STYLE_INFO } from "../settings.js";

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
const DEFAULT_INSTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "HYPE-USDT-SWAP"];

function flags(argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        f[k] = next;
        i++;
      } else f[k] = "true";
    } else pos.push(a);
  }
  return { pos, f };
}

const settings = (() => {
  try {
    return loadSettings(SETTINGS_PATH);
  } catch {
    return null;
  }
})();
// Admin-panel overrides apply to the lab too (the environment still wins).
const env = labEnv(withOverrides(process.env, loadOverrides(SETTINGS_PATH)), settings);
const historyDir = join(env.dir, "history");
const rankingPath = join(env.dir, "ranking.json");
const bar = (f: Record<string, string>) => (f.bar ?? "1H") as Bar;
/** How far back to fetch by default: 1-minute history is 1,440 rows a day, so it starts short. */
const defaultDays = (f: Record<string, string>) => Number(f.days ?? (bar(f) === "1m" ? 14 : bar(f) === "5m" ? 60 : 365));
const insts = (f: Record<string, string>) => (f.inst ? f.inst.split(",").map((s) => s.trim()).filter(Boolean) : null);

function councilBees(): CouncilBee[] {
  const clients = makeClients(env.creds);
  // The main three, then any extra bees added from the admin panel.
  const n = Math.max(BEES.length, Math.min(MAX_BEES, settings?.bees.length ?? 0));
  return Array.from({ length: n }, (_, i) => {
    const slot = slotId(i);
    const b = settings?.bees[i];
    const style = b?.style ?? (["bizzy", "breezy", "boozy"] as const)[i] ?? "boozy";
    const brain = env.slots[slot] ?? b?.brain ?? BRAINS[i % BRAINS.length]!;
    return {
      slot,
      name: b?.name ?? STYLE_INFO[style].name,
      style,
      rules: b?.rules ?? "",
      coins: b?.coins ?? [],
      brain,
      model: clients[brain]?.model ?? "rules",
    };
  });
}

async function cmdFetchCcxt(f: Record<string, string>) {
  const exchange = f.exchange!;
  const ex = await ccxtExchange(exchange);
  const days = defaultDays(f);
  for (const symbol of (f.symbol ?? "BTC/USDT,ETH/USDT,SOL/USDT").split(",").map((x) => x.trim()).filter(Boolean)) {
    const name = `${exchange}-${symbol.replace(/[/:]/g, "-")}`;
    process.stdout.write(`fetching ${symbol} on ${exchange} ${bar(f)} (${days} days)... `);
    try {
      const c = await fetchHistoryCcxt(ex, symbol, bar(f), days);
      if (!c.length) {
        console.log("no data");
        continue;
      }
      console.log(`${c.length} candles -> ${writeCache(historyDir, name, bar(f), c)}`);
    } catch (err) {
      console.log(`failed: ${(err as Error).message}`);
    }
  }
}

async function cmdFetch(f: Record<string, string>) {
  if (f.exchange) return cmdFetchCcxt(f);
  const rest = createOkxPublicRest({ apiBase: (f.base ?? "https://www.okx.com").replace(/\/+$/, ""), timeoutMs: 15_000 });
  const days = defaultDays(f);
  for (const instId of insts(f) ?? DEFAULT_INSTS) {
    process.stdout.write(`fetching ${instId} ${bar(f)} (${days} days)... `);
    try {
      const c = await fetchHistory(rest, instId, bar(f), days);
      if (!c.length) {
        console.log("no data");
        continue;
      }
      const file = writeCache(historyDir, instId, bar(f), c);
      console.log(`${c.length} candles -> ${file}`);
    } catch (err) {
      console.log(`failed: ${(err as Error).message}`);
    }
  }
}

function cmdCsv(pos: string[], f: Record<string, string>) {
  const file = pos[0];
  if (!file || !f.inst) throw new Error("usage: pnpm lab import <file.csv|file.json> --inst NAME [--bar 1H]");
  const text = readFileSync(file, "utf8");
  const c = file.toLowerCase().endsWith(".json") ? parseFreqtradeJson(text) : parseCsv(text);
  console.log(`${c.length} candles -> ${writeCache(historyDir, f.inst, bar(f), c)}`);
}

function loadDatasets(f: Record<string, string>): Dataset[] {
  const b = bar(f);
  const out: Dataset[] = [];
  const nSynthetic = Number(f.synthetic ?? 0);
  for (let i = 0; i < nSynthetic; i++) {
    out.push({ id: `SYN${i + 1} ${b}`, instId: `SYN${i + 1}`, bar: b, candles: syntheticCandles(1000 + i, Number(f.bars ?? 4000), BAR_MS[b]), source: "synthetic" });
  }
  const wanted = insts(f);
  const names = existsSync(historyDir) ? readdirSync(historyDir).filter((x) => x.endsWith(`_${b}.json`)) : [];
  for (const name of names) {
    const instId = name.slice(0, -`_${b}.json`.length);
    if (wanted && !wanted.includes(instId)) continue;
    const c = readCache(historyDir, instId, b);
    if (c && c.length > 300) out.push({ id: `${instId} ${b}`, instId, bar: b, candles: c, source: /^[a-z0-9]+-/.test(instId) ? "ccxt" : "okx" });
  }
  return out;
}

function cmdScalp(f: Record<string, string>) {
  const g = { ...f, bar: f.bar ?? "1m" };
  const datasets = loadDatasets(g);
  if (!datasets.length) throw new Error(`No 1-minute history in ${historyDir}. Run "pnpm lab fetch --bar 1m --days 14" first, or add --synthetic 2 for an offline run (synthetic data never opens the scalper's gate).`);
  const num = (k: string, d: number) => (f[k] !== undefined ? Number(f[k]) : d);
  const costs: CostModel = {
    makerFee: num("maker-fee", 0.0002),
    takerFee: num("taker-fee", env.takerFeeRate),
    slippageBps: num("slippage", 1),
    halfSpreadBps: num("half-spread", 0.5),
    throughBps: num("through", 0.5),
  };
  console.log(`scalper lab: ${datasets.map((d) => `${d.id}:${d.candles.length}`).join(", ")}; maker ${costs.makerFee * 1e4} bp, taker ${costs.takerFee * 1e4} bp`);
  const t0 = Date.now();
  const report = buildScalpReport(
    datasets.map((d) => ({ id: d.id, candles: d.candles, synthetic: d.source === "synthetic" })),
    undefined,
    { costs, folds: num("folds", 4) },
  );
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  console.log(scalpReportMarkdown(report));
  console.log(`report -> ${saveScalpReport(env.dir, report)}`);
  const gate = scalpGate(report);
  console.log(`gate for the live scalper: ${gate.open ? "OPEN" : "CLOSED"} (${gate.reason})`);
}

function longOnly(skills: Skill[]): Skill[] {
  return skills.map((s) => ("shorts" in s.defaults ? { ...s, defaults: { ...s.defaults, shorts: 0 }, grid: { ...s.grid, shorts: [0] } } : s));
}

function writeReport(r: Ranking) {
  const lines = [
    `# Strategy lab ranking`,
    ``,
    `Run ${new Date(r.createdAt).toISOString()} on ${r.datasets.map((d) => `${d.id} (${d.bars} bars)`).join(", ")}.`,
    `Walk-forward: ${r.opts.folds} out-of-sample folds over the last ${Math.round(r.opts.testFrac * 100)}% of each dataset; fee ${r.opts.sim.feeRate * 10_000} bp/side, slippage ${r.opts.sim.slippageBps} bp, leverage ${r.opts.sim.leverage}x, funding ${r.opts.sim.fundingPer8hPct}%/8h.`,
    `Paper simulation on past data. Past results do not predict future ones. Not financial advice.`,
    ``,
    `| # | skill | family | score | OOS return | buy & hold | Sharpe | SQN | max DD | trades | stable | overfit | params |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...r.results.map(
      (s) =>
        `| ${s.rank} | ${s.name} (\`${s.skillId}\`) | ${s.family} | ${s.score.toFixed(2)} | ${s.oos.returnPct.toFixed(1)}% | ${s.oos.benchmarkPct.toFixed(1)}% | ${s.oos.sharpe.toFixed(2)} | ${(s.oos.sqn ?? 0).toFixed(2)} | ${s.oos.maxDrawdownPct.toFixed(1)}% | ${s.oos.trades} | ${s.stabilityPct.toFixed(0)}% | ${s.overfitGap.toFixed(2)} | ${Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join(" ")} |`,
    ),
    ...(r.errors.length ? [``, `Errors:`, ...r.errors.map((e) => `- ${e}`)] : []),
  ];
  const file = join(env.dir, "report.md");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function cmdRun(f: Record<string, string>): Ranking {
  const datasets = loadDatasets(f);
  if (!datasets.length) throw new Error(`No history for bar ${bar(f)} in ${historyDir}. Run "pnpm lab fetch" first, or add --synthetic 4 for an offline run.`);
  const reg = skillRegistry(env.skillsDirs);
  for (const e of reg.errors) console.warn(`skill import: ${e}`);
  let skills = reg.skills;
  if (f.skills) {
    const only = new Set(f.skills.split(","));
    skills = skills.filter((s) => only.has(s.id) || s.id === "buy_hold");
  }
  if (f["long-only"] === "true") skills = longOnly(skills);
  console.log(`tournament: ${skills.length} skills x ${datasets.length} datasets (${datasets.map((d) => `${d.id}:${d.candles.length}`).join(", ")})`);
  const t0 = Date.now();
  const ranking = runTournament(
    skills,
    datasets,
    {
      folds: Number(f.folds ?? 3),
      sim: {
        feeRate: Number(f.fee ?? env.takerFeeRate),
        slippageBps: Number(f.slippage ?? 2),
        leverage: Math.min(env.maxLeverage, Number(f.leverage ?? 1)),
        stopAtr: 0,
        fundingPer8hPct: Number(f.funding ?? 0.01),
        startEquity: 1000,
      },
    },
    (done, total, s) => process.stdout.write(`\r  ${done}/${total} ${s.id.padEnd(28)}`),
  );
  console.log(`\r  done in ${((Date.now() - t0) / 1000).toFixed(1)} s${" ".repeat(30)}\n`);
  mkdirSync(env.dir, { recursive: true });
  writeFileSync(rankingPath, JSON.stringify(ranking));
  console.log(rankingTable(ranking, Number(f.top ?? 25)));
  const graph = new KnowledgeGraph(env.graphPath);
  ingestRanking(graph, ranking);
  const best = ranking.results.find((s) => s.family !== "benchmark");
  const bh = ranking.results.find((s) => s.skillId === "buy_hold");
  if (best) {
    graph.upsert("run", "lab", "the strategy lab");
    graph.learn(
      nodeId("run", "lab"),
      `Lab ${new Date(ranking.createdAt).toISOString().slice(0, 10)}: best out of sample was ${best.skillId} (score ${best.score.toFixed(2)}, ${best.oos.returnPct.toFixed(1)}% vs buy & hold ${bh ? bh.oos.returnPct.toFixed(1) : "?"}%, stability ${best.stabilityPct.toFixed(0)}%).`,
      [nodeId("skill", best.skillId)],
      { source: "lab" },
    );
  }
  graph.close();
  console.log(`\nranking -> ${rankingPath}\nreport  -> ${writeReport(ranking)}\ngraph   -> ${env.graphPath}`);
  return ranking;
}

async function cmdCouncil(ranking?: Ranking) {
  const r = ranking ?? (existsSync(rankingPath) ? (JSON.parse(readFileSync(rankingPath, "utf8")) as Ranking) : null);
  if (!r) throw new Error(`No ranking yet. Run "pnpm lab run" first.`);
  const graph = new KnowledgeGraph(env.graphPath);
  const clients = makeClients(env.creds);
  // No live market here: coin candidates come from the owner's coins, the style, the lab's datasets and the bee's record.
  const res = await runCouncil({ graph, ranking: r, bees: councilBees(), clients, previous: loadPlaybook(env.playbookPath), pickCoins: env.watchlist, pickMethod: env.specialization, market: loadMood(env.dir), scalp: env.scalp && scalpGate(loadScalpReport(env.dir)).open });
  savePlaybook(env.playbookPath, res.playbook);
  graph.close();
  for (const l of res.log) {
    const p = res.playbook.bees[l.bee]!;
    console.log(`\n${l.bee} thinks with ${l.brain === "rules" ? "rules" : BRAIN_INFO[l.brain as keyof typeof BRAIN_INFO].label} (${p.model})${l.error ? `  [brain failed: ${l.error}]` : ""}`);
    for (const s of p.skills) console.log(`  ${s.weight.toFixed(2)}  ${s.id.padEnd(24)} ${s.reason}`);
    if (p.specialization) console.log(`  specialises in ${p.specialization.kind} ${p.specialization.id}: ${p.specialization.reason}`);
    for (const w of p.watchlist ?? []) console.log(`  watch ${w.coin.padEnd(8)} ${w.reason}`);
    for (const x of p.lessons) console.log(`  lesson: ${x}`);
    if (p.message) console.log(`  to the hive: ${p.message}`);
  }
  console.log(`\nplaybook -> ${env.playbookPath}  (set LAB_SIGNALS=true so Jev sees the votes)`);
}

async function cmdKeys() {
  const c = env.creds;
  const check = async (name: string, has: boolean, fn: () => Promise<string | null>) => {
    if (!has) return console.log(`${name.padEnd(8)} no key`);
    const err = await fn().catch((e: Error) => e.message);
    console.log(`${name.padEnd(8)} ${err ? `FAILED: ${err}` : "ok"}`);
  };
  await check("ChatGPT", !!c.openai, async () => (await checkOpenAiKey(c.openai!.apiKey), null));
  await check("Claude", !!c.claude, () => checkClaudeKey(c.claude!));
  await check("Kimi", !!c.kimi, () => checkKimiKey(c.kimi!.apiKey, c.kimi!.baseUrl));
  for (const slot of BEES) console.log(`${slot} -> ${BRAIN_INFO[env.slots[slot]].label}`);
}

function cmdSkills() {
  const reg = skillRegistry(env.skillsDirs);
  for (const s of reg.skills) console.log(`${s.id.padEnd(26)} ${s.family.padEnd(15)} ${s.source.padEnd(22)} ${s.name}`);
  for (const e of reg.errors) console.log(`ERROR ${e}`);
  console.log(`\n${reg.skills.length} skills, ${reg.errors.length} import errors`);
}

function cmdGraph(f: Record<string, string>) {
  const graph = new KnowledgeGraph(env.graphPath);
  const out = f.out ?? join(env.dir, "graph.json");
  writeFileSync(out, JSON.stringify(graph.export(), null, 2));
  console.log(JSON.stringify(graph.stats()));
  console.log(`graph.json -> ${out}`);
  graph.close();
}

function cmdAsk(pos: string[]) {
  const slot = pos[0] ?? "bee1";
  const graph = new KnowledgeGraph(env.graphPath);
  console.log(JSON.stringify(contextFor(graph, slot), null, 2));
  graph.close();
}

/** Graphify-style reads of the hive mind, and a manual consolidation. */
async function cmdMemory(cmd: string, pos: string[]) {
  const graph = new KnowledgeGraph(env.graphPath);
  try {
    if (cmd === "query") console.log(JSON.stringify(memoryQuery(graph, pos.join(" ")), null, 2));
    else if (cmd === "path") console.log((memoryPath(graph, pos[0] ?? "", pos[1] ?? "") ?? ["not connected"]).join("\n"));
    else if (cmd === "explain") console.log(JSON.stringify(memoryExplain(graph, pos.join(" ")) ?? { error: "no such node" }, null, 2));
    else if (cmd === "report") {
      const out = join(env.dir, "HIVE_REPORT.md");
      writeFileSync(out, hiveReport(graph));
      console.log(`${hiveReport(graph)}\nreport -> ${out}`);
    } else {
      let n = 0;
      for (const b of graph.nodes("bee", 20)) n += await consolidate(graph, b.id);
      console.log(`${n} lessons folded into memories`);
    }
  } finally {
    graph.close();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, f } = flags(rest);
  switch (cmd) {
    case "fetch":
      return cmdFetch(f);
    case "csv":
    case "import":
      return cmdCsv(pos, f);
    case "scalp":
      return cmdScalp(f);
    case "skills":
      return cmdSkills();
    case "run":
      return void cmdRun(f);
    case "council":
      return cmdCouncil();
    case "cycle": {
      const have = loadDatasets({ ...f, synthetic: "0" }).length;
      if (!have && !f.synthetic) await cmdFetch(f);
      return cmdCouncil(cmdRun(f));
    }
    case "keys":
      return cmdKeys();
    case "graph":
      return cmdGraph(f);
    case "ask":
      return cmdAsk(pos);
    case "query":
    case "path":
    case "explain":
    case "report":
    case "remember":
      return cmdMemory(cmd, pos);
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n").replace(/^\/\/ ?/gm, ""));
      console.log(`\nbrains: ${BRAINS.map((b) => `${BRAIN_INFO[b].label} (${BRAIN_INFO[b].keyEnv})`).join(", ")}`);
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
