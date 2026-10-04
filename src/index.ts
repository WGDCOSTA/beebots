import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { checkCmcKey, CmcSource, marketMood, saveMood } from "./market/cmc.js";
import { dirname, join } from "node:path";
import { Alerts } from "./alerts.js";
import { BREEZY_COINS } from "./bees/breezy.js";
import { BEES, ConfigError, type BeeId, loadConfig, startEquityOf, STYLES, withOverrides, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { hashPassword, MIN_PASSWORD, PasswordGate } from "./gate.js";
import { Hive, hivePath } from "./hive.js";
import { OkxExecutor, SimExecutor, type Executor } from "./exec/executor.js";
import { checkJevKey, Jev } from "./jev.js";
import { log, setLogLevel } from "./log.js";
import { MarketFeed } from "./market/data.js";
import { loadScalpReport, scalpGate } from "./lab/scalp.js";
import { checkOkxAccount } from "./okx/account.js";
import { createOkxCli } from "./okx/cli.js";
import { createNewsSource } from "./okx/news.js";
import { createPublicApi } from "./okx/public.js";
import { createOkxPublicRest } from "./okx/rest.js";
import { safeError } from "./redact.js";
import { startServer } from "./server.js";
import { ownFromEngineDb, PublicChat } from "./publicChat.js";
import { okxChatMarket } from "./arena/chat.js";
import { loadOverrides, loadSettings, saveSettings, STYLE_INFO } from "./settings.js";
import { imageDir, imagePath, Setup } from "./setup.js";
import { blockers, bunnyProfile } from "./bunnyProfile.js";
import { UpdateCheck } from "./update.js";
import { Visitors } from "./visitors.js";
import { Coach } from "./brains/coach.js";
import { Farmer, farmerStats } from "./brains/farmer.js";
import { CREW, CREW_IDS, CrewMember, type CrewId } from "./brains/crew.js";
import { owlData, pigData, ratData, type CrewSnapshot } from "./brains/crewData.js";
import type { CouncilBee } from "./brains/council.js";
import { ANTHROPIC_PROFILE, checkBrainModel, checkClaudeKey, checkCompatKey, checkKimiKey, hasAnthropicLogin, listBrainModels, makeClients, OPENAI_EFFORTS, OpenAiBrain, ZAI_BASE_URL, ZAI_DEFAULT_MODEL, type OpenAiEffort } from "./brains/llm.js";
import { Admin } from "./admin/admin.js";
import { LabJobs } from "./admin/jobs.js";
import { Workspace } from "./lab/workspace.js";
import { SkillAgent } from "./lab/skillAgent.js";
import { NoteBook } from "./brains/notes.js";
import { Researcher } from "./brains/research.js";
import { McpGateway } from "./mcp/gateway.js";
import { checkAlpacaKey } from "./lab/alpaca.js";
import { checkOpenAiKey, crewBrief, designBee, paintBee, paintFarmer } from "./openai.js";
import { PlaybookWatcher } from "./brains/playbook.js";
import { LabSignals, LAB_NOTE } from "./brains/signals.js";
import { SurvivalCouncil } from "./brains/survival.js";
import { coinInfos, watchlistSize } from "./brains/watchlist.js";
import { calendarSummary, emptyCalendar, loadCalendar, saveCalendar, SessionRecorder, sessionInfo, watchedHours, type TickSample } from "./market/sessions.js";
import { Evolution, TIERS, type BeeEvolution, type EvolutionEvent } from "./evolution.js";
import { beeNode } from "./graph/hive-mind.js";
import type { Ranking } from "./lab/tournament.js";
import { KnowledgeGraph } from "./graph/graph.js";
import { contextFor, registerBees } from "./graph/hive-mind.js";
import { explain as memoryExplain, hiveReport, path as memoryPath, query as memoryQuery } from "./graph/memory.js";
import { skillRegistry } from "./lab/skills/index.js";
import type { Skill } from "./lab/skills/types.js";
import { ExperimentControl } from "./experiment-control.js";
import { AutoLab, labProcessRunner } from "./autolab.js";
import { recordScalpResearch } from "./lab/scalpResearch.js";
import { GhostProofClient } from "./ghostproof/client.js";
import { CoinBook } from "./lab/coinBook.js";
import { metered, parsePrices, UsageMeter } from "./brains/usage.js";
import { adminMetrics, RANGES, type RangeId } from "./admin/metrics.js";
import { LabBrain } from "./brains/labBrain.js";
import { GhostProofRecorder } from "./ghostproof/recorder.js";

// When a Jev call times out while its answer is still arriving, @typesafe-ai/sdk 0.6.0 can leave the aborted response's
// body promise without a handler. The call itself has already failed and been handled (the bunny holds), so that late
// rejection is harmless, but Node would stop the whole engine for it and every bunny would pause while Docker restarts
// it (seen 2026-10-01 22:21 and 2026-10-02 00:00 UTC). Only an AbortError is let go, with a log line; any other
// unhandled rejection still stops the process as before.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.name === "AbortError") {
    log.warn("ignored a late rejection from an aborted request", { err: safeError(reason) });
    return;
  }
  throw reason;
});

const SETTINGS_PATH = process.env.SETTINGS_PATH?.trim() || "./data/settings.json";
// Reference portraits for generated bunnies: the dashboard's default art (copied into the image by the Dockerfile).
const REF_DIR = process.env.REF_DIR?.trim() || "./dashboard/public/bees";

/** Names, rules, styles and pictures for the dashboard. */
function profile(cfg: Config | null) {
  return {
    setup: cfg === null,
    mode: cfg?.mode ?? "dry",
    links: cfg?.links ?? null,
    bees: cfg
      ? cfg.beeIds.map((id) => {
          const s = cfg.slots[id];
          return {
            id,
            name: s.name,
            tagline: s.tagline,
            style: s.style,
            styleLabel: s.squad === "macro" ? "Macro" : STYLE_INFO[s.style].label,
            rules: s.rules,
            coins: s.coins,
            market: s.market,
            squad: s.squad,
            // A Setup-made bunny only ever shows its own portrait (null = the dashboard's placeholder mark), never the
            // original bunnies' art, which belongs to the official main agents.
            img: portraitUrl(cfg.settingsPath, id, s) ?? (s.fromSetup ? null : s.style === "degen" ? "/bees/degen.png" : `/bees/${s.style}.jpg`),
          };
        })
      : [],
  };
}

/** A bunny's own portrait, versioned by the file's time so a repaint from the admin panel shows up at once. */
function portraitUrl(settingsPath: string, id: string, s: { customImage: boolean }): string | null {
  const p = s.customImage ? imagePath(settingsPath, id) : null;
  return p ? `/bee-image/${id}?v=${Math.floor(statSync(p).mtimeMs)}` : null;
}

/** No Jev key in the environment and no Setup file yet: serve only the Setup page until the owner fills it in. */
function runSetup() {
  const env = process.env;
  const setup = new Setup({
    settingsPath: SETTINGS_PATH,
    jevModel: env.JEV_MODEL?.trim() || "jev-1.13.0",
    openai: { apiKey: env.OPENAI_API_KEY?.trim() || undefined, textModel: env.OPENAI_TEXT_MODEL?.trim() || "gpt-5.4-nano", imageModel: env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2" },
    refDir: REF_DIR,
    windowMin: Math.max(1, Number(env.SETUP_WINDOW_MIN) || 120),
    okxApiBase: env.OKX_API_BASE?.trim().replace(/\/+$/, "") || "https://eea.okx.com",
    kimiBaseUrl: env.KIMI_BASE_URL?.trim() || undefined,
    onSaved: () => {
      log.info("settings saved; exiting so Docker restarts the engine with them");
      process.exit(0);
    },
  });
  const port = Number(env.ENGINE_PORT) || 8080;
  startServer({ setup, profile: () => profile(null), beeImage: (b) => imagePath(SETTINGS_PATH, b) }, port, env.ENGINE_BIND?.trim() || "127.0.0.1");
  setup.announce();
}

async function main() {
  const settings = loadSettings(SETTINGS_PATH);
  if (!settings && !process.env.TYPESAFE_API_KEY?.trim()) return runSetup();
  let cfg;
  try {
    // Admin-panel overrides (admin.json) fill in what the environment leaves blank.
    cfg = loadConfig(withOverrides({ ...process.env, SETTINGS_PATH }, loadOverrides(SETTINGS_PATH)), settings);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("refusing to start", { reason: err.message });
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  log.info("beebots engine starting", { mode: cfg.mode, tickMs: cfg.tickMs, dataRefreshMs: cfg.dataRefreshMs, jevModel: cfg.jev.model });

  const db = new Db(cfg.dbPath);
  const bus = new EventBus(db);
  const alerts = new Alerts(cfg.alertWebhookUrl);
  const cli = createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs });
  // Public market data runs in-process on the kit's REST client; the CLI (one child process per call) is kept for
  // the signed per-bee calls only.
  const api = createPublicApi(cfg.okx.apiBase, cfg.mode === "demo", createOkxPublicRest({ apiBase: cfg.okx.apiBase, timeoutMs: cfg.okx.cliTimeoutMs }));
  const demo = cfg.mode === "demo";

  let engine: Engine | null = null;
  const held = () => (engine ? cfg.beeIds.map((id) => engine!.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  // News needs a key: borrow the first Momentum bunny's (demo/live only).
  const newsCreds = cfg.beeIds.filter((b) => cfg.slots[b].style === "boozy").map((b) => cfg.creds[b]).find((c) => !!c);
  const news = cfg.mode !== "dry" && newsCreds ? createNewsSource(cli, newsCreds, demo) : null;
  const feed = new MarketFeed(
    api,
    {
      min24hVolUsd: cfg.universe.min24hVolUsd,
      spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)),
      trendCoins: [...BREEZY_COINS],
      // Stocks and commodities get gated (and their stats kept) only when a macro bunny runs.
      macro: cfg.beeIds.some((id) => cfg.slots[id].squad === "macro") ? { min24hVolUsd: cfg.macro.min24hVolUsd, spreadGateBps: cfg.macro.spreadGateBps } : null,
    },
    news,
    held,
  );

  const exec: Executor =
    cfg.mode === "dry"
      ? new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate, Date.now, { makerFeeRate: cfg.scalp.makerFee, refresh: () => feed.refreshTickers() })
      : new OkxExecutor(cli, cfg.creds, demo, (id) => feed.view().instruments.get(id), cfg.risk.maxLeverage);

  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: db.jevSpendSince(startOfDay) });
  const shadowJev = cfg.jev.shadowEnabled
    ? new Jev({ ...cfg.jev, dailyUsdCap: cfg.jev.shadowDailyUsdCap, spentTodayUsd: db.experiments.shadowSpendSince(startOfDay) })
    : undefined;

  // `deploy/close.sh` drops this file into the data volume to end the experiment cleanly (see Engine.windDown).
  const closeFlag = join(dirname(cfg.dbPath), `close-${cfg.mode}`);
  // Dry run only: `resume-last-dry` puts benched, flat bunnies back into their last position (consumed on use).
  const resumeFlag = join(dirname(cfg.dbPath), `resume-last-${cfg.mode}`);
  const takeResumeRequest = () => {
    if (cfg.mode !== "dry" || !existsSync(resumeFlag)) return false;
    unlinkSync(resumeFlag);
    return true;
  };
  // The warren memory (knowledge graph) and the configured LLM brains. Brains never place orders: they curate skills and lessons.
  const graph = new KnowledgeGraph(cfg.lab.graphPath);
  const clients = makeClients(cfg.brains.creds);
  // Every brain call is metered (brains/usage.ts): tokens, latency and errors per brain, model and purpose, for the
  // admin console's consumption view.
  const usage = new UsageMeter(db.raw);
  usage.prune();
  for (const k of Object.keys(clients)) clients[k] = metered(clients[k]!, usage);
  const councilBees: CouncilBee[] = cfg.beeIds.map((id) => {
    const s = cfg.slots[id];
    const brain = cfg.brains.slots[id];
    return { slot: id, name: s.name, style: s.style, rules: s.rules, coins: s.coins, brain, model: clients[brain]?.model ?? "rules", market: s.market };
  });
  registerBees(graph, councilBees);
  const playbook = new PlaybookWatcher(cfg.lab.playbookPath);
  const registry = skillRegistry(cfg.lab.skillsDirs);
  for (const e of registry.errors) log.warn("skill import failed", { error: e });
  // One registry of every skill (built-in, imported, learned): the lab votes and the bunnies' specialisations share it.
  const skillMap = new Map(registry.skills.map((s) => [s.id, s]));
  const signals = cfg.lab.signals ? new LabSignals(skillMap, () => playbook.get()) : null;
  const addSkill = (skill: Skill) => {
    skillMap.set(skill.id, skill);
    signals?.register(skill);
  };
  if (cfg.skippedBees.length) log.warn("extra bunnies sit out: no exchange keys for this mode", { bees: cfg.skippedBees.join(",") });
  log.info("brains", { brains: cfg.beeIds.map((id) => `${id}:${cfg.brains.slots[id]}${clients[cfg.brains.slots[id]] ? "" : "(no key)"}`).join(" "), labSignals: cfg.lab.signals, watchlist: cfg.lab.watchlist, coachMin: cfg.lab.coachIntervalMin });

  // Survival and rewards: health tiers, points, levels, prizes (evolution.ts), and the councils they wake.
  const rankingPath = join(cfg.lab.dir, "ranking.json");
  let fullRanking: { at: number; r: Ranking | null } = { at: 0, r: null };
  const readRanking = (): Ranking | null => {
    if (Date.now() - fullRanking.at > 60_000) {
      try {
        fullRanking = { at: Date.now(), r: JSON.parse(readFileSync(rankingPath, "utf8")) as Ranking };
      } catch {
        fullRanking = { at: Date.now(), r: null };
      }
    }
    return fullRanking.r;
  };
  let survival: SurvivalCouncil | null = null;
  const beeByslot = (id: BeeId) => councilBees.find((b) => b.slot === id);
  const onEvolution = (e: EvolutionEvent) => {
    bus.emit("evolution", { ...e, name: cfg.slots[e.bee]?.name ?? e.bee });
    const name = cfg.slots[e.bee]?.name ?? e.bee;
    if (e.kind === "tier") {
      const worse = TIERS.indexOf(e.to) > TIERS.indexOf(e.from);
      if (e.to === "dead") {
        graph.learn(beeNode(e.bee), `${name} died at ${e.health.toFixed(1)}% of its start. What it held and how it traded led here; the next life should avoid it.`, [], { source: "death" });
        alerts.send(`${name} died (equity ${e.health.toFixed(1)}% of start). Revive it from the admin panel.`);
      } else if (worse && (e.to === "danger" || e.to === "critical") && cfg.evolution.survival) {
        const bee = beeByslot(e.bee);
        if (bee) void survival?.convene(bee, "survival").catch((err) => log.warn("survival council failed", { bee: e.bee, err: safeError(err) }));
      }
    }
    if (e.kind === "level" && e.to > e.from) {
      graph.post(beeNode(e.bee), "hive", `${name} reached level ${e.to} with ${e.points} points.`, { source: "rewards" });
      const bee = beeByslot(e.bee);
      if (bee) void survival?.convene(bee, "reward").catch((err) => log.warn("reward council failed", { bee: e.bee, err: safeError(err) }));
    }
  };
  let savedEvolution: Partial<Record<BeeId, BeeEvolution>> = {};
  try {
    savedEvolution = JSON.parse(db.getMeta("evolution") ?? "{}") as Partial<Record<BeeId, BeeEvolution>>;
  } catch {
    /* start fresh */
  }
  const evolution = new Evolution(
    { ...cfg.evolution, deathPct: cfg.risk.retireAtPct, startEquityUsd: cfg.risk.startEquityUsd, startOf: (id) => startEquityOf(cfg, id) },
    savedEvolution,
    onEvolution,
  );
  // CoinMarketCap (optional): market-wide context for Jev, the brains and the dashboard (market/cmc.ts).
  const cmc = cfg.cmc.apiKey
    ? new CmcSource({ apiKey: cfg.cmc.apiKey, top: cfg.cmc.top, refreshMin: cfg.cmc.refreshMin, slowEveryMin: cfg.cmc.slowMin, maxCallsDay: cfg.cmc.maxCallsDay, onUpdate: (s) => saveMood(cfg.lab.dir, s) })
    : null;
  cmc?.start();
  const cmcState = () => cmc?.get() ?? null;
  const mood = () => marketMood(cmcState());
  // The scalper's gate: the strategy lab's latest report on real 1-minute data (pnpm lab scalp), read fresh each time so a
  // new report opens or closes it without a restart.
  // The coin book (lab/coinBook.ts) sits on top: what the owner blocked or the book retired or demoted is taken out, and
  // rules validated in an earlier rotating batch stay in while their evidence is fresh.
  const coinBook = new CoinBook(cfg.lab.dir);
  coinBook.refresh();
  const scalpLabGate = () => coinBook.gate(scalpGate(loadScalpReport(cfg.lab.dir), Date.now(), cfg.scalp.labMaxAgeDays), Date.now(), cfg.scalp.labMaxAgeDays);
  let labBrain: LabBrain | null = null;
  const scalpOn = () => cfg.scalp.enabled && (!cfg.scalp.requireLab || scalpLabGate().open);
  survival = new SurvivalCouncil({
    graph,
    evolution,
    clients,
    playbookPath: cfg.lab.playbookPath,
    learnedDir: join(cfg.lab.dir, "learned"),
    historyDir: join(cfg.lab.dir, "history"),
    ranking: readRanking,
    onNewSkill: addSkill,
    onDraft: (d) => {
      try {
        new Workspace(cfg.lab.dir).recordBee(d);
      } catch (err) {
        log.warn("skill workshop: could not record a bunny's draft", { err: safeError(err) });
      }
    },
    maxCallsPerDay: cfg.evolution.survivalMaxCallsDay,
    researchMaxCallsPerDay: cfg.lab.selfResearchMaxCallsDay,
    watchlist: cfg.lab.watchlist,
    universe: () => coinInfos(feed.view(), 40, cmcState()),
    market: mood,
    scalp: scalpOn,
  });

  // Trading hours of stocks and commodities, learned from their tickers every minute (market/sessions.ts). Always on,
  // so the calendar is ready by the time the owner forms a macro squad.
  const sessions = new SessionRecorder(loadCalendar(cfg.macro.sessionsPath) ?? emptyCalendar(Date.now()));
  const sampleSessions = () => {
    const v = feed.view();
    const ticks: TickSample[] = [];
    for (const i of v.instruments.values()) {
      if (i.state !== "live" || (i.kind !== "stock" && i.kind !== "commodity")) continue;
      const t = v.tickers.get(i.instId);
      if (t && Number.isFinite(t.ts)) ticks.push({ coin: i.coin, kind: i.kind, ts: t.ts, last: t.last, vol24h: t.vol24hUsd, spreadBp: t.spreadBp });
    }
    if (ticks.length) sessions.sample(ticks, Date.now());
  };
  const saveSessions = () => {
    try {
      saveCalendar(cfg.macro.sessionsPath, sessions.calendar);
    } catch (err) {
      log.warn("sessions: save failed", { err: safeError(err) });
    }
  };
  const sessionTimers = [setInterval(sampleSessions, 60_000), setInterval(saveSessions, 10 * 60_000)];

  engine = new Engine({
    cfg, db, feed, jev, shadowJev, exec, bus, alerts, closeRequested: () => existsSync(closeFlag), takeResumeRequest, evolution,
    sessions: () => sessions.calendar,
    cmc: cmcState,
    scalpGate: scalpLabGate,
    scalpClosed: (r) => coinBook.recordLive(r),
    ...(cfg.lab.watchlist ? { watchlist: (id: BeeId) => playbook.get()?.bees[id]?.watchlist ?? null } : {}),
    ...(cfg.lab.specialization ? { specialization: (id: BeeId) => playbook.get()?.bees[id]?.specialization ?? null, skillById: (sid: string) => skillMap.get(sid) } : {}),
    ...(signals
      ? {
          labVotes: (id: BeeId, instIds: string[]) => {
            const view = feed.view();
            const coins = instIds.map((instId) => ({ instId, coin: view.instruments.get(instId)?.coin ?? instId.split("-")[0]! }));
            return signals.votes(id, coins, (instId) => feed.candles1h(instId));
          },
          labNote: LAB_NOTE,
        }
      : {}),
  });
  await engine.start();
  const coach = new Coach({
    graph, db, clients, bees: councilBees, playbookPath: cfg.lab.playbookPath, intervalMin: cfg.lab.coachIntervalMin, maxCallsPerDay: cfg.lab.coachMaxCallsDay,
    watchlist: cfg.lab.watchlist,
    universe: () => coinInfos(feed.view(), 40, cmcState()),
    market: mood,
    scalp: scalpOn,
    ranking: readRanking,
    watchSize: (id) => watchlistSize(evolution.bees[id]?.level ?? 0, evolution.bees[id]?.tier ?? null),
    specialization: cfg.lab.specialization,
  });
  coach.start();
  // Keep the evidence underneath every learned skill fresh without ever blocking a trading tick. History downloads,
  // walk-forward tournaments and scalp validation run in a child process; their schedule survives engine restarts.
  const swapInstrument = (coin: string) => coin.includes("-") ? coin.toUpperCase() : `${coin.toUpperCase()}-USDT-SWAP`;
  const scalpUniverse = () => cfg.scalp.coins.includes("*")
    ? feed.view().gated
    : cfg.scalp.coins.map(swapInstrument);
  const autoLabInstruments = [...new Set([
    "BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "HYPE-USDT-SWAP",
    ...cfg.beeIds.filter((id) => cfg.slots[id].market === "crypto").flatMap((id) => cfg.slots[id].coins.map(swapInstrument)),
    ...scalpUniverse().slice(0, cfg.scalp.universeSize),
  ])];
  const recordLatestScalpReport = () => {
    const report = loadScalpReport(cfg.lab.dir);
    if (!report) throw new Error("scalp lab completed without a readable report");
    const brain = cfg.brains.slots.bee4;
    recordScalpResearch({ ledger: db.experiments, graph, report, mode: cfg.mode, brainModel: clients[brain]?.model ?? brain });
    // Each coin's rules move on what the lab measured (validated, failing, retired); applied once per report.
    coinBook.applyReport(report);
  };
  // Backfill the latest report from installations that predate the ledger bridge. The report fingerprint makes this
  // harmless on every later restart and gives Degen its existing NO EDGE lesson immediately.
  if (loadScalpReport(cfg.lab.dir)) {
    try {
      recordLatestScalpReport();
    } catch (err) {
      log.warn("could not backfill scalp research into the ledger", { err: safeError(err) });
    }
  }
  const autoLab = new AutoLab({
    db,
    intervalHours: cfg.lab.autoLabIntervalHours,
    scalpIntervalHours: cfg.lab.autoScalpLabIntervalHours,
    startDelayMin: cfg.lab.autoLabStartDelayMin,
    instruments: autoLabInstruments,
    scalpCoins: scalpUniverse,
    scalpBatchSize: cfg.scalp.universeSize,
    // Coins with passing rules, then coins where the book has rules waiting for a test, then the lab brain's focus.
    scalpPinned: () => [...new Set([...scalpLabGate().rules.map((rule) => rule.coin), ...coinBook.priorityCoins().slice(0, 10), ...(labBrain?.focus() ?? [])])].map(swapInstrument),
    scalpEnabled: cfg.scalp.enabled,
    run: labProcessRunner(cfg.settingsPath),
    onScalpReport: recordLatestScalpReport,
  });
  autoLab.start();

  // The Farmer (brains/farmer.ts): every FARMER_INTERVAL_MIN he looks at all the bunnies, says one line, and may rewrite a
  // bunny's rules once a day. With real money he only suggests unless FARMER_MODE=apply. FARMER=0 turns him off.
  const farmerBrain = process.env.FARMER_BRAIN?.trim();
  const farmerLlm = process.env.FARMER === "0" ? null : ((farmerBrain ? clients[farmerBrain] : undefined) ?? clients.claude ?? clients.openai ?? Object.values(clients)[0] ?? null);
  const farmer = new Farmer({
    db: db.raw,
    llm: farmerLlm,
    mode: process.env.FARMER_MODE === "apply" || (process.env.FARMER_MODE !== "advise" && cfg.mode !== "live") ? "apply" : "advise",
    intervalMin: Number(process.env.FARMER_INTERVAL_MIN ?? 120),
    bees: () => cfg.beeIds.map((id) => ({ slot: id, name: cfg.slots[id].name, style: cfg.slots[id].style, coins: cfg.slots[id].coins, rules: cfg.slots[id].rules })),
    stats: (id) => {
      const b = engine.bees[id];
      return farmerStats(db.raw, id, Date.now(), cfg.slots[id].startEquityUsd ?? 0, b?.position ? `${b.position.side} ${b.position.instId.split("-")[0]}` : null);
    },
    setRules: (id, rules) => {
      engine.setRules(id, rules);
      const cb = councilBees.find((x) => x.slot === id);
      if (cb) cb.rules = rules;
      // Saved where the owner's rules live, so a restart keeps them; the admin panel shows them like any edit.
      const st = loadSettings(cfg.settingsPath);
      const i = Number(id.slice(3)) - 1;
      if (st?.bees[i]) {
        st.bees[i] = { ...st.bees[i]!, rules };
        saveSettings(cfg.settingsPath, st);
      }
    },
  });
  farmer.start();
  // GhostProof (docs/GHOSTPROOF.md): every decision, order and fill as an AgentProof event with hashes only, kept in a
  // local outbox and sent to the gateway when GHOSTPROOF_TOKEN is set. GHOSTPROOF=1 turns it on.
  const ghostToken = process.env.GHOSTPROOF_TOKEN?.trim() || null;
  const ghostproof = process.env.GHOSTPROOF === "1"
    ? new GhostProofRecorder({
        db: db.raw,
        ctx: { actorId: process.env.GHOSTPROOF_ACTOR?.trim() || `beebots-${cfg.mode}`, mode: cfg.mode, model: cfg.jev.model },
        client: ghostToken ? new GhostProofClient({ baseUrl: process.env.GHOSTPROOF_URL?.trim() || "https://gateway.efps.live/api", token: () => ghostToken }) : null,
      })
    : null;
  ghostproof?.start();
  if (ghostproof) log.info("ghostproof: recording decisions", { sending: !!ghostToken });
  // His portrait: painted once with the OpenAI image key, in the bunnies' style, and kept in the data volume. Until then
  // (or without a key) the page shows the drawn one (dashboard/public/farmer.svg). FARMER_PAINT=0 never paints.
  const farmerImage = join(imageDir(cfg.settingsPath), "farmer.jpg");
  if (farmer.enabled && process.env.FARMER_PAINT !== "0" && cfg.openai.apiKey && !existsSync(farmerImage)) {
    void paintFarmer(cfg.openai.apiKey, cfg.openai.imageModel, REF_DIR)
      .then((jpg) => {
        mkdirSync(dirname(farmerImage), { recursive: true });
        writeFileSync(farmerImage, jpg);
        log.info("farmer: portrait painted");
      })
      .catch((e) => log.warn("farmer: portrait could not be painted, the drawn one stays", { error: safeError(e).message }));
  }
  // The crew (brains/crew.ts): the Owl coaches, the Rat reads the market, the Pig keeps the books. Each has its own brain
  // (OWL_BRAIN, RAT_BRAIN, PIG_BRAIN; default ChatGPT, then the Farmer's order), its own interval (OWL_INTERVAL_MIN, ...)
  // and its data tools (brains/crewData.ts). OWL=0, RAT=0 or PIG=0 sends one home. They advise; they never trade.
  const crewSnap = () => engine.snapshot() as unknown as CrewSnapshot;
  const crewBees = () => cfg.beeIds.map((id) => ({ slot: id, name: cfg.slots[id].name, style: cfg.slots[id].style, coins: cfg.slots[id].coins, rules: cfg.slots[id].rules }));
  const crewNode = (id: CrewId) => graph.upsert("run", id, `${CREW[id].name} (${CREW[id].role})`, { crew: id });
  const crewLlm = (id: CrewId) => {
    const key = id.toUpperCase();
    if (process.env[key] === "0") return null;
    const want = process.env[`${key}_BRAIN`]?.trim();
    return (want ? clients[want] : undefined) ?? clients.openai ?? clients.claude ?? Object.values(clients)[0] ?? null;
  };
  const crew: Record<CrewId, CrewMember> = {
    owl: new CrewMember(CREW.owl, {
      db: db.raw,
      llm: crewLlm("owl"),
      intervalMin: Number(process.env.OWL_INTERVAL_MIN ?? CREW.owl.everyMinDefault),
      gather: () => owlData(db.raw, crewSnap(), crewBees(), Date.now()),
      // A coaching note lands in the bunny's Warren inbox, which its councils, coach and research read.
      deliver: (_say, notes) => {
        const from = crewNode("owl");
        for (const n of notes) if (n.bee && cfg.beeIds.includes(n.bee as BeeId)) graph.post(from, beeNode(n.bee), `${n.title}: ${n.text}`.slice(0, 600), { source: "owl", level: n.level });
      },
    }),
    rat: new CrewMember(CREW.rat, {
      db: db.raw,
      llm: crewLlm("rat"),
      intervalMin: Number(process.env.RAT_INTERVAL_MIN ?? CREW.rat.everyMinDefault),
      gather: () => ratData(crewSnap(), cmcState()),
      // The brief becomes the Rat's lesson; every bunny's context reads his latest (graph/hive-mind.ts marketBrief).
      deliver: (say, notes) => {
        const brief = [say, ...notes.slice(0, 5).map((n) => `${n.title}: ${n.text}`)].join(" | ");
        graph.learn(crewNode("rat"), brief.slice(0, 600), [], { source: "rat" });
      },
    }),
    pig: new CrewMember(CREW.pig, {
      db: db.raw,
      llm: crewLlm("pig"),
      intervalMin: Number(process.env.PIG_INTERVAL_MIN ?? CREW.pig.everyMinDefault),
      gather: () => pigData(db.raw, crewSnap(), Object.fromEntries(cfg.beeIds.map((id) => [id, cfg.slots[id].name])), Date.now(), { coinMarketCap: cmc?.status() ?? null }),
      // What needs doing about money is told to the whole Warren.
      deliver: (_say, notes) => {
        const from = crewNode("pig");
        for (const n of notes) if (n.level === "act") graph.post(from, n.bee && cfg.beeIds.includes(n.bee as BeeId) ? beeNode(n.bee) : "hive", `${n.title}: ${n.text}`.slice(0, 600), { source: "pig", level: n.level });
      },
    }),
  };
  for (const id of CREW_IDS) crew[id].start();
  // Their portraits: painted once each with the OpenAI image key, like the Farmer's. CREW_PAINT=0 never paints.
  const crewImage = (id: CrewId) => join(imageDir(cfg.settingsPath), `crew-${id}.jpg`);
  if (process.env.CREW_PAINT !== "0" && cfg.openai.apiKey) {
    void (async () => {
      for (const id of CREW_IDS) {
        if (!crew[id].enabled || existsSync(crewImage(id))) continue;
        try {
          const jpg = await paintFarmer(cfg.openai.apiKey!, cfg.openai.imageModel, REF_DIR, 180_000, crewBrief(CREW[id].name, CREW[id].look));
          mkdirSync(dirname(crewImage(id)), { recursive: true });
          writeFileSync(crewImage(id), jpg);
          log.info(`crew: ${id}'s portrait painted`);
        } catch (e) {
          log.warn(`crew: ${id}'s portrait could not be painted`, { error: safeError(e).message });
        }
      }
    })();
  }
  // Agent-led R&D is deliberately slower than trading. Each agent's own brain proposes one hypothesis, the existing
  // walk-forward lab tests it, and both accepted and rejected attempts become durable graph memory. Attempts and the
  // shared daily budget are persisted before each call: a restart cannot make the agents repeat research or overspend.
  let researchTimer: NodeJS.Timeout | null = null;
  let researchRunning = false;
  const researchIntervalMs = cfg.lab.selfResearchIntervalMin * 60_000;
  const researchPollMs = Math.min(researchIntervalMs, 60 * 60_000);
  const researchCycle = async () => {
    if (researchRunning) return;
    researchRunning = true;
    try {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      const savedDay = db.getMeta("self_research_budget_day");
      let used = savedDay === day ? Number(db.getMeta("self_research_budget_used") ?? 0) : 0;
      if (savedDay !== day) {
        db.setMeta("self_research_budget_day", day);
        db.setMeta("self_research_budget_used", "0");
      }
      for (const bee of councilBees) {
        if (used >= cfg.lab.selfResearchMaxCallsDay) break;
        const attemptKey = `self_research_${bee.slot}_attempt_at`;
        const lastAttempt = Number(db.getMeta(attemptKey) ?? 0);
        if (Number.isFinite(lastAttempt) && now - lastAttempt < researchIntervalMs) continue;
        // Reserve the call durably before invoking a provider so a crash cannot replay it for free.
        db.setMeta(attemptKey, String(now));
        used++;
        db.setMeta("self_research_budget_used", String(used));
        try {
          const result = await survival?.convene(bee, "research");
          if (!result) log.info("self research deferred", { bee: bee.slot });
        } catch (err) {
          // A provider or one bunny failing must not starve the others.
          log.warn("self research failed", { bee: bee.slot, err: safeError(err) });
        }
      }
    } finally {
      researchRunning = false;
      if (researchIntervalMs > 0) researchTimer = setTimeout(() => void researchCycle(), researchPollMs);
    }
  };
  if (researchIntervalMs > 0) {
    // Let the autonomous evidence refresh begin first; R&D remains independent if that heavier child process is slow.
    const firstResearchDelayMin = Math.min(cfg.lab.selfResearchIntervalMin, Math.max(30, cfg.lab.autoLabStartDelayMin + 20));
    researchTimer = setTimeout(() => void researchCycle(), firstResearchDelayMin * 60_000);
  }
  const notes = new NoteBook(join(cfg.lab.dir, "notes.json"), graph);
  // The lab's brain (brains/labBrain.ts): GPT by default (LAB_BRAIN picks another; LAB_BRAIN=0 turns it off). Every
  // LAB_BRAIN_INTERVAL_MIN it studies everything the brains know and evolves each coin's rules in the coin book; one
  // bunny per round proposes rules for its own coins with its own brain.
  const labBrainId = process.env.LAB_BRAIN?.trim() || "openai";
  // LAB_BRAIN_MODEL / LAB_BRAIN_EFFORT give the study its own GPT (e.g. gpt-6-astra at max) apart from the bunnies'.
  const labEffort = (OPENAI_EFFORTS as readonly string[]).includes(process.env.LAB_BRAIN_EFFORT?.trim() ?? "") ? (process.env.LAB_BRAIN_EFFORT!.trim() as OpenAiEffort) : undefined;
  const labModel = process.env.LAB_BRAIN_MODEL?.trim();
  const openaiCreds = cfg.brains.creds.openai;
  const labOwnGpt = labBrainId === "openai" && openaiCreds && (labModel || labEffort) ? metered(new OpenAiBrain(openaiCreds.apiKey, labModel || openaiCreds.model, undefined, undefined, labEffort ?? openaiCreds.effort), usage) : null;
  const labLlm = () => (labBrainId === "0" ? null : (labOwnGpt ?? clients[labBrainId] ?? clients.openai ?? clients.claude ?? Object.values(clients)[0] ?? null));
  labBrain = new LabBrain({
    book: coinBook,
    graph,
    brain: labLlm,
    bunnyBrain: (b) => clients[b.brain] ?? null,
    bees: () => councilBees,
    report: () => loadScalpReport(cfg.lab.dir),
    ranking: readRanking,
    notes,
    market: mood,
    universe: () => coinInfos(feed.view(), 40, cmcState()) as unknown as Array<Record<string, unknown> & { coin: string }>,
    livePnl: () =>
      (db.raw.prepare("SELECT bee, inst_id AS inst, COUNT(*) AS n, SUM(realised_usd - fee_usd) AS net FROM fills WHERE ts >= ? GROUP BY bee, inst_id ORDER BY ABS(SUM(realised_usd - fee_usd)) DESC LIMIT 60").all(Date.now() - 14 * 86_400_000) as Array<{ bee: string; inst: string; n: number; net: number }>)
        .map((r) => ({ bee: r.bee, coin: r.inst.split("-")[0]!, trades: Number(r.n), netUsd: Math.round(Number(r.net) * 100) / 100 })),
    blockers: (slot) => blockers(db.raw, slot, Date.now(), 24),
    // The Rat writes lessons (his brief); the Owl and the Pig post messages.
    crew: () =>
      CREW_IDS.flatMap((id) => [
        ...graph.lessons(`run:${id}`, 2).map((l) => ({ who: CREW[id].name, text: l.text, at: l.ts })),
        ...graph.out(`run:${id}`, "said", 3).flatMap((e) => {
          const n = graph.node(e.dst);
          return n ? [{ who: CREW[id].name, text: String(n.props.text ?? n.label), at: n.updatedAt }] : [];
        }),
      ]).sort((a, b) => b.at - a.at),
    requestLab: () => autoLab.request("scalp"),
    path: join(cfg.lab.dir, "lab-brain.json"),
    intervalMin: Math.max(0, Number(process.env.LAB_BRAIN_INTERVAL_MIN ?? 360) || 0),
    maxCallsPerDay: Math.max(0, Number(process.env.LAB_BRAIN_MAX_CALLS_DAY ?? 8) || 0),
    startDelayMin: Math.max(1, Number(process.env.LAB_BRAIN_START_DELAY_MIN ?? 10) || 10),
  });
  labBrain.start();
  if (labBrain.enabled) log.info("lab brain: on", { brain: labBrainId, intervalMin: Number(process.env.LAB_BRAIN_INTERVAL_MIN ?? 360) });
  // Outside MCP servers the owner connected: read from the Setup file on every call, so changes apply at once.
  const mcp = new McpGateway({ servers: () => loadSettings(SETTINGS_PATH)?.mcpServers ?? [], path: join(cfg.lab.dir, "mcp.json") });
  const research = new Researcher({
    mcp, graph, notes, clients, bees: () => councilBees, playbookPath: cfg.lab.playbookPath, ranking: readRanking, market: mood,
    universe: () => coinInfos(feed.view(), 40, cmcState()), maxCallsPerDay: cfg.lab.coachMaxCallsDay,
  });
  let rankingCache: { at: number; body: unknown } = { at: 0, body: null };
  const labRanking = () => {
    if (Date.now() - rankingCache.at > 30_000) {
      try {
        const r = JSON.parse(readFileSync(rankingPath, "utf8")) as { results?: Array<Record<string, unknown>> };
        type Fold = { dataset: string; fold: number; params: unknown; oosScore: number; oos: { totalReturnPct: number; sharpe: number; trades: number; maxDrawdownPct: number; benchmarkPct: number } };
        // Folds are trimmed to what the dashboard's detail view shows.
        const trim = (f: Fold) => ({ dataset: f.dataset, fold: f.fold, params: f.params, score: f.oosScore, returnPct: f.oos.totalReturnPct, benchmarkPct: f.oos.benchmarkPct, sharpe: f.oos.sharpe, trades: f.oos.trades, maxDrawdownPct: f.oos.maxDrawdownPct });
        rankingCache = { at: Date.now(), body: { ...r, results: (r.results ?? []).map((x) => ({ ...x, folds: ((x.folds ?? []) as Fold[]).map(trim) })) } };
      } catch {
        rankingCache = { at: Date.now(), body: null };
      }
    }
    return rankingCache.body;
  };

  // The owner password (picked on Setup) gates joining and leaving the Warren from the dashboard. Installs without one
  // (a Setup file from before it existed, or keys only in .env) can set OWNER_PASSWORD instead.
  const envPassword = process.env.OWNER_PASSWORD ?? "";
  if (envPassword && envPassword.length < MIN_PASSWORD) log.warn(`OWNER_PASSWORD is ignored: it needs at least ${MIN_PASSWORD} characters`);
  let ownerHash = settings?.ownerPasswordHash ?? (envPassword.length >= MIN_PASSWORD ? hashPassword(envPassword) : null);
  const ownerPasswordHash = () => ownerHash;
  // One gate, one lockout, for every owner write (Warren and admin panel).
  const gate = new PasswordGate("x-owner-password", ownerPasswordHash, "owner password");

  // The Warren (opt-in public leaderboard, paper only).
  const hive = new Hive({
    ownerPasswordHash,
    gate,
    path: hivePath(cfg.settingsPath),
    url: cfg.hive.url,
    mode: cfg.mode,
    db,
    portrait: (slot) => (cfg.slots[slot as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, slot) : null),
    source: () => {
      const snap = engine!.snapshot();
      return {
        startedAt: snap.startedAt,
        startEquityUsd: snap.startEquityUsd,
        // The Warren leaderboard knows the four main slots only; extra bunnies race locally.
        bees: snap.bees.filter((b) => (BEES as readonly string[]).includes(b.bee)).map((b) => {
          const s = cfg.slots[b.bee];
          return { slot: b.bee, name: s.name, style: s.style, tagline: s.tagline, rules: s.rules, coins: s.coins, equityUsd: b.equityUsd, fundingUsd: b.totals.fundingUsd, cap: b.cap, tradesToday: b.tradesToday };
        }),
      };
    },
  });
  hive.start(settings);

  // "Update available" on the dashboard (checks GitHub Releases; never installs anything).
  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();

  // The admin panel: settings, keys, bunnies, password, lab jobs, coach, restart (admin/admin.ts).
  const jobs = new LabJobs(
    () => withOverrides(process.env, loadOverrides(SETTINGS_PATH)),
    () => {
      rankingCache = { at: 0, body: null };
    },
  );
  const experimentControl = new ExperimentControl(db, cfg.jev.shadowEnabled);
  const currentBrainCreds = (candidate = withOverrides(process.env, loadOverrides(SETTINGS_PATH))) =>
    loadConfig({ ...candidate, TYPESAFE_API_KEY: candidate.TYPESAFE_API_KEY || "model-catalog-validation" }, loadSettings(SETTINGS_PATH)).brains.creds;
  const admin = new Admin({
    coinBook,
    ...(labBrain ? { labBrain } : {}),
    // The admin console (admin/metrics.ts): the engine's own records per time bucket, plus live system state.
    metrics: (range: string) => {
      const r = (range in RANGES ? range : "24h") as RangeId;
      const settingsNow = withOverrides(process.env, loadOverrides(SETTINGS_PATH));
      return {
        ...adminMetrics({
          db: db.raw,
          bees: cfg.beeIds.map((id) => ({ slot: id, name: cfg.slots[id].name, style: cfg.slots[id].style, startEquityUsd: startEquityOf(cfg, id) ?? null })),
          range: r,
          now: Date.now(),
          prices: parsePrices(settingsNow.LLM_PRICES),
          jevDailyCapUsd: cfg.jev.dailyUsdCap,
        }),
        live: {
          health: engine!.health(),
          autolab: autoLab.state(),
          labBrain: labBrain ? { ...labBrain.status(), studies: labBrain.status().studies.slice(0, 1) } : null,
          coinBook: coinBook.view(false).totals,
          ghostproof: ghostproof?.status() ?? null,
          scalpGate: (() => {
            const g = scalpLabGate();
            return { open: g.open, reason: g.reason, rules: g.rules.length };
          })(),
          brains: Object.fromEntries(Object.entries(clients).map(([k, c]) => [k, c?.model ?? null])),
          prices: settingsNow.LLM_PRICES ?? "",
        },
      };
    },
    settingsPath: SETTINGS_PATH,
    env: process.env,
    gate,
    mode: cfg.mode,
    version: cfg.update.version,
    checks: {
      jev: (k) => checkJevKey(k, cfg.jev.model),
      openai: (k) => checkOpenAiKey(k).then(() => null, (e: Error) => `OpenAI said: ${e.message}`),
      anthropic: (k) => checkClaudeKey(k),
      coinmarketcap: (k) => checkCmcKey(k),
      kimi: (k) => checkKimiKey(k, cfg.brains.creds.kimi?.baseUrl ?? (process.env.KIMI_BASE_URL?.trim() || undefined)),
      alpaca: (keyId, secret, feed) => checkAlpacaKey({ keyId, secret, feed, baseUrl: process.env.ALPACA_DATA_URL?.trim() || undefined }),
      zai: (k) => checkCompatKey(cfg.brains.creds.zai?.baseUrl ?? (process.env.ZAI_BASE_URL?.trim() || ZAI_BASE_URL), k, cfg.brains.creds.zai?.model ?? (process.env.ZAI_MODEL?.trim() || ZAI_DEFAULT_MODEL), "Z.ai"),
      compat: (url, key, model, vendor) => checkCompatKey(url, key, model, vendor),
    },
    models: {
      list: (provider) => listBrainModels(provider, currentBrainCreds()),
      check: (provider, model, candidate) => checkBrainModel(provider, currentBrainCreds(candidate), model),
    },
    okxCheck: (creds, kind, walletUsd) => checkOkxAccount(cli, creds, kind, walletUsd),
    anthropicLogin: {
      profile: ANTHROPIC_PROFILE,
      active: () => hasAnthropicLogin(),
      check: () => checkClaudeKey({ profile: ANTHROPIC_PROFILE }),
    },
    jobs,
    coachNow: Object.keys(clients).length ? () => coach.reflectAll() : null,
    graphStats: () => graph.stats(),
    playbook: () => playbook.get(),
    experiments: experimentControl,
    onPasswordChanged: (hash) => {
      ownerHash = hash;
    },
    restart: () => shutdown("admin restart"),
    coins: () => {
      const set = new Set<string>();
      for (const i of feed.view().instruments.values()) if (i.kind === "crypto" && i.state === "live") set.add(i.coin);
      return [...set].sort();
    },
    macroCoins: () => {
      const c = new Set<string>();
      const s = new Set<string>();
      for (const i of feed.view().instruments.values()) {
        if (i.state !== "live" || !i.instId.includes("_UM_XPERP-")) continue;
        if (i.kind === "commodity") c.add(i.coin);
        if (i.kind === "stock") s.add(i.coin);
      }
      return { commodities: [...c].sort(), stocks: [...s].sort() };
    },
    sessions: () => ({
      watchedHours: watchedHours(sessions.calendar, Date.now()),
      allowNonCrypto: cfg.universe.allowNonCrypto,
      noOpenMin: cfg.macro.noOpenMin,
      coins: calendarSummary(sessions.calendar).map((c) => ({ ...c, now: sessionInfo(sessions.calendar, c.coin, Date.now()) })),
    }),
    runningBees: () => cfg.beeIds,
    isFlat: (id) => !engine?.bees[id]?.position,
    forgetBee: (id) => {
      // Only a slot the engine is not running (a bunny added since the last restart).
      if (cfg.beeIds.includes(id)) return;
      db.raw.prepare("DELETE FROM bee_state WHERE bunny = ?").run(id);
      delete evolution.bees[id];
      engine?.saveEvolution();
    },
    revive: (id) => engine!.respawn(id),
    council: async (id) => {
      const bee = beeByslot(id);
      if (!bee) throw new Error("That bunny is not running; restart the engine after adding it.");
      return survival?.convene(bee, "manual");
    },
    evolution: () => engine?.snapshot().evolution ?? null,
    registerSkill: addSkill,
    labDir: cfg.lab.dir,
    notes,
    research,
    mcp,
    portraits: {
      design: (key, description, coins) => designBee(key, cfg.openai.textModel, description, coins),
      paint: (key, name, look) => paintBee(key, cfg.openai.imageModel, REF_DIR, name, look),
    },
    skillAgent: new SkillAgent({ clients: () => clients, maxCallsPerDay: Math.max(cfg.lab.coachMaxCallsDay, 20) }),
  });

  // Visitors may ask a bunny for its view (publicChat.ts): the bunny's own brain answers, read-only, within a daily ceiling.
  const chat =
    process.env.PUBLIC_CHAT === "0"
      ? undefined
      : new PublicChat({
          market: okxChatMarket(feed, api),
          agent: (id) => {
            if (!(cfg.beeIds as readonly string[]).includes(id)) return null;
            const s = cfg.slots[id as keyof typeof cfg.slots];
            return { name: s.name, tagline: s.tagline, style: s.style, mode: "fixed", rules: s.rules, coins: s.coins, state: engine?.bees[id as keyof typeof engine.bees]?.position ? "in a position" : "running" };
          },
          llm: (id) => clients[cfg.brains.slots[id as keyof typeof cfg.brains.slots]] ?? Object.values(clients)[0] ?? null,
          own: (id) => ownFromEngineDb(db.raw, id, Date.now()),
          perHour: Number(process.env.PUBLIC_CHAT_PER_HOUR ?? 5),
          dailyLimit: Number(process.env.PUBLIC_CHAT_DAILY_LIMIT ?? 300),
        });

  const server = startServer(
    {
      engine: {
        chat,
        farmer: () => ({ ...farmer.summary(), image: existsSync(farmerImage) ? "/farmer-image" : "/farmer.svg" }),
        farmerImage: () => (existsSync(farmerImage) ? farmerImage : null),
        farmerLog: (limit, before) => farmer.entries(limit, before),
        crew: () => CREW_IDS.map((id) => ({ ...crew[id].summary(), animal: CREW[id].animal, image: existsSync(crewImage(id)) ? `/crew-image/${id}` : null })),
        crewLog: (id, limit, before) => ((CREW_IDS as readonly string[]).includes(id) ? { member: { ...crew[id as CrewId].summary(), animal: CREW[id as CrewId].animal, image: existsSync(crewImage(id as CrewId)) ? `/crew-image/${id}` : null }, entries: crew[id as CrewId].entries(limit, before), dashboard: crew[id as CrewId].dashboard() } : null),
        crewImage: (id) => ((CREW_IDS as readonly string[]).includes(id) && existsSync(crewImage(id as CrewId)) ? crewImage(id as CrewId) : null),
        bus, db, visitors: new Visitors(db), snapshot: () => engine!.snapshot(), health: () => engine!.health(), update: () => updates.status(),
        lab: {
          ranking: labRanking,
          playbook: () => playbook.get(),
          graph: () => graph.export(),
          context: (bee) => contextFor(graph, bee),
          query: (q) => memoryQuery(graph, q),
          path: (from, to) => memoryPath(graph, from, to),
          explain: (node) => memoryExplain(graph, node),
          report: () => hiveReport(graph),
          // The coin book and the lab brain's studies, for everyone: names and numbers, never the rules' specs.
          book: () => ({ book: coinBook.view(false), brain: labBrain?.status() ?? null }),
        },
        bunny: (slot, days) => bunnyProfile({ db, graph, playbook: () => playbook.get(), slots: () => cfg.beeIds }, slot, days),
      },
      hive,
      admin,
      profile: () => profile(cfg),
      beeImage: (b) => (cfg.slots[b as keyof typeof cfg.slots]?.customImage ? imagePath(cfg.settingsPath, b) : null),
    },
    cfg.server.port,
    cfg.server.bind,
  );

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    engine?.stop();
    for (const t of sessionTimers) clearInterval(t);
    if (researchTimer) clearTimeout(researchTimer);
    autoLab.stop();
    saveSessions();
    coach.stop();
    farmer.stop();
    ghostproof?.stop();
    labBrain?.stop();
    for (const id of CREW_IDS) crew[id].stop();
    cmc?.stop();
    graph.close();
    hive.stop();
    updates.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: safeError(err) });
  process.exit(1);
});
