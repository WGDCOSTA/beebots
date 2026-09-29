// What the first-run Setup page saves: the Jev key, an optional OpenAI key, the risk acknowledgement, the three
// bunnies (name, trading style, tagline, optional generated portrait), and whether to join the Warren. Stored as one JSON file in the data volume,
// readable by the engine's user only. Secrets in here are never sent to the dashboard or written to a log.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { BRAIN_ID_RE, checkBaseUrl, RESERVED_BRAIN_IDS } from "./brains/llm.js";

export const STYLES = ["bizzy", "breezy", "boozy"] as const;
/** A trading style is one of the three built-in strategies, named after the bunny that first traded it. */
export type StyleId = (typeof STYLES)[number];

/**
 * What a bunny trades. The main three and every bunny by default: crypto. Extra bunnies may join the macro squad instead:
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
/** The squad a bunny races in: crypto, or the macro squad. */
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

/** The original three are the official bunnies: owners' bunnies may not use their names ("Bizzy", "bizzy-bee", "Bizzie Bunny"). */
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/(bee|bunny|bunnie)$/, "")
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
  /** The built-in brain this bunny runs on (Setup derives it from the bunny's coins; see bees/custom.ts). */
  style: z.enum(STYLES),
  tagline: z.string().trim().max(40).default(""),
  /** The owner's rules for this bunny in plain English, fed to Jev with every decision. */
  rules: z.string().trim().max(500).default(""),
  /** Coin tickers this bunny is restricted to ([] = any). */
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
  /** What the bunny looks like (used for its portrait). */
  look: z.string().trim().max(400).optional(),
  /** What it trades (extra bunnies only; absent = crypto, and the main three are always crypto). */
  market: z.enum(MARKETS).optional(),
  /** Extra bunnies: the LLM brain chosen when the bunny was added (main bunnies use BEE1_BRAIN..BEE3_BRAIN). */
  brain: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,29}$/).optional(),
  /** true once a portrait has been generated for this bunny (served from the data volume). */
  image: z.boolean().default(false),
  /**
   * The bunny's own wallet: the money it starts with (and is revived with), in USD. Absent = BEE_START_EQUITY_USD.
   * Set when the bunny is created from the admin panel; the main three share BEE_START_EQUITY_USD (the Warren compares them).
   */
  walletUsd: z.number().min(10).max(1_000_000).optional(),
  /**
   * The bunny's OKX sub-account keys, set (and checked for balance) when it is created. The environment's
   * BUNNY<n>_OKX_*_API_* still wins. Never sent to the dashboard or written to a log.
   */
  okx: z
    .object({
      demo: OkxKeys.optional(),
      live: OkxKeys.optional(),
    })
    .optional(),
});

export const CustomBrainSchema = z.object({
  id: z
    .string()
    .regex(BRAIN_ID_RE, "id: lowercase letters, digits, - and _ (2 to 30)")
    .refine((v) => !RESERVED_BRAIN_IDS.includes(v), "that id is taken by a built-in brain"),
  label: z.string().trim().min(1).max(30),
  vendor: z.string().trim().max(30).default("Custom"),
  baseUrl: z.string().trim().max(200).refine((v) => checkBaseUrl(v) === null, "use https://… (http only for localhost)"),
  model: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._:/@-]+$/, "model: letters, digits and . _ : / @ -"),
  apiKey: z.string().trim().min(4).max(400).optional(),
  jsonMode: z.enum(["schema", "object", "prompt"]).default("object"),
});

/** A tool an outside MCP server offers, as last discovered. `readOnly` is the server's own claim (annotations.readOnlyHint), which is never trusted on its own. */
export const McpToolSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(600).default(""),
  readOnly: z.boolean().nullable().default(null),
  inputSchema: z.record(z.unknown()).default({}),
});

/** Which bunnies may call which tool of a server. A tool that is not proven read-only needs the owner's explicit confirmation. */
export const McpGrantSchema = z.object({
  tool: z.string().min(1).max(80),
  /** Bunny slots ("bee1"..), or "all". */
  bees: z.array(z.string().regex(/^(bee[1-9]|all)$/)).min(1).max(10),
  confirmed: z.boolean().optional(),
});

export const McpServerSchema = z.object({
  id: z.string().regex(BRAIN_ID_RE, "id: lowercase letters, digits, - and _ (2 to 30)"),
  label: z.string().trim().min(1).max(30),
  url: z.string().trim().max(300).refine((v) => checkBaseUrl(v) === null, "use https://… (http only for localhost)"),
  /** "http" = MCP streamable HTTP (current), "sse" = the older server-sent-events transport. */
  transport: z.enum(["http", "sse"]).default("http"),
  authHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/, "a header name like Authorization or X-API-Key").default("Authorization"),
  token: z.string().trim().min(1).max(600).optional(),
  maxCallsDay: z.number().int().min(1).max(500).default(50),
  tools: z.array(McpToolSchema).max(100).default([]),
  grants: z.array(McpGrantSchema).max(100).default([]),
});

export const SettingsSchema = z.object({
  version: z.literal(1),
  jevKey: z.string().trim().min(8),
  openaiKey: z.string().trim().min(8).optional(),
  /** Claude's brain (Anthropic API key). Optional: without it bee2 falls back to rules in the lab council. */
  anthropicKey: z.string().trim().min(8).optional(),
  /** Kimi's brain (Moonshot AI API key). Optional, as above for bee3. */
  kimiKey: z.string().trim().min(8).optional(),
  /** Alpaca market-data keys for the lab (a key ID and its secret; paper keys are enough). Optional. */
  alpacaKeyId: z.string().trim().min(8).max(100).optional(),
  alpacaSecret: z.string().trim().min(8).max(200).optional(),
  /** Z.ai's GLM brain (API key). Optional. */
  zaiKey: z.string().trim().min(8).optional(),
  /** Brains the owner added from the admin panel: any OpenAI-compatible chat API. Keys are stored here, like the others. */
  customBrains: z.array(CustomBrainSchema).max(50).optional(),
  /** Outside MCP servers the owner connected for research (mcp/gateway.ts). Tokens are stored here like the other keys. */
  mcpServers: z.array(McpServerSchema).max(20).optional(),
  /** CoinMarketCap Pro API key: market-wide context (market/cmc.ts). Optional. */
  cmcKey: z.string().trim().min(8).optional(),
  /** The owner password, as a salted scrypt hash (gate.ts). Absent in files saved before it existed. */
  ownerPasswordHash: z.string().startsWith("scrypt$").optional(),
  /** When the operator ticked the risk statements on the Setup page. */
  acceptedRiskAt: z.number(),
  /** The three main bunnies, then up to six extra bunnies added from the admin panel. */
  bees: z.array(BeeSchema).min(3).max(9),
  /** The "Join the Warren?" answer on the Setup page (absent in files saved before the Warren existed). */
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

/** Atomic JSON write, readable by the engine's user only (Setup file, Warren file). */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
