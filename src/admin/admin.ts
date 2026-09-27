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
import { ConfigError, loadConfig, parseEnv, withOverrides, type Mode } from "../config.js";
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
});
const BeesBody = z.object({ bees: z.array(BeeEdit).length(3) });
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
        ? settings.bees.map((b, i) => ({ slot: `bee${i + 1}`, name: b.name, tagline: b.tagline, rules: b.rules, coins: b.coins, style: b.style, image: b.image }))
        : null,
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
        if (new Set(names).size !== 3) return send(res, 400, { error: "Each bee needs its own name." });
        const reserved = p.data.bees.find((b) => isReservedName(b.name));
        if (reserved) return send(res, 400, { error: `"${reserved.name}" belongs to an official bee.` });
        const bees = p.data.bees.map((b, i) => {
          const coins = [...new Set(b.coins)];
          return { ...s.bees[i]!, name: b.name, tagline: b.tagline, rules: b.rules, coins, style: deriveStyle(b.style, coins) };
        });
        saveSettings(this.o.settingsPath, { ...s, bees });
        this.pending = true;
        log.info("admin: bees saved", { bees: bees.map((b) => `${b.name} (${STYLE_INFO[b.style].label})`) });
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
