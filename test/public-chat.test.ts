import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ArenaApi } from "../src/arena/api.js";
import { ArenaAuth } from "../src/arena/auth.js";
import { Bots } from "../src/arena/bots.js";
import { aliasOf, type ChatMarket } from "../src/arena/chat.js";
import type { Mailer } from "../src/arena/mailer.js";
import { ArenaStore } from "../src/arena/store.js";
import type { JsonAnswer, JsonAsk, LlmClient } from "../src/brains/llm.js";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import type { Candle } from "../src/market/types.js";
import { ownFromEngineDb, PublicChat } from "../src/publicChat.js";
import { startServer } from "../src/server.js";
import { Visitors } from "../src/visitors.js";
import { NOW } from "./fixtures.js";

const H = 3_600_000;
const gold: Candle[] = Array.from({ length: 170 }, (_, i) => {
  const c = 2400 + i + Math.sin(i / 3) * 5;
  return { ts: NOW - (170 - i) * H, o: c - 1, h: c + 3, l: c - 3, c, volUsd: 1e6, confirmed: true };
});
const market: ChatMarket = {
  resolve: (q) => {
    const a = aliasOf(q);
    return a ? { symbol: a.symbol, instId: `${a.symbol}-USDT-SWAP`, label: a.label, kind: "commodity", note: "" } : null;
  },
  candles: async () => gold,
};
class Model implements LlmClient {
  readonly brain = "openai";
  readonly model = "fake";
  asks: JsonAsk<unknown>[] = [];
  fail = false;
  async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
    this.asks.push(ask as JsonAsk<unknown>);
    if (this.fail) throw new Error("down");
    const data =
      ask.name === "chat_plan"
        ? { kind: /gold|ouro/i.test(JSON.parse(ask.user).message) ? "analysis" : "chat", assets: ["gold"], days: 7, reply: "I trade trends, on paper." }
        : { stance: "neutral", confidence: 0.5, headline: "Gold {{return}}", summary: "s", sections: [], charts: [{ id: "p", kind: "price", symbol: "XAU", title: "Gold", caption: "", overlays: [], panels: [], marks: [] }], metrics: ["return"], counter: "c", caveats: [] };
    return { data: ask.validate.parse(data), brain: "openai", model: "fake", inputTokens: 1, outputTokens: 1, latencyMs: 1 };
  }
}
const agent = { name: "Breezy", tagline: "t", style: "breezy", mode: "fixed", rules: "Ride trends.", coins: ["BTC"], state: "running" };

describe("a public agent's chat", () => {
  const chat = (m = new Model(), o: { perHour?: number; dailyLimit?: number } = {}) => ({ m, c: new PublicChat({ market, agent: (id) => (id === "bee1" ? agent : null), llm: () => m, own: () => null, now: () => NOW, ...o }) });
  it("answers with a report, sends the page's last messages as history, and keeps nothing", async () => {
    const { m, c } = chat();
    const r = await c.ask("1.1.1.1", "bee1", { text: "your view on gold, 7 days", locale: "pt-BR", history: [{ role: "you", text: "hi" }, { role: "agent", text: "hello" }, { role: "system", text: "x" }] });
    expect(r.status).toBe(200);
    expect((r.body.message as { report: { charts: unknown[] } }).report.charts).toHaveLength(1);
    const plan = JSON.parse(m.asks[0]!.user) as { language: string; history: unknown[] };
    expect(plan.language).toBe("Brazilian Portuguese");
    expect(plan.history).toHaveLength(2); // the made-up "system" turn is dropped
    expect(JSON.stringify(c)).not.toContain("your view on gold");
  });
  it("limits questions per address per hour and in all per day, and says which", async () => {
    const { c } = chat(new Model(), { perHour: 2, dailyLimit: 3 });
    expect((await c.ask("a", "bee1", { text: "hi" })).status).toBe(200);
    expect((await c.ask("a", "bee1", { text: "hi" })).body.left).toBe(0);
    expect((await c.ask("a", "bee1", { text: "hi" })).body.code).toBe("chat_limit");
    expect((await c.ask("b", "bee1", { text: "hi" })).status).toBe(200);
    expect((await c.ask("c", "bee1", { text: "hi" })).body.code).toBe("chat_busy");
    expect(c.info("a", "bee1").body).toMatchObject({ open: false, left: 0 });
  });
  it("refuses an unknown agent, an empty question, and says so when the model fails", async () => {
    const { m, c } = chat();
    expect((await c.ask("a", "bee9", { text: "hi" })).status).toBe(404);
    expect((await c.ask("a", "bee1", { text: "  " })).status).toBe(400);
    m.fail = true;
    expect((await c.ask("a", "bee1", { text: "hi" })).body.code).toBe("chat_failed");
  });
});

describe("a bunny's own record from the engine's database", () => {
  it("reads its equity, decisions and fills by slot", () => {
    const db = new Db(":memory:");
    for (let i = 0; i < 10; i++) db.raw.prepare("INSERT INTO equity_snapshots (bee, ts, equity_usd) VALUES (?, ?, ?)").run("bee1", NOW - (10 - i) * H, 333 + i);
    db.raw.prepare("INSERT INTO equity_snapshots (bee, ts, equity_usd) VALUES ('bee2', ?, 1)").run(NOW - H);
    const own = ownFromEngineDb(db.raw, "bee1", NOW)!;
    expect(own.equity).toHaveLength(10);
    expect(own.pnlPct).toBeCloseTo((9 / 333) * 100, 1);
    expect(ownFromEngineDb(db.raw, "bee3", NOW)).toBeNull();
  });
});

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

describe("HTTP on the engine: /chat and /chat/send", () => {
  it("answers a same-site POST, refuses one without the header, and stays read-only otherwise", async () => {
    const db = new Db(":memory:");
    const chat = new PublicChat({ market, agent: (id) => (id === "bee1" ? agent : null), llm: () => new Model(), own: () => null });
    const server = startServer({ engine: { bus: new EventBus(db), db, visitors: new Visitors(db), snapshot: () => ({}), health: () => ({ ok: true }), chat }, profile: () => ({}), beeImage: () => null }, 0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(await (await fetch(`${base}/chat?bee=bee1`)).json()).toMatchObject({ open: true, name: "Breezy", left: 5 });
    expect((await fetch(`${base}/chat/send`, { method: "POST", body: JSON.stringify({ bee: "bee1", text: "hi" }) })).status).toBe(405);
    const ok = await fetch(`${base}/chat/send`, { method: "POST", headers: { "x-chat": "1", "content-type": "application/json" }, body: JSON.stringify({ bee: "bee1", text: "hi" }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { message: { text: string } }).message.text).toBe("I trade trends, on paper.");
    expect((await fetch(`${base}/snapshot`, { method: "POST" })).status).toBe(405);
  });
});

class Inbox implements Mailer {
  sent: string[] = [];
  async send(_to: string, _s: string, text: string) {
    this.sent.push(text);
  }
}
async function http(api: ArenaApi, method: string, path: string, body?: unknown) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url: path, headers: { "x-arena": "1" }, socket: { remoteAddress: "9.9.9.9" } });
  let status = 0;
  let text = "";
  const res = Object.assign(new EventEmitter(), { headersSent: false, writeHead: (s: number) => void (status = s), end: (t: string) => void (text = String(t)) });
  await api.handle(req as never, res as never, path.split("?")[0]!);
  return { status, body: JSON.parse(text || "{}") as Record<string, unknown> };
}

describe("HTTP on the Arena: a house agent's chat, for anyone", () => {
  it("answers about a listed house agent without a session, and never about a member's agent", async () => {
    const store = new ArenaStore(mkdtempSync(join(tmpdir(), "arena-house-chat-")));
    const house = store.createUser("b".repeat(32), "house@example.com", 1);
    store.setHandle(house.id, "glitchbunny");
    const member = store.createUser("c".repeat(32), "ana@example.com", 1);
    const hb = new Bots(store.tenant(house.id), "free", () => NOW).create({ name: "Housey", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." } as never);
    const mb = new Bots(store.tenant(member.id), "free", () => NOW).create({ name: "Mine", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "Follow the BTC trend, cut losses fast." } as never);
    const api = new ArenaApi(new ArenaAuth(store, new Inbox(), { baseUrl: "https://x.test" }), store, { secureCookie: true, now: () => NOW, chat: { market, llm: new Model() } });
    expect((await http(api, "GET", `/arena/showcase/chat?id=${hb.id}`)).body).toMatchObject({ open: true, name: "Housey" });
    const r = await http(api, "POST", "/arena/showcase/chat/send", { id: hb.id, text: "what about gold?" });
    expect(r.status).toBe(200);
    expect((await http(api, "POST", "/arena/showcase/chat/send", { id: mb.id, text: "hi" })).status).toBe(404);
  });
});
