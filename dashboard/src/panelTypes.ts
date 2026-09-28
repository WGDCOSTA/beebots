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

export const BRAIN_LABEL: Record<string, string> = { openai: "ChatGPT", claude: "Claude", kimi: "Kimi", rules: "Rules" };

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

export interface JobStatus {
  id: number;
  command: string;
  args: string[];
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  log: string[];
}

export type KeyName = "jev" | "openai" | "anthropic" | "kimi";

export interface AdminState {
  mode: "dry" | "demo" | "live";
  version: string;
  hasSettingsFile: boolean;
  pendingRestart: boolean;
  keys: Record<KeyName, { set: boolean; source: "env" | "settings" | null }>;
  bees: Array<{ slot: string; name: string; tagline: string; rules: string; coins: string[]; style: string; image: boolean; brain: string | null; extra: boolean; running: boolean; flat: boolean }> | null;
  maxBees: number;
  /** Coins with a live X-Perp right now ([] before the market loads: free text then). */
  coins: string[];
  evolution: { survival: boolean; rewards: boolean; board: import("./types").EvolutionRow[] } | null;
  styles: Array<{ id: string; label: string; blurb: string }>;
  groups: Array<{ id: string; title: string; help: string }>;
  fields: AdminField[];
  lab: { job: JobStatus | null; graph: Record<string, number>; playbook: Playbook | null };
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
