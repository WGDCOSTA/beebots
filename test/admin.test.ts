import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Admin, type KeyChecks } from "../src/admin/admin.js";
import { ADMIN_FIELDS, checkField } from "../src/admin/fields.js";
import { labArgv, LabJobs } from "../src/admin/jobs.js";
import { loadConfig, parseEnv, withOverrides } from "../src/config.js";
import { hashPassword, PasswordGate, verifyPassword } from "../src/gate.js";
import { adminPath, loadOverrides, loadSettings, saveSettings, type Settings } from "../src/settings.js";

const PW = "correct horse battery";
const HASH = hashPassword(PW);

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "admin-"));
  const path = join(dir, "settings.json");
  const bee = (name: string, style: "bizzy" | "breezy" | "boozy", coins: string[]) => ({ name, style, tagline: "the test", rules: "Trade carefully, always.", coins, look: "a bee", image: true });
  const s: Settings = {
    version: 1,
    jevKey: "jev-key-12345678",
    openaiKey: "sk-openai-12345678",
    ownerPasswordHash: HASH,
    acceptedRiskAt: 1,
    bees: [bee("Zippy", "bizzy", ["BTC"]), bee("Calm", "breezy", ["BTC", "ETH"]), bee("Wild", "boozy", [])],
    hive: false,
    createdAt: 1,
  };
  saveSettings(path, s);
  return path;
}

const okChecks: KeyChecks = { jev: async () => null, openai: async () => null, anthropic: async () => null, kimi: async () => null };

function harness(opts: { env?: NodeJS.ProcessEnv; checks?: Partial<KeyChecks> } = {}) {
  const settingsPath = settingsFile();
  let hash = HASH;
  let restarted = 0;
  const started: Array<[string, unknown]> = [];
  const jobs = { start: (c: string, a: unknown) => started.push([c, a]), stop: () => {}, status: () => null } as unknown as LabJobs;
  const admin = new Admin({
    settingsPath,
    env: opts.env ?? {},
    gate: new PasswordGate("x-owner-password", () => hash, "owner password"),
    mode: "dry",
    version: "test",
    checks: { ...okChecks, ...opts.checks },
    jobs,
    coachNow: null,
    graphStats: () => ({ skill: 3 }),
    playbook: () => null,
    onPasswordChanged: (h) => (hash = h),
    restart: () => restarted++,
  });
  async function call(path: string, body: unknown = {}, password = PW) {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: "POST",
      headers: { "x-owner-password": encodeURIComponent(password) },
    });
    const out = { status: 0, body: null as unknown };
    const res = Object.assign(new EventEmitter(), {
      writeHead: (s: number) => (out.status = s),
      end: (b: string) => (out.body = JSON.parse(b)),
    });
    await admin.handle(req as never, res as never, path);
    return out as { status: number; body: Record<string, unknown> & { error?: string } };
  }
  return { admin, call, settingsPath, started, restarted: () => restarted, hash: () => hash };
}

describe("admin fields", () => {
  it("every field is a real setting with a default", () => {
    const d = parseEnv({});
    // Optional secrets (the alert webhook) have no default; every other field does.
    for (const f of ADMIN_FIELDS) expect(f.secret || f.key in d, f.key).toBe(true);
  });

  it("checks values by type and range", () => {
    const lev = ADMIN_FIELDS.find((f) => f.key === "MAX_LEVERAGE")!;
    expect(checkField(lev, 1.5)).toEqual({ ok: true, value: "1.5" });
    expect(checkField(lev, 3).ok).toBe(false);
    const brain = ADMIN_FIELDS.find((f) => f.key === "BEE2_BRAIN")!;
    expect(checkField(brain, "gemini").ok).toBe(false);
    const url = ADMIN_FIELDS.find((f) => f.key === "KIMI_BASE_URL")!;
    expect(checkField(url, "http://evil").ok).toBe(false);
  });

  it("overrides fill in only what the environment leaves blank", () => {
    const env = withOverrides({ TICK_MS: "5000", LAB_SIGNALS: "" }, { TICK_MS: "20000", LAB_SIGNALS: "true" });
    expect(env.TICK_MS).toBe("5000");
    expect(loadConfig({ ...env, TYPESAFE_API_KEY: "k".repeat(20) }).lab.signals).toBe(true);
  });
});

describe("admin API", () => {
  it("needs the owner password on every call", async () => {
    const h = harness();
    expect((await h.call("/admin/state", {}, "wrong password!")).status).toBe(401);
    const ok = await h.call("/admin/state");
    expect(ok.status).toBe(200);
    expect(ok.body.mode).toBe("dry");
  });

  it("never sends a key back, only whether it is set and where from", async () => {
    const h = harness({ env: { ANTHROPIC_API_KEY: "sk-ant-from-env-123456" } });
    const r = await h.call("/admin/state");
    expect(JSON.stringify(r.body)).not.toMatch(/sk-|jev-key/);
    expect(r.body.keys).toMatchObject({ jev: { set: true, source: "settings" }, anthropic: { set: true, source: "env" }, kimi: { set: false, source: null } });
  });

  it("saves overrides, rejects bad values and unknown settings, and flags a restart", async () => {
    const h = harness();
    const bad = await h.call("/admin/settings", { values: { MAX_LEVERAGE: 5, MODE: "live" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Max leverage/);
    expect(bad.body.error).toMatch(/MODE cannot be changed/);
    expect(existsSync(adminPath(h.settingsPath))).toBe(false);

    const ok = await h.call("/admin/settings", { values: { MAX_LEVERAGE: 1.5, LAB_SIGNALS: true, BEE3_BRAIN: "claude" } });
    expect(ok.status).toBe(200);
    expect(loadOverrides(h.settingsPath)).toEqual({ MAX_LEVERAGE: "1.5", LAB_SIGNALS: "true", BEE3_BRAIN: "claude" });
    expect(ok.body.pendingRestart).toBe(true);
    const fields = ok.body.fields as Array<{ key: string; value: unknown; overridden: boolean }>;
    expect(fields.find((f) => f.key === "MAX_LEVERAGE")).toMatchObject({ value: 1.5, overridden: true });

    await h.call("/admin/settings", { values: { MAX_LEVERAGE: null } });
    expect(loadOverrides(h.settingsPath)).toEqual({ LAB_SIGNALS: "true", BEE3_BRAIN: "claude" });
  });

  it("marks settings the environment controls", async () => {
    const h = harness({ env: { TICK_MS: "5000" } });
    const fields = (await h.call("/admin/state")).body.fields as Array<{ key: string; lockedByEnv: boolean; value: unknown }>;
    expect(fields.find((f) => f.key === "TICK_MS")).toMatchObject({ lockedByEnv: true, value: 5000 });
  });

  it("checks a key before saving it, and refuses keys the environment owns", async () => {
    const h = harness({ env: { KIMI_API_KEY: "sk-kimi-env-12345" }, checks: { anthropic: async () => "Anthropic rejected that key." } });
    expect((await h.call("/admin/keys", { keys: { anthropic: "sk-ant-bad-123456" } })).body.error).toMatch(/rejected/);
    expect((await h.call("/admin/keys", { keys: { kimi: "sk-kimi-other-1234" } })).status).toBe(409);
    expect((await h.call("/admin/keys", { remove: ["jev"] })).status).toBe(400);
    expect((await h.call("/admin/keys", { remove: ["openai"] })).status).toBe(200);
    expect(loadSettings(h.settingsPath)!.openaiKey).toBeUndefined();
  });

  it("edits the bees, re-deriving the style from the coins", async () => {
    const h = harness();
    const bees = [
      { name: "Zippy", tagline: "the fast", rules: "Only BTC breakouts.", coins: ["BTC"], style: "bizzy" },
      { name: "Calm", tagline: "the calm", rules: "Ride ETH trends.", coins: ["DOGE"], style: "breezy" },
      { name: "Wild", tagline: "the wild", rules: "Chase movers.", coins: [], style: "boozy" },
    ];
    const r = await h.call("/admin/bees", { bees });
    expect(r.status).toBe(200);
    const s = loadSettings(h.settingsPath)!;
    expect(s.bees[1]).toMatchObject({ name: "Calm", coins: ["DOGE"], style: "boozy", image: true });
    expect((await h.call("/admin/bees", { bees: [{ ...bees[0], name: "Bizzy" }, bees[1], bees[2]] })).body.error).toMatch(/official bee/);
  });

  it("changes the owner password and the old one stops working", async () => {
    const h = harness();
    expect((await h.call("/admin/password", { next: "short" })).status).toBe(400);
    expect((await h.call("/admin/password", { next: "a much better password" })).status).toBe(200);
    expect(verifyPassword("a much better password", h.hash())).toBe(true);
    expect((await h.call("/admin/state")).status).toBe(401);
    expect(JSON.parse(readFileSync(h.settingsPath, "utf8")).ownerPasswordHash).toBe(h.hash());
  });

  it("starts lab jobs and restarts on request", async () => {
    const h = harness();
    expect((await h.call("/admin/lab", { command: "rm -rf" })).status).toBe(400);
    expect((await h.call("/admin/lab", { command: "run", args: { synthetic: 2 } })).status).toBe(200);
    expect(h.started).toEqual([["run", { synthetic: 2 }]]);
    expect((await h.call("/admin/coach")).status).toBe(409);
    await h.call("/admin/restart");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.restarted()).toBe(1);
  });
});

describe("lab jobs", () => {
  it("builds CLI arguments only from checked fields", () => {
    expect(labArgv("run", { synthetic: 3, folds: 4, leverage: 1.5, longOnly: true })).toEqual(["run", "--bar", "1H", "--folds", "4", "--leverage", "1.5", "--synthetic", "3", "--long-only"]);
    expect(labArgv("fetch", { source: "ccxt", exchange: "binance", symbols: "BTC/USDT,ETH/USDT", days: 90 })).toEqual(["fetch", "--bar", "1H", "--days", "90", "--exchange", "binance", "--symbol", "BTC/USDT,ETH/USDT"]);
    expect(labArgv("council", {})).toEqual(["council"]);
    expect(() => labArgv("fetch", { source: "ccxt", exchange: "binance; rm -rf /" })).toThrow(/exchange/);
    expect(() => labArgv("fetch", { symbols: "BTC --base http://evil" })).toThrow(/instruments/);
    expect(() => labArgv("run", { leverage: 3 })).toThrow(/leverage/);
  });

  it("runs one job at a time and keeps its output", async () => {
    const children: EventEmitter[] = [];
    const spawnFn = (() => {
      const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} });
      children.push(c);
      return c;
    }) as never;
    let done = 0;
    const jobs = new LabJobs(() => ({}), () => done++, spawnFn, import.meta.filename);
    const j = jobs.start("run", { synthetic: 1 });
    expect(() => jobs.start("council", {})).toThrow(/already running/);
    (children[0] as unknown as { stdout: EventEmitter }).stdout.emit("data", Buffer.from("line one\nkey sk-abcdefghijklmnopqrstu\n"));
    children[0]!.emit("close", 0);
    expect(j).toMatchObject({ state: "done", exitCode: 0 });
    expect(j.log).toEqual(["line one", "key [redacted]"]);
    expect(done).toBe(1);
  });
});
