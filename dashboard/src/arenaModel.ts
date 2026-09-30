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
