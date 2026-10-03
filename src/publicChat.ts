// Chat with a public agent: the main site's bunnies and the Arena's house agents. Anyone may ask; the answer follows the same
// rules as a member's agent chat (arena/chat.ts): figures computed by code from real candles, charts drawn from them, the
// opinion labelled as the agent's, read-only. A visitor's questions are not stored: the page keeps its own conversation and
// sends the last few messages back. Limits: questions per address per hour, and a ceiling for the whole server per day.
import type { DatabaseSync } from "node:sqlite";
import { AgentChat, type ChatAgent, type ChatMarket, type HistoryItem, type OwnContext } from "./arena/chat.js";
import type { LlmClient } from "./brains/llm.js";
import { log } from "./log.js";
import { safeError } from "./redact.js";

export const PUBLIC_LOCALES = ["en", "pt-BR", "es", "fr", "de", "it"];

export interface PublicChatOpts {
  market: ChatMarket;
  /** The agent by its public id, or null for none. */
  agent(id: string): ChatAgent | null;
  /** The model that speaks for it, or null when it has none (then chat is closed for it). */
  llm(id: string): LlmClient | null;
  /** Its own record (equity, decisions, trades), for questions about itself. */
  own(id: string): OwnContext | null;
  perHour?: number;
  dailyLimit?: number;
  now?: () => number;
}

export interface PublicReply {
  status: number;
  body: Record<string, unknown>;
}

const clean = (h: unknown): HistoryItem[] =>
  (Array.isArray(h) ? h : [])
    .slice(-6)
    .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
    .filter((x) => (x.role === "you" || x.role === "agent") && typeof x.text === "string")
    .map((x) => ({ role: x.role as "you" | "agent", text: String(x.text).slice(0, 300) }));

export class PublicChat {
  private readonly perHour: number;
  private readonly dailyLimit: number;
  private readonly now: () => number;
  /** Question times per address, the last hour only; nothing else about a visitor is kept, and nothing is written to disk. */
  private byAddr = new Map<string, number[]>();
  private day = { key: "", n: 0 };

  constructor(private readonly o: PublicChatOpts) {
    this.perHour = o.perHour ?? 5;
    this.dailyLimit = o.dailyLimit ?? 300;
    this.now = o.now ?? Date.now;
  }

  private recent(addr: string, t: number): number[] {
    const list = (this.byAddr.get(addr) ?? []).filter((x) => x > t - 3_600_000);
    if (list.length) this.byAddr.set(addr, list);
    else this.byAddr.delete(addr);
    return list;
  }

  private today(t: number): number {
    const key = new Date(t).toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, n: 0 };
    return this.day.n;
  }

  /** Whether an agent can be asked, and how many questions this address has left this hour. */
  info(addr: string, id: string): PublicReply {
    const a = this.o.agent(id);
    if (!a) return { status: 404, body: { error: "No such agent." } };
    const t = this.now();
    return { status: 200, body: { open: !!this.o.llm(id) && this.today(t) < this.dailyLimit, name: a.name, perHour: this.perHour, left: Math.max(0, this.perHour - this.recent(addr, t).length) } };
  }

  async ask(addr: string, id: string, body: Record<string, unknown>): Promise<PublicReply> {
    const a = this.o.agent(id);
    if (!a) return { status: 404, body: { error: "No such agent." } };
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
    if (!text) return { status: 400, body: { error: "Write a question first." } };
    const llm = this.o.llm(id);
    if (!llm) return { status: 503, body: { error: "Chat is not open right now.", code: "chat_closed" } };
    const t = this.now();
    const mine = this.recent(addr, t);
    if (mine.length >= this.perHour) return { status: 429, body: { error: "You have asked a lot this hour. Try again a little later.", code: "chat_limit", left: 0 } };
    if (this.today(t) >= this.dailyLimit) return { status: 429, body: { error: "Chat is busy today. Try again tomorrow.", code: "chat_busy" } };
    mine.push(t);
    this.byAddr.set(addr, mine);
    this.day.n++;
    const locale = typeof body.locale === "string" && PUBLIC_LOCALES.includes(body.locale) ? body.locale : "en";
    try {
      const r = await new AgentChat({ llm, market: this.o.market, now: this.now }).reply({ agent: a, text, history: clean(body.history), locale, own: this.o.own(id) });
      return { status: 200, body: { message: { id: t, role: "agent", ts: this.now(), text: r.text, report: r.report, unavailable: r.unavailable }, left: Math.max(0, this.perHour - mine.length) } };
    } catch (e) {
      log.warn("public chat failed", { agent: id, error: safeError(e).message });
      return { status: 502, body: { error: "The agent could not answer just now. Try again.", code: "chat_failed" } };
    }
  }
}

/** One bunny's own record from the engine's database (several bunnies share it, one `bee` column each). */
export function ownFromEngineDb(raw: DatabaseSync, slot: string, now: number, days = 7): OwnContext | null {
  const since = now - days * 86_400_000;
  const first = (raw.prepare("SELECT MIN(ts) AS t FROM equity_snapshots WHERE bee = ? AND ts >= ?").get(slot, since) as { t: number | null }).t;
  if (first === null) return null;
  const bucket = Math.max(60_000, Math.ceil((now - first) / 120));
  const equity = (raw.prepare("SELECT MAX(ts) AS ts, equity_usd AS eq FROM equity_snapshots WHERE bee = ? AND ts >= ? AND equity_usd IS NOT NULL GROUP BY CAST(ts / ? AS INTEGER) ORDER BY ts").all(slot, since, bucket) as Array<{ ts: number; eq: number }>).map((r): [number, number] => [r.ts, Math.round(r.eq * 100) / 100]);
  const decisions = (raw.prepare("SELECT ts, choice, confidence, action_json AS a, vetoed_by AS v, forced_by AS f FROM decisions WHERE bee = ? ORDER BY id DESC LIMIT 12").all(slot) as Array<{ ts: number; choice: string | null; confidence: number | null; a: string; v: string | null; f: string | null }>).map((d) => {
    let kind = "none";
    try {
      kind = String((JSON.parse(d.a) as { kind?: unknown }).kind ?? "none");
    } catch {
      /* an unreadable action reads as none */
    }
    return { ts: d.ts, did: kind, choice: d.choice, confidencePct: d.confidence === null ? null : Math.round(d.confidence * 100), rule: d.v ?? d.f };
  });
  const trades = (raw.prepare("SELECT ts, inst_id AS i, side, notional_usd AS n, realised_usd AS r FROM fills WHERE bee = ? ORDER BY id DESC LIMIT 12").all(slot) as Array<{ ts: number; i: string; side: string; n: number; r: number }>).map((f) => ({ ts: f.ts, coin: f.i.split("-")[0] ?? f.i, side: f.side, sizeUsd: Math.round(f.n), realisedUsd: Math.round(f.r * 100) / 100 }));
  const pnlPct = equity.length > 1 && equity[0]![1] > 0 ? Number((((equity[equity.length - 1]![1] - equity[0]![1]) / equity[0]![1]) * 100).toFixed(2)) : null;
  return { equity, position: null, pnlPct, decisions, trades };
}
