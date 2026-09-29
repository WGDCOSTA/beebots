// The admin panel's API. Every call is a POST carrying the owner password (x-owner-password, the same gate and lockout
// as joining the Hive). What it can change:
// - settings on the ADMIN_FIELDS list, stored as overrides in admin.json (the environment still wins, as for Setup);
// - the Jev / OpenAI / Anthropic / Kimi keys, the three bees and the owner password, in the Setup file;
// - lab jobs (fetch, run, council, cycle), a coach review now, and an engine restart to apply saved changes.
// - each bee's wallet (the money it starts with) and its OKX sub-account keys, checked for permissions and balance
//   before the bee is created (a bee is never created on keys that fail, or on an account holding less than its wallet).
// What it cannot: the trading mode and LIVE_ACK stay in the environment, so real money is never one click away, and
// exchange keys set in the environment win over the panel's. Keys are write-only: the page only ever learns whether
// one is set, where from, and what the last check found.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deriveStyle } from "../bees/custom.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtestData } from "../brains/survival.js";
import { BEES, ConfigError, isBeeId, loadConfig, MAX_BEES, parseEnv, slotId, withOverrides, type BeeId, type Mode } from "../config.js";
import { skillFromSpec, type Skill } from "../lab/skills/index.js";
import { NoteError, type NoteBook } from "../brains/notes.js";
import type { Researcher } from "../brains/research.js";
import { AgentError, MAX_PROMPT, type SkillAgent } from "../lab/skillAgent.js";
import { looksLikeAction, needsConfirmation, type McpGateway, type McpServerDef } from "../mcp/gateway.js";
import { KEY_RE, TEMPLATES, validateSkill, Workspace, WorkspaceError } from "../lab/workspace.js";
import { evaluateSkill, DEFAULT_TOURNAMENT } from "../lab/tournament.js";
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD, readJson, send, type PasswordGate } from "../gate.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { anthropicLoginCommand, BRAINS, brainInfo, checkBaseUrl, registerBrain, ZAI_BASE_URL, ZAI_DEFAULT_MODEL } from "../brains/llm.js";
import { BeeSchema, CustomBrainSchema, McpGrantSchema, McpServerSchema, isReservedName, loadOverrides, loadSettings, MARKET_INFO, MARKETS, saveOverrides, saveSettings, STYLE_INFO, STYLES, type MarketId, type Settings } from "../settings.js";
import type { AccountFacts } from "../okx/account.js";
import { ADMIN_FIELDS, checkField, FIELD_BY_KEY, FIELD_GROUPS, GROUP_INFO } from "./fields.js";
import { CHECK_STAGES, goldCsvs, preflight, verdicts } from "./check.js";
import { LAB_COMMANDS, type LabArgs, type LabJobs } from "./jobs.js";

const MAX_BODY = 32 * 1024;
const KEY_NAMES = ["jev", "openai", "anthropic", "kimi", "zai", "coinmarketcap"] as const;
type KeyName = (typeof KEY_NAMES)[number];
const KEY_ENV: Record<KeyName, string[]> = {
  jev: ["TYPESAFE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY"],
  coinmarketcap: ["COINMARKETCAP_API_KEY", "CMC_API_KEY"],
};
const KEY_FIELD: Record<KeyName, "jevKey" | "openaiKey" | "anthropicKey" | "kimiKey" | "zaiKey" | "cmcKey"> = { jev: "jevKey", openai: "openaiKey", anthropic: "anthropicKey", kimi: "kimiKey", zai: "zaiKey", coinmarketcap: "cmcKey" };

export interface KeyChecks {
  jev(key: string): Promise<string | null>;
  openai(key: string): Promise<string | null>;
  anthropic(key: string): Promise<string | null>;
  kimi(key: string): Promise<string | null>;
  zai(key: string): Promise<string | null>;
  /** One read with an Alpaca key pair: are they valid, and does the plan serve the feed? */
  alpaca?(keyId: string, secret: string, feed: "iex" | "sip"): Promise<string | null>;
  /** One tiny chat call to any OpenAI-compatible API: is the address, key and model right? */
  compat?(baseUrl: string, apiKey: string | undefined, model: string, vendor: string): Promise<string | null>;
  coinmarketcap(key: string): Promise<string | null>;
}

export interface AdminOpts {
  settingsPath: string;
  /** The process environment (without overrides). */
  env: NodeJS.ProcessEnv;
  gate: PasswordGate;
  mode: Mode;
  version: string;
  checks: KeyChecks;
  jobs: LabJobs;
  /** Run every bee's coach review now (null when no brain has a key). */
  coachNow: (() => Promise<void>) | null;
  graphStats: () => Record<string, number>;
  playbook: () => unknown;
  /** Called after the owner password changes, with the new hash. */
  onPasswordChanged: (hash: string) => void;
  /** Exit so Docker restarts the engine with the saved changes. */
  restart: () => void;
  /** Coins with a live X-Perp right now (for the asset picker); [] when the market is not loaded yet. */
  coins?: () => string[];
  /** Stocks and commodities with a live X-Perp right now (the macro squad's picker). */
  macroCoins?: () => { commodities: string[]; stocks: string[] };
  /**
   * Claude via an Anthropic Console sign-in instead of a key (`ant --profile beebots auth login`): whether that
   * profile exists, and a free call that proves it works.
   */
  anthropicLogin?: { profile: string; active: () => boolean; check: () => Promise<string | null> };
  /** The trading-hours calendar the engine is learning (market/sessions.ts), summarised. */
  sessions?: () => unknown;
  /** Bees the running engine trades, and whether one is flat (a bee may only be removed flat). */
  runningBees?: () => BeeId[];
  isFlat?: (id: BeeId) => boolean;
  /** Drop the stored books of a slot about to be (re)used by a brand-new bee. */
  forgetBee?: (id: BeeId) => void;
  /** Revive a dead bee (fresh paper money). Throws a readable error when it cannot. */
  revive?: (id: BeeId) => void;
  /** Convene a council for a bee now (all the brains its tier and level allow). */
  council?: (id: BeeId) => Promise<unknown>;
  /** Survival and rewards board (evolution.ts). */
  evolution?: () => unknown;
  /** A skill the owner imported: make it live without a restart. */
  registerSkill?: (skill: Skill) => void;
  /** Research notes and background (brains/notes.ts) and the brains that draft them (brains/research.ts). */
  notes?: NoteBook;
  research?: Researcher;
  /** Drafts skills from a description, with any brain that can answer (lab/skillAgent.ts). */
  skillAgent?: SkillAgent;
  /** The gate to outside MCP servers (mcp/gateway.ts): discovery here, grants enforced when a bee researches. */
  mcp?: McpGateway;
  /** <LAB_DIR>, for imported skills and backtest history. */
  labDir?: string;
  /** Read-only OKX account check (okx/account.ts): keys, permissions, sub-account, USDC vs the wallet. */
  okxCheck?: (creds: { apiKey: string; secretKey: string; passphrase: string }, kind: "demo" | "live", walletUsd: number) => Promise<AccountFacts>;
  now?: () => number;
}

const Str = (max: number) => z.string().trim().max(max);
const KINDS = ["demo", "live"] as const;
type Kind = (typeof KINDS)[number];
const Wallet = z.number().min(10).max(1_000_000);
const Exchange = z.object({
  kind: z.enum(KINDS),
  apiKey: Str(200).min(8),
  secretKey: Str(200).min(8),
  passphrase: z.string().min(1).max(200),
});

const KeysBody = z.object({
  keys: z.record(z.enum(KEY_NAMES), Str(300)).default({}),
  remove: z.array(z.enum(KEY_NAMES)).max(KEY_NAMES.length).default([]),
});
const BeeEdit = z.object({
  name: BeeSchema.shape.name,
  tagline: Str(40).default(""),
  rules: Str(500).default(""),
  coins: BeeSchema.shape.coins,
  style: z.enum(STYLES),
  /** Extra bees only: which LLM brain it thinks with. */
  brain: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,29}$/, "brain: an id like openai, claude, kimi, zai or a custom one").optional(),
  /** Extra bees only: what it trades (the macro squad trades stocks and commodities). */
  market: z.enum(MARKETS).optional(),
  /** Extra bees only: the money it starts with, set when it is created. */
  walletUsd: Wallet.optional(),
  /** OKX sub-account keys to check and save for this bee (new keys, or a replacement while it is flat). */
  exchange: Exchange.optional(),
});
/** bee4 -> 3 */
const ALL_INDEX = (id: BeeId) => Number(id.slice(3)) - 1;
const CheckBody = Exchange.extend({ walletUsd: Wallet, bee: z.string().optional() });
const BeesBody = z.object({ bees: z.array(BeeEdit).min(BEES.length).max(MAX_BEES) });
const SlotBody = z.object({ bee: z.string() });
const ImportBody = z.object({ json: z.string().min(2).max(20_000) });
const PasswordBody = z.object({ next: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD) });
const RealCheckBody = z.object({ stages: z.array(z.enum(CHECK_STAGES)).min(1).max(CHECK_STAGES.length) });
const NoteBee = z.string().regex(/^(bee[1-9]|hive)$/, "bee: bee1..bee9 or hive");
const NoteAdd = z.object({ bee: NoteBee, title: Str(80), text: Str(700), coins: z.array(Str(20)).max(6).default([]) });
const NoteDecide = z.object({ id: z.string().regex(/^[0-9a-f]{10}$/), decision: z.enum(["approve", "reject"]) });
const NoteRef = z.object({ id: z.string().regex(/^[0-9a-f]{10}$/) });
const ResearchBody = z.object({ bee: z.string().regex(/^bee[1-9]$/, "bee: bee1..bee9") });
const CustomBrainBody = z.object({
  id: CustomBrainSchema.shape.id,
  label: CustomBrainSchema.shape.label,
  vendor: CustomBrainSchema.shape.vendor.optional(),
  baseUrl: z.string().trim().max(200),
  model: CustomBrainSchema.shape.model,
  apiKey: z.string().trim().max(400).optional(),
  jsonMode: CustomBrainSchema.shape.jsonMode.optional(),
  /** Save even though the connection test failed (a server that is down right now). */
  force: z.boolean().optional(),
});
const CustomBrainTest = z.object({ id: z.string().optional(), baseUrl: z.string().trim().max(200), model: z.string().trim().min(1).max(80), apiKey: z.string().trim().max(400).optional(), vendor: z.string().trim().max(30).optional() });
const BrainRef = z.object({ id: CustomBrainSchema.shape.id });
const AskAgent = z.object({ prompt: z.string().trim().min(8).max(MAX_PROMPT), brain: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,29}$/).optional(), key: z.string().trim().regex(KEY_RE).optional() });
const McpSave = z.object({
  id: McpServerSchema.shape.id,
  label: McpServerSchema.shape.label,
  url: z.string().trim().max(300),
  transport: McpServerSchema.shape.transport.optional(),
  authHeader: McpServerSchema.shape.authHeader.optional(),
  token: z.string().trim().max(600).optional(),
  maxCallsDay: McpServerSchema.shape.maxCallsDay.optional(),
  /** Save even though discovery failed (a server that is down right now). */
  force: z.boolean().optional(),
});
const McpRef = z.object({ id: McpServerSchema.shape.id });
const McpGrants = z.object({ id: McpServerSchema.shape.id, grants: z.array(McpGrantSchema).max(100) });
const AlpacaBody = z.object({ keyId: z.string().trim().min(8).max(100).optional(), secret: z.string().trim().min(8).max(200).optional(), remove: z.boolean().optional() });
const DraftKey = z.string().trim().regex(KEY_RE, "id: lowercase letters, digits and _ only (2 to 40)");
const DraftSave = z.object({ key: DraftKey.optional(), json: z.string().min(2).max(30_000), note: Str(200).optional() });
const DraftRef = z.object({ key: DraftKey });
const DraftPublish = z.object({ key: DraftKey, force: z.boolean().optional() });
const DraftCheck = z.object({ json: z.string().max(30_000) });
const LabBody = z.object({
  command: z.enum(LAB_COMMANDS),
  args: z
    .object({
      source: z.enum(["okx", "ccxt", "alpaca", "synthetic"]).optional(),
      symbols: Str(900).optional(),
      exchange: Str(30).optional(),
      bar: z.enum(["15m", "1H", "4H", "1D"]).optional(),
      days: z.number().optional(),
      folds: z.number().optional(),
      leverage: z.number().optional(),
      synthetic: z.number().optional(),
      longOnly: z.boolean().optional(),
    })
    .default({}),
});

export class Admin {
  /** Something was saved that only a restart applies. */
  private pending = false;
  private now: () => number;

  constructor(private o: AdminOpts) {
    this.now = o.now ?? Date.now;
  }

  private labDir(): string {
    return this.o.labDir ?? "./data/lab";
  }

  /** Every brain that exists here: the built-ins and the custom ones the owner added. */
  private brainIds(): string[] {
    return [...BRAINS, ...(loadSettings(this.o.settingsPath)?.customBrains ?? []).map((b) => b.id)];
  }

  /** Which bees and settings use each brain, so one that is in use cannot be removed from under them. */
  private brainUsers(id: string): string[] {
    const s = loadSettings(this.o.settingsPath);
    const users: string[] = (s?.bees ?? []).flatMap((b, i) => (b.brain === id ? [slotId(i)] : []));
    const ov = loadOverrides(this.o.settingsPath);
    for (const k of ["BEE1_BRAIN", "BEE2_BRAIN", "BEE3_BRAIN"]) if ((this.o.env[k] ?? ov[k]) === id) users.push(k);
    return users;
  }

  private workspace(): Workspace {
    return new Workspace(this.labDir(), this.now);
  }

  private keySet(k: KeyName): boolean {
    return KEY_ENV[k].some((n) => this.envSet(n)) || !!loadSettings(this.o.settingsPath)?.[KEY_FIELD[k]];
  }

  private envSet(name: string): boolean {
    return !!(this.o.env[name] ?? "").trim();
  }

  /** The environment holds this bee's OKX keys for that kind (they win over the panel's). */
  private envExchange(slot: BeeId, kind: Kind): boolean {
    const infix = kind === "demo" ? "OKX_DEMO_API" : "OKX_API";
    return ["KEY", "SECRET", "PASSPHRASE"].some((x) => this.envSet(`${slot.toUpperCase()}_${infix}_${x}`));
  }

  /** BEE_START_EQUITY_USD as the engine would load it now (environment plus saved overrides). */
  private defaultWallet(): number {
    try {
      return Number(parseEnv(withOverrides(this.o.env, loadOverrides(this.o.settingsPath))).BEE_START_EQUITY_USD);
    } catch {
      return Number(parseEnv(this.o.env).BEE_START_EQUITY_USD);
    }
  }

  /** What the panel may know about a bee's exchange keys: set?, from where, and the last check. Never a key. */
  private exchangeView(slot: BeeId, b: Settings["bees"][number]) {
    return Object.fromEntries(
      KINDS.map((k) => {
        const env = this.envExchange(slot, k);
        const saved = b.okx?.[k];
        return [k, { set: env || !!saved, source: env ? "env" : saved ? "settings" : null, checkedAt: saved?.checkedAt ?? null, balanceUsd: saved?.balanceUsd ?? null }];
      }),
    ) as Record<Kind, { set: boolean; source: "env" | "settings" | null; checkedAt: number | null; balanceUsd: number | null }>;
  }

  /** The brains the panel offers, with whether each can answer right now (a key is set). Never a key. */
  private brainsView(keys: Record<string, { set: boolean }>) {
    const settings = loadSettings(this.o.settingsPath);
    const custom = settings?.customBrains ?? [];
    for (const b of custom) registerBrain(b.id, b);
    const builtinKey: Record<string, string> = { openai: "openai", claude: "anthropic", kimi: "kimi", zai: "zai" };
    return {
      builtin: BRAINS.map((id) => ({ id, label: brainInfo(id).label, vendor: brainInfo(id).vendor, ready: !!keys[builtinKey[id]!]?.set })),
      custom: custom.map((b) => ({ id: b.id, label: b.label, vendor: b.vendor, baseUrl: b.baseUrl, model: b.model, jsonMode: b.jsonMode, keySet: !!b.apiKey, usedBy: this.brainUsers(b.id) })),
      zaiDefaults: { model: ZAI_DEFAULT_MODEL, baseUrl: ZAI_BASE_URL },
      canEdit: !!settings,
    };
  }

  /** Brains that can answer now, by id (built-ins with a key, and every custom brain). */
  private readyBrains(keys: Record<string, { set: boolean }>): string[] {
    const v = this.brainsView(keys);
    return [...v.builtin.filter((b) => b.ready).map((b) => b.id), ...v.custom.map((b) => b.id)];
  }

  /** The connectors as the panel may see them: never a token, the tools the server offers, and who may call which. */
  private mcpView() {
    const settings = loadSettings(this.o.settingsPath);
    const used = this.o.mcp?.usedToday() ?? {};
    return {
      available: !!this.o.mcp,
      canEdit: !!settings,
      servers: (settings?.mcpServers ?? []).map((m) => ({
        id: m.id,
        label: m.label,
        url: m.url,
        transport: m.transport,
        authHeader: m.authHeader,
        tokenSet: !!m.token,
        maxCallsDay: m.maxCallsDay,
        usedToday: used[m.id] ?? 0,
        tools: m.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly, needsConfirm: needsConfirmation(t), looksLikeAction: looksLikeAction(t.name) })),
        grants: m.grants,
      })),
      log: this.o.mcp?.recent(30) ?? [],
    };
  }

  /** Alpaca data keys as the panel may see them: set?, from where, and the feed. Never a key. */
  private alpacaView(feed: unknown) {
    const env = this.envSet("ALPACA_API_KEY_ID") && this.envSet("ALPACA_API_SECRET_KEY");
    const s = loadSettings(this.o.settingsPath);
    const file = !!(s?.alpacaKeyId && s.alpacaSecret);
    return { set: env || file, source: env ? ("env" as const) : file ? ("settings" as const) : null, feed: feed === "sip" ? "sip" : "iex", canEdit: !!s };
  }

  /** Everything the panel shows. No secret ever leaves here. */
  state() {
    const settings = loadSettings(this.o.settingsPath);
    const overrides = loadOverrides(this.o.settingsPath);
    let effective: Record<string, unknown> = {};
    try {
      effective = parseEnv(withOverrides(this.o.env, overrides));
    } catch {
      effective = parseEnv(this.o.env);
    }
    const defaults = parseEnv({});
    const keys = Object.fromEntries(
      KEY_NAMES.map((k) => {
        const env = KEY_ENV[k].some((n) => this.envSet(n));
        const file = !!settings?.[KEY_FIELD[k]];
        // No Anthropic key: an Anthropic Console sign-in counts (the brain uses it; see brains/llm.ts).
        const login = k === "anthropic" && !env && !file && !!this.o.anthropicLogin?.active();
        return [k, { set: env || file || login, source: env ? "env" : file ? "settings" : login ? "login" : null }];
      }),
    );
    return {
      mode: this.o.mode,
      version: this.o.version,
      hasSettingsFile: !!settings,
      pendingRestart: this.pending,
      keys,
      bees: settings
        ? settings.bees.map((b, i) => ({
            slot: slotId(i),
            name: b.name,
            tagline: b.tagline,
            rules: b.rules,
            coins: b.coins,
            style: b.style,
            image: b.image,
            brain: b.brain ?? null,
            market: i >= BEES.length ? (b.market ?? "crypto") : "crypto",
            extra: i >= BEES.length,
            running: this.o.runningBees?.().includes(slotId(i)) ?? true,
            flat: this.o.isFlat?.(slotId(i)) ?? true,
            walletUsd: i >= BEES.length && b.walletUsd ? b.walletUsd : this.defaultWallet(),
            exchange: this.exchangeView(slotId(i), b),
          }))
        : null,
      maxBees: MAX_BEES,
      defaultWalletUsd: this.defaultWallet(),
      /** Outside paper trading a new bee needs checked keys for this kind before it is created. */
      exchangeRequired: this.o.mode === "dry" ? null : this.o.mode,
      exchangeCheck: !!this.o.okxCheck,
      coins: this.o.coins?.() ?? [],
      macroCoins: this.o.macroCoins?.() ?? { commodities: [], stocks: [] },
      markets: MARKETS.map((m) => ({ id: m, ...MARKET_INFO[m] })),
      sessions: this.o.sessions?.() ?? null,
      anthropicLogin: this.o.anthropicLogin
        ? { profile: this.o.anthropicLogin.profile, active: this.o.anthropicLogin.active(), command: anthropicLoginCommand(this.o.anthropicLogin.profile) }
        : null,
      brains: this.brainsView(keys),
      alpaca: this.alpacaView(effective.ALPACA_FEED),
      evolution: this.o.evolution?.() ?? null,
      styles: STYLES.map((s) => ({ id: s, label: STYLE_INFO[s].label, blurb: STYLE_INFO[s].blurb })),
      groups: FIELD_GROUPS.map((g) => ({ id: g, ...GROUP_INFO[g] })),
      fields: ADMIN_FIELDS.map((f) => {
        const lockedByEnv = this.envSet(f.key);
        return {
          key: f.key,
          group: f.group,
          label: f.label,
          help: f.help,
          type: f.type,
          min: f.min,
          max: f.max,
          step: f.step,
          options: /^BEE[123]_BRAIN$/.test(f.key) ? this.brainIds() : f.options,
          secret: !!f.secret,
          lockedByEnv,
          overridden: f.key in overrides,
          ...(f.secret ? { set: lockedByEnv || f.key in overrides } : { value: effective[f.key] ?? null, default: defaults[f.key] ?? null }),
        };
      }),
      lab: {
        job: this.o.jobs.status(),
        graph: this.o.graphStats(),
        playbook: this.o.playbook(),
        check: {
          stages: CHECK_STAGES,
          preflight: preflight({ mode: this.o.mode, keys, hasBees: !!settings, labDir: this.labDir(), hasAlpaca: this.alpacaView(effective.ALPACA_FEED).set, customBrains: (settings?.customBrains ?? []).map((b) => b.label) }),
          verdicts: verdicts(this.labDir(), { now: this.now(), maxAgeDays: Number(effective.SCALP_LAB_MAX_AGE_DAYS ?? 14) || 14, graph: this.o.graphStats() }),
          goldDir: join(this.labDir(), "gold", "data"),
          goldFiles: goldCsvs(this.labDir()).map((f) => f.split("/").pop()),
        },
        workshop: { drafts: this.workspace().list(), templates: TEMPLATES, agent: this.o.skillAgent?.available() ?? [] },
        mcp: this.mcpView(),
        notes: {
          available: !!this.o.notes,
          notes: this.o.notes?.all().filter((n) => n.status !== "rejected").slice(0, 200) ?? [],
          busy: this.o.research?.busy() ?? [],
          blocked: Object.fromEntries((this.o.runningBees?.() ?? []).map((id) => [id, this.o.research ? this.o.research.blocked(id) : "research is not available here"])),
        },
      },
      coachAvailable: !!this.o.coachNow,
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (!path.startsWith("/admin/")) return false;
    if (req.method !== "POST") {
      send(res, 405, { error: "method not allowed" });
      return true;
    }
    const gate = this.o.gate.check(req);
    if (gate === "locked") return send(res, 429, { error: "Too many wrong passwords. The admin panel is locked for 15 minutes." }), true;
    if (gate === "unset") return send(res, 409, { error: "This server has no owner password yet. Set OWNER_PASSWORD, or run Setup again." }), true;
    if (gate === "bad") return send(res, 401, { error: "That owner password is not right." }), true;
    let body: unknown;
    try {
      body = await readJson(req, MAX_BODY);
    } catch {
      return send(res, 400, { error: "bad request" }), true;
    }
    try {
      await this.route(path, body as Record<string, unknown>, res);
    } catch (err) {
      log.warn("admin request failed", { path, err: safeError(err) });
      send(res, 500, { error: safeError(err).message });
    }
    return true;
  }

  private async route(path: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    switch (path) {
      case "/admin/login":
      case "/admin/state":
        return send(res, 200, this.state());

      case "/admin/settings": {
        const values = (body.values ?? {}) as Record<string, unknown>;
        if (typeof values !== "object" || Array.isArray(values)) return send(res, 400, { error: "values: an object" });
        const next = { ...loadOverrides(this.o.settingsPath) };
        const errors: string[] = [];
        for (const [k, v] of Object.entries(values)) {
          const f0 = FIELD_BY_KEY.get(k);
          if (!f0) {
            errors.push(`${k} cannot be changed here`);
            continue;
          }
          const f = /^BEE[123]_BRAIN$/.test(f0.key) ? { ...f0, options: this.brainIds() } : f0;
          if (v === null) {
            delete next[k];
            continue;
          }
          const c = checkField(f, v);
          if (c.ok) next[k] = c.value;
          else errors.push(c.error);
        }
        if (errors.length) return send(res, 400, { error: errors.join("; ") });
        // The whole configuration must still load with these values (e.g. leverage <= 2).
        try {
          const candidate = withOverrides(this.o.env, next);
          loadConfig({ ...candidate, TYPESAFE_API_KEY: candidate.TYPESAFE_API_KEY || "validation-only-key" }, loadSettings(this.o.settingsPath));
        } catch (err) {
          return send(res, 400, { error: err instanceof ConfigError ? err.message : safeError(err).message });
        }
        saveOverrides(this.o.settingsPath, next);
        this.pending = true;
        log.info("admin: settings saved", { keys: Object.keys(values).join(",") });
        return send(res, 200, this.state());
      }

      case "/admin/keys": {
        const p = KeysBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "keys: text values for jev, openai, anthropic, kimi or coinmarketcap" });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "This server takes its keys from the environment (.env), so they are changed there." });
        const next: Settings = { ...s };
        for (const k of [...Object.keys(p.data.keys), ...p.data.remove] as KeyName[]) {
          if (KEY_ENV[k].some((n) => this.envSet(n))) return send(res, 409, { error: `The ${k} key is set in the environment; change it there.` });
        }
        for (const k of p.data.remove) {
          if (k === "jev") return send(res, 400, { error: "The Jev key cannot be removed: every decision needs it." });
          delete next[KEY_FIELD[k]];
        }
        for (const [k, v] of Object.entries(p.data.keys) as Array<[KeyName, string]>) {
          if (v.length < 8) return send(res, 400, { error: `The ${k} key looks too short.` });
          const err = await this.o.checks[k](v);
          if (err) return send(res, 400, { error: err });
          next[KEY_FIELD[k]] = v;
        }
        saveSettings(this.o.settingsPath, next);
        this.pending = true;
        log.info("admin: keys saved", { changed: [...Object.keys(p.data.keys), ...p.data.remove.map((r) => `-${r}`)].join(",") });
        return send(res, 200, this.state());
      }

      case "/admin/bees": {
        const p = BeesBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => `bee ${Number(i.path[1] ?? 0) + 1} ${String(i.path[2] ?? "")}: ${i.message}`).join("; ") });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "The original three bees run without a Setup file; design your own on Setup first." });
        const names = p.data.bees.map((b) => b.name.toLowerCase());
        if (new Set(names).size !== names.length) return send(res, 400, { error: "Each bee needs its own name." });
        // Only the last bees can go (slots are positions: removing one in the middle would hand its books to another),
        // and only while flat.
        const removed = s.bees.slice(p.data.bees.length).map((_, i) => slotId(p.data.bees.length + i));
        const holding = removed.filter((id) => this.o.isFlat && !this.o.isFlat(id));
        if (holding.length) return send(res, 409, { error: `${holding.join(", ")} still holds a position; it must be flat before it is removed.` });
        // Each bee's coins must be live X-Perps of its own market (the main three trade crypto only).
        const crypto = this.o.coins?.() ?? [];
        const macro = this.o.macroCoins?.() ?? { commodities: [], stocks: [] };
        const listFor = (m: MarketId) => (m === "crypto" ? crypto : m === "commodities" ? macro.commodities : m === "stocks" ? macro.stocks : [...macro.commodities, ...macro.stocks]);
        for (const [i, b] of p.data.bees.entries()) {
          const m: MarketId = i >= BEES.length ? (b.market ?? s.bees[i]?.market ?? "crypto") : "crypto";
          const known = listFor(m);
          if (!known.length) continue; // market not loaded yet
          const bad = [...new Set(b.coins)].filter((c) => !known.includes(c));
          if (bad.length) return send(res, 400, { error: `${b.name}: not a live ${MARKET_INFO[m].label} X-Perp on OKX right now: ${bad.join(", ")}.` });
        }
        const reserved = p.data.bees.find((b) => isReservedName(b.name));
        if (reserved) return send(res, 400, { error: `"${reserved.name}" belongs to an official bee.` });
        // Wallet and exchange: a new bee is created only with its wallet set and, outside paper trading, with keys
        // for this mode that pass the account check (Trade, no Withdraw, a sub-account holding at least the wallet).
        const running = this.o.runningBees?.() ?? [];
        const okx: Array<Settings["bees"][number]["okx"]> = [];
        for (const [i, b] of p.data.bees.entries()) {
          const slot = slotId(i);
          const old = s.bees[i];
          const extra = i >= BEES.length;
          const fresh = !old || !running.includes(slot);
          if (!extra && b.walletUsd !== undefined && b.walletUsd !== this.defaultWallet())
            return send(res, 400, { error: `${b.name}: the main three share the start equity (Settings → Risk), so the Hive can compare them.` });
          const wallet = extra ? (b.walletUsd ?? old?.walletUsd) : this.defaultWallet();
          if (extra && !old && !b.walletUsd) return send(res, 400, { error: `${b.name}: set its wallet (the money it starts with) before creating it.` });
          if (extra && old && b.walletUsd !== undefined && b.walletUsd !== (old.walletUsd ?? this.defaultWallet()) && !fresh)
            return send(res, 400, { error: `${b.name}: the wallet is set when a bee is created. It already trades, so it keeps $${old.walletUsd ?? this.defaultWallet()}.` });
          let keys = old?.okx;
          const need = this.o.mode === "dry" ? null : this.o.mode;
          if (b.exchange) {
            if (this.envExchange(slot, b.exchange.kind)) return send(res, 409, { error: `${b.name}: its ${b.exchange.kind} keys are set in the environment; change them there.` });
            if (old && this.o.isFlat && !this.o.isFlat(slot)) return send(res, 409, { error: `${b.name} holds a position: its exchange keys can change once it is flat.` });
            if (!this.o.okxCheck) return send(res, 503, { error: "The OKX account check is not available on this server." });
            const f = await this.o.okxCheck(b.exchange, b.exchange.kind, wallet ?? this.defaultWallet());
            if (f.problems.length) return send(res, 400, { error: `${b.name}: ${f.problems.join(" ")}` });
            const clash = s.bees.findIndex((o, j) => j !== i && f.uidHash && KINDS.some((k) => o.okx?.[k]?.uidHash === f.uidHash));
            if (clash >= 0) return send(res, 400, { error: `${b.name}: these keys open the same OKX account as ${s.bees[clash]!.name}. Each bee needs its own sub-account.` });
            keys = { ...(keys ?? {}), [b.exchange.kind]: { apiKey: b.exchange.apiKey, secretKey: b.exchange.secretKey, passphrase: b.exchange.passphrase, checkedAt: this.now(), balanceUsd: f.usdcUsd, uidHash: f.uidHash } };
          }
          if (need && !old && !keys?.[need] && !this.envExchange(slot, need))
            return send(res, 400, { error: `${b.name}: connect its OKX ${need} sub-account (and check its balance) before creating it.` });
          okx.push(keys);
        }
        const added: BeeId[] = [];
        let badBrain = "";
        const bees = p.data.bees.map((b, i) => {
          const coins = [...new Set(b.coins)];
          const old = s.bees[i];
          if (!old) added.push(slotId(i));
          const brain = i >= BEES.length ? (b.brain ?? old?.brain) : undefined;
          if (brain && !this.brainIds().includes(brain)) badBrain = `${b.name}: "${brain}" is not a brain here. Add it under Custom brains first.`;
          const market = i >= BEES.length ? (b.market ?? old?.market) : undefined;
          const next: Settings["bees"][number] = { ...(old ?? { image: false }), name: b.name, tagline: b.tagline, rules: b.rules, coins, style: deriveStyle(b.style, coins), ...(brain ? { brain } : {}) };
          if (market && market !== "crypto") next.market = market;
          else delete next.market;
          const wallet = i >= BEES.length ? (b.walletUsd ?? old?.walletUsd) : undefined;
          if (wallet) next.walletUsd = wallet;
          else delete next.walletUsd;
          if (okx[i]) next.okx = okx[i];
          else delete next.okx;
          return next;
        });
        // A brand-new bee starts with fresh paper money, never with the books of a bee that once had its slot.
        for (const id of added) this.o.forgetBee?.(id);
        if (badBrain) return send(res, 400, { error: badBrain });
        saveSettings(this.o.settingsPath, { ...s, bees });
        this.pending = true;
        log.info("admin: bees saved", { bees: bees.map((b) => `${b.name} (${STYLE_INFO[b.style].label})`) });
        return send(res, 200, this.state());
      }

      case "/admin/exchange/check": {
        // Test keys before the bee is created: read-only, nothing saved.
        const p = CheckBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "kind (demo or live), apiKey, secretKey, passphrase and walletUsd (10 to 1,000,000)" });
        if (!this.o.okxCheck) return send(res, 503, { error: "The OKX account check is not available on this server." });
        const f = await this.o.okxCheck(p.data, p.data.kind, p.data.walletUsd);
        const s = loadSettings(this.o.settingsPath);
        const self = p.data.bee && isBeeId(p.data.bee) ? ALL_INDEX(p.data.bee) : -1;
        const clash = s?.bees.findIndex((o, j) => j !== self && !!f.uidHash && KINDS.some((k) => o.okx?.[k]?.uidHash === f.uidHash)) ?? -1;
        if (clash >= 0) f.problems.push(`These keys open the same OKX account as ${s!.bees[clash]!.name}. Each bee needs its own sub-account.`);
        log.info("admin: exchange keys checked", { kind: p.data.kind, ok: f.ok && !f.problems.length });
        return send(res, 200, { ...f, uidHash: undefined, ready: f.ok && !f.problems.length });
      }

      case "/admin/anthropic-login": {
        if (!this.o.anthropicLogin) return send(res, 404, { error: "Anthropic sign-in is not available here." });
        const err = await this.o.anthropicLogin.check();
        if (err) return send(res, 400, { error: err });
        // The brain picks the login up at the next start when no key is set.
        if (!this.keySet("anthropic")) this.pending = true;
        log.info("admin: Anthropic sign-in checked");
        return send(res, 200, this.state());
      }

      case "/admin/revive": {
        const p = SlotBody.safeParse(body);
        if (!p.success || !isBeeId(p.data.bee) || !this.o.revive) return send(res, 400, { error: "bee: bee1..bee9" });
        try {
          this.o.revive(p.data.bee);
        } catch (err) {
          return send(res, 409, { error: (err as Error).message });
        }
        log.info("admin: bee revived", { bee: p.data.bee });
        return send(res, 200, this.state());
      }

      case "/admin/council": {
        const p = SlotBody.safeParse(body);
        if (!p.success || !isBeeId(p.data.bee) || !this.o.council) return send(res, 400, { error: "bee: bee1..bee9" });
        void this.o.council(p.data.bee).catch((err) => log.warn("admin: council failed", { err: safeError(err) }));
        return send(res, 200, { ok: true, note: "Council convened: its brains are thinking. Lessons, messages and any new skill appear in the hive mind in a minute or two." });
      }

      case "/admin/skills/import": {
        const p = ImportBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "json: a skill in the JSON rule language" });
        let raw: unknown;
        try {
          raw = JSON.parse(p.data.json);
        } catch {
          return send(res, 400, { error: "That is not valid JSON." });
        }
        let skill: Skill;
        try {
          skill = skillFromSpec(raw, "imported by the owner");
        } catch (err) {
          return send(res, 400, { error: (err as Error).message });
        }
        const labDir = this.o.labDir ?? "./data/lab";
        const result = evaluateSkill(skill, backtestData(join(labDir, "history")), { ...DEFAULT_TOURNAMENT, maxCombos: 12 });
        mkdirSync(join(labDir, "learned"), { recursive: true });
        writeFileSync(join(labDir, "learned", `owner_${skill.id}.json`), JSON.stringify(raw, null, 2));
        this.o.registerSkill?.(skill);
        log.info("admin: skill imported", { id: skill.id, score: result.score.toFixed(2) });
        return send(res, 200, {
          ok: true,
          skill: { id: skill.id, name: skill.name, family: skill.family },
          backtest: { score: result.score, returnPct: result.oos.returnPct, stabilityPct: result.stabilityPct, trades: result.oos.trades, maxDrawdownPct: result.oos.maxDrawdownPct },
          note: "Saved. It joins every lab run from now on; a council can adopt it.",
        });
      }

      case "/admin/alpaca": {
        const p = AlpacaBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "keyId and secret (8+ characters each), or remove: true" });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "This server takes its keys from the environment (.env), so they are changed there." });
        if (this.envSet("ALPACA_API_KEY_ID") || this.envSet("ALPACA_API_SECRET_KEY")) return send(res, 409, { error: "The Alpaca keys are set in the environment; change them there." });
        if (p.data.remove) {
          const next: Settings = { ...s };
          delete next.alpacaKeyId;
          delete next.alpacaSecret;
          saveSettings(this.o.settingsPath, next);
          log.info("admin: alpaca keys removed");
          return send(res, 200, this.state());
        }
        if (!p.data.keyId || !p.data.secret) return send(res, 400, { error: "Send the key ID and the secret together." });
        let feed: "iex" | "sip" = "iex";
        try {
          feed = parseEnv(withOverrides(this.o.env, loadOverrides(this.o.settingsPath))).ALPACA_FEED === "sip" ? "sip" : "iex";
        } catch {
          /* keep iex */
        }
        const err = this.o.checks.alpaca ? await this.o.checks.alpaca(p.data.keyId, p.data.secret, feed) : null;
        if (err) return send(res, 400, { error: err });
        saveSettings(this.o.settingsPath, { ...s, alpacaKeyId: p.data.keyId, alpacaSecret: p.data.secret });
        log.info("admin: alpaca keys saved", { feed });
        return send(res, 200, this.state());
      }

      case "/admin/mcp/save": {
        const p = McpSave.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => `${i.path.join(".") || "server"}: ${i.message}`).join("; ") });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "This server has no Setup file, so connectors cannot be saved here. Run Setup first." });
        if (!this.o.mcp) return send(res, 503, { error: "Connectors are not available here." });
        const list = [...(s.mcpServers ?? [])];
        const at = list.findIndex((m) => m.id === p.data.id);
        if (at < 0 && list.length >= 20) return send(res, 400, { error: "That is 20 connectors already." });
        const old = list[at];
        const base = McpServerSchema.safeParse({
          id: p.data.id,
          label: p.data.label,
          url: p.data.url,
          transport: p.data.transport ?? old?.transport ?? "http",
          authHeader: p.data.authHeader ?? old?.authHeader ?? "Authorization",
          ...((p.data.token || old?.token) ? { token: p.data.token || old?.token } : {}),
          maxCallsDay: p.data.maxCallsDay ?? old?.maxCallsDay ?? 50,
          tools: old?.tools ?? [],
          grants: old?.grants ?? [],
        });
        if (!base.success) return send(res, 400, { error: base.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        const next = base.data;
        if (!p.data.force) {
          try {
            const tools = await this.o.mcp.discover(next as McpServerDef);
            next.tools = tools;
            next.grants = next.grants.filter((g) => tools.some((t) => t.name === g.tool));
          } catch (err) {
            return send(res, 400, { error: `Could not read its tools: ${safeError(err).message}. Not saved. If the server is only down right now, save it anyway with "Save without testing".` });
          }
        }
        if (at >= 0) list[at] = next;
        else list.push(next);
        saveSettings(this.o.settingsPath, { ...s, mcpServers: list });
        log.info("admin: connector saved", { id: next.id, host: new URL(next.url).host, tools: next.tools.length });
        return send(res, 200, this.state());
      }

      case "/admin/mcp/discover": {
        const p = McpRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: "id" });
        const s = loadSettings(this.o.settingsPath);
        const m = s?.mcpServers?.find((x) => x.id === p.data.id);
        if (!s || !m) return send(res, 404, { error: "No such connector." });
        if (!this.o.mcp) return send(res, 503, { error: "Connectors are not available here." });
        try {
          const tools = await this.o.mcp.discover(m as McpServerDef);
          m.tools = tools;
          // A grant for a tool the server no longer offers goes away with it.
          m.grants = m.grants.filter((g) => tools.some((t) => t.name === g.tool));
        } catch (err) {
          return send(res, 502, { error: `Could not read its tools: ${safeError(err).message}` });
        }
        saveSettings(this.o.settingsPath, s);
        return send(res, 200, this.state());
      }

      case "/admin/mcp/grant": {
        const p = McpGrants.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => `${i.path.join(".") || "grants"}: ${i.message}`).join("; ") });
        const s = loadSettings(this.o.settingsPath);
        const m = s?.mcpServers?.find((x) => x.id === p.data.id);
        if (!s || !m) return send(res, 404, { error: "No such connector." });
        const seen = new Set<string>();
        const grants: typeof m.grants = [];
        for (const g of p.data.grants) {
          const t = m.tools.find((x) => x.name === g.tool);
          if (!t) return send(res, 400, { error: `${g.tool}: this server does not offer that tool (refresh its tools first).` });
          if (seen.has(g.tool)) return send(res, 400, { error: `${g.tool}: listed twice.` });
          seen.add(g.tool);
          if (needsConfirmation(t) && !g.confirmed) {
            return send(res, 400, { error: `${g.tool}: ${t.readOnly === true ? "its name reads like an action" : "the server does not say it is read-only"}. Confirm you checked that it only reads, or leave it off.` });
          }
          grants.push({ tool: g.tool, bees: [...new Set(g.bees)], ...(needsConfirmation(t) ? { confirmed: true } : {}) });
        }
        m.grants = grants;
        saveSettings(this.o.settingsPath, s);
        log.info("admin: connector grants saved", { id: m.id, tools: grants.length });
        return send(res, 200, this.state());
      }

      case "/admin/mcp/delete": {
        const p = McpRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: "id" });
        const s = loadSettings(this.o.settingsPath);
        if (!s?.mcpServers?.some((m) => m.id === p.data.id)) return send(res, 404, { error: "No such connector." });
        saveSettings(this.o.settingsPath, { ...s, mcpServers: s.mcpServers.filter((m) => m.id !== p.data.id) });
        log.info("admin: connector removed", { id: p.data.id });
        return send(res, 200, this.state());
      }

      case "/admin/brains/test": {
        const p = CustomBrainTest.safeParse(body);
        if (!p.success) return send(res, 400, { error: "baseUrl and model" });
        if (!this.o.checks.compat) return send(res, 503, { error: "The connection test is not available here." });
        const bad = checkBaseUrl(p.data.baseUrl);
        if (bad) return send(res, 400, { error: bad });
        // Testing a saved brain without retyping its key: the panel sends the id and no key.
        const key = p.data.apiKey || (p.data.id ? loadSettings(this.o.settingsPath)?.customBrains?.find((b) => b.id === p.data.id)?.apiKey : undefined);
        const err = await this.o.checks.compat(p.data.baseUrl, key || undefined, p.data.model, p.data.vendor || "The server");
        return send(res, 200, { ok: !err, error: err ?? undefined });
      }

      case "/admin/brains/save": {
        const p = CustomBrainBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues.map((i) => `${i.path.join(".") || "brain"}: ${i.message}`).join("; ") });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "This server has no Setup file, so custom brains cannot be saved here. Run Setup first." });
        const list = [...(s.customBrains ?? [])];
        const at = list.findIndex((b) => b.id === p.data.id);
        if (at < 0 && list.length >= 50) return send(res, 400, { error: "That is 50 custom brains already." });
        const bad = checkBaseUrl(p.data.baseUrl);
        if (bad) return send(res, 400, { error: bad });
        const apiKey = p.data.apiKey || list[at]?.apiKey;
        const brain = CustomBrainSchema.safeParse({ id: p.data.id, label: p.data.label, vendor: p.data.vendor ?? "Custom", baseUrl: p.data.baseUrl, model: p.data.model, ...(apiKey ? { apiKey } : {}), jsonMode: p.data.jsonMode ?? "object" });
        if (!brain.success) return send(res, 400, { error: brain.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        if (!p.data.force && this.o.checks.compat) {
          const err = await this.o.checks.compat(brain.data.baseUrl, brain.data.apiKey, brain.data.model, brain.data.label);
          if (err) return send(res, 400, { error: `${err} Not saved. If the server is only down right now, save it anyway with "Save without testing".` });
        }
        if (at >= 0) list[at] = brain.data;
        else list.push(brain.data);
        saveSettings(this.o.settingsPath, { ...s, customBrains: list });
        registerBrain(brain.data.id, brain.data);
        this.pending = true;
        log.info("admin: custom brain saved", { id: brain.data.id, model: brain.data.model, host: new URL(brain.data.baseUrl).host });
        return send(res, 200, this.state());
      }

      case "/admin/brains/delete": {
        const p = BrainRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: "id" });
        const s = loadSettings(this.o.settingsPath);
        const list = s?.customBrains ?? [];
        if (!s || !list.some((b) => b.id === p.data.id)) return send(res, 404, { error: "No such custom brain." });
        const users = this.brainUsers(p.data.id);
        if (users.length) return send(res, 409, { error: `${brainInfo(p.data.id).label} is in use by ${users.join(", ")}. Give them another brain first.` });
        saveSettings(this.o.settingsPath, { ...s, customBrains: list.filter((b) => b.id !== p.data.id) });
        this.pending = true;
        log.info("admin: custom brain removed", { id: p.data.id });
        return send(res, 200, this.state());
      }

      case "/admin/workspace/ai": {
        const p = AskAgent.safeParse(body);
        if (!p.success) return send(res, 400, { error: `Describe the strategy in 8 to ${MAX_PROMPT} characters.` });
        const agent = this.o.skillAgent;
        if (!agent) return send(res, 503, { error: "The skill agent is not available here." });
        const ws = this.workspace();
        // Revising: the newest version of an open draft goes to the brain along with the request.
        const base = p.data.key ? ws.get(p.data.key) : null;
        if (p.data.key && !base) return send(res, 404, { error: "No such draft to revise." });
        const current = base?.versions[base.versions.length - 1]?.json;
        try {
          const r = await agent.draft({ prompt: p.data.prompt, ...(p.data.brain ? { brain: p.data.brain } : {}), ...(current ? { current } : {}) });
          let json = r.json;
          // A revision stays on the same draft, so its versions line up: the brain may not move it to another id.
          if (r.valid && base) {
            try {
              json = JSON.stringify({ ...(JSON.parse(r.json) as object), id: base.key }, null, 2);
            } catch {
              /* validated already; keep the text */
            }
          }
          if (!r.valid || !validateSkill(json).ok) return send(res, 200, { ok: false, ...r, json, valid: false, state: this.state() });
          const draft = ws.save({ ...(base ? { key: base.key } : {}), json, note: `${r.brainLabel}: ${p.data.prompt}`.slice(0, 200), author: `ai:${r.brain}` });
          log.info("admin: skill drafted by a brain", { brain: r.brain, key: draft.key });
          return send(res, 200, { ok: true, ...r, json, draft, state: this.state() });
        } catch (err) {
          if (err instanceof AgentError) return send(res, 409, { error: err.message });
          throw err;
        }
      }

      case "/admin/workspace/check": {
        const p = DraftCheck.safeParse(body);
        if (!p.success) return send(res, 400, { error: "json: the skill text" });
        const v = validateSkill(p.data.json);
        return send(res, 200, v.ok ? { ok: true, id: v.skill.id, name: v.skill.name, family: v.skill.family } : { ok: false, errors: v.errors });
      }

      case "/admin/workspace/get": {
        const p = DraftRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "key" });
        const d = this.workspace().get(p.data.key);
        return d ? send(res, 200, { draft: d }) : send(res, 404, { error: "No such draft." });
      }

      case "/admin/workspace/save": {
        const p = DraftSave.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "json: the skill text" });
        try {
          const d = this.workspace().save({ ...(p.data.key ? { key: p.data.key } : {}), json: p.data.json, ...(p.data.note ? { note: p.data.note } : {}) });
          log.info("admin: skill draft saved", { key: d.key, version: d.versions.length });
          return send(res, 200, { draft: d, state: this.state() });
        } catch (err) {
          if (err instanceof WorkspaceError) return send(res, 400, { error: err.message });
          throw err;
        }
      }

      case "/admin/workspace/backtest": {
        const p = DraftRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "key" });
        try {
          const r = this.workspace().backtest(p.data.key, backtestData(join(this.labDir(), "history")));
          log.info("admin: skill draft backtested", { key: p.data.key, score: r.summary.score, data: r.summary.data });
          return send(res, 200, { draft: r.draft, state: this.state() });
        } catch (err) {
          if (err instanceof WorkspaceError) return send(res, 400, { error: err.message });
          return send(res, 500, { error: `backtest failed: ${safeError(err)}` });
        }
      }

      case "/admin/workspace/publish": {
        const p = DraftPublish.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "key" });
        try {
          const r = this.workspace().publish(p.data.key, { force: !!p.data.force });
          this.o.registerSkill?.(r.skill);
          log.info("admin: skill published", { key: p.data.key, forced: !!p.data.force });
          return send(res, 200, { draft: r.draft, state: this.state(), note: "Published. It joins every lab run from now on; a council can adopt it. Only a council pick makes it one vote Jev may weigh." });
        } catch (err) {
          if (err instanceof WorkspaceError) return send(res, 409, { error: err.message });
          throw err;
        }
      }

      case "/admin/workspace/discard": {
        const p = DraftRef.safeParse(body);
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "key" });
        try {
          this.workspace().discard(p.data.key);
        } catch (err) {
          if (err instanceof WorkspaceError) return send(res, 404, { error: err.message });
          throw err;
        }
        return send(res, 200, this.state());
      }

      case "/admin/notes/add": {
        const p = NoteAdd.safeParse(body);
        if (!this.o.notes) return send(res, 503, { error: "Notes are not available here." });
        if (!p.success) return send(res, 400, { error: p.error.issues[0]?.message ?? "bee, title and text" });
        try {
          this.o.notes.add({ bee: p.data.bee, kind: "background", author: "owner", title: p.data.title, text: p.data.text, coins: p.data.coins });
        } catch (err) {
          if (err instanceof NoteError) return send(res, 400, { error: err.message });
          throw err;
        }
        log.info("admin: background note added", { bee: p.data.bee });
        return send(res, 200, this.state());
      }

      case "/admin/notes/decide": {
        const p = NoteDecide.safeParse(body);
        if (!this.o.notes) return send(res, 503, { error: "Notes are not available here." });
        if (!p.success) return send(res, 400, { error: "id and decision (approve or reject)" });
        try {
          this.o.notes.decide(p.data.id, p.data.decision);
        } catch (err) {
          if (err instanceof NoteError) return send(res, 409, { error: err.message });
          throw err;
        }
        log.info("admin: note decided", { decision: p.data.decision });
        return send(res, 200, this.state());
      }

      case "/admin/notes/delete": {
        const p = NoteRef.safeParse(body);
        if (!this.o.notes) return send(res, 503, { error: "Notes are not available here." });
        if (!p.success) return send(res, 400, { error: "id" });
        try {
          this.o.notes.remove(p.data.id);
        } catch (err) {
          if (err instanceof NoteError) return send(res, 404, { error: err.message });
          throw err;
        }
        return send(res, 200, this.state());
      }

      case "/admin/research": {
        const p = ResearchBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "bee: bee1..bee9" });
        const r = this.o.research;
        if (!r) return send(res, 503, { error: "Research is not available here." });
        const why = r.blocked(p.data.bee as BeeId);
        if (why) return send(res, 409, { error: `Cannot research now: ${why}.` });
        void r.research(p.data.bee as BeeId).catch((err) => log.warn("admin: research failed", { err: safeError(err) }));
        return send(res, 200, this.state());
      }

      case "/admin/password": {
        const p = PasswordBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: `The new password needs ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.` });
        const s = loadSettings(this.o.settingsPath);
        if (!s) return send(res, 409, { error: "This server's password comes from OWNER_PASSWORD in the environment; change it there." });
        const hash = hashPassword(p.data.next);
        saveSettings(this.o.settingsPath, { ...s, ownerPasswordHash: hash });
        this.o.onPasswordChanged(hash);
        log.info("admin: owner password changed");
        return send(res, 200, { ok: true });
      }

      case "/admin/lab": {
        const p = LabBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: "command: fetch, run, council or cycle" });
        try {
          this.o.jobs.start(p.data.command, p.data.args as LabArgs);
        } catch (err) {
          return send(res, 409, { error: (err as Error).message });
        }
        log.info("admin: lab job started", { command: p.data.command });
        return send(res, 200, this.state());
      }

      case "/admin/check": {
        const p = RealCheckBody.safeParse(body);
        if (!p.success) return send(res, 400, { error: `stages: any of ${CHECK_STAGES.join(", ")}` });
        const keys = this.state().keys as Record<string, { set: boolean }>;
        try {
          this.o.jobs.startCheck(p.data.stages, { labDir: this.labDir(), hasBrain: this.readyBrains(keys).length > 0, hasAlpaca: this.alpacaView(undefined).set });
        } catch (err) {
          return send(res, 409, { error: (err as Error).message });
        }
        log.info("admin: real-data check started", { stages: p.data.stages });
        return send(res, 200, this.state());
      }

      case "/admin/lab/stop":
        this.o.jobs.stop();
        return send(res, 200, this.state());

      case "/admin/coach": {
        if (!this.o.coachNow) return send(res, 409, { error: "No brain has a key, so there is nobody to coach." });
        void this.o.coachNow().catch((err) => log.warn("admin: coach run failed", { err: safeError(err) }));
        return send(res, 200, { ok: true, note: "Coach review started; lessons appear in the hive mind in a minute or two." });
      }

      case "/admin/restart":
        send(res, 200, { ok: true, note: "Restarting. The dashboard reconnects in a few seconds." });
        log.info("admin: restart requested");
        setTimeout(() => this.o.restart(), 500);
        return;

      default:
        return send(res, 404, { error: "not found" });
    }
  }
}
