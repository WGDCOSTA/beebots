import type { Key } from "./i18n/en.js";
import { humanLabel } from "./tickerModel.js";

// Pure helpers for the Arena pages: what the address bar means and how to word what the API answers. No React, so the root suite tests it.

export type LegalDocId = "terms" | "privacy" | "risk" | "cookies";
export type ArenaView = { kind: "home" } | { kind: "new" } | { kind: "ranking" } | { kind: "me" } | { kind: "plans"; paid: boolean } | { kind: "agent"; id: string } | { kind: "legal"; doc: LegalDocId } | { kind: "verify"; token: string };

/** #/arena is home (or the landing page when signed out); #/arena/verify?token=... is the page the e-mailed link opens. */
export function arenaView(hash: string): ArenaView {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/");
  const sub = parts[1];
  if (sub === "ranking") return { kind: "ranking" };
  if (sub === "me") return { kind: "me" };
  if (sub === "plans") return { kind: "plans", paid: new URLSearchParams(query).get("paid") === "1" };
  if (sub === "new") return { kind: "new" };
  if (sub === "agent" && /^[\w-]{1,40}$/.test(parts[2] ?? "")) return { kind: "agent", id: parts[2]! };
  if (sub === "legal" && (["terms", "privacy", "risk", "cookies"] as string[]).includes(parts[2] ?? "")) return { kind: "legal", doc: parts[2] as LegalDocId };
  const token = new URLSearchParams(query).get("token");
  return sub === "verify" && token ? { kind: "verify", token } : { kind: "home" };
}

export const TIER_LABEL: Record<"free" | "pro" | "premium", string> = { free: "Free", pro: "Pro", premium: "Premium" };

export function looksLikeEmail(v: string): boolean {
  const e = v.trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/** Seconds until a resend is allowed, never negative. */
export function resendIn(sentAt: number, now: number, cooldownMs = 30_000): number {
  return Math.max(0, Math.ceil((sentAt + cooldownMs - now) / 1000));
}

export const PROVIDER_LABEL: Record<string, string> = { openai: "OpenAI", claude: "Claude (Anthropic)", zai: "Z.ai (GLM)", kimi: "Kimi (Moonshot)" };

export interface BotDraft {
  /** fixed (default) or autonomous (Premium): the agent picks its own style and coins. */
  mode?: "fixed" | "autonomous";
  /** The member's own model key it thinks with; null or missing = the platform's model. */
  /** The models it thinks with: "platform" and/or the member's own key ids. Several decide by vote. */
  brains?: string[];
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

export const STYLE_KEYS: Record<string, { title: Key; blurb: Key }> = {
  breezy: { title: "style.breezy.t", blurb: "style.breezy.b" },
  bizzy: { title: "style.bizzy.t", blurb: "style.bizzy.b" },
  boozy: { title: "style.boozy.t", blurb: "style.boozy.b" },
};

/** A message the page can say in the member's language: a key and what fills its {markers}. */
export interface Say {
  key: Key;
  vars?: Record<string, string | number>;
}

/** Whether a coin can be picked for a style (false = shown greyed out, with the reason). */
export const coinFits = (style: string, coin: string): boolean => !STYLE_COINS[style] || STYLE_COINS[style]!.includes(coin);

type Names = (id: string) => string;
const lookIssue = (d: BotDraft): Say | null => {
  const name = d.name.trim();
  if (name.length < 2 || name.length > 24) return { key: "prob.name" };
  if (!d.theme || !d.avatar) return { key: "prob.avatar" };
  return null;
};
const styleIssue = (d: BotDraft, maxCoins: number, styleName: Names): Say | null => {
  if (d.mode === "autonomous") return null; // no style or coins to pick
  if (!d.style) return { key: "prob.style" };
  if (d.coins.length === 0) return { key: "prob.coins" };
  if (d.coins.length > maxCoins) return { key: "prob.maxCoins", vars: { n: maxCoins } };
  const only = STYLE_COINS[d.style];
  if (only && d.coins.some((c) => !only.includes(c))) return { key: "prob.styleCoins", vars: { style: styleName(d.style), coins: only.join(", ") } };
  return null;
};
const rulesIssue = (d: BotDraft): Say | null => {
  const n = d.rules.trim().length;
  if (n < 8) return { key: "prob.rulesShort" };
  if (n > 500) return { key: "prob.rulesLong" };
  return null;
};

/** The first thing wrong with a draft, as a message to translate, or null when it can be sent. The server checks everything again. */
export function draftIssue(d: BotDraft, maxCoins: number, styleName: Names = (id) => id): Say | null {
  return lookIssue(d) ?? styleIssue(d, maxCoins, styleName) ?? rulesIssue(d);
}

/** The wizard's steps, in order. A step is done when nothing it asks for is wrong. */
export const WIZARD_STEPS = ["start", "look", "style", "rules", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** What stops the member from leaving a step: only the fields that step owns. */
export function stepIssue(step: WizardStep, d: BotDraft, maxCoins: number, styleName: Names = (id) => id): Say | null {
  if (step === "look") return lookIssue(d);
  if (step === "style") return styleIssue(d, maxCoins, styleName);
  if (step === "rules") return rulesIssue(d);
  if (step === "review") return draftIssue(d, maxCoins, styleName);
  return null;
}

/** Toggles a coin, refusing to go past the plan's limit or a coin the style cannot trade. */
export function toggleCoin(coins: string[], coin: string, max: number, style?: string): string[] {
  if (coins.includes(coin)) return coins.filter((c) => c !== coin);
  if (style && !coinFits(style, coin)) return coins;
  return coins.length >= max ? coins : [...coins, coin];
}

/** Moving to another style drops the coins it cannot trade, so the draft stays valid. */
export function withStyle(d: BotDraft, style: string): BotDraft {
  const coins = d.coins.filter((c) => coinFits(style, c));
  return { ...d, style, coins: coins.length ? coins : STYLE_COINS[style]?.slice(0, 1) ?? d.coins };
}

export type AgentState = "running" | "paused" | "stopped" | "quarantined";

export interface RunStatus {
  state: "running" | "paused" | "stopping" | "stopped" | "queued" | "error";
  error?: string;
  equityUsd?: number;
  startEquityUsd?: number;
  pnlUsd?: number;
  pnlPct?: number;
  position?: { coin: string; side: string; sizeUsd: number | null; uplUsd: number; minutesHeld: number } | null;
  tradesToday?: number;
  decisions?: number;
  orders?: number;
  spentUsd?: number;
  capped?: boolean;
  /** Autonomous agents: the style it chose last. */
  style?: string | null;
  last?: { choice: string | null; confidence: number | null; status: string; ts: number } | null;
}

export type Pill = { key: Key; tone: "run" | "pause" | "stop" | "wait" | "bad" };

/** The one word that says what an agent is doing right now. */
export function statePill(enabled: boolean, botState: AgentState, run: RunStatus | undefined): Pill {
  if (botState === "quarantined") return { key: "state.quarantined", tone: "stop" };
  if (run?.state === "error") return { key: "state.error", tone: "bad" };
  if (run?.state === "stopping") return { key: "state.stopping", tone: "stop" };
  // What the member chose shows whether or not trading is switched on.
  if (botState === "stopped" || run?.state === "stopped") return { key: "state.stopped", tone: "stop" };
  if (botState === "paused" || run?.state === "paused") return { key: "state.paused", tone: "pause" };
  if (!enabled) return { key: "state.saved", tone: "wait" };
  if (!run || run.state === "queued") return { key: "state.waiting", tone: "wait" };
  return { key: "state.running", tone: "run" };
}

export const pnlTone = (n: number | undefined): "good" | "bad" | "flat" => ((n ?? 0) > 0.005 ? "good" : (n ?? 0) < -0.005 ? "bad" : "flat");

export function fmtUsd(n: number, locale = "en", signed = false): string {
  const f = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", signDisplay: signed ? "exceptZero" : "auto" });
  return f.format(n);
}

export function fmtPct(n: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(n / 100);
}

/** An SVG path for a small curve, scaled to its own range so a flat line stays in the middle. */
export function sparkPath(values: number[], w: number, h: number, pad = 2, minSpan = 0): string {
  if (values.length < 2) return "";
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  // A paper account that moved a cent should look like it moved a cent: never stretch a tiny range to fill the box.
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const span = hi - lo || 1;
  return values
    .map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - 2 * pad);
      const y = hi === lo ? h / 2 : h - pad - ((v - lo) / span) * (h - 2 * pad);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/** How long ago, as a number and a unit that Intl.RelativeTimeFormat understands. */
export function agoParts(ts: number, now: number): { n: number; unit: "second" | "minute" | "hour" | "day" } {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return { n: -s, unit: "second" };
  if (s < 3600) return { n: -Math.round(s / 60), unit: "minute" };
  if (s < 86_400) return { n: -Math.round(s / 3600), unit: "hour" };
  return { n: -Math.round(s / 86_400), unit: "day" };
}

const RISK: Record<string, Key> = {
  stop: "risk.stop",
  time_stop: "risk.time_stop",
  max_flat: "risk.max_flat",
  jev_unreachable: "risk.jev_unreachable",
  jev_daily_cap: "risk.jev_daily_cap",
  loss_stop: "risk.loss_stop",
  retired: "risk.retired",
  experiment_closed: "risk.experiment_closed",
  trade_cap: "risk.trade_cap",
  fee_budget: "risk.fee_budget",
};
/** The rule that overruled or acted for an agent, in words. An unknown rule is named as it is, never hidden. */
export function riskSay(name: string): Say {
  return RISK[name] ? { key: RISK[name]! } : { key: "risk.other", vars: { name: name.replace(/_/g, " ") } };
}

const DID: Record<string, Key> = { open: "did.open", close: "did.close", add: "did.add", trim: "did.trim", switch: "did.switch", hold: "did.hold", none: "did.hold" };
export const didKey = (kind: string): Key => DID[kind] ?? "did.hold";

/** The "getting started" list: what is done is read from the member's real data, never ticked by hand. */
export function checklist(agents: number, decisions: number, ranked: boolean): Array<{ key: Key; done: boolean }> {
  return [
    { key: "home.check.create", done: agents > 0 },
    { key: "home.check.decide", done: decisions > 0 },
    { key: "home.check.rank", done: ranked },
  ];
}

/** "Ends in 2d 5h" as a message to translate. */
export function seasonEndsSay(end: number, now: number): Say {
  const ms = end - now;
  if (ms <= 0) return { key: "season.ended" };
  const h = Math.floor(ms / 3_600_000);
  return h >= 24 ? { key: "season.endsDays", vars: { d: Math.floor(h / 24), h: h % 24 } } : { key: "season.endsHours", vars: { h: Math.max(1, h) } };
}

/** A league id such as "free:breezy" in words ("Free · Trend"). */
export function leagueText(id: string, t: (key: Key) => string): string {
  const [tier = "", style = ""] = id.split(":");
  const name = style === "autonomous" ? t("league.autonomous") : STYLE_KEYS[style] ? t(STYLE_KEYS[style]!.title) : style;
  return `${TIER_LABEL[tier as "free" | "pro" | "premium"] ?? "Free"} · ${name}`;
}

/** What an agent still needs before it is ranked, as messages to translate (the server sends the numbers). */
export interface Need {
  started: boolean;
  days: number;
  trades: number;
  history: boolean;
}
export function needSays(n: Need): Say[] {
  if (!n.started) return [{ key: "rank.need.started" }];
  const out: Say[] = [];
  if (n.days) out.push({ key: "rank.need.days", vars: { n: n.days.toFixed(1) } });
  if (n.trades) out.push({ key: "rank.need.trades", vars: { n: n.trades } });
  if (n.history) out.push({ key: "rank.need.history" });
  return out;
}

/** Mirrors the server's public-name rule (the server has the last word). Null when fine, else the message to show. */
export function handleIssue(raw: string): Key | null {
  return /^[a-z0-9][a-z0-9_-]{2,19}$/.test(raw.trim().toLowerCase()) ? null : "me.handleRule";
}

/** A menu label such as LONG_BTC or HOLD_WINNER in the member's language. Labels it does not know keep their English wording. */
export function choiceText(label: string, t: (key: Key, vars?: Record<string, string | number>) => string): string {
  const m = /^(LONG|SHORT)_([A-Z0-9]+)$/.exec(label);
  if (m) return t(m[1] === "LONG" ? "choice.long" : "choice.short", { coin: m[2]! });
  if (/^HOLD/.test(label)) return t("choice.hold");
  if (/^(CLOSE|EXIT|FLAT)/.test(label)) return t("choice.close");
  return humanLabel(label);
}

/** Whole days left before an agent in quarantine is deleted (never below 0). */
export function quarantineDaysLeft(quarantinedAt: number | null, now: number, days: number): number {
  if (quarantinedAt === null) return days;
  return Math.max(0, Math.ceil((quarantinedAt + days * 86_400_000 - now) / 86_400_000));
}

export function fmtPrice(amountCents: number, currency: string, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(amountCents / 100);
}

export interface PlanLimits {
  bots: number;
  maxCoins: number;
  styles: string[];
  proThemes: boolean;
  autonomy: boolean;
  brains: number;
  skillSlots: number;
  history: boolean;
}

/** What a plan includes, as messages to translate. `soon` marks what the plan promises but the Arena does not do yet: it is never sold as if it worked. */
export function planFeatures(l: PlanLimits): Array<Say & { soon?: boolean }> {
  const out: Array<Say & { soon?: boolean }> = [
    { key: "plans.f.agents", vars: { n: l.bots } },
    { key: "plans.f.coins", vars: { n: l.maxCoins } },
    { key: l.styles.length > 2 ? "plans.f.stylesAll" : "plans.f.stylesBasic" },
    { key: l.proThemes ? "plans.f.packsAll" : "plans.f.packsFree" },
    { key: "plans.f.brains", vars: { n: l.brains } },
    { key: "plans.f.skills", vars: { n: l.skillSlots }, soon: true },
  ];
  if (l.history) out.push({ key: "plans.f.history", soon: true });
  if (l.autonomy) out.push({ key: "plans.f.auto" });
  return out;
}

/** The name of the style an agent trades, or what it is when it chooses its own. */
export function styleTitleKey(mode: string | undefined, style: string): Key {
  return mode === "autonomous" ? "style.auto.t" : (STYLE_KEYS[style]?.title ?? "style.breezy.t");
}
