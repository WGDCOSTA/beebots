// Specialisation: each bee's brains may choose the method the bee trades, freely: any built-in style its market allows,
// or any backtested lab skill (built-in, imported, or one a bee wrote itself). The chosen skill then generates the
// bee's entries and exits live (bees/skill.ts); the engine switches only while the bee is flat (engine.ts).
import { z } from "zod";
import type { Ranking } from "../lab/tournament.js";

/** Answer fragment every council carries: keep the current method, or pick a style or a skill. */
export const SPECIALIZATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "reason"],
  description: "The method this bee should specialise in: kind 'keep' (no change), 'style' (id from methodOptions.styles) or 'skill' (id from methodOptions.skills)",
  properties: { kind: { type: "string", enum: ["keep", "style", "skill"] }, id: { type: "string" }, reason: { type: "string" } },
} as const;

export const SpecializationPick = z.object({ kind: z.enum(["keep", "style", "skill"]), id: z.string().max(80), reason: z.string().max(400) });
export type SpecializationPickT = z.infer<typeof SpecializationPick>;

export const SPECIALIZATION_PROMPT =
  "You are free to choose this bee's SPECIALISATION: the method it trades. Keep its current method, switch to another style, or specialise in any skill from methodOptions.skills " +
  "(walk-forward out-of-sample results; a skill you pick generates the bee's live entries and exits). Choose on evidence: out-of-sample score, stability, drawdown and the bee's real record. " +
  "The bee switches only when flat and not too often, so switch for a clear edge, not noise.";

export interface MethodOptions {
  current: { kind: "own" | "style" | "skill"; id: string };
  styles: string[];
  skills: Array<{ id: string; family: string; score: number; stabilityPct: number; oosReturnPct: number; maxDrawdownPct: number; params: Record<string, number> }>;
}

/** What a bee may specialise in: its market's styles, and the lab's positive, reasonably stable skills. */
export function methodOptions(o: { market: string; current: MethodOptions["current"]; ranking: Ranking | null; extraSkills?: string[]; limit?: number }): MethodOptions {
  const styles = o.market === "crypto" ? ["bizzy", "breezy", "boozy"] : ["macro"];
  const skills = (o.ranking?.results ?? [])
    .filter((r) => r.family !== "benchmark" && r.score > 0 && r.stabilityPct >= 40)
    .slice(0, o.limit ?? 10)
    .map((r) => ({
      id: r.skillId,
      family: r.family,
      score: +r.score.toFixed(2),
      stabilityPct: Math.round(r.stabilityPct),
      oosReturnPct: +r.oos.returnPct.toFixed(1),
      maxDrawdownPct: +r.oos.maxDrawdownPct.toFixed(1),
      params: r.params,
    }));
  return { current: o.current, styles, skills };
}

/** A pick, checked against the options: null for "keep" or anything not on offer. */
export function resolvePick(pick: SpecializationPickT | undefined, opts: MethodOptions, now: number): { kind: "style" | "skill"; id: string; params: Record<string, number>; reason: string; decidedAt: number } | null {
  if (!pick || pick.kind === "keep") return null;
  if (pick.kind === "style" && opts.styles.includes(pick.id)) return { kind: "style", id: pick.id, params: {}, reason: pick.reason.slice(0, 300), decidedAt: now };
  if (pick.kind === "skill") {
    const s = opts.skills.find((x) => x.id === pick.id);
    if (s) return { kind: "skill", id: s.id, params: s.params, reason: pick.reason.slice(0, 300), decidedAt: now };
  }
  return null;
}
