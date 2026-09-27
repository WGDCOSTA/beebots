import { BUILTIN_SKILLS } from "./library.js";
import { loadSkillDir } from "./dsl.js";
import type { Skill } from "./types.js";

export * from "./types.js";
export { BUILTIN_SKILLS } from "./library.js";
export { loadSkillDir, skillFromSpec, skillsFromJson, SkillSpecSchema } from "./dsl.js";

/** Built-in skills plus every imported skill in `dirs`. An imported skill with a built-in's id replaces it. */
export function skillRegistry(dirs: string[] = []): { skills: Skill[]; errors: string[] } {
  const byId = new Map(BUILTIN_SKILLS.map((s) => [s.id, s]));
  const errors: string[] = [];
  for (const d of dirs) {
    const r = loadSkillDir(d);
    errors.push(...r.errors);
    for (const s of r.skills) byId.set(s.id, s);
  }
  return { skills: [...byId.values()], errors };
}
