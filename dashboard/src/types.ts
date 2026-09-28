// Mirrors the engine's read-only /snapshot and SSE payloads. No account data exists in these shapes.
import { BEE_MARK_URL } from "./BeeMark";

/**
 * Bee slots: the three main bees (the live columns), then any extra bees added from the admin panel (bee4..bee9).
 * Names, taglines and portraits come from the engine's /profile.
 */
export type BeeName = string;
export const BEE_NAMES: BeeName[] = ["bee1", "bee2", "bee3"];
/** Every bee the engine runs, main three first. Filled in from /profile. */
export const ALL_BEES: BeeName[] = [...BEE_NAMES];

export type Cap = "trade_cap" | "fee_budget" | "loss_stop" | "retired" | null;

export interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
}

export interface PublicBee {
  bee: BeeName;
  equityUsd: number;
  /** What this bee started with (its own wallet, or the shared start equity). */
  startEquityUsd?: number;
  pnlUsd: number;
  pnlPct: number;
  position: {
    coin: string;
    side: "long" | "short";
    sizeUsd: number | null;
    entryPx: number;
    markPx: number | null;
    stopPx: number | null;
    uplUsd: number;
    minutesHeld: number;
  } | null;
  flatMinutes: number | null;
  tradesToday: number;
  maxTradesPerDay: number;
  feesTodayUsd: number;
  feeBudgetUsd: number;
  cap: Cap;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  maxNotionalUsd: number;
  last: LastDecision | null;
  /** Survival and rewards (engine evolution.ts); null when off. */
  evo?: { tier: Tier; health: number; points: number; level: number; deaths: number } | null;
  /** The coins its AI brains chose that the engine applies right now (null = the style's normal choice). */
  watchlist?: { coins: string[]; probation: string[] } | null;
  /** The LLM brain that plans for it, and whether that brain has a key or sign-in. */
  brain?: { id: string; model: string | null; online: boolean };
  market?: string;
  squad?: "crypto" | "macro";
  /** The method it trades: the specialisation its brains chose, or its own style ("own"). */
  method?: { kind: "own" | "style" | "skill"; id: string; name: string | null; since: number | null };
  /** Notional of every position it holds (main + legs) vs its cap. */
  exposureUsd?: number;
  /** Main position's unrealised P&L in R (risk at entry). */
  uplR?: number | null;
  /** Multi-orders: extra positions, and how many positions its performance allows. */
  legs?: Array<{ coin: string; side: "long" | "short"; sizeUsd: number | null; entryPx: number; markPx: number | null; stopPx: number | null; uplUsd: number | null; minutesHeld: number }>;
  slots?: number;
}

/** Engine telemetry for the system bar. */
export interface SystemInfo {
  jevModel: string;
  brains: Array<{ id: string; model: string | null; online: boolean }>;
  labSignals: boolean;
  watchlist: boolean;
  survival: boolean;
  rewards: boolean;
  maxPositions: number;
  macroTrading: boolean;
  macroBees: number;
  maxLeverage: number;
  /** CoinMarketCap's market mood (null when no key or stale). */
  cmc?: {
    fearGreed: { value: number; label: string } | null;
    btcDominancePct: number | null;
    mcapChange24hPct: number | null;
    totalMcapUsd: number | null;
    coins: number;
    updatedAt: number;
  } | null;
}

export type Tier = "thriving" | "healthy" | "danger" | "critical" | "dead";

export interface EvolutionRow {
  bee: BeeName;
  name: string;
  points: number;
  level: number;
  nextLevelAt: number | null;
  tier: Tier;
  health: number;
  deaths: number;
  skillsAuthored: number;
  perks: { skillSlots: number; canAuthorSkills: boolean; extraBrains: number; limitBoost: number; extraTrades: number };
  history: Array<{ day: string; pnlPct: number; points: number; bonus: string | null }>;
}

/** Tier glyph + words: never colour alone. */
export const TIER_INFO: Record<Tier, { icon: string; label: string; tone: "good" | "bad" | "warn" | "" }> = {
  thriving: { icon: "★", label: "thriving", tone: "good" },
  healthy: { icon: "●", label: "healthy", tone: "" },
  danger: { icon: "⚠", label: "in danger", tone: "warn" },
  critical: { icon: "✚", label: "critical", tone: "bad" },
  dead: { icon: "✖", label: "dead", tone: "bad" },
};

export interface Snapshot {
  ts: number;
  mode: "dry" | "demo" | "live";
  closed?: { at: number; flat: boolean } | null;
  startedAt: number;
  startEquityUsd: number;
  tickMs: number;
  system?: SystemInfo;
  bees: PublicBee[];
  leaderboard: Array<{ bee: BeeName; equityUsd: number }>;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; pnlUsd: number };
  jev: { spentTodayUsd: number; dailyCapUsd: number; capTripped: boolean; down: boolean };
  recon: { ok: boolean | null; detail: string; ts: number };
  market: { refreshedAt: number; universe: string[]; spreadBlocked: Array<{ coin: string; spreadBp: number }>; attention: "news" | "volume" };
  visitors?: { total: number; watching: number };
  evolution?: { survival: boolean; rewards: boolean; board: EvolutionRow[] } | null;
  /** Set when a newer GitHub Release exists than the version this install runs. */
  update?: { current: string; latest: string } | null;
}

export interface DecisionEvent {
  type: "decision";
  ts: number;
  bee: BeeName;
  choice: string | null;
  probabilities: Array<{ label: string; p: number }>;
  confidence: number | null;
  conviction: string | null;
  latencyMs: number | null;
  tokens: number | null;
  jevUsd: number;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  jev: string;
  /** A benched bee's live row: no Jev call, just its position P&L moving. */
  pulse?: boolean;
  /** Flat bee with nothing to ask Jev: what it is watching for (e.g. "SOL is 0.80% from breakout"). */
  watch?: string;
  /** One legal move (a hold, e.g. boozy's 24h lock): the rules decided and Jev was not asked. */
  required?: boolean;
  /** The bee's money at this moment: open P&L while positioned, total P&L when flat, and the move since its last row. */
  live?: { coin: string | null; side: "long" | "short" | null; valueUsd: number; kind: "open" | "total"; deltaUsd: number };
}

export interface FillEvent {
  type: "fill";
  ts: number;
  bee: BeeName;
  coin: string;
  side: "buy" | "sell";
  purpose: string;
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  label: string;
}

export interface CapEvent {
  type: "cap";
  ts: number;
  bee: BeeName;
  cap: Cap;
  detail: string;
}

export interface FundingEvent {
  type: "funding";
  ts: number;
  bee: BeeName;
  coin: string | null;
  amountUsd: number;
}

export type AnyEvent =
  | DecisionEvent
  | FillEvent
  | CapEvent
  | FundingEvent
  | { type: "equity"; ts: number; bees: PublicBee[] }
  | { type: "recon"; ts: number; ok: boolean; detail: string }
  | { type: "order" | "heartbeat" | "status" | "evolution"; ts: number; [k: string]: unknown };

export interface BeeMeta {
  /** Card title: "Boozy Bee" for the official three, the owner's own name for a Setup-made bee. */
  title: string;
  short: string;
  tagline: string;
  styleLabel: string;
  /** The owner's rules for this bee (Setup), "" for the original three. */
  rules: string;
  coins: string[];
  img: string;
  color: string;
  glow: string;
  /** What it trades and the squad it races in (crypto, or macro: stocks and commodities). */
  market?: string;
  squad?: "crypto" | "macro";
}

/** Colours belong to the slot, so two bees on the same style still look different. Filled in from /profile at load. */
export const BEE_META: Record<string, BeeMeta> = {
  bee1: { title: "Bizzy Bee", short: "Bizzy", tagline: "the grinder", styleLabel: "Breakout", rules: "", coins: [], img: "/bees/bizzy.jpg", color: "var(--bizzy)", glow: "var(--bizzy-glow)" },
  bee2: { title: "Breezy Bee", short: "Breezy", tagline: "the calculated one", styleLabel: "Trend", rules: "", coins: [], img: "/bees/breezy.jpg", color: "var(--breezy)", glow: "var(--breezy-glow)" },
  bee3: { title: "Boozy Bee", short: "Boozy", tagline: "the degen", styleLabel: "Momentum", rules: "", coins: [], img: "/bees/boozy.jpg", color: "var(--boozy)", glow: "var(--boozy-glow)" },
};

export interface Profile {
  setup: boolean;
  mode: "dry" | "demo" | "live";
  links: { sponsor: string; code: string } | null;
  /** img null: a Setup-made bee without its portrait (the dashboard shows the placeholder mark). */
  bees: Array<{ id: BeeName; name: string; tagline: string; style: string; styleLabel: string; rules?: string; coins?: string[]; img: string | null; market?: string; squad?: "crypto" | "macro" }>;
}

export const PROFILE: { links: Profile["links"] } = { links: null };

const OFFICIAL_NAMES = ["Bizzy", "Breezy", "Boozy"];

/**
 * Extra bees take the remaining categorical slots of the validated dark palette in fixed order (the main three hold
 * yellow, violet and magenta): blue, orange, aqua, green, red, then again with a lighter glow.
 */
const EXTRA_COLORS = ["#3987e5", "#d95926", "#199e70", "#008300", "#e66767", "#6da7ec"];

/** Meta for any slot; unknown slots get a neutral placeholder rather than crashing a card. */
export function beeMeta(id: BeeName): BeeMeta {
  return BEE_META[id] ?? { title: id, short: id, tagline: "", styleLabel: "", rules: "", coins: [], img: BEE_MARK_URL, color: "var(--muted)", glow: "transparent" };
}

export function applyProfile(p: Profile): void {
  PROFILE.links = p.links;
  ALL_BEES.length = 0;
  for (const b of p.bees) {
    ALL_BEES.push(b.id);
    if (!BEE_META[b.id]) {
      const c = EXTRA_COLORS[(ALL_BEES.length - 4 + EXTRA_COLORS.length) % EXTRA_COLORS.length]!;
      BEE_META[b.id] = { title: b.name, short: b.name, tagline: "", styleLabel: "", rules: "", coins: [], img: BEE_MARK_URL, color: c, glow: `${c}73` };
    }
    const m = BEE_META[b.id]!;
    m.short = b.name;
    m.title = OFFICIAL_NAMES.includes(b.name) ? `${b.name} Bee` : b.name;
    m.tagline = b.tagline;
    m.styleLabel = b.styleLabel;
    m.rules = b.rules ?? "";
    m.coins = b.coins ?? [];
    m.img = b.img ?? BEE_MARK_URL;
    m.market = b.market ?? "crypto";
    m.squad = b.squad ?? "crypto";
  }
}

/** Shown on Setup and in the dashboard's Hive dialog. */
export const HIVE_DISCLAIMER =
  "You're about to share your bees' names, styles and paper-trading results on the public leaderboard at beebots.tech. The board shows % gain/loss only. No keys, no exchange account details, no IP address. Paper trading only. Not financial advice. You can leave any time.";

/** The engine's GET /hive/status. No hive id, no key. */
export interface HiveStatus {
  joined: boolean;
  /** false in MODE=live: the Hive is paper only. */
  paper: boolean;
  /** The leaderboard's base URL (HIVE_URL). */
  board: string;
  lastReportAt: number | null;
  verified: Record<string, boolean> | null;
  problem: string | null;
  locked: boolean;
  /** false: no owner password on this server (join/leave impossible until one is set). */
  passwordSet: boolean;
}
