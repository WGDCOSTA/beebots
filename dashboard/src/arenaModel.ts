// Pure helpers for the Arena pages: what the address bar means and how to word what the API answers. No React, so the root suite tests it.

export type ArenaView = { kind: "account" } | { kind: "verify"; token: string };

/** #/arena is the account page; #/arena/verify?token=... is the page the e-mailed link opens. */
export function arenaView(hash: string): ArenaView {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const token = new URLSearchParams(query).get("token");
  return path.split("/")[1] === "verify" && token ? { kind: "verify", token } : { kind: "account" };
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
  if (n > 2000) return "Keep the rules under 2000 characters.";
  return null;
}

/** Toggles a coin, refusing to go past the plan's limit. */
export function toggleCoin(coins: string[], coin: string, max: number): string[] {
  if (coins.includes(coin)) return coins.filter((c) => c !== coin);
  return coins.length >= max ? coins : [...coins, coin];
}
