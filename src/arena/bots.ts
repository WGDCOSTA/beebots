// A member's bots, stored in that member's own database. Plan limits decide how many bots, which styles, which coins and
// which theme packs; rules and style changes create a new version so a bot's record is never rewritten behind its history.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { STYLES, isReservedName, type StyleId } from "../settings.js";
import type { Tier } from "./store.js";
import { avatarOf, themeById } from "./themes.js";

export interface PlanLimits {
  bots: number;
  maxCoins: number;
  styles: readonly StyleId[];
  /** May use the Pro theme packs. */
  proThemes: boolean;
}

/** Free: one bot, simple styles, three coins. Pro: more bots, every style, more coins and every pack. */
export const LIMITS: Record<Tier, PlanLimits> = {
  free: { bots: 1, maxCoins: 3, styles: ["breezy", "bizzy"], proThemes: false },
  pro: { bots: 10, maxCoins: 8, styles: STYLES, proThemes: true },
};

export const COINS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "BNB", "ADA"] as const;

export interface BotView {
  id: string;
  name: string;
  theme: string;
  avatar: string;
  style: StyleId;
  coins: string[];
  rules: string;
  version: number;
  createdAt: number;
}

export interface BotInput {
  name?: unknown;
  theme?: unknown;
  avatar?: unknown;
  style?: unknown;
  coins?: unknown;
  rules?: unknown;
}

export class BotError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,22}[\p{L}\p{N}]$/u;
const MIN_RULES = 8;
const MAX_RULES = 2000;

interface Row {
  id: string;
  name: string;
  theme: string;
  avatar: string;
  style: string;
  coins: string;
  rules: string;
  version: number;
  created_at: number;
}
const toView = (r: Row): BotView => ({ id: r.id, name: r.name, theme: r.theme, avatar: r.avatar, style: r.style as StyleId, coins: JSON.parse(r.coins) as string[], rules: r.rules, version: r.version, createdAt: r.created_at });

interface Clean {
  name: string;
  theme: string;
  avatar: string;
  style: StyleId;
  coins: string[];
  rules: string;
}

export class Bots {
  constructor(private readonly db: DatabaseSync, private readonly tier: Tier, private readonly now: () => number = Date.now) {}

  list(): BotView[] {
    return (this.db.prepare("SELECT * FROM bots ORDER BY created_at, id").all() as unknown as Row[]).map(toView);
  }

  private get(id: unknown): Row {
    const r = typeof id === "string" ? (this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Row | undefined) : undefined;
    if (!r) throw new BotError("Bot not found.", 404);
    return r;
  }

  private clean(i: BotInput, exceptId?: string): Clean {
    const lim = LIMITS[this.tier];
    const name = typeof i.name === "string" ? i.name.trim().replace(/\s+/g, " ") : "";
    if (!NAME_RE.test(name)) throw new BotError("Name: 2 to 24 letters, numbers, spaces, apostrophes or hyphens.");
    if (isReservedName(name)) throw new BotError("That name belongs to one of the Warren's own bunnies. Pick another.");
    const dup = this.db.prepare("SELECT id FROM bots WHERE lower(name) = lower(?)").get(name) as { id: string } | undefined;
    if (dup && dup.id !== exceptId) throw new BotError("You already have a bot with that name.");

    const theme = typeof i.theme === "string" ? themeById(i.theme) : undefined;
    if (!theme) throw new BotError("Pick a theme.");
    if (theme.tier === "pro" && !lim.proThemes) throw new BotError(`The ${theme.label} pack is for Pro members.`, 403);
    const avatar = typeof i.avatar === "string" ? avatarOf(theme.id, i.avatar) : undefined;
    if (!avatar) throw new BotError("Pick an avatar from that theme.");

    const style = STYLES.find((s) => s === i.style);
    if (!style) throw new BotError("Pick a trading style.");
    if (!lim.styles.includes(style)) throw new BotError("That style is for Pro members.", 403);

    const coinsIn = Array.isArray(i.coins) ? i.coins : [];
    const coins = [...new Set(coinsIn.filter((c): c is string => typeof c === "string").map((c) => c.toUpperCase()))];
    if (coins.length === 0 || coins.some((c) => !(COINS as readonly string[]).includes(c))) throw new BotError("Pick at least one coin from the list.");
    if (coins.length > lim.maxCoins) throw new BotError(`Your plan allows up to ${lim.maxCoins} coins per bot.`, 403);

    const rules = typeof i.rules === "string" ? i.rules.trim() : "";
    if (rules.length < MIN_RULES || rules.length > MAX_RULES) throw new BotError(`Rules: ${MIN_RULES} to ${MAX_RULES} characters.`);
    return { name, theme: theme.id, avatar: avatar.id, style, coins, rules };
  }

  create(i: BotInput): BotView {
    const lim = LIMITS[this.tier];
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n;
    if (n >= lim.bots) throw new BotError(this.tier === "free" ? "The Free plan has one bot. Upgrade to Pro for more." : `You have reached ${lim.bots} bots.`, 403);
    const c = this.clean(i);
    const id = randomBytes(6).toString("hex");
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO bots (id, name, theme, avatar, style, coins, rules, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").run(id, c.name, c.theme, c.avatar, c.style, JSON.stringify(c.coins), c.rules, t);
      this.db.prepare("INSERT INTO bot_versions (bot_id, version, style, coins, rules, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, c.style, JSON.stringify(c.coins), c.rules, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return toView(this.get(id));
  }

  /** Name, theme and avatar change in place; a new style, coin set or rules text is a new version. */
  update(id: unknown, i: BotInput): BotView {
    const cur = this.get(id);
    const c = this.clean(i, cur.id);
    const same = c.style === cur.style && c.rules === cur.rules && JSON.stringify(c.coins) === cur.coins;
    const version = same ? cur.version : cur.version + 1;
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE bots SET name = ?, theme = ?, avatar = ?, style = ?, coins = ?, rules = ?, version = ? WHERE id = ?").run(c.name, c.theme, c.avatar, c.style, JSON.stringify(c.coins), c.rules, version, cur.id);
      if (!same) this.db.prepare("INSERT INTO bot_versions (bot_id, version, style, coins, rules, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cur.id, version, c.style, JSON.stringify(c.coins), c.rules, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return toView(this.get(cur.id));
  }

  remove(id: unknown): void {
    const cur = this.get(id);
    this.db.prepare("DELETE FROM bot_versions WHERE bot_id = ?").run(cur.id);
    this.db.prepare("DELETE FROM bots WHERE id = ?").run(cur.id);
  }

  versions(id: unknown): Array<{ version: number; style: string; coins: string[]; rules: string; createdAt: number }> {
    const cur = this.get(id);
    return (this.db.prepare("SELECT version, style, coins, rules, created_at FROM bot_versions WHERE bot_id = ? ORDER BY version DESC").all(cur.id) as Array<{ version: number; style: string; coins: string; rules: string; created_at: number }>).map((r) => ({ version: r.version, style: r.style, coins: JSON.parse(r.coins) as string[], rules: r.rules, createdAt: r.created_at }));
  }
}
