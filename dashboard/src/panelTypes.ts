// Shapes of the strategy-lab and admin endpoints (engine: /lab/*, /hive-mind, POST /admin/*). Display only.

export interface RankedSkill {
  rank: number;
  skillId: string;
  name: string;
  family: string;
  source: string;
  description: string;
  params: Record<string, number>;
  score: number;
  oos: { scoreMean: number; returnPct: number; benchmarkPct: number; sharpe: number; sqn?: number; maxDrawdownPct: number; trades: number; winRatePct: number; profitFactor: number };
  isScoreMean: number;
  stabilityPct: number;
  overfitGap: number;
  folds: Array<{ dataset: string; fold: number; params: Record<string, number>; score: number; returnPct: number; benchmarkPct: number; sharpe: number; trades: number; maxDrawdownPct: number }>;
}

export interface Ranking {
  createdAt: number;
  datasets: Array<{ id: string; bars: number; from: number; to: number; source: string }>;
  opts: { folds: number; testFrac: number; sim: { feeRate: number; slippageBps: number; leverage: number; fundingPer8hPct: number } };
  results: RankedSkill[];
  errors: string[];
}

export interface PlaybookSkill {
  id: string;
  params: Record<string, number>;
  weight: number;
  reason: string;
  score: number;
}

export interface WatchItem {
  coin: string;
  reason: string;
  /** Added by the coach, not yet kept: half size. */
  probation: boolean;
  addedAt?: number;
}

export interface Playbook {
  updatedAt: number;
  rankingAt: number;
  bees: Record<string, { brain: string; model: string; skills: PlaybookSkill[]; lessons: string[]; message: string; decidedAt: number; watchlist?: WatchItem[] }>;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  text?: string;
  from?: string;
  to?: string;
  updated_at: number;
  [k: string]: unknown;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
  weight: number;
  [k: string]: unknown;
}

export interface GraphJson {
  nodes: GraphNode[];
  links: GraphLink[];
}

/** Labels for every brain id; custom brains are added when the admin state loads (see AdminPage). */
export const BRAIN_LABEL: Record<string, string> = { openai: "ChatGPT", claude: "Claude", kimi: "Kimi", zai: "GLM", rules: "Rules" };

export const FAMILY_LABEL: Record<string, string> = {
  trend: "Trend",
  breakout: "Breakout",
  momentum: "Momentum",
  mean_reversion: "Mean reversion",
  hybrid: "Hybrid",
  benchmark: "Benchmark",
};

// ---------- admin ----------

export interface AdminField {
  key: string;
  group: string;
  label: string;
  help: string;
  type: "number" | "bool" | "enum" | "text";
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  secret: boolean;
  lockedByEnv: boolean;
  overridden: boolean;
  value?: number | boolean | string | null;
  default?: number | boolean | string | null;
  set?: boolean;
}

export interface StepStatus {
  id: string;
  stage: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  note: string;
  startedAt: number | null;
  endedAt: number | null;
}
export interface PreflightItem {
  id: string;
  label: string;
  ok: boolean;
  required: boolean;
  note: string;
}
export interface StageVerdict {
  stage: "skills" | "scalper" | "gold" | "hive";
  title: string;
  status: "pass" | "fail" | "none" | "stale" | "incomplete";
  headline: string;
  details: string[];
  at: number | null;
}
export interface CheckState {
  stages: string[];
  preflight: PreflightItem[];
  verdicts: StageVerdict[];
  goldDir: string;
  goldFiles: string[];
}

export interface BacktestSummary {
  at: number;
  data: "real" | "synthetic";
  datasets: string[];
  score: number;
  returnPct: number;
  benchmarkPct: number;
  sharpe: number;
  stabilityPct: number;
  trades: number;
  maxDrawdownPct: number;
  overfitGap: number;
  pass: boolean;
  why: string;
}
export interface DraftVersion {
  n: number;
  at: number;
  author: string;
  note: string;
  json: string;
  valid: boolean;
  errors: string[];
  backtest: BacktestSummary | null;
}
export interface DraftFull {
  key: string;
  author: string;
  status: "draft" | "proposed" | "published" | "discarded";
  createdAt: number;
  updatedAt: number;
  publishedVersion: number | null;
  versions: DraftVersion[];
}
export interface DraftSummary {
  key: string;
  name: string;
  family: string;
  author: string;
  status: DraftFull["status"];
  updatedAt: number;
  versions: number;
  publishedVersion: number | null;
  valid: boolean;
  errors: string[];
  backtest: BacktestSummary | null;
}
export interface WorkshopState {
  /** Brains that can draft a skill from a description. */
  agent: Array<{ id: string; label: string }>;
  drafts: DraftSummary[];
  templates: Array<{ id: string; label: string; json: string }>;
}

export interface ResearchNote {
  id: string;
  bee: string;
  kind: "background" | "research";
  author: string;
  brain: string | null;
  title: string;
  text: string;
  evidence: string[];
  coins: string[];
  confidence: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected";
  createdAt: number;
  decidedAt: number | null;
}
export interface McpTool {
  name: string;
  description: string;
  readOnly: boolean | null;
  needsConfirm: boolean;
  looksLikeAction: boolean;
}
export interface McpGrant {
  tool: string;
  bees: string[];
  confirmed?: boolean;
}
export interface McpServerView {
  id: string;
  label: string;
  url: string;
  transport: "http" | "sse";
  authHeader: string;
  tokenSet: boolean;
  maxCallsDay: number;
  usedToday: number;
  tools: McpTool[];
  grants: McpGrant[];
}
export interface McpCallLog {
  at: number;
  bee: string;
  server: string;
  tool: string;
  args: string;
  ok: boolean;
  bytes: number;
  ms: number;
  note: string;
}
export interface McpView {
  available: boolean;
  canEdit: boolean;
  servers: McpServerView[];
  log: McpCallLog[];
}

export interface NotesState {
  available: boolean;
  notes: ResearchNote[];
  busy: string[];
  /** Per running bee: why its brain cannot research right now, or null. */
  blocked: Record<string, string | null>;
}

export interface JobStatus {
  id: number;
  command: string;
  steps?: StepStatus[];
  args: string[];
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  log: string[];
}

export type KeyName = "jev" | "openai" | "anthropic" | "kimi" | "zai" | "coinmarketcap";

export type ExchangeKind = "demo" | "live";
/** A bee's OKX keys as the panel may see them: never the keys, only where they come from and the last check. */
export interface ExchangeStatus {
  set: boolean;
  source: "env" | "settings" | null;
  checkedAt: number | null;
  balanceUsd: number | null;
}
/** What POST /admin/exchange/check found (read-only, nothing saved). */
export interface ExchangeCheck {
  ok: boolean;
  ready: boolean;
  kind: ExchangeKind;
  perms: string[];
  canTrade: boolean;
  canWithdraw: boolean;
  subAccount: boolean;
  ipBound: boolean;
  usdcUsd: number | null;
  problems: string[];
  warnings: string[];
}

export interface BrainsView {
  builtin: Array<{ id: string; label: string; vendor: string; ready: boolean }>;
  custom: Array<{ id: string; label: string; vendor: string; baseUrl: string; model: string; jsonMode: "schema" | "object" | "prompt"; keySet: boolean; usedBy: string[] }>;
  zaiDefaults: { model: string; baseUrl: string };
  canEdit: boolean;
}

export interface AdminState {
  brains: BrainsView;
  /** Alpaca market-data keys for the lab: set?, from where, the feed. Never a key. */
  alpaca: { set: boolean; source: "env" | "settings" | null; feed: "iex" | "sip"; canEdit: boolean };
  mode: "dry" | "demo" | "live";
  version: string;
  hasSettingsFile: boolean;
  pendingRestart: boolean;
  keys: Record<KeyName, { set: boolean; source: "env" | "settings" | "login" | null }>;
  /** Claude through an Anthropic Console sign-in instead of a key (`ant auth login` in the engine container). */
  anthropicLogin: { profile: string; active: boolean; command: string } | null;
  bees: Array<{
    slot: string;
    name: string;
    tagline: string;
    rules: string;
    coins: string[];
    style: string;
    image: boolean;
    brain: string | null;
    market?: string;
    extra: boolean;
    running: boolean;
    flat: boolean;
    /** The money it starts with (extra bees: set at creation; main three: the shared start equity). */
    walletUsd: number;
    exchange: Record<ExchangeKind, ExchangeStatus>;
  }> | null;
  maxBees: number;
  defaultWalletUsd: number;
  /** Outside paper trading: the OKX environment a new bee must be connected to before it is created. */
  exchangeRequired: ExchangeKind | null;
  /** The server can check OKX keys. */
  exchangeCheck: boolean;
  /** Coins with a live X-Perp right now ([] before the market loads: free text then). */
  coins: string[];
  /** Stocks and commodities with a live X-Perp (the macro squad's picker). */
  macroCoins: { commodities: string[]; stocks: string[] };
  markets: Array<{ id: string; label: string; blurb: string }>;
  /** The trading hours the engine is learning (market/sessions.ts). */
  sessions: {
    watchedHours: number;
    allowNonCrypto: boolean;
    noOpenMin: number;
    coins: Array<{
      coin: string;
      kind: string;
      verifiedPct: number;
      openHoursPerWeek: number;
      meanSpreadBp: number | null;
      grid: string[];
      now: { status: "open" | "closed" | "unverified"; closesInMin: number | null; opensInMin: number | null };
    }>;
  } | null;
  evolution: { survival: boolean; rewards: boolean; board: import("./types").EvolutionRow[] } | null;
  styles: Array<{ id: string; label: string; blurb: string }>;
  groups: Array<{ id: string; title: string; help: string }>;
  fields: AdminField[];
  lab: { job: JobStatus | null; graph: Record<string, number>; playbook: Playbook | null; check: CheckState; workshop: WorkshopState; notes: NotesState; mcp: McpView };
  coachAvailable: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** POST to the admin API with the owner password. */
export async function adminCall<T = AdminState>(path: string, password: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`/admin/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-owner-password": encodeURIComponent(password) },
    body: JSON.stringify(body),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`);
  return j;
}

export async function getJson<T>(path: string): Promise<T | null> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) return null;
  return (await r.json()) as T;
}

export const when = (ts: number | null | undefined) => (ts ? new Date(ts).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "–");
