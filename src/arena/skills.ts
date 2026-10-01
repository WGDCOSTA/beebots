// A member's skills: the rule sets an agent can trade by. A skill is data, never code: either a reference to a skill in the
// platform's library, or the member's own rules in the Lab's JSON rule language (lab/skills/dsl.ts), which is validated and
// compiled by the same code that checks the owner's skills, so a member's skill can only compare indicators and open or close
// a position. The slots of a plan limit how many skills a member keeps; the oldest ones (by when they were added) are the ones
// that stay usable if a downgrade leaves more than the plan allows, and the rest come back on an upgrade.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { skillFromSpec, type Skill } from "../lab/skills/index.js";
import { LIMITS } from "./bots.js";
import type { Tier } from "./store.js";

export const MAX_SPEC_BYTES = 6_000;

export class SkillError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface SkillView {
  id: string;
  kind: "lib" | "own";
  name: string;
  family: string;
  description: string;
  /** Beyond the plan's slots after a downgrade: kept, but no agent can use it until the plan allows it again. */
  locked: boolean;
  createdAt: number;
}

/** What the library offers a member (no code, no parameters: just what a person needs to choose). */
export interface LibraryEntry {
  id: string;
  name: string;
  family: string;
  description: string;
}

interface Row {
  id: string;
  kind: string;
  ref: string | null;
  spec: string | null;
  name: string;
  family: string;
  description: string;
  created_at: number;
}

const SQL = "CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT, spec TEXT, name TEXT NOT NULL, family TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)";

export function libraryOf(skills: readonly Skill[]): LibraryEntry[] {
  return skills.map((s) => ({ id: s.id, name: s.name, family: s.family, description: s.description })).sort((a, b) => a.name.localeCompare(b.name));
}

export class SkillBank {
  constructor(private readonly db: DatabaseSync, private readonly tier: Tier, private readonly library: readonly Skill[], private readonly now: () => number = Date.now) {
    db.exec(SQL);
  }

  get slots(): number {
    return LIMITS[this.tier].skillSlots;
  }

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM skills ORDER BY created_at, rowid").all() as unknown as Row[];
  }

  list(): SkillView[] {
    return this.rows().map((r, i) => ({ id: r.id, kind: r.kind === "lib" ? "lib" : "own", name: r.name, family: r.family, description: r.description, locked: i >= this.slots, createdAt: r.created_at }));
  }

  /** The ids an agent may use right now. */
  usableIds(): Set<string> {
    return new Set(this.list().filter((s) => !s.locked).map((s) => s.id));
  }

  private room(): void {
    if (this.rows().length >= this.slots) throw new SkillError(`Your plan has ${this.slots} skill slots and they are all used. Remove one, or upgrade.`, 403);
  }

  /** Keeps a skill from the platform's library in the member's slots. */
  addFromLibrary(libId: unknown): SkillView {
    const s = typeof libId === "string" ? this.library.find((x) => x.id === libId) : undefined;
    if (!s) throw new SkillError("That skill is not in the library.", 404);
    if (this.rows().some((r) => r.kind === "lib" && r.ref === s.id)) throw new SkillError("You already have that skill.", 409);
    this.room();
    return this.insert({ kind: "lib", ref: s.id, spec: null, name: s.name, family: s.family, description: s.description });
  }

  /** Keeps the member's own rules. `spec` is the JSON of the Lab's rule language, as text or as an object. */
  addOwn(spec: unknown): SkillView {
    let obj: unknown = spec;
    if (typeof spec === "string") {
      if (Buffer.byteLength(spec) > MAX_SPEC_BYTES) throw new SkillError("That skill is too long.");
      try {
        obj = JSON.parse(spec);
      } catch {
        throw new SkillError("That is not valid JSON.");
      }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new SkillError("A skill is one JSON object.");
    const text = JSON.stringify(obj);
    if (Buffer.byteLength(text) > MAX_SPEC_BYTES) throw new SkillError("That skill is too long.");
    let s: Skill;
    try {
      s = skillFromSpec(obj, "member");
    } catch (e) {
      throw new SkillError((e as Error).message.slice(0, 300));
    }
    if (this.rows().some((r) => r.kind === "own" && r.name.toLowerCase() === s.name.toLowerCase())) throw new SkillError("You already have a skill with that name.", 409);
    this.room();
    return this.insert({ kind: "own", ref: null, spec: text, name: s.name, family: s.family, description: s.description });
  }

  private insert(r: { kind: "lib" | "own"; ref: string | null; spec: string | null; name: string; family: string; description: string }): SkillView {
    const id = randomBytes(6).toString("hex");
    const t = this.now();
    this.db.prepare("INSERT INTO skills (id, kind, ref, spec, name, family, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, r.kind, r.ref, r.spec, r.name, r.family, r.description, t);
    return { id, kind: r.kind, name: r.name, family: r.family, description: r.description, locked: false, createdAt: t };
  }

  remove(id: unknown): void {
    if (typeof id !== "string" || Number(this.db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes) === 0) throw new SkillError("Skill not found.", 404);
  }

  /** The compiled skill behind a row, or null when it is gone, locked, or its library skill no longer exists. Used by the runner. */
  resolve(id: string, opts: { allowLocked?: boolean } = {}): Skill | null {
    const r = this.rows().find((x) => x.id === id);
    if (!r) return null;
    if (!opts.allowLocked && !this.usableIds().has(id)) return null;
    try {
      if (r.kind === "lib") return this.library.find((s) => s.id === r.ref) ?? null;
      return skillFromSpec(JSON.parse(r.spec ?? "{}"), "member");
    } catch {
      return null;
    }
  }
}
