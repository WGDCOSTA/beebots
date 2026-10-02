// The Arena as its own process: `pnpm arena`. It shares no database, settings file or key with the owner's engine and
// admin panel, which is the whole point: the platform's owner has no route to a user's data.
//   ARENA_DIR          where the directory database and the per-user files live (default ./data/arena)
//   ARENA_BASE_URL     the public address of the sign-in page (default http://localhost:5173)
//   ARENA_PORT / ARENA_BIND   (default 8090 / 127.0.0.1)
//   ARENA_MAIL_API_KEY + ARENA_MAIL_FROM   send real e-mail through Resend; without them links are printed to the log
//   ARENA_RUN=1        open the race track: run members' bunnies on paper (needs ARENA_OPENAI_KEY; ARENA_MAX_RUNNERS, ARENA_TICK_MS, ARENA_START_USD, ARENA_BOT_DAILY_USD, ARENA_LLM_MODEL, ARENA_LLM_USD_PER_MTOK, ARENA_SAMPLE_MS for the leaderboard samples)
//   ARENA_STRIPE_KEY + ARENA_STRIPE_WEBHOOK_SECRET + ARENA_STRIPE_PRICE_PRO + ARENA_STRIPE_PRICE_PREMIUM   open payments on the operator's own Stripe account (ARENA_STRIPE_TAX=1 lets Stripe Tax work out VAT). Without them everyone is on Free and the plans page says payments are not open.
//   ARENA_OPERATOR_NAME / _ADDRESS / _COMPANY_NO / _VAT / _EMAIL / _PRIVACY_EMAIL   who operates the Arena, shown on the legal pages. ARENA_LEGAL_REVIEWED_ON=YYYY-MM-DD   the day counsel signed the texts off; until it is set every legal page says it is a draft
//   ARENA_HISTORY=0   do not fetch historical candles (default: with ARENA_RUN=1, the agents' coins are kept up to date every ARENA_HISTORY_SYNC_MS, 6 h); ARENA_TRAIN_USD   what one simulated training may spend on the platform's model (default 1); ARENA_TRAIN_PARALLEL   trainings at once (default 2)
//   ARENA_CHAT_DAILY_LIMIT   chat messages the whole platform answers on its own model per day (default 2000; needs ARENA_RUN=1); ARENA_PUBLIC_CHAT_PER_HOUR / _DAILY_LIMIT   visitors' questions to the house agents per address per hour (5) and in all per day (300)
//   ARENA_SKILLS_DIR   folders (comma separated) of skill packs (JSON) added to the built-in library members can pick from (default ./skills)
//   ARENA_VAULT_KEY    32 random bytes (hex or base64) that encrypt members' own model keys. Keep it outside the data folder and back it up: without it the stored keys cannot be read. Unset = members cannot add their own keys. (ARENA_OWN_KEY_DAILY_USD: the daily ceiling for an agent on a member's key when the member set none, default 1000)
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
import { Leaderboard } from "./ranking.js";
import { ArenaRunner } from "./runner.js";
import { ArenaAuth } from "./auth.js";
import { Billing, HttpStripe, type BillingConfig } from "./billing.js";
import { ConsoleMailer, ResendMailer, type Mailer } from "./mailer.js";
import { ArenaStore } from "./store.js";
import { Vault } from "./vault.js";
import { okxChatMarket } from "./chat.js";
import { CandleStore, syncHistory } from "./history.js";
import { Trainer } from "./training.js";
import { createOkxPublicRest } from "../okx/rest.js";
import { COINS } from "./bots.js";
import { skillRegistry } from "../lab/skills/index.js";

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
const library = skillRegistry((env.ARENA_SKILLS_DIR ?? "./skills").split(",").map((d) => d.trim()).filter(Boolean));
for (const e of library.errors) log.warn("arena: a library skill could not be loaded", { error: e });
const vault = new Vault(env.ARENA_VAULT_KEY);
if (env.ARENA_VAULT_KEY && !vault.open) log.warn("arena: ARENA_VAULT_KEY is not 32 bytes (64 hex characters or base64), members' own keys stay closed");
if (!env.ARENA_VAULT_KEY) log.warn("arena: ARENA_VAULT_KEY is not set, members cannot add their own model keys");

// The race track: runs every member's bunnies on paper (runner.ts). Needs the platform's model key and is off by default.
const leaderboard = new Leaderboard(store.dir);
let runner: ArenaRunner | null = null;
// Historical candles for backtests and simulated training (public OKX data, one shared file).
const history = new CandleStore(`${env.ARENA_DIR ?? "./data/arena"}/history.sqlite`);
let trainer: Trainer | null = null;
let chat: { market: ReturnType<typeof okxChatMarket>; llm: OpenAiBrain | null; dailyLimit: number; publicPerHour: number; publicDailyLimit: number } | null = null;
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
      leaderboard,
      vault,
      library: library.skills,
      llm,
      ownKeyDailyUsd: Number(env.ARENA_OWN_KEY_DAILY_USD ?? 1000),
      sampleMs: Number(env.ARENA_SAMPLE_MS ?? 600_000),
    });
    trainer = new Trainer({ store, root: env.ARENA_DIR ?? "./data/arena", history, runner, platformBudgetUsd: Number(env.ARENA_TRAIN_USD ?? 1), maxParallel: Number(env.ARENA_TRAIN_PARALLEL ?? 2) });
    if (env.ARENA_HISTORY !== "0") {
      const rest = createOkxPublicRest({ apiBase: cfg.okx.apiBase, timeoutMs: 15_000 });
      const pub = createPublicApi(cfg.okx.apiBase);
      const sync = () =>
        syncHistory(history, { rest, instruments: () => pub.instruments() }, COINS)
          .then((r) => log.info("arena: history synced", { fetched: r.fetched, failed: r.failed.length }))
          .catch((e) => log.warn("arena: history sync failed", { error: e instanceof Error ? e.message : String(e) }));
      void sync();
      setInterval(() => void sync(), Number(env.ARENA_HISTORY_SYNC_MS ?? 6 * 3_600_000)).unref();
    }
    chat = { market: okxChatMarket(real, createPublicApi(cfg.okx.apiBase)), llm, dailyLimit: Number(env.ARENA_CHAT_DAILY_LIMIT ?? 2000), publicPerHour: Number(env.ARENA_PUBLIC_CHAT_PER_HOUR ?? 5), publicDailyLimit: Number(env.ARENA_PUBLIC_CHAT_DAILY_LIMIT ?? 300) };
    runner.begin();
    log.info("arena: race track open (paper trading only)", { maxRunners: Number(env.ARENA_MAX_RUNNERS ?? 25) });
  }
}

// Plans and payment, on the operator's own Stripe account (billing.ts).
const billingCfg: BillingConfig | null =
  env.ARENA_STRIPE_KEY && env.ARENA_STRIPE_WEBHOOK_SECRET && env.ARENA_STRIPE_PRICE_PRO && env.ARENA_STRIPE_PRICE_PREMIUM
    ? { secretKey: env.ARENA_STRIPE_KEY, webhookSecret: env.ARENA_STRIPE_WEBHOOK_SECRET, prices: { pro: env.ARENA_STRIPE_PRICE_PRO, premium: env.ARENA_STRIPE_PRICE_PREMIUM }, automaticTax: env.ARENA_STRIPE_TAX === "1", baseUrl: baseUrl.replace(/\/$/, "") }
    : null;
if (!billingCfg) log.warn("arena: Stripe is not configured, payments are closed and everyone is on Free");
const billing = new Billing(
  store,
  billingCfg,
  billingCfg ? new HttpStripe(billingCfg.secretKey) : null,
  async (userId, r) => {
    for (const id of [...r.quarantined, ...r.purged]) leaderboard.remove(id);
    await runner?.update(userId); // stops what is in quarantine, starts nothing the member did not ask for
  },
);
// A quarantine that has run out is deleted, and a missed event is caught up: every ten minutes, and once at start.
void billing.sweep();
const sweeper = setInterval(() => {
  void billing.sweep();
  store.purgeExpired(Date.now());
}, 600_000);
store.purgeExpired(Date.now());

const api = new ArenaApi(new ArenaAuth(store, mailer, { baseUrl }), store, { secureCookie: baseUrl.startsWith("https://"), ai, chat, history, trainer, aiDailyLimit: Number(env.ARENA_AI_DAILY_LIMIT ?? 100), runner, leaderboard, billing, vault, library: library.skills, operator: { name: env.ARENA_OPERATOR_NAME, address: env.ARENA_OPERATOR_ADDRESS, companyNo: env.ARENA_OPERATOR_COMPANY_NO, vat: env.ARENA_OPERATOR_VAT, email: env.ARENA_OPERATOR_EMAIL, privacyEmail: env.ARENA_OPERATOR_PRIVACY_EMAIL, reviewedOn: env.ARENA_LEGAL_REVIEWED_ON } });

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
    clearInterval(sweeper);
    runner?.stopAll();
    store.close();
    history.close();
    process.exit(0);
  });
