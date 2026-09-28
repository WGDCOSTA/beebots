// What the first-run Setup page saves: the Jev key, an optional OpenAI key, the risk acknowledgement, the three
// bees (name, trading style, tagline, optional generated portrait), and whether to join the Hive. Stored as one JSON file in the data volume,
// readable by the engine's user only. Secrets in here are never sent to the dashboard or written to a log.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const STYLES = ["bizzy", "breezy", "boozy"] as const;
/** A trading style is one of the three built-in strategies, named after the bee that first traded it. */
export type StyleId = (typeof STYLES)[number];

/**
 * What a bee trades. The main three and every bee by default: crypto. Extra bees may join the macro squad instead:
 * commodities (gold, silver, oil), stocks (stocks and ETFs) or macro (both). Non-crypto trading also needs
 * ALLOW_NON_CRYPTO=true and a verified open session (market/sessions.ts).
 */
export const MARKETS = ["crypto", "commodities", "stocks", "macro"] as const;
export type MarketId = (typeof MARKETS)[number];
export const MARKET_INFO: Record<MarketId, { label: string; blurb: string }> = {
  crypto: { label: "Crypto", blurb: "Crypto X-Perps, 24/7." },
  commodities: { label: "Commodities", blurb: "Gold (XAU), silver (XAG), WTI and Brent oil (CL, BZ). Session hours apply." },
  stocks: { label: "Stocks & ETFs", blurb: "NVDA, TSLA, MSTR, SPY, QQQ, SOXL and more. Session hours and gaps apply." },
  macro: { label: "Macro (both)", blurb: "Commodities and stocks together." },
};
/** The squad a bee races in: crypto, or the macro squad. */
export const squadOf = (m: MarketId): "crypto" | "macro" => (m === "crypto" ? "crypto" : "macro");

export const STYLE_INFO: Record<StyleId, { label: string; blurb: string; name: string; tagline: string }> = {
  bizzy: {
    label: "Breakout",
    blurb: "One volatility breakout a day on BTC, ETH, SOL or HYPE, ridden to the daily close. Patient, then all in.",
    name: "Bizzy",
    tagline: "the grinder",
  },
  breezy: {
    label: "Trend",
    blurb: "Trend following on BTC and ETH only. Few trades, rides winners, sized by volatility. The calm one.",
    name: "Breezy",
    tagline: "the calculated one",
  },
  boozy: {
    label: "Momentum",
    blurb: "Chases the strongest 7-day mover across every liquid coin, and adds to winners. Big swings, strange coins.",
    name: "Boozy",
    tagline: "the degen",
  },
};

/** The original three are the official bees: owners' bees may not use their names ("Bizzy", "bizzy-bee", "Bizzie Bee"). */
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/bee$/, "")
    .replace(/(.)\1+/g, "$1")
    .replace(/(ie|ey|i)$/, "y");
const RESERVED = new Set(STYLES.map((s) => squash(STYLE_INFO[s].name)));

export function isReservedName(name: string): boolean {
  return RESERVED.has(squash(name));
}

/** One OKX API key set, and what the last check found (sanitised). */
const OkxKeys = z.object({
  apiKey: z.string().trim().min(8).max(200),
  secretKey: z.string().trim().min(8).max(200),
  passphrase: z.string().min(1).max(200),
  checkedAt: z.number(),
  /** USDC on the account at the last check. */
  balanceUsd: z.number().nullable(),
  uidHash: z.string().max(64).nullable(),
});
export type OkxKeySet = z.infer<typeof OkxKeys>;

const BeeSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .regex(/^[\p{L}\p{N} .'_-]+$/u, "letters, numbers, spaces and . ' _ - only"),
  /** The built-in brain this bee runs on (Setup derives it from the bee's coins; see bees/custom.ts). */
  style: z.enum(STYLES),
  tagline: z.string().trim().max(40).default(""),
  /** The owner's rules for this bee in plain English, fed to Jev with every decision. */
  rules: z.string().trim().max(500).default(""),
  /** Coin tickers this bee is restricted to ([] = any). */
  coins: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z0-9]{1,15}$/),
    )
    .max(20)
    .default([]),
  /** What the bee looks like (used for its portrait). */
  look: z.string().trim().max(400).optional(),
  /** What it trades (extra bees only; absent = crypto, and the main three are always crypto). */
  market: z.enum(MARKETS).optional(),
  /** Extra bees: the LLM brain chosen when the bee was added (main bees use BEE1_BRAIN..BEE3_BRAIN). */
  brain: z.enum(["openai", "claude", "kimi"]).optional(),
  /** true once a portrait has been generated for this bee (served from the data volume). */
  image: z.boolean().default(false),
  /**
   * The bee's own wallet: the money it starts with (and is revived with), in USD. Absent = BEE_START_EQUITY_USD.
   * Set when the bee is created from the admin panel; the main three share BEE_START_EQUITY_USD (the Hive compares them).
   */
  walletUsd: z.number().min(10).max(1_000_000).optional(),
  /**
   * The bee's OKX sub-account keys, set (and checked for balance) when it is created. The environment's
   * BEE<n>_OKX_*_API_* still wins. Never sent to the dashboard or written to a log.
   */
  okx: z
    .object({
      demo: OkxKeys.optional(),
      live: OkxKeys.optional(),
    })
    .optional(),
});

export const SettingsSchema = z.object({
  version: z.literal(1),
  jevKey: z.string().trim().min(8),
  openaiKey: z.string().trim().min(8).optional(),
  /** Claude's brain (Anthropic API key). Optional: without it bee2 falls back to rules in the lab council. */
  anthropicKey: z.string().trim().min(8).optional(),
  /** Kimi's brain (Moonshot AI API key). Optional, as above for bee3. */
  kimiKey: z.string().trim().min(8).optional(),
  /** CoinMarketCap Pro API key: market-wide context (market/cmc.ts). Optional. */
  cmcKey: z.string().trim().min(8).optional(),
  /** The owner password, as a salted scrypt hash (gate.ts). Absent in files saved before it existed. */
  ownerPasswordHash: z.string().startsWith("scrypt$").optional(),
  /** When the operator ticked the risk statements on the Setup page. */
  acceptedRiskAt: z.number(),
  /** The three main bees, then up to six extra bees added from the admin panel. */
  bees: z.array(BeeSchema).min(3).max(9),
  /** The "Join the Hive?" answer on the Setup page (absent in files saved before the Hive existed). */
  hive: z.boolean().optional(),
  createdAt: z.number(),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type BeeSettings = z.infer<typeof BeeSchema>;
export { BeeSchema };

export function loadSettings(path: string): Settings | null {
  if (!existsSync(path)) return null;
  const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not valid (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}). Delete it and run Setup again.`);
  return parsed.data;
}

/** Atomic write, owner-only permissions. */
export function saveSettings(path: string, s: Settings): void {
  writePrivateJson(path, s);
}

/** The admin panel's settings overrides (admin.json, next to settings.json): variable name -> value as text. */
export const adminPath = (settingsPath: string) => `${dirname(settingsPath)}/admin.json`;

const AdminFile = z.object({ version: z.literal(1), overrides: z.record(z.string().max(500)), updatedAt: z.number() });

export function loadOverrides(settingsPath: string): Record<string, string> {
  const p = adminPath(settingsPath);
  if (!existsSync(p)) return {};
  const r = AdminFile.safeParse(JSON.parse(readFileSync(p, "utf8")));
  return r.success ? r.data.overrides : {};
}

export function saveOverrides(settingsPath: string, overrides: Record<string, string>): void {
  writePrivateJson(adminPath(settingsPath), { version: 1, overrides, updatedAt: Date.now() });
}

/** Atomic JSON write, readable by the engine's user only (Setup file, Hive file). */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
