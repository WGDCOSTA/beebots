import { z } from "zod";
import { ANTHROPIC_PROFILE, BRAINS, BRAIN_ID_RE, hasAnthropicLogin, ZAI_BASE_URL, ZAI_DEFAULT_MODEL, type BrainCreds, type BrainId } from "./brains/llm.js";
import { parseHug, parseLock, type HugRung, type LockRung } from "./bees/ratchet.js";
import { squadOf, STYLE_INFO, STYLES, type MarketId, type Settings, type StyleId } from "./settings.js";

/**
 * The three main bunny slots (the live dashboard's columns, Setup, the Warren). Each one trades one of the three styles
 * (settings.ts); two bunnies may share a style. Extra bunnies added from the admin panel take slots bee4..bee9: the engine
 * runs every slot in `cfg.beeIds`.
 */
export const BEES = ["bee1", "bee2", "bee3"] as const;
export const ALL_SLOTS = ["bee1", "bee2", "bee3", "bee4", "bee5", "bee6", "bee7", "bee8", "bee9"] as const;
export type BeeId = (typeof ALL_SLOTS)[number];
/** Main slots plus extras. */
export const MAX_BEES = 9;
export const slotId = (i: number): BeeId => ALL_SLOTS[i]!;
export const isBeeId = (s: string): s is BeeId => (ALL_SLOTS as readonly string[]).includes(s);
export { STYLES, type StyleId };

/** Each main bunny thinks with its own LLM brain (strategy, lessons, messages; Jev still makes the per-tick call). */
const DEFAULT_BRAINS: Record<(typeof BEES)[number], BrainId> = { bee1: "openai", bee2: "claude", bee3: "kimi" };

/** With no Setup file (settings only from .env), the bunnies are the original three. */
const DEFAULT_SLOTS: Record<(typeof BEES)[number], StyleId> = { bee1: "bizzy", bee2: "breezy", bee3: "boozy" };
/** Typed as the only acknowledgement that unlocks MODE=live. */
export const LIVE_ACK_PHRASE = "I-ACCEPT-REAL-MONEY-RISK";

export type Mode = "dry" | "demo" | "live";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a number" });
        return z.NEVER;
      }
      return n;
    });
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));
/** One of `values`; blank (compose passes "" for an unset variable) means the default. */
const oneOf = <T extends readonly [string, ...string[]]>(values: T, def: T[number]) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v), z.enum(values).optional().default(def as never)) as unknown as z.ZodType<T[number], z.ZodTypeDef, string | undefined>;
/** A brain id: a built-in's or a custom brain's. Blank means the default; whether it exists is checked where clients are built. */
const brainId = (def: BrainId) =>
  z.preprocess((v) => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : v), z.string().regex(BRAIN_ID_RE, "a brain id like openai, claude, kimi, zai or a custom one").optional().default(def)) as unknown as z.ZodType<BrainId, z.ZodTypeDef, string | undefined>;
/** The three brains extra bunnies take turns on when none was chosen (unchanged by adding more brains). */
const ROTATION: BrainId[] = ["openai", "claude", "kimi"];
const opt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

// Per-style knobs: BIZZY_* = Breakout, BREEZY_* = Trend, BOOZY_* = Momentum. Every bunny on that style uses them.
const perStyle = (prefix: string, d: { trades: number; fee: number; spread: number; cooldown: number; stopAtr: number; maxFlat: number }) => ({
  [`${prefix}_MAX_TRADES_PER_DAY`]: num(d.trades),
  [`${prefix}_FEE_BUDGET_USD_DAY`]: num(d.fee),
  [`${prefix}_SPREAD_GATE_BPS`]: num(d.spread),
  [`${prefix}_COOLDOWN_MINUTES`]: num(d.cooldown),
  [`${prefix}_STOP_ATR_MULT`]: num(d.stopAtr),
  [`${prefix}_MAX_FLAT_MINUTES`]: num(d.maxFlat),
});
// Per-bee OKX keys (demo or live only): BEE1_OKX_API_KEY, BEE1_OKX_DEMO_API_KEY, ...
const perSlot = (prefix: string) => ({
  [`${prefix}_OKX_API_KEY`]: opt,
  [`${prefix}_OKX_API_SECRET`]: opt,
  [`${prefix}_OKX_API_PASSPHRASE`]: opt,
  [`${prefix}_OKX_DEMO_API_KEY`]: opt,
  [`${prefix}_OKX_DEMO_API_SECRET`]: opt,
  [`${prefix}_OKX_DEMO_API_PASSPHRASE`]: opt,
});

const EnvSchema = z.object({
  // DRY_RUN=true (the default) forces MODE=dry whatever MODE says. Going to demo or live needs both DRY_RUN=false and MODE set.
  DRY_RUN: bool(true),
  MODE: z.enum(["dry", "demo", "live"]).optional().default("dry"),

  TYPESAFE_API_KEY: opt,
  JEV_MODEL: str("jev-1.13.0"),
  JEV_TIMEOUT_MS: num(2000),
  JEV_DAILY_USD_CAP: num(2),
  JEV_SHADOW_ENABLED: bool(false),
  JEV_SHADOW_DAILY_USD_CAP: num(0.25),
  JEV_USD_PER_MTOK: num(0.042),
  TICK_MS: num(10_000),
  DATA_REFRESH_MS: num(60_000),

  OKX_SITE: z.literal("eea").optional().default("eea"),
  OKX_API_BASE: str("https://eea.okx.com"),
  OKX_CLI_TIMEOUT_MS: num(15_000),

  BEE_START_EQUITY_USD: num(333),
  MAX_LEVERAGE: num(2),
  MARGIN_MODE: z.literal("isolated").optional().default("isolated"),
  MAX_NOTIONAL_USD_PER_BEE: num(700),
  DAILY_LOSS_STOP_PCT: num(8),
  BEE_RETIRE_AT_PCT: num(40),
  MAX_FLAT_MINUTES: num(30),
  LIVE_SIZE_MULTIPLIER: num(0.25),
  LIVE_RAMP_HOURS: num(2),
  MIN_24H_VOL_USD: num(1_000_000),
  // Master switch for the macro squad (stocks, commodities): off = macro bunnies watch and learn but never open.
  ALLOW_NON_CRYPTO: bool(false),
  // Macro squad gates: stocks and gold trade far less than crypto on OKX, so they get their own volume and spread gates.
  MACRO_MIN_24H_VOL_USD: num(200_000),
  // No new position this close (minutes) to a session's end; the calendar is learned from the market (sessions.ts).
  SESSION_NO_OPEN_MIN: num(30),
  // Flatten a macro position before its session ends: "all" closes, "weekend" (closures of a day or more), or "off".
  SESSION_FLATTEN: oneOf(["all", "weekend", "off"] as const, "all"),
  // How many minutes before the close the flatten fires.
  SESSION_FLATTEN_MIN: num(10),
  // Macro bunnies' leverage cap (x equity), below MAX_LEVERAGE: gold and stocks gap.
  MACRO_MAX_LEVERAGE: num(1),
  // Size factor for a macro open late in a session (under 2 h to the close): less to lose to a gap.
  MACRO_LATE_SESSION_SIZE: num(0.5),
  TAKER_FEE_RATE: num(0.0005),

  BREEZY_MIN_OPEN_PROB: num(0.7),
  BREEZY_MIN_SIZE_USD: num(10),
  BIZZY_SIZE_FRACTION: num(0.4),
  BIZZY_UNIVERSE_SIZE: num(8),
  BIZZY_TIME_STOP_MINUTES: num(240),
  BOOZY_CANDIDATES: num(5),
  // Defaults = the "wider swings" rules in strategies/*.md (what the original bunnies ran from 2026-09-24).
  ...perStyle("BREEZY", { trades: 3, fee: 1.0, spread: 5, cooldown: 240, stopAtr: 2, maxFlat: 0 }),
  ...perStyle("BIZZY", { trades: 1, fee: 1.0, spread: 5, cooldown: 5, stopAtr: 1.5, maxFlat: 20 }),
  ...perStyle("BOOZY", { trades: 3, fee: 3.0, spread: 15, cooldown: 2, stopAtr: 2, maxFlat: 0 }),
  // The macro squad's style (bees/macro.ts): few trades, wider stops, a spread gate that suits stocks and gold.
  ...perStyle("MACRO", { trades: 4, fee: 2.0, spread: 15, cooldown: 30, stopAtr: 2.5, maxFlat: 0 }),
  ...perSlot("BEE1"),
  ...perSlot("BEE2"),
  ...perSlot("BEE3"),
  // Real money needs DRY_RUN=false, MODE=live AND this set to LIVE_ACK_PHRASE. Paper trading needs none of it.
  LIVE_ACK: opt,

  ENGINE_PORT: num(8080),
  ENGINE_BIND: str("127.0.0.1"),
  // "{mode}" is replaced with dry/demo/live, so each mode keeps its own books.
  DB_PATH: str("./data/bees-{mode}.sqlite"),
  // Written by the Setup page. Anything set in the environment wins over it.
  SETTINGS_PATH: str("./data/settings.json"),
  OPENAI_API_KEY: opt,
  OPENAI_TEXT_MODEL: str("gpt-5.4-nano"),
  OPENAI_IMAGE_MODEL: str("gpt-image-2"),
  // Optional links shown on the dashboard (the "Hosted on Hostinger" chip and the "Get the code" link).
  HOST_LINK: str("https://mrc.fm/beebots"),
  REPO_LINK: str("https://github.com/imikerussell/beebots"),
  // The Warren: the public leaderboard that installs can join (paper only). Reports go to <HIVE_URL>/hive/report.
  HIVE_URL: str("https://beebots.tech"),
  // "Update available" on the dashboard: checks this repo's latest GitHub Release against APP_VERSION (set by the build).
  UPDATE_CHECK: bool(true),
  UPDATE_REPO: str("imikerussell/beebots"),
  APP_VERSION: str("dev"),
  // ---- LLM brains and the strategy lab (brains/*, lab/*, graph/*) ----
  // ChatGPT reuses OPENAI_API_KEY. Claude: ANTHROPIC_API_KEY. Kimi (Moonshot AI): KIMI_API_KEY (or MOONSHOT_API_KEY).
  OPENAI_BRAIN_MODEL: str("gpt-5.4"),
  ANTHROPIC_API_KEY: opt,
  CLAUDE_MODEL: str("claude-opus-5"),
  CLAUDE_EFFORT: oneOf(["low", "medium", "high"] as const, "medium"),
  KIMI_API_KEY: opt,
  // ---- CoinMarketCap (market/cmc.ts): market-wide context, optional ----
  COINMARKETCAP_API_KEY: opt,
  CMC_API_KEY: opt,
  // Minutes between refreshes (3 calls each), coins fetched, and a hard daily call cap (Basic plan: 10,000 a month).
  CMC_REFRESH_MIN: num(15),
  CMC_TOP: num(200),
  CMC_MAX_CALLS_DAY: num(330),
  // Minutes between fetches of the slow context (altcoin season, the mood's week, sectors): 3 calls each time.
  CMC_SLOW_MIN: num(120),
  // Show Jev the market line (Fear & Greed, BTC dominance, total market cap 24h move) in every decision.
  CMC_IN_JEV: bool(true),
  MOONSHOT_API_KEY: opt,
  KIMI_MODEL: str("kimi-k2.5"),
  KIMI_BASE_URL: str("https://api.moonshot.ai/v1"),
  // Z.ai (GLM models): ZAI_API_KEY. International https://api.z.ai/api/paas/v4, China https://open.bigmodel.cn/api/paas/v4.
  // Alpaca (alpaca.markets) market data for the lab: stocks, ETFs, crypto history. Data only; paper keys are enough.
  ALPACA_API_KEY_ID: opt,
  ALPACA_API_SECRET_KEY: opt,
  ALPACA_FEED: oneOf(["iex", "sip"] as const, "iex"),
  ALPACA_DATA_URL: str("https://data.alpaca.markets"),
  ZAI_API_KEY: opt,
  ZAI_MODEL: str(ZAI_DEFAULT_MODEL),
  ZAI_BASE_URL: str(ZAI_BASE_URL),
  BEE1_BRAIN: brainId(DEFAULT_BRAINS.bee1),
  BEE2_BRAIN: brainId(DEFAULT_BRAINS.bee2),
  BEE3_BRAIN: brainId(DEFAULT_BRAINS.bee3),
  LAB_DIR: str("./data/lab"),
  GRAPH_PATH: str("./data/lab/hive-mind.sqlite"),
  // Extra folders of importable JSON skills (comma separated), on top of ./skills.
  SKILLS_DIRS: str("./skills"),
  // Show Jev each bunny's lab vote (its playbook skills on 1h bars). Off by default: it changes what Jev sees.
  LAB_SIGNALS: bool(false),
  // Let the brains choose each bunny's coins (a watchlist in the playbook). The owner's coins and the style still limit it.
  BRAIN_WATCHLIST: bool(true),
  // Let the brains choose each bunny's specialisation: any style or any backtested lab skill (bees/skill.ts). The bunny
  // switches method only when flat, and not more often than SPECIALIZE_MIN_HOURS. Risk rules never change.
  SPECIALIZATION: bool(true),
  SPECIALIZE_MIN_HOURS: num(6),
  // ---- Dynamic profit-locking ratchet (bees/ratchet.ts) ----
  // Hard profit floor ("gain%:keep" rungs) and runner hug ("gain%:ATR multiple" rungs) on top of each style's stops,
  // for the styles listed in RATCHET_STYLES. Stops only ever tighten.
  RATCHET: bool(true),
  RATCHET_LOCK: str("2.5:0.5,5:0.65"),
  RATCHET_HUG: str("2.5:1.2,5:0.8,8:0.6"),
  RATCHET_STYLES: str("bizzy,boozy,macro,skill"),
  // ---- The scalper (bees/scalp.ts; phases 2 and 3) ----
  // Off by default. Even on, a bunny only scalps when its brains chose the "scalp" method AND the strategy lab's latest
  // report on real 1-minute data (pnpm lab scalp) found an edge after costs (SCALP_REQUIRE_LAB). Entries are maker limits.
  SCALP: bool(false),
  SCALP_REQUIRE_LAB: bool(true),
  SCALP_LAB_MAX_AGE_DAYS: num(14),
  SCALP_COINS: str("BTC,ETH"),
  SCALP_MAKER_FEE: num(0.0002),
  // Fast loop for scalping bunnies (code only, no Jev call), and how long a maker order may wait for its fill.
  SCALP_TICK_MS: num(2000),
  SCALP_MAKER_WAIT_S: num(8),
  SCALP_EXIT_WAIT_S: num(3),
  // Jev sets a mandate (a coin, a bias, a trade budget, a lifetime) at most every SCALP_MANDATE_MIN minutes.
  SCALP_MANDATE_MIN: num(10),
  SCALP_MANDATE_MINUTES: num(30),
  SCALP_MANDATE_TRADES: num(20),
  SCALP_MAX_TRADES_PER_DAY: num(60),
  SCALP_FEE_BUDGET_USD_DAY: num(3),
  SCALP_SPREAD_GATE_BPS: num(1.5),
  SCALP_SIZE_FRAC: num(0.5),
  // Circuit breaker: this many losses in a row pause the bunny for SCALP_PAUSE_MIN minutes.
  SCALP_MAX_LOSS_STREAK: num(4),
  SCALP_PAUSE_MIN: num(30),
  // Minutes between coach reviews (0 = off), and a hard cap on coach LLM calls per UTC day.
  COACH_INTERVAL_MIN: num(0),
  COACH_MAX_CALLS_DAY: num(12),
  // ---- Survival and rewards (evolution.ts) ----
  // A bunny in danger trades smaller and is told how close it is to death (BEE_RETIRE_AT_PCT); its brains meet to save it.
  SURVIVAL_MODE: bool(true),
  SURVIVAL_DANGER_PCT: num(80),
  SURVIVAL_CRITICAL_PCT: num(60),
  SURVIVAL_MAX_CALLS_DAY: num(12),
  // Profitable bunnies earn points and levels; levels unlock more skills, skill writing, extra brains and bigger limits.
  REWARDS: bool(true),
  REWARD_MAX_LIMIT_BOOST: num(0.5),
  // Limit boosts with real money too (off: in live mode rewards unlock skills and brains, never bigger limits).
  REWARDS_IN_LIVE: bool(false),
  // Multi-orders: 3 positions at level zero, +3 per level, on different coins inside one shared leverage cap.
  // This is a hard ceiling; the default covers levels 0..5 (3..18).
  MAX_POSITIONS_PER_BEE: num(18),
  // Autonomous research: agents propose, walk-forward test and remember new skills on a separate bounded schedule.
  SELF_RESEARCH_INTERVAL_MIN: num(360),
  SELF_RESEARCH_MAX_CALLS_DAY: num(12),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  ALERT_WEBHOOK_URL: opt,
});

/** Raw parsed settings (numbers, booleans, enums) for an environment; `{}` gives every default. */
export function parseEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const r = EnvSchema.safeParse(env);
  if (!r.success) throw new ConfigError(`Invalid settings:\n  ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
  return r.data as Record<string, unknown>;
}

/**
 * Admin-panel overrides under the environment: a variable set (non-blank) in the environment always wins, as for
 * the Setup file; an override fills it in otherwise. Compose passes "" for unset variables, so blank means unset.
 */
export function withOverrides(env: NodeJS.ProcessEnv, overrides: Record<string, string> | null | undefined): NodeJS.ProcessEnv {
  if (!overrides) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(overrides)) if (!(env[k] ?? "").trim()) out[k] = v;
  return out;
}

export interface BeeKnobs {
  maxTradesPerDay: number;
  feeBudgetUsdDay: number;
  spreadGateBps: number;
  cooldownMinutes: number;
  stopAtrMult: number;
  /** Effective max flat minutes: min(per-bee, global MAX_FLAT_MINUTES). 0 means "never flat past one tick". */
  maxFlatMinutes: number;
}

export interface OkxCreds {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** A bunny as the dashboard shows it. No secrets. */
export interface SlotProfile {
  style: StyleId;
  name: string;
  tagline: string;
  /** A portrait generated on Setup lives in the data volume. */
  customImage: boolean;
  /** The owner's rules (fed to Jev) and coin restriction, from Setup. Empty for the original three. */
  rules: string;
  coins: string[];
  /** Made on the Setup page (never shown with the original bunnies' art). */
  fromSetup: boolean;
  /** What it trades, and the squad it races in (crypto, or macro: stocks and commodities). */
  market: MarketId;
  squad: "crypto" | "macro";
  /** The money this bunny starts with (and is revived with): its own wallet, else BEE_START_EQUITY_USD. */
  startEquityUsd: number;
}

export interface Config {
  mode: Mode;
  /** Every bunny the engine runs: bee1..bee3, then any extra bunnies from the admin panel (with exchange keys, outside paper). */
  beeIds: BeeId[];
  /** Extra bunnies left out because their exchange keys are missing in demo/live mode (named in the log). */
  skippedBees: BeeId[];
  slots: Record<BeeId, SlotProfile>;
  openai: { apiKey?: string; textModel: string; imageModel: string };
  /** CoinMarketCap context (market/cmc.ts); apiKey absent = off. */
  cmc: { apiKey?: string; refreshMin: number; slowMin: number; top: number; maxCallsDay: number; inJev: boolean };
  links: { sponsor: string; code: string };
  hive: { url: string };
  update: { enabled: boolean; repo: string; version: string };
  settingsPath: string;
  jev: { apiKey: string; model: string; timeoutMs: number; dailyUsdCap: number; shadowEnabled: boolean; shadowDailyUsdCap: number; usdPerMTok: number };
  tickMs: number;
  dataRefreshMs: number;
  okx: { site: "eea"; apiBase: string; cliTimeoutMs: number };
  risk: {
    startEquityUsd: number;
    maxLeverage: number;
    maxNotionalUsdPerBee: number;
    dailyLossStopPct: number;
    retireAtPct: number;
    maxFlatMinutes: number;
    liveSizeMultiplier: number;
    liveRampHours: number;
    takerFeeRate: number;
  };
  universe: { min24hVolUsd: number; allowNonCrypto: boolean };
  /** Dynamic profit-locking ratchet: rungs, and the brain ids (styles, "skill") it applies to. */
  ratchet: { enabled: boolean; lock: LockRung[]; hug: HugRung[]; styles: string[] };
  /** The scalper (bees/scalp.ts). `enabled` is only the master switch: the lab gate and the brains' choice come on top. */
  scalp: {
    enabled: boolean;
    requireLab: boolean;
    labMaxAgeDays: number;
    coins: string[];
    makerFee: number;
    tickMs: number;
    makerWaitMs: number;
    exitWaitMs: number;
    mandateMin: number;
    mandateMinutes: number;
    mandateTrades: number;
    sizeFrac: number;
    maxLossStreak: number;
    pauseMin: number;
    knobs: BeeKnobs;
  };
  /** The macro squad: gates, the session rule and where the learned calendar lives. */
  macro: {
    min24hVolUsd: number;
    spreadGateBps: number;
    noOpenMin: number;
    sessionsPath: string;
    /** The macro style's knobs (MACRO_*), used by every macro bunny instead of its crypto style's. */
    knobs: BeeKnobs;
    maxLeverage: number;
    flatten: "all" | "weekend" | "off";
    flattenMin: number;
    lateSessionSize: number;
  };
  /** Knobs per trading style. */
  bees: Record<StyleId, BeeKnobs>;
  breezy: { minOpenProb: number; minSizeUsd: number };
  bizzy: { sizeFraction: number; universeSize: number; timeStopMinutes: number };
  boozy: { candidates: number };
  /** Per-bee OKX credentials for the current mode. Never logged, never sent to the dashboard. */
  creds: Partial<Record<BeeId, OkxCreds>>;
  server: { port: number; bind: string };
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertWebhookUrl?: string;
  /** LLM brains: keys (never logged, never sent to the dashboard) and which brain each bunny thinks with. */
  brains: { creds: BrainCreds; slots: Record<BeeId, BrainId> };
  lab: { dir: string; graphPath: string; playbookPath: string; skillsDirs: string[]; signals: boolean; watchlist: boolean; specialization: boolean; specializeMinHours: number; coachIntervalMin: number; coachMaxCallsDay: number; selfResearchIntervalMin: number; selfResearchMaxCallsDay: number };
  evolution: {
    survival: boolean;
    dangerPct: number;
    criticalPct: number;
    survivalMaxCallsDay: number;
    rewards: boolean;
    maxLimitBoost: number;
    /** Whether reward limit boosts apply in this mode. */
    boostLimits: boolean;
    /** Most positions a bunny may hold at once (multi-orders perk). */
    maxPositions: number;
  };
}

export class ConfigError extends Error {}

/** The money a bunny starts with: its own wallet (extra bunnies created with one), else BEE_START_EQUITY_USD. */
export const startEquityOf = (cfg: Pick<Config, "slots" | "risk">, id: BeeId): number => cfg.slots[id]?.startEquityUsd ?? cfg.risk.startEquityUsd;

/** Parse and validate the environment (plus the Setup file, if any). Throws ConfigError listing NAMES only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: Settings | null = null): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid settings:\n  ${names.join("\n  ")}`);
  }
  const e = parsed.data as Record<string, unknown> & z.infer<typeof EnvSchema>;
  const mode: Mode = e.DRY_RUN ? "dry" : e.MODE;

  const jevKey = e.TYPESAFE_API_KEY ?? settings?.jevKey;
  const missing: string[] = [];
  if (!jevKey) missing.push("TYPESAFE_API_KEY");
  if (mode === "live" && e.LIVE_ACK !== LIVE_ACK_PHRASE) {
    throw new ConfigError(`MODE=live moves real money. Set LIVE_ACK=${LIVE_ACK_PHRASE} to confirm you accept the risk, or go back to DRY_RUN=true.`);
  }

  const knownBrains = new Set<string>([...BRAINS, ...(settings?.customBrains ?? []).map((b) => b.id)]);
  for (const k of ["BEE1_BRAIN", "BEE2_BRAIN", "BEE3_BRAIN"] as const) {
    if (!knownBrains.has(e[k])) throw new ConfigError(`${k}: not a known brain (${[...knownBrains].join(", ")}). Add a custom brain in the admin panel first.`);
  }
  if (e.MAX_LEVERAGE > 2 || e.MAX_LEVERAGE <= 0) throw new ConfigError("MAX_LEVERAGE must be in (0, 2]. Hard rule 3.");
  if (e.MAX_FLAT_MINUTES < 0) throw new ConfigError("MAX_FLAT_MINUTES must be >= 0");
  // Survival lines must sit above the death line, in order. An install with a high BEE_RETIRE_AT_PCT keeps running:
  // the lines move up just above it rather than refusing to start.
  const criticalPct = Math.max(e.SURVIVAL_CRITICAL_PCT, e.BEE_RETIRE_AT_PCT + 1);
  const dangerPct = Math.max(e.SURVIVAL_DANGER_PCT, criticalPct + 1);
  if (e.REWARD_MAX_LIMIT_BOOST < 0 || e.REWARD_MAX_LIMIT_BOOST > 1) throw new ConfigError("REWARD_MAX_LIMIT_BOOST must be between 0 and 1.");

  const slots = {} as Record<BeeId, SlotProfile>;
  const allIds: BeeId[] = Array.from({ length: Math.max(BEES.length, Math.min(MAX_BEES, settings?.bees.length ?? 0)) }, (_, i) => slotId(i));
  allIds.forEach((id, i) => {
    const b = settings?.bees[i];
    const style = b?.style ?? DEFAULT_SLOTS[id as (typeof BEES)[number]] ?? "boozy";
    // The main three are always crypto (Setup, the Warren and the live columns are about crypto).
    const market: MarketId = i < BEES.length ? "crypto" : (b?.market ?? "crypto");
    // Extra bunnies have their own wallet; the main three share BEE_START_EQUITY_USD (the Warren compares them).
    const startEquityUsd = i >= BEES.length && b?.walletUsd ? b.walletUsd : e.BEE_START_EQUITY_USD;
    slots[id] = b
      ? { style, name: b.name, tagline: b.tagline, customImage: b.image, rules: b.rules, coins: b.coins, fromSetup: true, market, squad: squadOf(market), startEquityUsd }
      : { style, name: STYLE_INFO[style].name, tagline: STYLE_INFO[style].tagline, customImage: false, rules: "", coins: [], fromSetup: false, market, squad: squadOf(market), startEquityUsd };
  });

  const creds: Partial<Record<BeeId, OkxCreds>> = {};
  if (mode !== "dry") {
    const infix = mode === "demo" ? "OKX_DEMO_API" : "OKX_API";
    allIds.forEach((bee, i) => {
      const p = bee.toUpperCase();
      const extra = !(BEES as readonly string[]).includes(bee);
      // Keys set when the bunny was created (admin panel, checked for balance then), unless the environment has its own.
      const saved = settings?.bees[i]?.okx?.[mode === "demo" ? "demo" : "live"];
      // Extra bunnies read their keys straight from the environment (BEE4_OKX_DEMO_API_KEY, ...); without them they sit
      // out demo/live rather than blocking the whole engine.
      const raw = (k: string) => (extra ? (env[k] ?? "").trim() || undefined : (e[k] as string | undefined));
      const envK = raw(`${p}_${infix}_KEY`);
      const envS = raw(`${p}_${infix}_SECRET`);
      const envP = raw(`${p}_${infix}_PASSPHRASE`);
      const fromEnv = !!(envK || envS || envP);
      const k = fromEnv ? envK : saved?.apiKey;
      const s = fromEnv ? envS : saved?.secretKey;
      const ph = fromEnv ? envP : saved?.passphrase;
      if (extra) {
        if (k && s && ph) creds[bee] = { apiKey: k, secretKey: s, passphrase: ph };
        return;
      }
      if (!k) missing.push(`${p}_${infix}_KEY`);
      if (!s) missing.push(`${p}_${infix}_SECRET`);
      if (!ph) missing.push(`${p}_${infix}_PASSPHRASE`);
      if (k && s && ph) creds[bee] = { apiKey: k, secretKey: s, passphrase: ph };
    });
  }
  const skippedBees = mode === "dry" ? [] : allIds.filter((id) => !creds[id]);
  const beeIds = allIds.filter((id) => !skippedBees.includes(id));
  if (missing.length) {
    throw new ConfigError(`MODE=${mode} needs these settings, which are blank or missing:\n  ${missing.join("\n  ")}`);
  }

  const knobs = (style: StyleId | "macro"): BeeKnobs => {
    const p = style.toUpperCase();
    const n = (k: string) => e[`${p}_${k}`] as number;
    return {
      maxTradesPerDay: n("MAX_TRADES_PER_DAY"),
      feeBudgetUsdDay: n("FEE_BUDGET_USD_DAY"),
      spreadGateBps: n("SPREAD_GATE_BPS"),
      cooldownMinutes: n("COOLDOWN_MINUTES"),
      stopAtrMult: n("STOP_ATR_MULT"),
      maxFlatMinutes: Math.min(n("MAX_FLAT_MINUTES"), e.MAX_FLAT_MINUTES),
    };
  };

  return {
    mode,
    beeIds,
    skippedBees,
    slots,
    openai: { apiKey: e.OPENAI_API_KEY ?? settings?.openaiKey, textModel: e.OPENAI_TEXT_MODEL, imageModel: e.OPENAI_IMAGE_MODEL },
    cmc: {
      apiKey: e.COINMARKETCAP_API_KEY ?? e.CMC_API_KEY ?? settings?.cmcKey,
      refreshMin: Math.max(5, e.CMC_REFRESH_MIN),
      slowMin: Math.max(15, e.CMC_SLOW_MIN),
      top: Math.min(5000, Math.max(10, Math.round(e.CMC_TOP))),
      maxCallsDay: Math.max(0, Math.round(e.CMC_MAX_CALLS_DAY)),
      inJev: e.CMC_IN_JEV,
    },
    links: { sponsor: e.HOST_LINK, code: e.REPO_LINK },
    hive: { url: e.HIVE_URL.replace(/\/+$/, "") },
    update: { enabled: e.UPDATE_CHECK, repo: e.UPDATE_REPO, version: e.APP_VERSION },
    settingsPath: e.SETTINGS_PATH,
    jev: {
      apiKey: jevKey!,
      model: e.JEV_MODEL,
      timeoutMs: e.JEV_TIMEOUT_MS,
      dailyUsdCap: e.JEV_DAILY_USD_CAP,
      shadowEnabled: e.JEV_SHADOW_ENABLED,
      shadowDailyUsdCap: Math.max(0, e.JEV_SHADOW_DAILY_USD_CAP),
      usdPerMTok: e.JEV_USD_PER_MTOK,
    },
    tickMs: Math.max(1000, e.TICK_MS),
    dataRefreshMs: Math.max(15_000, e.DATA_REFRESH_MS),
    okx: { site: e.OKX_SITE, apiBase: e.OKX_API_BASE.replace(/\/+$/, ""), cliTimeoutMs: e.OKX_CLI_TIMEOUT_MS },
    risk: {
      startEquityUsd: e.BEE_START_EQUITY_USD,
      maxLeverage: e.MAX_LEVERAGE,
      maxNotionalUsdPerBee: e.MAX_NOTIONAL_USD_PER_BEE,
      dailyLossStopPct: e.DAILY_LOSS_STOP_PCT,
      retireAtPct: e.BEE_RETIRE_AT_PCT,
      maxFlatMinutes: e.MAX_FLAT_MINUTES,
      liveSizeMultiplier: e.LIVE_SIZE_MULTIPLIER,
      liveRampHours: e.LIVE_RAMP_HOURS,
      takerFeeRate: e.TAKER_FEE_RATE,
    },
    universe: { min24hVolUsd: e.MIN_24H_VOL_USD, allowNonCrypto: e.ALLOW_NON_CRYPTO },
    ratchet: {
      enabled: e.RATCHET,
      lock: parseLock(e.RATCHET_LOCK),
      hug: parseHug(e.RATCHET_HUG),
      styles: e.RATCHET_STYLES.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
    },
    scalp: {
      enabled: e.SCALP,
      // With real money the lab gate cannot be switched off.
      requireLab: e.SCALP_REQUIRE_LAB || mode === "live",
      labMaxAgeDays: Math.max(1, e.SCALP_LAB_MAX_AGE_DAYS),
      coins: e.SCALP_COINS.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
      makerFee: Math.max(0, e.SCALP_MAKER_FEE),
      tickMs: Math.max(500, e.SCALP_TICK_MS),
      makerWaitMs: Math.max(1000, e.SCALP_MAKER_WAIT_S * 1000),
      exitWaitMs: Math.max(1000, e.SCALP_EXIT_WAIT_S * 1000),
      mandateMin: Math.max(1, e.SCALP_MANDATE_MIN),
      mandateMinutes: Math.max(1, e.SCALP_MANDATE_MINUTES),
      mandateTrades: Math.max(1, Math.round(e.SCALP_MANDATE_TRADES)),
      sizeFrac: Math.max(0.05, Math.min(1, e.SCALP_SIZE_FRAC)),
      maxLossStreak: Math.max(1, Math.round(e.SCALP_MAX_LOSS_STREAK)),
      pauseMin: Math.max(1, e.SCALP_PAUSE_MIN),
      knobs: { maxTradesPerDay: Math.max(1, Math.round(e.SCALP_MAX_TRADES_PER_DAY)), feeBudgetUsdDay: Math.max(0, e.SCALP_FEE_BUDGET_USD_DAY), spreadGateBps: Math.max(0, e.SCALP_SPREAD_GATE_BPS), cooldownMinutes: 0, stopAtrMult: 1.5, maxFlatMinutes: 1440 },
    },
    macro: {
      min24hVolUsd: Math.max(0, e.MACRO_MIN_24H_VOL_USD),
      spreadGateBps: Math.max(0, e.MACRO_SPREAD_GATE_BPS as number),
      noOpenMin: Math.max(0, e.SESSION_NO_OPEN_MIN),
      sessionsPath: `${e.LAB_DIR.replace(/\/+$/, "")}/sessions.json`,
      knobs: knobs("macro"),
      maxLeverage: Math.max(0, Math.min(e.MACRO_MAX_LEVERAGE, e.MAX_LEVERAGE)),
      flatten: e.SESSION_FLATTEN,
      flattenMin: Math.max(0, e.SESSION_FLATTEN_MIN),
      lateSessionSize: Math.max(0, Math.min(1, e.MACRO_LATE_SESSION_SIZE)),
    },
    bees: { bizzy: knobs("bizzy"), breezy: knobs("breezy"), boozy: knobs("boozy") },
    breezy: { minOpenProb: e.BREEZY_MIN_OPEN_PROB, minSizeUsd: e.BREEZY_MIN_SIZE_USD },
    bizzy: { sizeFraction: e.BIZZY_SIZE_FRACTION, universeSize: e.BIZZY_UNIVERSE_SIZE, timeStopMinutes: e.BIZZY_TIME_STOP_MINUTES },
    boozy: { candidates: e.BOOZY_CANDIDATES },
    creds,
    server: { port: e.ENGINE_PORT, bind: e.ENGINE_BIND },
    dbPath: e.DB_PATH.replaceAll("{mode}", mode),
    logLevel: e.LOG_LEVEL,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
    brains: {
      creds: brainCreds(e, settings),
      slots: brainSlots(allIds, { bee1: e.BEE1_BRAIN, bee2: e.BEE2_BRAIN, bee3: e.BEE3_BRAIN }, settings),
    },
    lab: {
      dir: e.LAB_DIR,
      graphPath: e.GRAPH_PATH,
      playbookPath: `${e.LAB_DIR.replace(/\/+$/, "")}/playbook.json`,
      // Skills the bunnies wrote and passed their backtest (brains/survival.ts) live in <LAB_DIR>/learned.
      skillsDirs: [...e.SKILLS_DIRS.split(",").map((d) => d.trim()).filter(Boolean), `${e.LAB_DIR.replace(/\/+$/, "")}/learned`],
      signals: e.LAB_SIGNALS,
      watchlist: e.BRAIN_WATCHLIST,
      specialization: e.SPECIALIZATION,
      specializeMinHours: Math.max(0, e.SPECIALIZE_MIN_HOURS),
      coachIntervalMin: Math.max(0, e.COACH_INTERVAL_MIN),
      coachMaxCallsDay: Math.max(0, e.COACH_MAX_CALLS_DAY),
      selfResearchIntervalMin: Math.max(0, e.SELF_RESEARCH_INTERVAL_MIN),
      selfResearchMaxCallsDay: Math.max(0, e.SELF_RESEARCH_MAX_CALLS_DAY),
    },
    evolution: {
      survival: e.SURVIVAL_MODE,
      dangerPct,
      criticalPct,
      survivalMaxCallsDay: Math.max(0, e.SURVIVAL_MAX_CALLS_DAY),
      rewards: e.REWARDS,
      maxLimitBoost: e.REWARD_MAX_LIMIT_BOOST,
      boostLimits: mode !== "live" || e.REWARDS_IN_LIVE,
      maxPositions: Math.max(1, Math.min(18, Math.floor(e.MAX_POSITIONS_PER_BEE))),
    },
  };
}

/** Main bunnies: BEE1_BRAIN..BEE3_BRAIN. Extra bunnies: the brain picked when they were added, else they take turns. */
function brainSlots(ids: BeeId[], main: Record<(typeof BEES)[number], BrainId>, settings: Settings | null): Record<BeeId, BrainId> {
  const out = {} as Record<BeeId, BrainId>;
  ids.forEach((id, i) => {
    out[id] = (main as Record<string, BrainId>)[id] ?? settings?.bees[i]?.brain ?? ROTATION[i % ROTATION.length]!;
  });
  return out;
}

/** Brain keys from the environment first, then the Setup file. A brain without a key is left out. */
export function brainCreds(
  e: { OPENAI_API_KEY?: string; OPENAI_BRAIN_MODEL: string; ANTHROPIC_API_KEY?: string; CLAUDE_MODEL: string; CLAUDE_EFFORT: "low" | "medium" | "high"; KIMI_API_KEY?: string; MOONSHOT_API_KEY?: string; KIMI_MODEL: string; KIMI_BASE_URL: string; ZAI_API_KEY?: string; ZAI_MODEL?: string; ZAI_BASE_URL?: string },
  settings: Settings | null,
): BrainCreds {
  const openai = e.OPENAI_API_KEY ?? settings?.openaiKey;
  const claudeKey = e.ANTHROPIC_API_KEY ?? settings?.anthropicKey;
  // No key: an Anthropic Console sign-in (`ant --profile beebots auth login`) works too.
  const claude = claudeKey ? { apiKey: claudeKey } : hasAnthropicLogin() ? { profile: ANTHROPIC_PROFILE } : null;
  const kimi = e.KIMI_API_KEY ?? e.MOONSHOT_API_KEY ?? settings?.kimiKey;
  const zai = e.ZAI_API_KEY ?? settings?.zaiKey;
  return {
    ...(openai ? { openai: { apiKey: openai, model: e.OPENAI_BRAIN_MODEL } } : {}),
    ...(claude ? { claude: { ...claude, model: e.CLAUDE_MODEL, effort: e.CLAUDE_EFFORT } } : {}),
    ...(kimi ? { kimi: { apiKey: kimi, model: e.KIMI_MODEL, baseUrl: e.KIMI_BASE_URL.replace(/\/+$/, "") } } : {}),
    ...(zai ? { zai: { apiKey: zai, model: e.ZAI_MODEL ?? ZAI_DEFAULT_MODEL, baseUrl: (e.ZAI_BASE_URL ?? ZAI_BASE_URL).replace(/\/+$/, "") } } : {}),
    ...(settings?.customBrains?.length ? { custom: settings.customBrains } : {}),
  };
}

/** Alpaca data keys from the environment first, then the Setup file; null without both halves of the pair. */
export function alpacaCreds(e: { ALPACA_API_KEY_ID?: string; ALPACA_API_SECRET_KEY?: string; ALPACA_FEED?: "iex" | "sip"; ALPACA_DATA_URL?: string }, settings: Settings | null): { keyId: string; secret: string; feed: "iex" | "sip"; baseUrl: string } | null {
  const keyId = e.ALPACA_API_KEY_ID ?? settings?.alpacaKeyId;
  const secret = e.ALPACA_API_SECRET_KEY ?? settings?.alpacaSecret;
  return keyId && secret ? { keyId, secret, feed: e.ALPACA_FEED ?? "iex", baseUrl: (e.ALPACA_DATA_URL ?? "https://data.alpaca.markets").replace(/\/+$/, "") } : null;
}

/** The same env parsing as loadConfig, for tools that need only the brain and lab settings (no Jev key required). */
export function labEnv(env: NodeJS.ProcessEnv = process.env, settings: Settings | null = null) {
  const e = EnvSchema.parse(env) as z.infer<typeof EnvSchema>;
  return {
    creds: brainCreds(e, settings),
    alpaca: alpacaCreds(e, settings),
    slots: { bee1: e.BEE1_BRAIN, bee2: e.BEE2_BRAIN, bee3: e.BEE3_BRAIN } as Record<BeeId, BrainId>,
    dir: e.LAB_DIR,
    graphPath: e.GRAPH_PATH,
    playbookPath: `${e.LAB_DIR.replace(/\/+$/, "")}/playbook.json`,
    skillsDirs: [...e.SKILLS_DIRS.split(",").map((d) => d.trim()).filter(Boolean), `${e.LAB_DIR.replace(/\/+$/, "")}/learned`],
    watchlist: e.BRAIN_WATCHLIST,
    specialization: e.SPECIALIZATION,
    scalp: e.SCALP,
    takerFeeRate: e.TAKER_FEE_RATE,
    maxLeverage: e.MAX_LEVERAGE,
  };
}
