// The platform's own AI help, for a member's FIRST bot only: describe it in a sentence and the Arena designs it (name,
// tagline, rules, coins, style, look) with the platform's default model, then paints its portrait. It is paid by the
// platform, so it is bounded three ways: a few tries per member for life, only while they have no bot (design) or only for
// their first bot (portrait), and a daily budget across the whole platform. Everything after the first bot uses the
// member's own keys, which arrive with the key vault.
import type { DatabaseSync } from "node:sqlite";
import { deriveStyle } from "../bees/custom.js";
import { DesignError, finishDesign } from "../setup.js";
import type { BeeDesign } from "../openai.js";
import { designBee, paintBee } from "../openai.js";
import { COINS, LIMITS, STYLE_COINS, styleCoinProblem, type BotInput } from "./bots.js";
import type { Tier } from "./store.js";

export interface AiService {
  design(description: string, coins: string[]): Promise<BeeDesign>;
  paint(name: string, look: string): Promise<Buffer>;
}

export class PlatformAi implements AiService {
  constructor(private readonly o: { apiKey: string; textModel: string; imageModel: string; refDir: string }) {}
  design(description: string, coins: string[]): Promise<BeeDesign> {
    return designBee(this.o.apiKey, this.o.textModel, description, coins);
  }
  paint(name: string, look: string): Promise<Buffer> {
    return paintBee(this.o.apiKey, this.o.imageModel, this.o.refDir, name, look);
  }
}

export const AI_CREDITS = { designs: 3, portraits: 2 } as const;

export class AiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface AiStatus {
  /** The platform has AI help switched on. */
  enabled: boolean;
  designsLeft: number;
  portraitsLeft: number;
  /** A sentence can be turned into a bot now (the member has no bot yet). */
  canDesign: boolean;
  /** The bot whose portrait the platform may paint, if any. */
  portraitBotId: string | null;
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export class MemberAi {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tier: Tier,
    private readonly ai: AiService | null,
    private readonly opts: { now: () => number; dailyLimit: number; today: (day: string, add?: number) => number },
  ) {}

  private used(key: string): number {
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? 0);
  }
  private bump(key: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(key);
  }
  private botCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM bots").get() as { n: number }).n;
  }
  /** The id of the member's first bunny, remembered for good even after it is deleted. */
  private firstBotId(): string | null {
    return (this.db.prepare("SELECT value FROM meta WHERE key = 'first_bot'").get() as { value: string } | undefined)?.value ?? null;
  }
  private firstBot(): { id: string; image: number } | null {
    const id = this.firstBotId();
    if (!id) return null;
    return (this.db.prepare("SELECT id, image FROM bots WHERE id = ?").get(id) as { id: string; image: number } | undefined) ?? null;
  }

  status(): AiStatus {
    const first = this.firstBot();
    const designsLeft = Math.max(0, AI_CREDITS.designs - this.used("ai_designs"));
    const portraitsLeft = Math.max(0, AI_CREDITS.portraits - this.used("ai_portraits"));
    return {
      enabled: this.ai !== null,
      designsLeft,
      portraitsLeft,
      canDesign: this.ai !== null && designsLeft > 0 && this.botCount() === 0 && this.firstBotId() === null,
      portraitBotId: this.ai !== null && portraitsLeft > 0 && first ? first.id : null,
    };
  }

  private spend(): void {
    const day = dayKey(this.opts.now());
    if (this.opts.today(day) >= this.opts.dailyLimit) throw new AiError("The free AI help has reached its limit for today. Fill the form in yourself, or try again tomorrow.", 503);
    this.opts.today(day, 1);
  }

  /** A sentence in, a form's worth of fields out. The member still reads it and presses Create. */
  async design(descriptionRaw: unknown): Promise<BotInput & { note?: string }> {
    const st = this.status();
    if (!this.ai) throw new AiError("AI help is not switched on here.", 503);
    if (!st.canDesign) throw new AiError(st.designsLeft === 0 ? "You used your free AI tries. Fill the form in yourself." : "AI design is for your first bunny only.", 403);
    const description = typeof descriptionRaw === "string" ? descriptionRaw.trim() : "";
    if (description.length < 8 || description.length > 400) throw new AiError("Describe your bunny in 8 to 400 characters.", 400);
    this.spend();
    let raw: BeeDesign;
    try {
      raw = await this.ai.design(description, [...COINS]);
    } catch {
      // The provider failed, not the member: the platform's budget is spent, their free try is not.
      throw new AiError("The designer is busy. Try again in a moment.", 502);
    }
    this.bump("ai_designs");
    try {
      return this.fit(finishDesign(raw, [...COINS]));
    } catch (e) {
      if (e instanceof DesignError) throw new AiError(e.message, 422);
      throw e;
    }
  }

  /** Makes a design fit the member's plan, saying so when something had to change. */
  private fit(d: BeeDesign): BotInput & { note?: string } {
    const lim = LIMITS[this.tier];
    let coins = d.coins.filter((c) => (COINS as readonly string[]).includes(c)).slice(0, lim.maxCoins);
    let style = deriveStyle(d.baseStyle, coins);
    const notes: string[] = [];
    if (d.styleNote) notes.push(d.styleNote);
    if (!lim.styles.includes(style)) {
      // Free members run the simple styles: keep the coins the designer wanted if a simple style can take them.
      const simple = lim.styles.find((s) => !styleCoinProblem(s, coins.length ? coins : ["BTC"]));
      if (simple) style = simple;
      else {
        style = lim.styles[0]!;
        const only = STYLE_COINS[style] ?? [];
        coins = coins.filter((c) => only.includes(c));
        notes.push(`The Free plan runs simple styles, so this bunny trades ${coins.length ? coins.join(", ") : only.slice(0, 1).join("")} on ${style === "breezy" ? "Trend" : "Breakout"}. Pro members can use any coin.`);
      }
    }
    if (coins.length === 0) coins = [STYLE_COINS[style]?.[0] ?? "BTC"];
    return { name: d.name, tagline: d.tagline, rules: d.rules, coins, style, look: d.look, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  /** Paints the portrait for the member's first bot. Returns the JPEG; the caller stores it. */
  async paint(bot: { id: string; name: string; look: string }): Promise<Buffer> {
    const st = this.status();
    if (!this.ai) throw new AiError("AI help is not switched on here.", 503);
    if (st.portraitBotId !== bot.id) throw new AiError(st.portraitsLeft === 0 ? "You used your free portraits." : "The free portrait is for your first bunny.", 403);
    this.spend();
    let jpg: Buffer;
    try {
      jpg = await this.ai.paint(bot.name, bot.look || `a cartoon bunny called ${bot.name}`);
    } catch {
      throw new AiError("The painter is busy. Try again in a moment.", 502);
    }
    this.bump("ai_portraits");
    return jpg;
  }
}
