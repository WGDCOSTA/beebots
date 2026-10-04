// What every LLM brain call costs: tokens in and out, latency, success, per brain, model and purpose (the JSON schema
// name: "lab_study", "council", "research_notes", ...). Recorded once per call by wrapping the clients, so councils,
// research, the coach, the Farmer, the crew and the lab brain are all counted the same way. Jev is not here: its cost
// is on each decision row. Prices are the owner's (LLM_PRICES), since list prices change and differ per account.
import type { DatabaseSync } from "node:sqlite";
import type { JsonAnswer, JsonAsk, LlmClient } from "./llm.js";

const SQL = `CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, brain TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
  in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL, error TEXT);
CREATE INDEX IF NOT EXISTS llm_usage_ts ON llm_usage(ts);`;

export class UsageMeter {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SQL);
  }

  record(r: { brain: string; model: string; purpose: string; inTokens: number; outTokens: number; latencyMs: number; ok: boolean; error?: string | null }): void {
    try {
      this.db
        .prepare("INSERT INTO llm_usage (ts, brain, model, purpose, in_tokens, out_tokens, latency_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(this.now(), r.brain, r.model.slice(0, 80), r.purpose.slice(0, 60), Math.max(0, Math.round(r.inTokens)), Math.max(0, Math.round(r.outTokens)), Math.max(0, Math.round(r.latencyMs)), r.ok ? 1 : 0, r.error ? r.error.slice(0, 200) : null);
    } catch {
      // Metering must never break a brain call.
    }
  }

  /** Drops rows older than `keepDays` (the dashboard looks back 90 days). */
  prune(keepDays = 120): void {
    this.db.prepare("DELETE FROM llm_usage WHERE ts < ?").run(this.now() - keepDays * 86_400_000);
  }
}

/** The same client, with every call recorded. */
export function metered(client: LlmClient, meter: UsageMeter): LlmClient {
  return {
    brain: client.brain,
    model: client.model,
    async json<T>(ask: JsonAsk<T>): Promise<JsonAnswer<T>> {
      const t0 = Date.now();
      try {
        const r = await client.json(ask);
        meter.record({ brain: r.brain, model: r.model, purpose: ask.name, inTokens: r.inputTokens, outTokens: r.outputTokens, latencyMs: r.latencyMs, ok: true });
        return r;
      } catch (err) {
        meter.record({ brain: client.brain, model: client.model, purpose: ask.name, inTokens: 0, outTokens: 0, latencyMs: Date.now() - t0, ok: false, error: (err as Error).message });
        throw err;
      }
    },
  };
}

/**
 * The owner's prices, USD per million tokens: "gpt-6-astra=5:20,claude-opus-5=15:75" (input:output). A model matches
 * its exact id first, then the longest listed prefix ("gpt-6" covers "gpt-6-astra"). Unpriced models show tokens only.
 */
export function parsePrices(raw: string | undefined): Map<string, { inUsd: number; outUsd: number }> {
  const out = new Map<string, { inUsd: number; outUsd: number }>();
  for (const part of (raw ?? "").split(",")) {
    const m = /^\s*([A-Za-z0-9._:/-]+)\s*=\s*([0-9.]+)\s*:\s*([0-9.]+)\s*$/.exec(part);
    if (m) out.set(m[1]!, { inUsd: Number(m[2]), outUsd: Number(m[3]) });
  }
  return out;
}

export function priceOf(prices: Map<string, { inUsd: number; outUsd: number }>, model: string): { inUsd: number; outUsd: number } | null {
  if (prices.has(model)) return prices.get(model)!;
  let best: string | null = null;
  for (const k of prices.keys()) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? prices.get(best)! : null;
}
