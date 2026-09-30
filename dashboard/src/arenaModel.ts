import { humanLabel } from "./tickerModel.js";

// Pure helpers for the Arena pages: what the address bar means and how to word what the API answers. No React, so the root suite tests it.

export type ArenaView = { kind: "account" } | { kind: "verify"; token: string } | { kind: "ranking" };

/** #/arena is the account page; #/arena/verify?token=... is the page the e-mailed link opens. */
export function arenaView(hash: string): ArenaView {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const token = new URLSearchParams(query).get("token");
  const sub = path.split("/")[1];
  if (sub === "ranking") return { kind: "ranking" };
  return sub === "verify" && token ? { kind: "verify", token } : { kind: "account" };
}

/** A member-since line such as "Member since 30 Sep 2026". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function memberSince(ts: number): string {
  const d = new Date(ts);
  return `Member since ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const TIER_LABEL: Record<"free" | "pro", string> = { free: "Free", pro: "Pro" };

export function looksLikeEmail(v: string): boolean {
  const e = v.trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/** Seconds until a resend is allowed, never negative. */
export function resendIn(sentAt: number, now: number, cooldownMs = 30_000): number {
  return Math.max(0, Math.ceil((sentAt + cooldownMs - now) / 1000));
}

export const STYLE_LABEL: Record<string, { label: string; blurb: string }> = {
  breezy: { label: "Trend", blurb: "Follows BTC and ETH trends. Few trades, calm." },
  bizzy: { label: "Breakout", blurb: "One volatility breakout a day, ridden to the close." },
  boozy: { label: "Momentum", blurb: "Chases fast moves. Busier and riskier." },
};

export interface BotDraft {
  name: string;
  theme: string;
  avatar: string;
  style: string;
  coins: string[];
  rules: string;
  tagline: string;
  look: string;
  /** Shown on the public leaderboard. */
  listed: boolean;
}

/** The coins a style can trade at all (Momentum takes any). Mirrors the server's check, which has the last word. */
export const STYLE_COINS: Record<string, string[]> = { breezy: ["BTC", "ETH"], bizzy: ["BTC", "ETH", "SOL", "HYPE"] };

/** The first thing wrong with a draft, in words, or null when it can be sent. The server checks everything again. */
export function draftProblem(d: BotDraft, maxCoins: number): string | null {
  const name = d.name.trim();
  if (name.length < 2 || name.length > 24) return "Give it a name of 2 to 24 characters.";
  if (!d.theme || !d.avatar) return "Pick a theme and an avatar.";
  if (!d.style) return "Pick a trading style.";
  if (d.coins.length === 0) return "Pick at least one coin.";
  if (d.coins.length > maxCoins) return `Your plan allows up to ${maxCoins} coins.`;
  const only = STYLE_COINS[d.style];
  if (only && d.coins.some((c) => !only.includes(c))) return `${STYLE_LABEL[d.style]?.label ?? d.style} only trades ${only.join(", ")}. Pick those coins, or another style.`;
  const n = d.rules.trim().length;
  if (n < 8) return "Write a few words about how it should trade (8 characters or more).";
  if (n > 500) return "Keep the rules under 500 characters.";
  return null;
}

/** Toggles a coin, refusing to go past the plan's limit. */
export function toggleCoin(coins: string[], coin: string, max: number): string[] {
  if (coins.includes(coin)) return coins.filter((c) => c !== coin);
  return coins.length >= max ? coins : [...coins, coin];
}

export interface RunStatus {
  state: "running" | "queued" | "error";
  error?: string;
  equityUsd?: number;
  startEquityUsd?: number;
  pnlUsd?: number;
  pnlPct?: number;
  position?: { coin: string; side: string; sizeUsd: number | null; uplUsd: number; minutesHeld: number } | null;
  tradesToday?: number;
  decisions?: number;
  spentUsd?: number;
  capped?: boolean;
  last?: { choice: string | null; confidence: number | null; status: string; ts: number } | null;
}

const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

/** What to show under a bunny: one headline, one detail line, and whether the news is good, bad or neutral. */
export function runSummary(enabled: boolean, run: RunStatus | undefined): { headline: string; detail: string; tone: "good" | "bad" | "flat" } {
  if (!enabled) return { headline: "Saved, not trading yet", detail: "The race track is not open yet. Your bunny is stored and ready.", tone: "flat" };
  if (!run || run.state === "queued") return { headline: "Waiting for a place on the track", detail: "The track is full. It starts on its own when a place frees up.", tone: "flat" };
  if (run.state === "error") return { headline: "Could not start", detail: run.error ?? "It will be retried.", tone: "bad" };
  const pnl = run.pnlUsd ?? 0;
  const pos = run.position;
  const where = pos ? `${pos.side.toUpperCase()} ${pos.coin}${pos.sizeUsd !== null ? ` ${usd(pos.sizeUsd)}` : ""}, ${signed(pos.uplUsd)} open` : "Flat, waiting for a setup";
  const last = run.last ? ` Last call: ${humanLabel(run.last.choice)}${run.last.confidence !== null ? ` (${Math.round(run.last.confidence * 100)}% sure)` : ""}.` : "";
  const cap = run.capped ? " Today's decision budget is used up, so it holds until 00:00 UTC." : "";
  return {
    headline: `Paper account ${usd(run.equityUsd ?? 0)} (${signed(pnl)}, ${(run.pnlPct ?? 0) >= 0 ? "+" : ""}${(run.pnlPct ?? 0).toFixed(2)}%)`,
    detail: `${where}. ${run.decisions ?? 0} decisions.${last}${cap}`,
    tone: pnl > 0 ? "good" : pnl < 0 ? "bad" : "flat",
  };
}


/** A league id such as "free:breezy" in words. */
export function leagueLabel(id: string): string {
  const [tier = "", style = ""] = id.split(":");
  return `${tier === "pro" ? "Pro" : "Free"} · ${STYLE_LABEL[style]?.label ?? style}`;
}

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
export const pctText = pct;

/** "Ends in 2d 5h", "Ends in 3h", "Ended". */
export function seasonEnds(end: number, now: number): string {
  const ms = end - now;
  if (ms <= 0) return "Ended";
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? `Ends in ${Math.floor(h / 24)}d ${h % 24}h` : `Ends in ${Math.max(1, h)}h`;
}

/** Mirrors the server's public-name rule (the server has the last word). */
export function handleProblem(raw: string): string | null {
  const h = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,19}$/.test(h)) return "3 to 20 letters, numbers, - or _.";
  return null;
}
