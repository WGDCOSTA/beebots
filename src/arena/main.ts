// The Arena as its own process: `pnpm arena`. It shares no database, settings file or key with the owner's engine and
// admin panel, which is the whole point: the platform's owner has no route to a user's data.
//   ARENA_DIR          where the directory database and the per-user files live (default ./data/arena)
//   ARENA_BASE_URL     the public address of the sign-in page (default http://localhost:5173)
//   ARENA_PORT / ARENA_BIND   (default 8090 / 127.0.0.1)
//   ARENA_MAIL_API_KEY + ARENA_MAIL_FROM   send real e-mail through Resend; without them links are printed to the log
//   ARENA_RUN=1        open the race track: run members' bunnies on paper (needs ARENA_OPENAI_KEY; ARENA_MAX_RUNNERS, ARENA_TICK_MS, ARENA_START_USD, ARENA_BOT_DAILY_USD, ARENA_LLM_MODEL, ARENA_LLM_USD_PER_MTOK)
//   ARENA_OPENAI_KEY   the platform's own OpenAI key for the free AI design and portrait of a member's first bunny (ARENA_TEXT_MODEL, ARENA_IMAGE_MODEL, ARENA_AI_DAILY_LIMIT)
import { createServer } from "node:http";
import { log } from "../log.js";
import { ArenaApi } from "./api.js";
import { PlatformAi } from "./ai.js";
import { BREEZY_COINS } from "../bees/breezy.js";
import { OpenAiBrain } from "../brains/llm.js";
import { loadConfig } from "../config.js";
import { MarketFeed } from "../market/data.js";
import { createPublicApi } from "../okx/public.js";
import { STYLES } from "../settings.js";
import { LlmSystemOne } from "./decider.js";
import { sharedFeed } from "./feed.js";
import { ArenaRunner } from "./runner.js";
import { ArenaAuth } from "./auth.js";
import { ConsoleMailer, ResendMailer, type Mailer } from "./mailer.js";
import { ArenaStore } from "./store.js";

const env = process.env;
const baseUrl = env.ARENA_BASE_URL ?? "http://localhost:5173";
const mailer: Mailer = env.ARENA_MAIL_API_KEY && env.ARENA_MAIL_FROM ? new ResendMailer(env.ARENA_MAIL_API_KEY, env.ARENA_MAIL_FROM) : new ConsoleMailer();
if (mailer instanceof ConsoleMailer) log.warn("arena: no mail provider configured, sign-in links are printed to the log (development only)");

// The platform's own AI, for a member's first bunny: a sentence becomes a bunny and gets a portrait. Its own key, never the owner's.
const ai = env.ARENA_OPENAI_KEY
  ? new PlatformAi({ apiKey: env.ARENA_OPENAI_KEY, textModel: env.ARENA_TEXT_MODEL ?? "gpt-5.4-nano", imageModel: env.ARENA_IMAGE_MODEL ?? "gpt-image-2", refDir: env.REF_DIR ?? "./dashboard/public/bees" })
  : null;
if (!ai) log.warn("arena: ARENA_OPENAI_KEY is not set, the free AI design and portrait are off");

const store = new ArenaStore(env.ARENA_DIR ?? "./data/arena");

// The race track: runs every member's bunnies on paper (runner.ts). Needs the platform's model key and is off by default.
let runner: ArenaRunner | null = null;
if (env.ARENA_RUN === "1") {
  if (!env.ARENA_OPENAI_KEY) log.warn("arena: ARENA_RUN=1 needs ARENA_OPENAI_KEY (the platform's decision model). Bots are only stored.");
  else {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "arena-platform", DRY_RUN: "true" });
    const real = new MarketFeed(createPublicApi(cfg.okx.apiBase), { min24hVolUsd: cfg.universe.min24hVolUsd, spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)), trendCoins: [...BREEZY_COINS], macro: null }, null, () => runner?.held() ?? []);
    const llm = new OpenAiBrain(env.ARENA_OPENAI_KEY, env.ARENA_LLM_MODEL ?? env.ARENA_TEXT_MODEL ?? "gpt-5.4-nano", 30_000);
    runner = new ArenaRunner({
      store,
      root: env.ARENA_DIR ?? "./data/arena",
      feed: sharedFeed(real),
      decider: new LlmSystemOne(llm),
      maxRunners: Number(env.ARENA_MAX_RUNNERS ?? 25),
      tickMs: Number(env.ARENA_TICK_MS ?? 60_000),
      startUsd: Number(env.ARENA_START_USD ?? 1000),
      dailyUsd: Number(env.ARENA_BOT_DAILY_USD ?? 0.5),
      usdPerMTok: Number(env.ARENA_LLM_USD_PER_MTOK ?? 0.3),
    });
    runner.begin();
    log.info("arena: race track open (paper trading only)", { maxRunners: Number(env.ARENA_MAX_RUNNERS ?? 25) });
  }
}

const api = new ArenaApi(new ArenaAuth(store, mailer, { baseUrl }), store, { secureCookie: baseUrl.startsWith("https://"), ai, aiDailyLimit: Number(env.ARENA_AI_DAILY_LIMIT ?? 100), runner });

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  void api.handle(req, res, path).then((handled) => {
    if (!handled) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
    }
  }).catch((e) => {
    log.error("arena request failed", { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"request failed"}');
  });
});

const port = Number(env.ARENA_PORT ?? 8090);
const bind = env.ARENA_BIND ?? "127.0.0.1";
server.listen(port, bind, () => log.info("arena listening", { port, bind }));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close();
    runner?.stopAll();
    store.close();
    process.exit(0);
  });
