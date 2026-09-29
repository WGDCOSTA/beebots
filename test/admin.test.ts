import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Admin, type AdminOpts, type KeyChecks } from "../src/admin/admin.js";
import { ADMIN_FIELDS, checkField } from "../src/admin/fields.js";
import { NoteBook } from "../src/brains/notes.js";
import { labArgv, LabJobs } from "../src/admin/jobs.js";
import { loadConfig, parseEnv, withOverrides, type BeeId } from "../src/config.js";
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

const okChecks: KeyChecks = { jev: async () => null, openai: async () => null, anthropic: async () => null, kimi: async () => null, zai: async () => null, alpaca: async (id: string) => (id.includes("bad") ? "Alpaca rejected that key pair." : null), compat: async () => null, coinmarketcap: async () => null };

function harness(opts: { env?: NodeJS.ProcessEnv; checks?: Partial<KeyChecks>; holding?: string[]; mode?: "dry" | "demo" | "live"; okxCheck?: AdminOpts["okxCheck"]; running?: BeeId[]; skillAgent?: AdminOpts["skillAgent"]; mcp?: AdminOpts["mcp"] } = {}) {
  const settingsPath = settingsFile();
  const forgotten: string[] = [];
  const revived: string[] = [];
  const imported: string[] = [];
  const researched: string[] = [];
  const labDir = join(settingsPath, "..", "lab");
  let hash = HASH;
  let restarted = 0;
  const started: Array<[string, unknown]> = [];
  const jobs = { start: (c: string, a: unknown) => started.push([c, a]), startCheck: (st: unknown) => started.push(["check", st]), stop: () => {}, status: () => null } as unknown as LabJobs;
  const admin = new Admin({
    settingsPath,
    env: opts.env ?? {},
    gate: new PasswordGate("x-owner-password", () => hash, "owner password"),
    mode: opts.mode ?? "dry",
    version: "test",
    checks: { ...okChecks, ...opts.checks },
    jobs,
    coachNow: null,
    graphStats: () => ({ skill: 3 }),
    playbook: () => null,
    onPasswordChanged: (h) => (hash = h),
    restart: () => restarted++,
    coins: () => ["BTC", "ETH", "SOL", "DOGE"],
    macroCoins: () => ({ commodities: ["XAU", "XAG", "CL"], stocks: ["NVDA", "SPY"] }),
    runningBees: () => opts.running ?? ["bee1", "bee2", "bee3"],
    isFlat: (id) => !(opts.holding ?? []).includes(id),
    forgetBee: (id) => forgotten.push(id),
    revive: (id) => {
      if (id === "bee2") throw new Error("This bee still holds a position; it must be flat before it can be revived.");
      revived.push(id);
    },
    council: async () => null,
    evolution: () => ({ board: [] }),
    registerSkill: (sk) => imported.push(sk.id),
    labDir,
    notes: new NoteBook(join(labDir, "notes.json")),
    ...(opts.skillAgent ? { skillAgent: opts.skillAgent } : {}),
    ...(opts.mcp ? { mcp: opts.mcp } : {}),
    research: { busy: () => [], blocked: (id: string) => (id === "bee2" ? "Claude has no key (Admin → API keys)" : null), research: async (id: string) => void researched.push(id) } as never,
    okxCheck: opts.okxCheck,
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
  return { admin, call, settingsPath, started, restarted: () => restarted, hash: () => hash, forgotten, revived, imported, labDir, researched };
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
    // Coins must be tradable right now.
    const badCoin = await h.call("/admin/bees", { bees: [bees[0], { ...bees[1], coins: ["NOPE"] }, bees[2]] });
    expect(badCoin.body.error).toMatch(/not a live Crypto X-Perp.*NOPE/);
    expect((await h.call("/admin/bees", { bees: [{ ...bees[0], name: "Bizzy" }, bees[1], bees[2]] })).body.error).toMatch(/official bunn/);
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
    expect((await h.call("/admin/check", { stages: ["rm -rf"] })).status).toBe(400);
    expect((await h.call("/admin/check", { stages: [] })).status).toBe(400);
    const ck = await h.call("/admin/check", { stages: ["skills", "report"] });
    expect(ck.status).toBe(200);
    expect(h.started.at(-1)).toEqual(["check", ["skills", "report"]]);
    const lab = (ck.body as { lab: { check: { stages: string[]; preflight: Array<{ id: string }>; verdicts: Array<{ stage: string }> } } }).lab.check;
    expect(lab.stages).toContain("gold");
    expect(lab.preflight.map((i) => i.id)).toContain("brains");
    expect(lab.verdicts.map((v) => v.stage)).toEqual(["skills", "scalper", "gold", "hive"]);
    expect(h.started).toEqual([["run", { synthetic: 2 }], ["check", ["skills", "report"]]]);
    expect((await h.call("/admin/coach")).status).toBe(409);
    await h.call("/admin/restart");
    await new Promise((r) => setTimeout(r, 600));
    expect(h.restarted()).toBe(1);
  });
});

describe("adding and removing bees", () => {
  const base = [
    { name: "Zippy", tagline: "", rules: "", coins: ["BTC"], style: "bizzy" },
    { name: "Calm", tagline: "", rules: "", coins: ["BTC", "ETH"], style: "breezy" },
    { name: "Wild", tagline: "", rules: "", coins: [], style: "boozy" },
  ];

  it("adds extra bees with fresh books and their own brain, up to nine", async () => {
    const h = harness();
    const r = await h.call("/admin/bees", { bees: [...base, { name: "Scout", tagline: "the new one", rules: "Trade SOL.", coins: ["SOL"], style: "boozy", brain: "claude", walletUsd: 500 }] });
    expect(r.status).toBe(200);
    expect(loadSettings(h.settingsPath)!.bees[3]).toMatchObject({ name: "Scout", coins: ["SOL"], brain: "claude", image: false });
    expect(h.forgotten).toEqual(["bee4"]);
    const listed = (r.body.bees as Array<{ slot: string; extra: boolean; running: boolean }>)[3]!;
    expect(listed).toMatchObject({ slot: "bee4", extra: true, running: false });
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...base[2], name: `B${i}`, walletUsd: 100 }));
    expect((await h.call("/admin/bees", { bees: ten })).status).toBe(400);
    expect((await h.call("/admin/bees", { bees: base.slice(0, 2) })).status).toBe(400);
  });

  it("removes only the last bees, and only while they are flat", async () => {
    const h = harness({ holding: ["bee4"] });
    await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 200 }] });
    const r = await h.call("/admin/bees", { bees: base });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/bee4 still holds a position/);
    const h2 = harness();
    await h2.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 200 }] });
    expect((await h2.call("/admin/bees", { bees: base })).status).toBe(200);
    expect(loadSettings(h2.settingsPath)!.bees).toHaveLength(3);
  });

  it("revives a dead bee, and explains when it cannot", async () => {
    const h = harness();
    expect((await h.call("/admin/revive", { bee: "bee3" })).status).toBe(200);
    expect(h.revived).toEqual(["bee3"]);
    expect((await h.call("/admin/revive", { bee: "bee2" })).body.error).toMatch(/must be flat/);
    expect((await h.call("/admin/revive", { bee: "../etc" })).status).toBe(400);
  });

  it("alpaca data keys: checked before saving, never shown, removable, and not changeable when the environment owns them", async () => {
    const h = harness();
    expect((await h.call("/admin/alpaca", { keyId: "x" })).status).toBe(400);
    expect((await h.call("/admin/alpaca", { keyId: "PKONLYKEYID123" })).status).toBe(400);
    const bad = await h.call("/admin/alpaca", { keyId: "PKbadbadbad123", secret: "s".repeat(40) });
    expect(bad).toMatchObject({ status: 400, body: { error: "Alpaca rejected that key pair." } });
    expect(loadSettings(h.settingsPath)!.alpacaKeyId).toBeUndefined();
    const ok = await h.call("/admin/alpaca", { keyId: "PKGOODKEY123456", secret: "secret-value-abcdef-0123456789" });
    expect(ok.status).toBe(200);
    expect((ok.body as { alpaca: unknown }).alpaca).toEqual({ set: true, source: "settings", feed: "iex", canEdit: true });
    expect(JSON.stringify(ok.body)).not.toContain("secret-value-abcdef");
    expect(JSON.stringify(ok.body)).not.toContain("PKGOODKEY123456");
    expect(loadSettings(h.settingsPath)).toMatchObject({ alpacaKeyId: "PKGOODKEY123456", alpacaSecret: "secret-value-abcdef-0123456789" });
    const pf = (ok.body as { lab: { check: { preflight: Array<{ id: string; ok: boolean }> } } }).lab.check.preflight;
    expect(pf.find((i) => i.id === "alpaca")!.ok).toBe(true);
    const gone = await h.call("/admin/alpaca", { remove: true });
    expect((gone.body as { alpaca: { set: boolean } }).alpaca.set).toBe(false);
    expect(loadSettings(h.settingsPath)!.alpacaSecret).toBeUndefined();
    const env = harness({ env: { ALPACA_API_KEY_ID: "PKENVKEY1234567", ALPACA_API_SECRET_KEY: "env-secret-1234567890", ALPACA_FEED: "sip" } });
    expect((await env.call("/admin/alpaca", { keyId: "PKGOODKEY123456", secret: "secret-value-abcdef" })).status).toBe(409);
    const st = (await env.call("/admin/state")).body as { alpaca: unknown };
    expect(st.alpaca).toEqual({ set: true, source: "env", feed: "sip", canEdit: true });
    expect((await h.call("/admin/lab", { command: "fetch", args: { source: "alpaca", symbols: "SPY,QQQ" } })).status).toBe(200);
    expect(h.started.at(-1)).toEqual(["fetch", { source: "alpaca", symbols: "SPY,QQQ" }]);
    expect((await h.call("/admin/check", { stages: ["stocks"] })).status).toBe(200);
  });

  it("custom brains: test, save, use, and no removal while a bee uses one; Z.ai has its own key", async () => {
    const h = harness({ checks: { compat: async (url: string) => (url.includes("down") ? "Could not reach My LLM." : null) } });
    const brain = { id: "my_llm", label: "My LLM", vendor: "Acme", baseUrl: "https://api.acme.example/v1", model: "acme-1", apiKey: "acme-secret-key-1234", jsonMode: "object" };
    expect((await h.call("/admin/brains/test", { baseUrl: "http://public.example/v1", model: "m" })).status).toBe(400);
    expect((await h.call("/admin/brains/test", { baseUrl: brain.baseUrl, model: brain.model, apiKey: brain.apiKey })).body).toMatchObject({ ok: true });
    expect((await h.call("/admin/brains/test", { baseUrl: "https://down.example/v1", model: "m" })).body).toMatchObject({ ok: false, error: expect.stringMatching(/reach/) });
    expect((await h.call("/admin/brains/save", { ...brain, id: "openai" })).status).toBe(400);
    expect((await h.call("/admin/brains/save", { ...brain, baseUrl: "http://public.example/v1" })).status).toBe(400);
    const down = await h.call("/admin/brains/save", { ...brain, baseUrl: "https://down.example/v1" });
    expect(down.status).toBe(400);
    expect(down.body.error).toMatch(/Not saved/);
    const saved = await h.call("/admin/brains/save", brain);
    expect(saved.status).toBe(200);
    const view = (saved.body as { brains: { custom: Array<Record<string, unknown>>; builtin: Array<{ id: string }> }; fields: Array<{ key: string; options?: string[] }> }).brains;
    expect(view.builtin.map((b) => b.id)).toEqual(["openai", "claude", "kimi", "zai"]);
    expect(view.custom[0]).toMatchObject({ id: "my_llm", label: "My LLM", model: "acme-1", keySet: true, usedBy: [] });
    expect(JSON.stringify(saved.body)).not.toContain("acme-secret-key-1234");
    expect((saved.body as { fields: Array<{ key: string; options?: string[] }> }).fields.find((f) => f.key === "BEE1_BRAIN")!.options).toContain("my_llm");
    // Editing without retyping the key keeps the saved one.
    expect((await h.call("/admin/brains/save", { ...brain, apiKey: undefined, model: "acme-2" })).status).toBe(200);
    expect(loadSettings(h.settingsPath)!.customBrains![0]).toMatchObject({ model: "acme-2", apiKey: "acme-secret-key-1234" });
    // It can be a bee's brain; a brain that does not exist cannot.
    expect((await h.call("/admin/settings", { values: { BEE1_BRAIN: "nope_llm" } })).status).toBe(400);
    expect((await h.call("/admin/settings", { values: { BEE1_BRAIN: "my_llm" } })).status).toBe(200);
    expect((await h.call("/admin/brains/delete", { id: "my_llm" })).body.error).toMatch(/in use by BEE1_BRAIN/);
    expect((await h.call("/admin/settings", { values: { BEE1_BRAIN: null } })).status).toBe(200);
    expect((await h.call("/admin/brains/delete", { id: "my_llm" })).status).toBe(200);
    expect((await h.call("/admin/brains/delete", { id: "my_llm" })).status).toBe(404);
    // Saving while the server is down, on purpose.
    expect((await h.call("/admin/brains/save", { ...brain, baseUrl: "https://down.example/v1", force: true })).status).toBe(200);
    // Z.ai is a built-in with its own key.
    const k = await h.call("/admin/keys", { keys: { zai: "zai-key-12345678" } });
    expect(k.status).toBe(200);
    expect((k.body as { keys: Record<string, { set: boolean }> }).keys.zai!.set).toBe(true);
    expect(loadSettings(h.settingsPath)!.zaiKey).toBe("zai-key-12345678");
  });

  it("connectors: save, discover, grant only what is confirmed read-only, and never show a token", async () => {
    let offered = [
      { name: "get_price", description: "Latest price", readOnly: true, inputSchema: { type: "object" } },
      { name: "send_alert", description: "Send a message", readOnly: false, inputSchema: {} },
      { name: "search_news", description: "Headlines", readOnly: null, inputSchema: {} },
      { name: "delete_thing", description: "Claims read-only, reads like an action", readOnly: true, inputSchema: {} },
    ];
    let fail = false;
    const mcp = { discover: async () => (fail ? Promise.reject(new Error("connection refused")) : offered), usedToday: () => ({ data: 3 }), recent: () => [] };
    const h = harness({ mcp: mcp as never });
    const server = { id: "data", label: "Data feed", url: "https://mcp.example.com/mcp", token: "tok-secret-987654321", authHeader: "X-Api-Key" };
    expect((await h.call("/admin/mcp/save", { ...server, url: "http://public.example/mcp" })).status).toBe(400);
    expect((await h.call("/admin/mcp/save", { ...server, id: "Bad Id" })).status).toBe(400);
    fail = true;
    const down = await h.call("/admin/mcp/save", server);
    expect(down.status).toBe(400);
    expect(down.body.error).toMatch(/Not saved/);
    fail = false;
    const saved = await h.call("/admin/mcp/save", server);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("tok-secret-987654321");
    const view = (saved.body as { lab: { mcp: { available: boolean; canEdit: boolean; servers: Array<{ id: string; tokenSet: boolean; usedToday: number; authHeader: string; tools: Array<{ name: string; needsConfirm: boolean; looksLikeAction: boolean }>; grants: unknown[] }> } } }).lab.mcp;
    expect(view).toMatchObject({ available: true, canEdit: true });
    expect(view.servers[0]).toMatchObject({ id: "data", tokenSet: true, usedToday: 3, authHeader: "X-Api-Key", grants: [] });
    expect(view.servers[0]!.tools.map((t) => [t.name, t.needsConfirm, t.looksLikeAction])).toEqual([["get_price", false, false], ["send_alert", true, true], ["search_news", true, false], ["delete_thing", true, true]]);
    expect(loadSettings(h.settingsPath)!.mcpServers![0]!.token).toBe("tok-secret-987654321");
    // Grants: a proven read-only tool goes through; the rest need the owner's confirmation; unknown and repeated tools are refused.
    const grant = (grants: unknown[]) => h.call("/admin/mcp/grant", { id: "data", grants });
    expect((await grant([{ tool: "get_price", bees: ["bee1"] }])).status).toBe(200);
    expect((await grant([{ tool: "send_alert", bees: ["all"] }])).body.error).toMatch(/does not say it is read-only/);
    expect((await grant([{ tool: "delete_thing", bees: ["all"] }])).body.error).toMatch(/reads like an action/);
    expect((await grant([{ tool: "nope", bees: ["all"] }])).status).toBe(400);
    expect((await grant([{ tool: "get_price", bees: ["bee1"] }, { tool: "get_price", bees: ["bee2"] }])).body.error).toMatch(/listed twice/);
    expect((await grant([{ tool: "get_price", bees: ["bee99"] }])).status).toBe(400);
    expect((await grant([{ tool: "get_price", bees: ["bee1", "bee1"] }, { tool: "search_news", bees: ["all"], confirmed: true }])).status).toBe(200);
    expect(loadSettings(h.settingsPath)!.mcpServers![0]!.grants).toEqual([{ tool: "get_price", bees: ["bee1"] }, { tool: "search_news", bees: ["all"], confirmed: true }]);
    // Editing without retyping the token keeps it and the grants; refreshing drops grants for tools that vanished.
    expect((await h.call("/admin/mcp/save", { id: "data", label: "Data feed 2", url: server.url, maxCallsDay: 10 })).status).toBe(200);
    expect(loadSettings(h.settingsPath)!.mcpServers![0]).toMatchObject({ label: "Data feed 2", token: "tok-secret-987654321", maxCallsDay: 10, transport: "http", authHeader: "X-Api-Key" });
    expect(loadSettings(h.settingsPath)!.mcpServers![0]!.grants).toHaveLength(2);
    offered = offered.filter((t) => t.name !== "search_news");
    expect((await h.call("/admin/mcp/discover", { id: "data" })).status).toBe(200);
    expect(loadSettings(h.settingsPath)!.mcpServers![0]!.grants).toEqual([{ tool: "get_price", bees: ["bee1"] }]);
    fail = true;
    expect((await h.call("/admin/mcp/discover", { id: "data" })).status).toBe(502);
    expect((await h.call("/admin/mcp/discover", { id: "nope_x" })).status).toBe(404);
    // Saving while it is down, on purpose, keeps what was known.
    expect((await h.call("/admin/mcp/save", { ...server, force: true })).status).toBe(200);
    expect((await h.call("/admin/mcp/delete", { id: "data" })).status).toBe(200);
    expect((await h.call("/admin/mcp/delete", { id: "data" })).status).toBe(404);
    expect(loadSettings(h.settingsPath)!.mcpServers).toEqual([]);
  });

  it("skill agent: drafts a skill from a prompt into the workshop, never publishing it", async () => {
    const good = JSON.stringify({ id: "ai_dip", name: "AI dip", family: "mean_reversion", long: { entry: [{ left: "rsi(14)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } });
    let reply = good;
    const asked: unknown[] = [];
    const agent = {
      available: () => [{ id: "claude", label: "Claude" }],
      draft: async (a: unknown) => (asked.push(a), { brain: "claude", brainLabel: "Claude", model: "m", json: reply, explanation: "An idea.", valid: JSON.parse(reply).id !== "broken", errors: JSON.parse(reply).id === "broken" ? ["boom"] : [], attempts: 1 }),
    };
    const h = harness({ skillAgent: agent as never });
    expect((await h.call("/admin/workspace/ai", { prompt: "x" })).status).toBe(400);
    expect((await h.call("/admin/workspace/ai", { prompt: "Buy oversold dips with RSI", key: "nope_x" })).status).toBe(404);
    const r = await h.call("/admin/workspace/ai", { prompt: "Buy oversold dips with RSI", brain: "claude" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, brain: "claude", explanation: "An idea." });
    const st = (r.body as { state: { lab: { workshop: { drafts: Array<{ key: string; author: string; status: string }>; agent: Array<{ id: string }> } } } }).state.lab.workshop;
    expect(st.agent).toEqual([{ id: "claude", label: "Claude" }]);
    expect(st.drafts[0]).toMatchObject({ key: "ai_dip", author: "ai:claude", status: "draft" });
    expect(h.imported).toEqual([]);
    // Revising keeps the same draft even if the brain renames it.
    reply = good.replace('"ai_dip"', '"renamed"');
    const rev = await h.call("/admin/workspace/ai", { prompt: "Make the entry stricter", key: "ai_dip" });
    expect(JSON.parse(rev.body.json as string).id).toBe("ai_dip");
    expect((rev.body.draft as { key: string; versions: unknown[] }).versions).toHaveLength(2);
    expect((asked[1] as { current?: string }).current).toContain('"ai_dip"');
    // A draft that does not compile is returned for editing, not saved.
    reply = JSON.stringify({ id: "broken" });
    const bad = await h.call("/admin/workspace/ai", { prompt: "Something that will not compile" });
    expect(bad.body).toMatchObject({ ok: false, valid: false, errors: ["boom"] });
    expect(((await h.call("/admin/workspace/get", { key: "broken" })).status)).toBe(404);
  });

  it("skill workshop: save, read, backtest, publish, discard", async () => {
    const h = harness();
    const json = JSON.stringify({ id: "wk_dip", name: "Workshop dip", family: "mean_reversion", long: { entry: [{ left: "rsi(14)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } });
    expect((await h.call("/admin/workspace/check", { json: "{nope" })).body).toMatchObject({ ok: false });
    expect((await h.call("/admin/workspace/check", { json })).body).toMatchObject({ ok: true, id: "wk_dip" });
    expect((await h.call("/admin/workspace/save", { json: "{nope" })).status).toBe(400);
    expect((await h.call("/admin/workspace/save", { key: "../x", json })).status).toBe(400);
    const saved = await h.call("/admin/workspace/save", { json, note: "first" });
    expect(saved.status).toBe(200);
    const lab = (saved.body as { state: { lab: { workshop: { drafts: Array<{ key: string }>; templates: unknown[] } } } }).state.lab.workshop;
    expect(lab.drafts.map((d) => d.key)).toEqual(["wk_dip"]);
    expect(lab.templates.length).toBeGreaterThan(0);
    expect(((await h.call("/admin/workspace/get", { key: "wk_dip" })).body.draft as { versions: unknown[] }).versions).toHaveLength(1);
    expect((await h.call("/admin/workspace/get", { key: "nope_x" })).status).toBe(404);
    // No real history in the harness: the backtest is synthetic, so publishing is refused until forced.
    const bt = await h.call("/admin/workspace/backtest", { key: "wk_dip" });
    expect(bt.status).toBe(200);
    expect((bt.body.draft as { versions: Array<{ backtest: { data: string } }> }).versions[0]!.backtest.data).toBe("synthetic");
    expect((await h.call("/admin/workspace/publish", { key: "wk_dip" })).body.error).toMatch(/synthetic/);
    expect(h.imported).toEqual([]);
    expect((await h.call("/admin/workspace/publish", { key: "wk_dip", force: true })).status).toBe(200);
    expect(h.imported).toEqual(["wk_dip"]);
    expect(existsSync(join(h.labDir, "learned", "owner_wk_dip.json"))).toBe(true);
    expect((await h.call("/admin/workspace/discard", { key: "wk_dip" })).status).toBe(200);
    expect((await h.call("/admin/workspace/discard", { key: "wk_dip_none" })).status).toBe(404);
  });

  it("research notes: owner background, review, delete, and asking a brain to research", async () => {
    const h = harness();
    expect((await h.call("/admin/notes/add", { bee: "nope", title: "x", text: "some text here" })).status).toBe(400);
    expect((await h.call("/admin/notes/add", { bee: "bee1", title: "", text: "some text here" })).status).toBe(400);
    const added = await h.call("/admin/notes/add", { bee: "bee1", title: "Study gold", text: "Watch how gold reacts to real yields.", coins: ["xau"] });
    expect(added.status).toBe(200);
    const st = (added.body as { lab: { notes: { available: boolean; notes: Array<{ id: string; status: string; kind: string; coins: string[] }>; blocked: Record<string, string | null> } } }).lab.notes;
    expect(st.available).toBe(true);
    expect(st.notes[0]).toMatchObject({ status: "approved", kind: "background", coins: ["XAU"] });
    expect(st.blocked).toMatchObject({ bee1: null, bee2: expect.stringMatching(/no key/) });
    const id = st.notes[0]!.id;
    expect((await h.call("/admin/notes/decide", { id, decision: "maybe" })).status).toBe(400);
    expect((await h.call("/admin/notes/decide", { id: "0123456789", decision: "approve" })).status).toBe(409);
    const rej = await h.call("/admin/notes/decide", { id, decision: "reject" });
    expect((rej.body as { lab: { notes: { notes: unknown[] } } }).lab.notes.notes).toHaveLength(0);
    expect((await h.call("/admin/notes/delete", { id })).status).toBe(200);
    expect((await h.call("/admin/notes/delete", { id })).status).toBe(404);
    expect((await h.call("/admin/research", { bee: "bee2" })).body.error).toMatch(/no key/);
    expect((await h.call("/admin/research", { bee: "../x" })).status).toBe(400);
    expect(((await h.call("/admin/research", { bee: "bee1" })).body as { lab?: unknown }).lab).toBeDefined();
    expect(h.researched).toEqual(["bee1"]);
  });

  it("imports a skill: compiled, backtested, saved and made live", async () => {
    const h = harness();
    const skill = { id: "owner_dip", name: "Owner dip", family: "mean_reversion", long: { entry: [{ left: "rsi(14)", op: "<", right: 30 }], exit: [{ left: "rsi(14)", op: ">", right: 55 }] } };
    const r = await h.call("/admin/skills/import", { json: JSON.stringify(skill) });
    expect(r.status).toBe(200);
    expect(r.body.backtest).toHaveProperty("score");
    expect(h.imported).toEqual(["owner_dip"]);
    expect(existsSync(join(h.labDir, "learned", "owner_owner_dip.json"))).toBe(true);
    expect((await h.call("/admin/skills/import", { json: "{nope" })).body.error).toMatch(/not valid JSON/);
    expect((await h.call("/admin/skills/import", { json: JSON.stringify({ ...skill, long: { entry: [{ left: "magic(1)", op: ">", right: 1 }], exit: skill.long.exit } }) })).body.error).toMatch(/unknown indicator/);
  });
});

describe("lab jobs", () => {
  it("builds CLI arguments only from checked fields", () => {
    expect(labArgv("run", { synthetic: 3, folds: 4, leverage: 1.5, longOnly: true })).toEqual(["run", "--bar", "1H", "--folds", "4", "--leverage", "1.5", "--synthetic", "3", "--long-only"]);
    expect(labArgv("fetch", { source: "ccxt", exchange: "binance", symbols: "BTC/USDT,ETH/USDT", days: 90 })).toEqual(["fetch", "--bar", "1H", "--days", "90", "--exchange", "binance", "--symbol", "BTC/USDT,ETH/USDT"]);
    expect(labArgv("council", {})).toEqual(["council"]);
    expect(labArgv("fetch", { source: "alpaca", symbols: "SPY,QQQ,BTC/USD", days: 200 })).toEqual(["fetch", "--bar", "1H", "--days", "200", "--source", "alpaca", "--symbol", "SPY,QQQ,BTC/USD"]);
    expect(labArgv("fetch", { source: "alpaca" })).toEqual(["fetch", "--bar", "1H", "--days", "365", "--source", "alpaca"]);
    expect(() => labArgv("fetch", { source: "alpaca", symbols: "SPY --feed sip" })).toThrow(/symbols/);
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
    await new Promise((r) => setImmediate(r));
    expect(j).toMatchObject({ state: "done", exitCode: 0 });
    expect(j.log).toEqual(["line one", "key [redacted]"]);
    expect(done).toBe(1);
  });
});

describe("the macro squad in the admin panel", () => {
  const base = [
    { name: "Zippy", tagline: "", rules: "", coins: ["BTC"], style: "bizzy" },
    { name: "Calm", tagline: "", rules: "", coins: ["BTC", "ETH"], style: "breezy" },
    { name: "Wild", tagline: "", rules: "", coins: [], style: "boozy" },
  ];
  it("adds gold, energy and stock bees whose coins are checked against their own market", async () => {
    const h = harness();
    const squad = [
      { name: "Goldie", tagline: "", rules: "", coins: ["XAU", "XAG"], style: "breezy", market: "commodities", walletUsd: 1000 },
      { name: "Oily", tagline: "", rules: "", coins: ["CL"], style: "boozy", market: "commodities", walletUsd: 1000 },
      { name: "Stonks", tagline: "", rules: "", coins: [], style: "boozy", market: "stocks", walletUsd: 1000 },
    ];
    const r = await h.call("/admin/bees", { bees: [...base, ...squad] });
    expect(r.status).toBe(200);
    const s = loadSettings(h.settingsPath)!;
    expect(s.bees.slice(3).map((b) => [b.name, b.market, b.style])).toEqual([
      ["Goldie", "commodities", "boozy"],
      ["Oily", "commodities", "boozy"],
      ["Stonks", "stocks", "boozy"],
    ]);
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20) }, s);
    expect(cfg.slots.bee4).toMatchObject({ market: "commodities", squad: "macro" });
    expect(cfg.slots.bee1).toMatchObject({ market: "crypto", squad: "crypto" });
    expect((r.body.bees as Array<{ market: string }>).map((b) => b.market)).toEqual(["crypto", "crypto", "crypto", "commodities", "commodities", "stocks"]);
    expect(r.body.macroCoins).toEqual({ commodities: ["XAU", "XAG", "CL"], stocks: ["NVDA", "SPY"] });

    // A stock on a commodities bee, gold on a crypto bee, or a stock on a main bee: refused.
    const wrong = await h.call("/admin/bees", { bees: [...base, { ...squad[0]!, coins: ["NVDA"] }] });
    expect(wrong.body.error).toMatch(/Goldie: not a live Commodities X-Perp.*NVDA/);
    expect((await h.call("/admin/bees", { bees: [...base, { ...squad[0]!, market: "crypto" }] })).body.error).toMatch(/not a live Crypto/);
    expect((await h.call("/admin/bees", { bees: [{ ...base[0]!, coins: ["XAU"], market: "commodities" }, base[1], base[2]] })).body.error).toMatch(/Zippy: not a live Crypto/);
    // Back to crypto: the market field goes away.
    await h.call("/admin/bees", { bees: [...base, { ...squad[2]!, market: "crypto" }] });
    expect(loadSettings(h.settingsPath)!.bees[3]!.market).toBeUndefined();
  });
});


describe("a new bee's wallet and exchange account", () => {
  const base = [
    { name: "Zippy", tagline: "", rules: "", coins: ["BTC"], style: "bizzy" },
    { name: "Calm", tagline: "", rules: "", coins: ["BTC", "ETH"], style: "breezy" },
    { name: "Wild", tagline: "", rules: "", coins: [], style: "boozy" },
  ];
  const keys = { kind: "demo" as const, apiKey: "demo-key-123456", secretKey: "demo-secret-123456", passphrase: "pass" };
  const facts = (usdc: number, wallet: number, uid = "u-a") => ({
    ok: true,
    kind: "demo" as const,
    perms: ["read_only", "trade"],
    canTrade: true,
    canWithdraw: false,
    subAccount: true,
    ipBound: false,
    usdcUsd: usdc,
    uidHash: `h-${uid}`,
    problems: usdc >= wallet ? [] : [`The account holds $${usdc.toFixed(2)} USDC, less than the bee's $${wallet.toFixed(2)} wallet. Fund the sub-account first.`],
    warnings: [],
  });

  it("paper trading: a new bee needs its wallet, and starts with it instead of the default", async () => {
    const h = harness();
    const no = await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout" }] });
    expect(no.status).toBe(400);
    expect(no.body.error).toMatch(/set its wallet/);
    const r = await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 750 }] });
    expect(r.status).toBe(200);
    expect((r.body.bees as Array<{ walletUsd: number }>).map((b) => b.walletUsd)).toEqual([333, 333, 333, 750]);
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k".repeat(20) }, loadSettings(h.settingsPath));
    expect(cfg.slots.bee4.startEquityUsd).toBe(750);
    expect(cfg.slots.bee1.startEquityUsd).toBe(333);
    // The main three share the start equity (the Hive compares them).
    expect((await h.call("/admin/bees", { bees: [{ ...base[0], walletUsd: 900 }, base[1], base[2]] })).body.error).toMatch(/share the start equity/);
  });

  it("the wallet is fixed once the bee trades", async () => {
    const h = harness();
    const settings = loadSettings(h.settingsPath)!;
    saveSettings(h.settingsPath, { ...settings, bees: [...settings.bees, { ...settings.bees[2]!, name: "Old", walletUsd: 400 }] });
    // Created but not started yet: still editable.
    expect((await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Old", walletUsd: 450 }] })).status).toBe(200);
    const live = harness({ running: ["bee1", "bee2", "bee3", "bee4"] });
    const s2 = loadSettings(live.settingsPath)!;
    saveSettings(live.settingsPath, { ...s2, bees: [...s2.bees, { ...s2.bees[2]!, name: "Old", walletUsd: 400 }] });
    const r = await live.call("/admin/bees", { bees: [...base, { ...base[2], name: "Old", walletUsd: 450 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/keeps \$400/);
    expect((await live.call("/admin/bees", { bees: [...base, { ...base[2], name: "Old", walletUsd: 400 }] })).status).toBe(200);
  });

  it("demo: a bee is created only on keys that pass the check, with enough USDC; keys never come back", async () => {
    let calls = 0;
    const h = harness({ mode: "demo", okxCheck: async (_c, _k, wallet) => (calls++, facts(calls === 1 ? 200 : 1200, wallet)) });
    const missing = await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 1000 }] });
    expect(missing.body.error).toMatch(/connect its OKX demo sub-account/);
    const poor = await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 1000, exchange: keys }] });
    expect(poor.status).toBe(400);
    expect(poor.body.error).toMatch(/holds \$200\.00 USDC, less than the bee's \$1000\.00 wallet/);
    expect(loadSettings(h.settingsPath)!.bees).toHaveLength(3);
    const ok = await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "Scout", walletUsd: 1000, exchange: keys }] });
    expect(ok.status).toBe(200);
    const saved = loadSettings(h.settingsPath)!.bees[3]!;
    expect(saved.walletUsd).toBe(1000);
    expect(saved.okx?.demo).toMatchObject({ apiKey: keys.apiKey, balanceUsd: 1200, uidHash: "h-u-a" });
    expect(JSON.stringify(ok.body)).not.toContain(keys.apiKey);
    expect(JSON.stringify(ok.body)).not.toContain(keys.secretKey);
    expect((ok.body.bees as Array<{ exchange: { demo: unknown } }>)[3]!.exchange.demo).toMatchObject({ set: true, source: "settings", balanceUsd: 1200 });
    // The engine trades bee4 with the saved keys.
    const cfg = loadConfig(
      {
        TYPESAFE_API_KEY: "k".repeat(20),
        DRY_RUN: "false",
        MODE: "demo",
        ...Object.fromEntries(["BEE1", "BEE2", "BEE3"].flatMap((b) => [[`${b}_OKX_DEMO_API_KEY`, "x"], [`${b}_OKX_DEMO_API_SECRET`, "x"], [`${b}_OKX_DEMO_API_PASSPHRASE`, "x"]])),
      },
      loadSettings(h.settingsPath),
    );
    expect(cfg.beeIds).toContain("bee4");
    expect(cfg.creds.bee4).toEqual({ apiKey: keys.apiKey, secretKey: keys.secretKey, passphrase: keys.passphrase });
  });

  it("refuses a second bee on the same OKX account, and keys the environment already sets", async () => {
    const h = harness({ mode: "demo", okxCheck: async (_c, _k, wallet) => facts(5000, wallet) });
    expect((await h.call("/admin/bees", { bees: [...base, { ...base[2], name: "One", walletUsd: 500, exchange: keys }] })).status).toBe(200);
    const two = await h.call("/admin/bees", {
      bees: [...base, { ...base[2], name: "One" }, { ...base[2], name: "Two", walletUsd: 500, exchange: { ...keys, apiKey: "other-key-123456" } }],
    });
    expect(two.status).toBe(400);
    expect(two.body.error).toMatch(/same OKX account as One/);
    const env = harness({ mode: "demo", env: { BEE4_OKX_DEMO_API_KEY: "from-env" }, okxCheck: async (_c, _k, wallet) => facts(5000, wallet) });
    const r = await env.call("/admin/bees", { bees: [...base, { ...base[2], name: "Env", walletUsd: 500, exchange: keys }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/set in the environment/);
  });

  it("checks keys without saving anything", async () => {
    const h = harness({ okxCheck: async (_c, _k, wallet) => facts(300, wallet) });
    const r = await h.call("/admin/exchange/check", { ...keys, walletUsd: 500 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ready: false, usdcUsd: 300 });
    expect(r.body.uidHash).toBeUndefined();
    expect((await h.call("/admin/exchange/check", { ...keys, walletUsd: 5 })).status).toBe(400);
    expect(loadSettings(h.settingsPath)!.bees[0]!.okx).toBeUndefined();
    expect((await harness().call("/admin/exchange/check", { ...keys, walletUsd: 500 })).status).toBe(503);
  });
});
