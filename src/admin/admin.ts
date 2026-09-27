// The admin panel's API. Every call is a POST carrying the owner password (x-owner-password, the same gate and lockout
// as joining the Hive). What it can change:
// - settings on the ADMIN_FIELDS list, stored as overrides in admin.json (the environment still wins, as for Setup);
// - the Jev / OpenAI / Anthropic / Kimi keys, the three bees and the owner password, in the Setup file;
// - lab jobs (fetch, run, council, cycle), a coach review now, and an engine restart to apply saved changes.
// What it cannot: the trading mode, LIVE_ACK and exchange keys stay in the environment, so real money is never one
// click away. Keys are write-only: the page only ever learns whether one is set, and where from.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { deriveStyle } from "../bees/custom.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtestData } from "../brains/survival.js";
import { BEES, ConfigError, isBeeId, loadConfig, MAX_BEES, parseEnv, slotId, withOverrides, type BeeId, type Mode } from "../config.js";
import { skillFromSpec, type Skill } from "../lab/skills/index.js";
import { evaluateSkill, DEFAULT_TOURNAMENT } from "../lab/tournament.js";
import { hashPassword, MAX_PASSWORD, MIN_PASSWORD, readJson, send, type PasswordGate } from "../gate.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { BeeSchema, isReservedName, loadOverrides, loadSettings, saveOverrides, saveSettings, STYLE_INFO, STYLES, type Settings } from "../settings.js";
import { ADMIN_FIELDS, checkField, FIELD_BY_KEY, FIELD_GROUPS, GROUP_INFO } from "./fields.js";
import { LAB_COMMANDS, type LabArgs, type LabJobs } from "./jobs.js";

const MAX_BODY = 32 * 1024;
const KEY_NAMES = ["jev", "openai", "anthropic", "kimi"] as const;
type KeyName = (typeof KEY_NAMES)[number];
const KEY_ENV: Record<KeyName, string[]> = {
  jev: ["TYPESAFE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  kimi: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
};
const KEY_FIELD: Record<KeyName, "jevKey" | "openaiKey" | "anthropicKey" | "kimiKey"> = { jev: "jevKey", openai: "openaiKey", anthropic: "anthropicKey", kimi: "kimiKey" };

export interface KeyChecks {
  jev(key: string): Promise<string | null>;
  openai(key: string): Promise<string | null>;
  anthropic(key: string): Promise<string | null>;
  kimi(key: string): Promise<string | null>;
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
  /** <LAB_DIR>, for imported skills and backtest history. */
  labDir?: string;
  now?: () => number;
}

const Str = (max: number) => z.string().trim().max(max);
const KeysBody = z.object({
  keys: z.record(z.enum(KEY_NAMES), Str(300)).default({}),
  remove: z.array(z.enum(KEY_NAMES)).max(4).default([]),
});
const BeeEdit = z.object({
  name: BeeSchema.shape.name,
  tagline: Str(40).default(""),
  rules: Str(500).default(""),
  coins: BeeSchema.shape.coins,
  style: z.enum(STYLES),
  /** Extra bees only: which LLM brain it thinks with. */
  brain: z.enum(["openai", "claude", "kimi"]).optional(),
});
const BeesBody = z.object({ bees: z.array(BeeEdit).min(BEES.length).max(MAX_BEES) });
const SlotBody = z.object({ bee: z.string() });
const ImportBody = z.object({ json: z.string().min(2).max(20_000) });
const PasswordBody = z.object({ next: z.string().min(MIN_PASSWORD).max(MAX_PASSWORD) });
const LabBody = z.object({
  command: z.enum(LAB_COMMANDS),
  args: z
    .object({
      source: z.enum(["okx", "ccxt", "synthetic"]).optional(),
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

  private envSet(name: string): boolean {
    return !!(this.o.env[name] ?? "").trim();
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
        return [k, { set: env || file, source: env ? "env" : file ? "settings" : null }];
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
            extra: i >= BEES.length,
            running: this.o.runningBees?.().includes(slotId(i)) ?? true,
            flat: this.o.isFlat?.(slotId(i)) ?? true,
          }))
        : null,
      maxBees: MAX_BEES,
      coins: this.o.coins?.() ?? [],
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
          options: f.options,
          secret: !!f.secret,
          lockedByEnv,
          overridden: f.key in overrides,
          ...(f.secret ? { set: lockedByEnv || f.key in overrides } : { value: effective[f.key] ?? null, default: defaults[f.key] ?? null }),
        };
      }),
      lab: { job: this.o.jobs.status(), graph: this.o.graphStats(), playbook: this.o.playbook() },
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
          const f = FIELD_BY_KEY.get(k);
          if (!f) {
            errors.push(`${k} cannot be changed here`);
            continue;
          }
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
        if (!p.success) return send(res, 400, { error: "keys: text values for jev, openai, anthropic or kimi" });
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
        const known = this.o.coins?.() ?? [];
        if (known.length) {
          const bad = [...new Set(p.data.bees.flatMap((b) => b.coins))].filter((c) => !known.includes(c));
          if (bad.length) return send(res, 400, { error: `Not tradable on OKX right now: ${bad.join(", ")}.` });
        }
        const reserved = p.data.bees.find((b) => isReservedName(b.name));
        if (reserved) return send(res, 400, { error: `"${reserved.name}" belongs to an official bee.` });
        const added: BeeId[] = [];
        const bees = p.data.bees.map((b, i) => {
          const coins = [...new Set(b.coins)];
          const old = s.bees[i];
          if (!old) added.push(slotId(i));
          const brain = i >= BEES.length ? (b.brain ?? old?.brain) : undefined;
          return { ...(old ?? { image: false }), name: b.name, tagline: b.tagline, rules: b.rules, coins, style: deriveStyle(b.style, coins), ...(brain ? { brain } : {}) };
        });
        // A brand-new bee starts with fresh paper money, never with the books of a bee that once had its slot.
        for (const id of added) this.o.forgetBee?.(id);
        saveSettings(this.o.settingsPath, { ...s, bees });
        this.pending = true;
        log.info("admin: bees saved", { bees: bees.map((b) => `${b.name} (${STYLE_INFO[b.style].label})`) });
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
