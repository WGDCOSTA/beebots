// A member's bots, stored in that member's own database. Plan limits decide how many bots, which styles, which coins and
// which theme packs; rules and style changes create a new version so a bot's record is never rewritten behind its history.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BIZZY_BREAKOUT_COINS } from "../bees/bizzy.js";
import { BREEZY_COINS } from "../bees/breezy.js";
import { MAX_BEES } from "../config.js";
import { QUARANTINE_DAYS } from "./plans.js";
import { STYLES, STYLE_INFO, isReservedName, type StyleId } from "../settings.js";
import type { Tier } from "./store.js";
import { avatarOf, themeById } from "./themes.js";

export interface PlanLimits {
  bots: number;
  maxCoins: number;
  styles: readonly StyleId[];
  /** May use the Pro theme packs. */
  proThemes: boolean;
  /** May run an agent in autonomous mode: it picks and changes its own style, coins and instruments. */
  autonomy: boolean;
  /** Model brains an agent may use together. Not enforced yet: the feature does not exist. */
  brains: number;
  /** Skills a member may keep active. Not enforced yet: the skill bank does not exist. */
  skillSlots: number;
  /** Stored historical candles and simulated training on them. Not built yet. */
  history: boolean;
}

/** Free: one agent, simple styles, three coins. Pro: up to nine, every style, more coins and every pack. Premium: up to 20 and autonomy. */
export const LIMITS: Record<Tier, PlanLimits> = {
  free: { bots: 1, maxCoins: 3, styles: ["breezy", "bizzy"], proThemes: false, autonomy: false, brains: 1, skillSlots: 5, history: false },
  pro: { bots: MAX_BEES, maxCoins: 8, styles: STYLES, proThemes: true, autonomy: false, brains: 3, skillSlots: 30, history: true },
  // Premium's skill slots were not given: it has at least Pro's, so it gets Pro's until the owner says otherwise.
  premium: { bots: 20, maxCoins: 8, styles: STYLES, proThemes: true, autonomy: true, brains: 6, skillSlots: 30, history: true },
};

export const COINS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "BNB", "ADA"] as const;

/** running: trades. paused: keeps what it holds under its stops, opens nothing new. stopped: closed out and finished. quarantined: the plan no longer allows it; stopped, off the board, kept for QUARANTINE_DAYS, restored by upgrading. */
export type BotState = "running" | "paused" | "stopped" | "quarantined";

/** fixed: one style the member picked. autonomous (Premium): the agent picks and changes its own style and trades any coin the market offers. skill: it trades by one of the member's skills (a rule set) on the coins the member picked. */
export type BotMode = "fixed" | "autonomous" | "skill";

export interface BotView {
  mode: BotMode;
  /** Skill mode: the member's skill it trades by (an id from their skills), else null. */
  skill: string | null;
  id: string;
  name: string;
  theme: string;
  avatar: string;
  style: StyleId;
  coins: string[];
  rules: string;
  tagline: string;
  look: string;
  /** A portrait has been painted for this bot. */
  image: boolean;
  /** Shown on the public leaderboard (name, style and results only; never positions or rules). */
  listed: boolean;
  state: BotState;
  /** When it went into quarantine, or null. */
  quarantinedAt: number | null;
  /** The member's own model key it thinks with (their bill), or null for the platform's model. */
  brainKey: string | null;
  /** Every model that decides together, in order: "platform" and/or the member's own key ids. One entry is a single brain; more is a vote. */
  brains: string[];
  version: number;
  createdAt: number;
}

export interface BotInput {
  mode?: unknown;
  skill?: unknown;
  brains?: unknown;
  brainKey?: unknown;
  listed?: unknown;
  tagline?: unknown;
  look?: unknown;
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

const QUARANTINED_MSG = "This agent is in quarantine because your plan no longer includes it. Upgrade to restore it.";
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,22}[\p{L}\p{N}]$/u;
const MIN_RULES = 8;
const MAX_RULES = 500;

interface Row {
  id: string;
  name: string;
  theme: string;
  avatar: string;
  style: string;
  coins: string;
  rules: string;
  tagline: string;
  look: string;
  image: number;
  listed: number;
  state: string;
  quarantined_at: number | null;
  brain_key: string | null;
  brains: string;
  skill: string | null;
  mode: string;
  version: number;
  created_at: number;
}
export const PLATFORM = "platform";
/** The brains an agent decides with: its list, or what the older single-key column says, or the platform's model. */
function brainsOf(r: { brains: string; brain_key: string | null }): string[] {
  try {
    const l = r.brains ? (JSON.parse(r.brains) as unknown) : null;
    if (Array.isArray(l) && l.length) return l.filter((x): x is string => typeof x === "string");
  } catch {
    /* fall through */
  }
  return [r.brain_key ?? PLATFORM];
}
const toView = (r: Row): BotView => ({ id: r.id, name: r.name, theme: r.theme, avatar: r.avatar, style: r.style as StyleId, coins: JSON.parse(r.coins) as string[], rules: r.rules, tagline: r.tagline, look: r.look, image: r.image === 1, listed: r.listed === 1, state: r.state as BotState, quarantinedAt: r.quarantined_at, brainKey: brainsOf(r).length === 1 && brainsOf(r)[0] !== PLATFORM ? brainsOf(r)[0]! : null, brains: brainsOf(r), mode: r.mode === "autonomous" ? "autonomous" : r.mode === "skill" ? "skill" : "fixed", skill: r.skill, version: r.version, createdAt: r.created_at });

/** The coins a style can trade at all (Momentum ranks every coin that passes the gates). */
export const STYLE_COINS: Partial<Record<StyleId, readonly string[]>> = { breezy: BREEZY_COINS, bizzy: BIZZY_BREAKOUT_COINS };

/** Says why a style cannot take these coins, or null when it can. */
export function styleCoinProblem(style: StyleId, coins: readonly string[]): string | null {
  const only = STYLE_COINS[style];
  if (!only || coins.every((c) => only.includes(c))) return null;
  return `${STYLE_INFO[style].label} only trades ${only.join(", ")}. Pick those coins, or another style.`;
}

interface Clean {
  mode: BotMode;
  skill: string | null;
  name: string;
  theme: string;
  avatar: string;
  style: StyleId;
  coins: string[];
  rules: string;
  tagline: string;
  look: string;
  listed: boolean | undefined;
  /** undefined = not sent (keep what it has). */
  brains: string[] | undefined;
}

export class Bots {
  constructor(private readonly db: DatabaseSync, private readonly tier: Tier, private readonly now: () => number = Date.now) {}

  list(): BotView[] {
    return (this.db.prepare("SELECT * FROM bots ORDER BY created_at, rowid").all() as unknown as Row[]).map(toView);
  }

  private get(id: unknown): Row {
    const r = typeof id === "string" ? (this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Row | undefined) : undefined;
    if (!r) throw new BotError("Agent not found.", 404);
    return r;
  }

  /** The brains asked for: a list, or the older single key (null = the platform). Checked against the plan's number of brains; ownership of a key is checked by the API, which knows the member's vault. */
  private brainsIn(i: BotInput, max: number): string[] | undefined {
    const raw: unknown = i.brains !== undefined ? i.brains : i.brainKey === undefined ? undefined : i.brainKey === null || i.brainKey === "" ? [PLATFORM] : [i.brainKey];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new BotError("Pick the models it thinks with.");
    const list = [...new Set(raw.filter((x): x is string => typeof x === "string"))];
    if (list.length === 0 || list.some((x) => x !== PLATFORM && !/^[0-9a-f]{12}$/.test(x))) throw new BotError("Pick at least one model it thinks with.");
    if (list.length > max) throw new BotError(max === 1 ? "Your plan lets an agent think with one model. Upgrade for more." : `Your plan lets an agent think with up to ${max} models.`, 403);
    return list;
  }

  /** The ids of the member's skills their plan lets them use (the oldest `skillSlots`). */
  private usableSkills(): Set<string> {
    try {
      const rows = this.db.prepare("SELECT id FROM skills ORDER BY created_at, rowid").all() as Array<{ id: string }>;
      return new Set(rows.slice(0, LIMITS[this.tier].skillSlots).map((r) => r.id));
    } catch {
      return new Set(); // no skills table yet: no skills
    }
  }

  private clean(i: BotInput, exceptId?: string, mode0: unknown = i.mode): Clean {
    const lim = LIMITS[this.tier];
    const name = typeof i.name === "string" ? i.name.trim().replace(/\s+/g, " ") : "";
    if (!NAME_RE.test(name)) throw new BotError("Name: 2 to 24 letters, numbers, spaces, apostrophes or hyphens.");
    if (isReservedName(name)) throw new BotError("That name is reserved for the platform's official agents. Pick another.");
    const dup = this.db.prepare("SELECT id FROM bots WHERE lower(name) = lower(?)").get(name) as { id: string } | undefined;
    if (dup && dup.id !== exceptId) throw new BotError("You already have an agent with that name.");

    const theme = typeof i.theme === "string" ? themeById(i.theme) : undefined;
    if (!theme) throw new BotError("Pick a theme.");
    if (theme.tier === "pro" && !lim.proThemes) throw new BotError(`The ${theme.label} pack is for Pro members.`, 403);
    const avatar = typeof i.avatar === "string" ? avatarOf(theme.id, i.avatar) : undefined;
    if (!avatar) throw new BotError("Pick an avatar from that theme.");

    // Autonomous (Premium only): no style and no coin list to pick. It starts as Momentum, which takes any coin, and chooses
    // its own style from there. The mode is fixed when the agent is made: a fixed agent never turns autonomous, or the other way round.
    const mode: BotMode = mode0 === "autonomous" ? "autonomous" : mode0 === "skill" ? "skill" : "fixed";
    if (mode === "autonomous" && !lim.autonomy) throw new BotError("Autonomous agents are for Premium members.", 403);
    // Skill mode: it trades by one of the member's skills (it must exist and be within the plan's slots). The style is only the
    // frame the engine runs it in (Momentum takes any coin), so no style/coin pairing applies; the coins are still the member's choice.
    let skill: string | null = null;
    if (mode === "skill") {
      skill = typeof i.skill === "string" ? i.skill : null;
      if (!skill || !this.usableSkills().has(skill)) throw new BotError("Pick one of your skills (one that fits your plan's slots).", 400);
    }
    const style = mode === "autonomous" || mode === "skill" ? ("boozy" as const) : STYLES.find((s) => s === i.style);
    if (!style) throw new BotError("Pick a trading style.");
    if (mode === "fixed" && !lim.styles.includes(style)) throw new BotError("That style is for Pro members.", 403);

    const coinsIn = Array.isArray(i.coins) ? i.coins : [];
    let coins = [...new Set(coinsIn.filter((c): c is string => typeof c === "string").map((c) => c.toUpperCase()))];
    if (mode === "autonomous") coins = []; // empty means: any coin the market offers
    else {
      if (coins.length === 0 || coins.some((c) => !(COINS as readonly string[]).includes(c))) throw new BotError("Pick at least one coin from the list.");
      if (coins.length > lim.maxCoins) throw new BotError(`Your plan allows up to ${lim.maxCoins} coins per agent.`, 403);
      const mismatch = mode === "skill" ? null : styleCoinProblem(style, coins);
      if (mismatch) throw new BotError(mismatch);
    }

    const rules = typeof i.rules === "string" ? i.rules.trim() : "";
    if (rules.length < MIN_RULES || rules.length > MAX_RULES) throw new BotError(`Rules: ${MIN_RULES} to ${MAX_RULES} characters.`);
    // A tagline like "the sleepy dip hunter" and a few words on its looks (for the portrait), as in the admin panel.
    let tagline = typeof i.tagline === "string" ? i.tagline.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (tagline && !/^the\b/i.test(tagline)) tagline = `the ${tagline}`.slice(0, 40);
    const look = typeof i.look === "string" ? i.look.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    return { mode, skill, name, theme: theme.id, avatar: avatar.id, style, coins, rules, tagline, look, listed: typeof i.listed === "boolean" ? i.listed : undefined, brains: this.brainsIn(i, lim.brains) };
  }

  create(i: BotInput): BotView {
    const lim = LIMITS[this.tier];
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n;
    if (n >= lim.bots) throw new BotError(this.tier === "free" ? "The Free plan has one agent. Upgrade to Pro for more." : `You have reached ${lim.bots} agents.`, 403);
    const c = this.clean(i);
    const id = randomBytes(6).toString("hex");
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO bots (id, name, theme, avatar, style, coins, rules, tagline, look, listed, brains, mode, skill, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)").run(id, c.name, c.theme, c.avatar, c.style, JSON.stringify(c.coins), c.rules, c.tagline, c.look, c.listed === false ? 0 : 1, JSON.stringify(c.brains ?? [PLATFORM]), c.mode, c.skill, t);
      this.db.prepare("INSERT INTO bot_versions (bot_id, version, style, coins, rules, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, c.style, JSON.stringify(c.coins), c.rules, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    // The member's first bot is remembered for good: the platform's free AI help is for it alone.
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('first_bot', ?)").run(id);
    return toView(this.get(id));
  }

  get firstBotId(): string | null {
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'first_bot'").get() as { value: string } | undefined)?.value ?? null;
  }

  find(id: unknown): BotView {
    return toView(this.get(id));
  }

  setImage(id: unknown, has: boolean): void {
    this.db.prepare("UPDATE bots SET image = ? WHERE id = ?").run(has ? 1 : 0, this.get(id).id);
  }

  /** Name, theme and avatar change in place; a new style, coin set or rules text is a new version. */
  update(id: unknown, i: BotInput): BotView {
    const cur = this.get(id);
    if (cur.state === "quarantined") throw new BotError(QUARANTINED_MSG, 409);
    const c = this.clean({ ...i, skill: i.skill ?? cur.skill }, cur.id, cur.mode);
    // A different model is a different agent: its record starts again, so results stay comparable.
    const same = c.style === cur.style && c.rules === cur.rules && JSON.stringify(c.coins) === cur.coins && c.skill === cur.skill && (c.brains === undefined || JSON.stringify(c.brains) === JSON.stringify(brainsOf(cur)));
    const version = same ? cur.version : cur.version + 1;
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE bots SET name = ?, theme = ?, avatar = ?, style = ?, coins = ?, rules = ?, tagline = ?, look = ?, listed = ?, brains = ?, skill = ?, version = ? WHERE id = ?").run(c.name, c.theme, c.avatar, c.style, JSON.stringify(c.coins), c.rules, c.tagline, c.look, c.listed === undefined ? cur.listed : c.listed ? 1 : 0, JSON.stringify(c.brains ?? brainsOf(cur)), c.skill, version, cur.id);
      if (!same) this.db.prepare("INSERT INTO bot_versions (bot_id, version, style, coins, rules, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cur.id, version, c.style, JSON.stringify(c.coins), c.rules, t);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return toView(this.get(cur.id));
  }

  /** Pause keeps the positions under their stops and opens nothing new; resume undoes it. Stop closes everything and ends this run. */
  setState(id: unknown, to: BotState): BotView {
    const cur = this.get(id);
    if (cur.state === "quarantined") throw new BotError(QUARANTINED_MSG, 409);
    const from = cur.state as BotState;
    const ok = (from === "running" && (to === "paused" || to === "stopped")) || (from === "paused" && (to === "running" || to === "stopped"));
    if (!ok) throw new BotError(from === "stopped" ? "This agent is stopped. Start it again to run it." : `This agent is already ${from}.`, 409);
    this.db.prepare("UPDATE bots SET state = ? WHERE id = ?").run(to, cur.id);
    return toView(this.get(cur.id));
  }

  /** A stopped agent runs again as a new version: a fresh paper account, the old run kept in its history. */
  startAgain(id: unknown): BotView {
    const cur = this.get(id);
    if (cur.state === "quarantined") throw new BotError(QUARANTINED_MSG, 409);
    if (cur.state !== "stopped") throw new BotError("Only a stopped agent can be started again.", 409);
    const version = cur.version + 1;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE bots SET state = 'running', version = ? WHERE id = ?").run(version, cur.id);
      this.db.prepare("INSERT INTO bot_versions (bot_id, version, style, coins, rules, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(cur.id, version, cur.style, cur.coins, cur.rules, this.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return toView(this.get(cur.id));
  }

  /**
   * Brings the agents in line with the plan. The oldest agents the plan allows (by count and by style) stay; the rest go into
   * quarantine: stopped, off the board, kept for QUARANTINE_DAYS. Agents in quarantine that fit again (the member upgraded) are
   * restored as stopped, so nothing starts trading without the member pressing Start again. Returns what changed.
   */
  reconcile(now: number): { quarantined: string[]; restored: string[] } {
    const lim = LIMITS[this.tier];
    const rows = this.db.prepare("SELECT * FROM bots ORDER BY created_at, rowid").all() as unknown as Row[];
    const quarantined: string[] = [];
    const restored: string[] = [];
    let kept = 0;
    const usable = this.usableSkills();
    for (const r of rows) {
      const fits = (r.mode === "autonomous" ? lim.autonomy : r.mode === "skill" ? !!r.skill && usable.has(r.skill) : lim.styles.includes(r.style as StyleId)) && brainsOf(r).length <= lim.brains && kept < lim.bots;
      if (fits) kept++;
      if (fits && r.state === "quarantined") {
        this.db.prepare("UPDATE bots SET state = 'stopped', quarantined_at = NULL WHERE id = ?").run(r.id);
        restored.push(r.id);
      } else if (!fits && r.state !== "quarantined") {
        this.db.prepare("UPDATE bots SET state = 'quarantined', quarantined_at = ? WHERE id = ?").run(now, r.id);
        quarantined.push(r.id);
      }
    }
    return { quarantined, restored };
  }

  /** Deletes the agents whose quarantine is over. Returns their ids so the caller can remove their portraits and ranking rows. */
  purgeQuarantined(now: number): string[] {
    const cutoff = now - QUARANTINE_DAYS * 86_400_000;
    const ids = (this.db.prepare("SELECT id FROM bots WHERE state = 'quarantined' AND quarantined_at IS NOT NULL AND quarantined_at <= ?").all(cutoff) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      this.db.prepare("DELETE FROM bot_versions WHERE bot_id = ?").run(id);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    }
    return ids;
  }

  /** Pauses every running agent (the Home's "Pause all"), or resumes every paused one. Returns how many changed. */
  setAll(to: "paused" | "running"): number {
    const from = to === "paused" ? "running" : "paused";
    return Number(this.db.prepare("UPDATE bots SET state = ? WHERE state = ?").run(to, from).changes);
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
