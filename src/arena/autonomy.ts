// Autonomous agents (Premium): the agent picks its own trading style and changes it when the market changes. The engine
// already lets a bee switch its method (only while it holds nothing, and not more often than every few hours); this file asks
// the agent's model which style fits the market right now. The model's one-line reason is shown as the model's own words:
// it is what the model said, not an explanation the platform checked. Every risk rule stays in code, whatever style it picks.
import { z } from "zod";
import type { LlmClient } from "../brains/llm.js";
import type { MarketView } from "../market/types.js";
import { STYLES, STYLE_INFO, type StyleId } from "../settings.js";

export interface StyleChoice {
  style: StyleId;
  /** What the model said, trimmed. Shown as the model's words. */
  reason: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM =
  "You choose the trading style of a paper-trading agent in a game (simulated money, real prices). Styles: " +
  STYLES.map((s) => `${s} = ${STYLE_INFO[s].label}: ${STYLE_INFO[s].blurb}`).join(" ") +
  " Look at the market lines and the owner's guidance and pick the ONE style that fits the market now. Switching has a cost, so keep the current style unless the market clearly calls for another. Give a one-sentence reason. This is not financial advice.";

/** A few lines about the biggest coins, enough for a style call and short enough to be cheap. */
export function marketLines(view: MarketView, max = 8): string[] {
  const rows = [...view.stats.values()]
    .filter((s) => view.gated.includes(s.instId))
    .sort((a, b) => b.vol24hUsd - a.vol24hUsd)
    .slice(0, max);
  return rows.map((s) => `${s.coin}: 24h ${s.ret24hPct === null ? "?" : s.ret24hPct.toFixed(1)}%, RSI ${s.rsi14 === null ? "?" : Math.round(s.rsi14)}, band width ${s.bbWidthPct === null ? "?" : s.bbWidthPct.toFixed(1)}%, spread ${s.spreadBp.toFixed(1)}bp${s.trend ? `, trend score ${s.trend.score}` : ""}`);
}

export async function chooseStyle(llm: LlmClient, o: { rules: string; current: StyleId | null; market: string[] }): Promise<StyleChoice> {
  const r = await llm.json({
    system: SYSTEM,
    user: JSON.stringify({ ownerGuidance: o.rules, currentStyle: o.current, market: o.market }),
    name: "style_choice",
    schema: { type: "object", properties: { style: { type: "string", enum: [...STYLES] }, reason: { type: "string" } }, required: ["style", "reason"], additionalProperties: false },
    validate: z.object({ style: z.enum(STYLES), reason: z.string() }),
    maxTokens: 300,
    effort: "low",
  });
  return { style: r.data.style, reason: r.data.reason.replace(/\s+/g, " ").trim().slice(0, 240), inputTokens: r.inputTokens, outputTokens: r.outputTokens };
}
