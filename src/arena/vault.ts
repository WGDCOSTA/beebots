// The key vault: a member's own model keys, so an agent can think with the member's model and the member's bill.
// Rules: a secret is encrypted before it is stored (AES-256-GCM, a master key that lives outside the database, and the
// ciphertext bound to the member and the key so it cannot be moved to another row); it is write-only (no route ever sends
// it back, only the last four characters); it is decrypted only by the runner, at the moment an agent starts; and it never
// appears in a log or an error. Without a master key the vault is closed and nothing can be stored.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ClaudeBrain, OpenAiBrain, ZaiBrain, KimiBrain, type LlmClient } from "../brains/llm.js";
import { z } from "zod";

export const PROVIDERS = ["openai", "claude", "zai", "kimi"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const DEFAULT_MODEL: Record<Provider, string> = { openai: "gpt-5.4-nano", claude: "claude-haiku-4-5-20251001", zai: "glm-5.3", kimi: "kimi-k2.5" };
/** A rough price per million tokens (input and output together) for the member's own ceiling. It is an estimate: a dearer model costs more than it says. */
export const EST_USD_PER_MTOK: Record<Provider, number> = { openai: 0.5, claude: 3, zai: 1, kimi: 1 };
export const MAX_KEYS = 5;
const MODEL_RE = /^[\w.:/-]{1,60}$/;

export class VaultError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface KeyView {
  id: string;
  provider: Provider;
  label: string;
  model: string;
  /** The last four characters, to tell keys apart. Never more. */
  last4: string;
  /** The member's own daily spend ceiling for agents on this key, in USD; null means none. */
  dailyUsd: number | null;
  createdAt: number;
}

export interface KeyInput {
  provider?: unknown;
  label?: unknown;
  secret?: unknown;
  model?: unknown;
  dailyUsd?: unknown;
}

/** Builds the model client for a provider. */
export function brainFor(provider: Provider, secret: string, model: string): LlmClient {
  if (provider === "openai") return new OpenAiBrain(secret, model, 60_000);
  if (provider === "claude") return new ClaudeBrain({ apiKey: secret }, model, "low", 60_000);
  if (provider === "zai") return new ZaiBrain(secret, model);
  return new KimiBrain(secret, model);
}

/** Asks the provider for a one-word answer: proves the key works, for a few tokens. A fake in tests. */
export type Verifier = (provider: Provider, secret: string, model: string) => Promise<void>;
export const liveVerifier: Verifier = async (provider, secret, model) => {
  const llm = brainFor(provider, secret, model);
  await llm.json({ system: "Answer with JSON.", user: "Say ok.", name: "ping", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }, validate: z.object({ ok: z.boolean() }), maxTokens: 50 });
};

export class Vault {
  private readonly key: Buffer | null;
  /** masterKey: 32 bytes as base64 or hex; null or invalid closes the vault. */
  constructor(masterKey: string | null | undefined, private readonly verify: Verifier = liveVerifier, readonly brain: (provider: Provider, secret: string, model: string) => LlmClient = brainFor) {
    let k: Buffer | null = null;
    if (masterKey) {
      const b = /^[0-9a-f]{64}$/i.test(masterKey) ? Buffer.from(masterKey, "hex") : Buffer.from(masterKey, "base64");
      if (b.length === 32) k = b;
    }
    this.key = k;
  }

  get open(): boolean {
    return this.key !== null;
  }

  private seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key!, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }

  private unseal(blob: string, aad: string): string {
    const b = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", this.key!, b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  }

  /** The member's keys, in their own database. */
  for(db: DatabaseSync, userId: string, now: () => number = Date.now): MemberKeys {
    db.exec("CREATE TABLE IF NOT EXISTS member_keys (id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, model TEXT NOT NULL, last4 TEXT NOT NULL, daily_usd REAL, sealed TEXT NOT NULL, created_at INTEGER NOT NULL)");
    return new MemberKeys(this, db, userId, now);
  }

  /** @internal used by MemberKeys */
  _verify = (p: Provider, s: string, m: string) => this.verify(p, s, m);
  /** @internal */
  _seal = (plain: string, aad: string) => this.seal(plain, aad);
  /** @internal */
  _unseal = (blob: string, aad: string) => this.unseal(blob, aad);
}

interface Row {
  id: string;
  provider: string;
  label: string;
  model: string;
  last4: string;
  daily_usd: number | null;
  sealed: string;
  created_at: number;
}
const view = (r: Row): KeyView => ({ id: r.id, provider: r.provider as Provider, label: r.label, model: r.model, last4: r.last4, dailyUsd: r.daily_usd, createdAt: r.created_at });

export class MemberKeys {
  constructor(private readonly vault: Vault, private readonly db: DatabaseSync, private readonly userId: string, private readonly now: () => number) {}

  list(): KeyView[] {
    return (this.db.prepare("SELECT * FROM member_keys ORDER BY created_at, rowid").all() as unknown as Row[]).map(view);
  }

  has(id: unknown): boolean {
    return typeof id === "string" && !!this.db.prepare("SELECT 1 FROM member_keys WHERE id = ?").get(id);
  }

  async add(i: KeyInput): Promise<KeyView> {
    if (!this.vault.open) throw new VaultError("Your own model keys are not open yet.", 503);
    const provider = PROVIDERS.find((p) => p === i.provider);
    if (!provider) throw new VaultError("Pick a provider.");
    const secret = typeof i.secret === "string" ? i.secret.trim() : "";
    if (secret.length < 12 || secret.length > 400 || /\s/.test(secret)) throw new VaultError("That does not look like an API key.");
    const label = typeof i.label === "string" ? i.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!label) throw new VaultError("Give the key a name you will recognise.");
    const model = typeof i.model === "string" && i.model.trim() ? i.model.trim() : DEFAULT_MODEL[provider];
    if (!MODEL_RE.test(model)) throw new VaultError("That model name is not valid.");
    let dailyUsd: number | null = null;
    if (i.dailyUsd !== undefined && i.dailyUsd !== null && i.dailyUsd !== "") {
      dailyUsd = Number(i.dailyUsd);
      if (!Number.isFinite(dailyUsd) || dailyUsd < 0.05 || dailyUsd > 10_000) throw new VaultError("A daily ceiling is between 0.05 and 10000 USD.");
    }
    if (this.list().length >= MAX_KEYS) throw new VaultError(`You can keep up to ${MAX_KEYS} keys.`, 409);
    try {
      await this.vault._verify(provider, secret, model);
    } catch {
      // Never repeat the provider's answer: it can echo part of the key.
      throw new VaultError("The provider did not accept that key and model. Check both and try again.", 422);
    }
    const id = randomBytes(6).toString("hex");
    this.db.prepare("INSERT INTO member_keys (id, provider, label, model, last4, daily_usd, sealed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, provider, label, model, secret.slice(-4), dailyUsd, this.vault._seal(secret, `${this.userId}:${id}`), this.now());
    return view(this.db.prepare("SELECT * FROM member_keys WHERE id = ?").get(id) as unknown as Row);
  }

  remove(id: unknown): void {
    if (typeof id !== "string") throw new VaultError("Key not found.", 404);
    const n = Number(this.db.prepare("DELETE FROM member_keys WHERE id = ?").run(id).changes);
    if (n === 0) throw new VaultError("Key not found.", 404);
  }

  /** The decrypted secret, for the runner only. Null when the key is gone or the vault is closed or the row was tampered with. */
  secret(id: string): { provider: Provider; model: string; secret: string; dailyUsd: number | null } | null {
    if (!this.vault.open) return null;
    const r = this.db.prepare("SELECT * FROM member_keys WHERE id = ?").get(id) as unknown as Row | undefined;
    if (!r) return null;
    try {
      return { provider: r.provider as Provider, model: r.model, secret: this.vault._unseal(r.sealed, `${this.userId}:${r.id}`), dailyUsd: r.daily_usd };
    } catch {
      return null;
    }
  }
}
