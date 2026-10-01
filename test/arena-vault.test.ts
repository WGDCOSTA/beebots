import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Bots } from "../src/arena/bots.js";
import { LlmSystemOne } from "../src/arena/decider.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaRunner } from "../src/arena/runner.js";
import { ArenaStore } from "../src/arena/store.js";
import { MAX_KEYS, Vault, type Verifier } from "../src/arena/vault.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, trend, view } from "./fixtures.js";

const MASTER = randomBytes(32).toString("hex");
const SECRET = "sk-test-0123456789abcdef-WXYZ";
const input = (name: string, extra: Record<string, unknown> = {}) => ({ name, theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast.", ...extra });

const okVerifier: Verifier = async () => {};
function fakeBrain(label: string): LlmClient & { asked: number } {
  return {
    brain: "openai",
    model: label,
    asked: 0,
    async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
      this.asked++;
      const labels = Object.keys((JSON.parse(ask.user) as { menu: Record<string, unknown> }).menu);
      return { data: ask.validate.parse({ choice: labels.find((l) => l.startsWith("LONG")) ?? labels[0], confidence: 0.9, conviction: 3 }), brain: "openai", model: label, inputTokens: 500, outputTokens: 20, latencyMs: 1 };
    },
  };
}

class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function http(api: ArenaApi, method: string, path: string, body?: unknown, cookie?: string) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1", ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path.split("?")[0]!);
  return { status, body: JSON.parse(text || "{}") as Json };
}

const market = view([{ ...coin("BTC", { ret24hPct: 3 }, 100_000), trend: trend({ score: 8, longOn: 8 }) }, coin("ETH", {}, 4000)]);
const fakeFeed = () => ({ view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW, candles1h: () => [], candles1m: () => [] }) as unknown as MarketFeed;
const live: ArenaRunner[] = [];
afterEach(() => void live.splice(0).forEach((r) => r.stopAll()));

async function setup(opts: { master?: string | null; verify?: Verifier; tier?: "free" | "pro" } = {}) {
  const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-vault-")));
  const own = fakeBrain("own-model");
  const platform = fakeBrain("platform-model");
  const vault = new Vault(opts.master === undefined ? MASTER : opts.master, opts.verify ?? okVerifier, () => own);
  const inbox = new Inbox();
  const auth = new ArenaAuth(store, inbox, { baseUrl: "https://x.test" });
  const clock = { t: NOW };
  const runner = new ArenaRunner({ store, root: mkdtempSync(join(tmpdir(), "arena-vault-run-")), feed: fakeFeed(), decider: new LlmSystemOne(platform), now: () => clock.t, tickMs: 1000, vault, dailyUsd: 0.5 });
  live.push(runner);
  const api = new ArenaApi(auth, store, { secureCookie: true, vault, runner, now: () => clock.t });
  await auth.requestLink("ana@example.com", "1.1.1.1");
  const v = auth.verify(inbox.sent.at(-1)!.match(/token=([\w-]+)/)![1])!;
  store.acceptConsent(v.user.id, 1);
  if (opts.tier === "pro") store.setTier(v.user.id, "pro");
  return { store, vault, own, platform, api, runner, clock, uid: v.user.id, cookie: `arena_session=${v.session}`, keys: () => vault.for(store.tenant(v.user.id), v.user.id, () => NOW), bots: () => new Bots(store.tenant(v.user.id), opts.tier ?? "free", () => NOW) };
}

describe("the vault", () => {
  it("is closed without a good master key", () => {
    expect(new Vault(null).open).toBe(false);
    expect(new Vault("tooshort").open).toBe(false);
    expect(new Vault(MASTER).open).toBe(true);
    expect(new Vault(randomBytes(32).toString("base64")).open).toBe(true);
  });
  it("stores a key encrypted, shows only its last four, and gives the secret back to the runner alone", async () => {
    const w = await setup();
    const k = await w.keys().add({ provider: "openai", label: "My OpenAI", secret: SECRET });
    expect(k).toMatchObject({ provider: "openai", label: "My OpenAI", last4: "WXYZ", model: "gpt-5.4-nano", dailyUsd: null });
    expect(JSON.stringify(k)).not.toContain(SECRET);
    expect(JSON.stringify(w.keys().list())).not.toContain(SECRET);
    const raw = JSON.stringify(w.store.tenant(w.uid).prepare("SELECT * FROM member_keys").all());
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("0123456789abcdef");
    expect(w.keys().secret(k.id)).toMatchObject({ secret: SECRET, provider: "openai" });
  });
  it("binds the ciphertext to the member and the key, and to the master key", async () => {
    const w = await setup();
    const a = await w.keys().add({ provider: "openai", label: "A", secret: SECRET });
    const b = await w.keys().add({ provider: "zai", label: "B", secret: "zai-secret-0123456789" });
    const db = w.store.tenant(w.uid);
    const sealedA = (db.prepare("SELECT sealed FROM member_keys WHERE id = ?").get(a.id) as { sealed: string }).sealed;
    db.prepare("UPDATE member_keys SET sealed = ? WHERE id = ?").run(sealedA, b.id); // moved to another row
    expect(w.keys().secret(b.id)).toBeNull();
    expect(w.keys().secret(a.id)?.secret).toBe(SECRET);
    db.prepare("UPDATE member_keys SET sealed = ? WHERE id = ?").run(sealedA.slice(0, -4) + "AAAA", a.id); // tampered
    expect(w.keys().secret(a.id)).toBeNull();
    const other = new Vault(randomBytes(32).toString("hex"), okVerifier);
    expect(other.for(db, w.uid).secret(b.id)).toBeNull(); // another master key
  });
  it("checks what is typed, calls the provider once, and never repeats the provider's answer", async () => {
    const w = await setup({ verify: async () => { throw new Error(`bad key ${SECRET}`); } });
    await expect(w.keys().add({ provider: "openai", label: "x", secret: SECRET })).rejects.toThrow(/did not accept/);
    await expect(w.keys().add({ provider: "openai", label: "x", secret: SECRET })).rejects.not.toThrow(new RegExp(SECRET));
    const ok = await setup();
    for (const bad of [{ provider: "nope" }, { secret: "short" }, { secret: "has a space inside it" }, { label: "  " }, { model: "bad model!" }, { dailyUsd: 0 }, { dailyUsd: "x" }]) {
      await expect(ok.keys().add({ provider: "openai", label: "ok", secret: SECRET, ...bad })).rejects.toThrow();
    }
    expect(ok.keys().list()).toHaveLength(0);
    const closed = await setup({ master: null });
    await expect(closed.keys().add({ provider: "openai", label: "ok", secret: SECRET })).rejects.toThrow(/not open/);
  });
  it("keeps up to five keys", async () => {
    const w = await setup();
    for (let i = 0; i < MAX_KEYS; i++) await w.keys().add({ provider: "openai", label: `k${i}`, secret: SECRET + i });
    await expect(w.keys().add({ provider: "openai", label: "six", secret: SECRET })).rejects.toThrow(/up to 5/);
  });
});

describe("HTTP: keys", () => {
  it("lists, adds and removes, never sending a secret back", async () => {
    const w = await setup();
    const add = await http(w.api, "POST", "/arena/keys/add", { provider: "openai", label: "Mine", secret: SECRET, dailyUsd: 2 }, w.cookie);
    expect(add.status).toBe(200);
    expect(JSON.stringify(add.body)).not.toContain(SECRET);
    const list = await http(w.api, "GET", "/arena/keys", undefined, w.cookie);
    expect(list.body).toMatchObject({ open: true, max: 5 });
    expect(list.body.keys).toHaveLength(1);
    expect(list.body.keys[0]).toMatchObject({ last4: "WXYZ", dailyUsd: 2 });
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect((await http(w.api, "POST", "/arena/keys/delete", { id: add.body.key.id }, w.cookie)).status).toBe(200);
    expect((await http(w.api, "POST", "/arena/keys/delete", { id: add.body.key.id }, w.cookie)).status).toBe(404);
  });
  it("is closed without a master key, needs a session, and is rate limited", async () => {
    const closed = await setup({ master: null });
    expect((await http(closed.api, "GET", "/arena/keys", undefined, closed.cookie)).body.open).toBe(false);
    expect((await http(closed.api, "POST", "/arena/keys/add", { provider: "openai", label: "x", secret: SECRET }, closed.cookie)).status).toBe(503);
    const w = await setup();
    expect((await http(w.api, "GET", "/arena/keys")).status).toBe(401);
    expect((await http(w.api, "POST", "/arena/keys/add", {})).status).toBe(401);
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await http(w.api, "POST", "/arena/keys/add", { provider: "nope" }, w.cookie)).status;
    expect(last).toBe(429);
  });
  it("sets an agent to a key only if the key is the member's, and a change of model starts a new record", async () => {
    const w = await setup({ tier: "pro" });
    const k = (await http(w.api, "POST", "/arena/keys/add", { provider: "openai", label: "Mine", secret: SECRET }, w.cookie)).body.key;
    expect((await http(w.api, "POST", "/arena/bots/create", input("Evil", { brainKey: "abcdef123456" }), w.cookie)).status).toBe(400);
    const made = await http(w.api, "POST", "/arena/bots/create", input("Mine", { brainKey: k.id }), w.cookie);
    expect(made.status).toBe(200);
    const id = made.body.bot.id;
    expect(made.body.bot).toMatchObject({ brainKey: k.id, version: 1 });
    // saving the form without naming a key keeps it; no new version
    const same = await http(w.api, "POST", "/arena/bots/update", { ...input("Mine"), id }, w.cookie);
    expect(same.body.bot).toMatchObject({ brainKey: k.id, version: 1 });
    // back to the platform's model is a new version
    const back = await http(w.api, "POST", "/arena/bots/update", { ...input("Mine", { brainKey: null }), id }, w.cookie);
    expect(back.body.bot).toMatchObject({ brainKey: null, version: 2 });
    // a key an agent uses cannot be removed
    await http(w.api, "POST", "/arena/bots/update", { ...input("Mine", { brainKey: k.id }), id }, w.cookie);
    const del = await http(w.api, "POST", "/arena/keys/delete", { id: k.id }, w.cookie);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain("Mine");
  });
});

describe("the runner and a member's key", () => {
  it("thinks with the member's model and never the platform's", async () => {
    const w = await setup();
    const k = await w.keys().add({ provider: "openai", label: "Mine", secret: SECRET, dailyUsd: 3 });
    const b = w.bots().create(input("Mine", { brainKey: k.id }));
    await w.runner.update(w.uid);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.own.asked).toBeGreaterThan(0);
    expect(w.platform.asked).toBe(0);
    expect(w.runner.status(w.uid, [b.id])[b.id]).toMatchObject({ state: "running", position: { coin: "BTC" } });
  });
  it("still uses the platform's model, with its small ceiling, for an agent without a key", async () => {
    const w = await setup();
    const b = w.bots().create(input("Plain"));
    await w.runner.update(w.uid);
    await w.runner.engineOf(b.id)!.tick();
    expect(w.platform.asked).toBeGreaterThan(0);
    expect(w.own.asked).toBe(0);
  });
  it("does not start, and never falls back to the platform's model, when its key is gone", async () => {
    const w = await setup();
    const k = await w.keys().add({ provider: "openai", label: "Mine", secret: SECRET });
    const b = w.bots().create(input("Mine", { brainKey: k.id }));
    w.keys().remove(k.id);
    await w.runner.update(w.uid);
    expect(w.runner.running).toBe(0);
    expect(w.runner.status(w.uid, [b.id])[b.id]!.state).toBe("error");
    expect(w.platform.asked).toBe(0);
  });
  it("does not start when the vault is closed", async () => {
    const w = await setup();
    const k = await w.keys().add({ provider: "openai", label: "Mine", secret: SECRET });
    const b = w.bots().create(input("Mine", { brainKey: k.id }));
    const closed = new ArenaRunner({ store: w.store, root: mkdtempSync(join(tmpdir(), "arena-vault-run-")), feed: fakeFeed(), decider: new LlmSystemOne(w.platform), now: () => NOW, tickMs: 1000, vault: new Vault(null) });
    live.push(closed);
    await closed.update(w.uid);
    expect(closed.running).toBe(0);
    expect(closed.status(w.uid, [b.id])[b.id]!.state).toBe("error");
  });
});
