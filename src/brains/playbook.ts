// The playbook: which backtested skills each bee leans on, with what weight, and why. Written by the council (and
// re-weighted by the coach), read by the engine to give Jev a per-coin "lab" vote. One JSON file in the lab folder.
import { existsSync, readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { writePrivateJson } from "../settings.js";
import { BRAINS } from "./llm.js";

export const NATURAL_FAMILY: Record<string, string> = { bizzy: "breakout", breezy: "trend", boozy: "momentum" };

const PlaybookSkill = z.object({
  id: z.string(),
  params: z.record(z.number()),
  weight: z.number().min(0).max(1),
  reason: z.string().default(""),
  score: z.number().default(0),
});
export type PlaybookSkill = z.infer<typeof PlaybookSkill>;

const BeePlan = z.object({
  // "ensemble": several brains combined in a survival or reward council (brains/survival.ts).
  brain: z.union([z.enum(BRAINS), z.literal("rules"), z.literal("ensemble")]),
  model: z.string(),
  skills: z.array(PlaybookSkill).max(6),
  lessons: z.array(z.string()).max(10).default([]),
  message: z.string().default(""),
  decidedAt: z.number(),
  // The coins the brains chose for this bee (brains/watchlist.ts). Absent = the style's normal coin choice.
  watchlist: z
    .array(z.object({ coin: z.string(), reason: z.string().default(""), probation: z.boolean().default(false), addedAt: z.number().optional() }))
    .max(12)
    .optional(),
});
export type BeePlan = z.infer<typeof BeePlan>;

export const PlaybookSchema = z.object({
  version: z.literal(1),
  updatedAt: z.number(),
  rankingAt: z.number(),
  bees: z.record(BeePlan),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

export function loadPlaybook(path: string): Playbook | null {
  if (!existsSync(path)) return null;
  const r = PlaybookSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  return r.success ? r.data : null;
}

export function savePlaybook(path: string, p: Playbook): void {
  writePrivateJson(path, p);
}

/** Re-reads the file only when it changed on disk (the lab CLI and the coach write it while the engine runs). */
export class PlaybookWatcher {
  private mtime = -1;
  private cached: Playbook | null = null;
  constructor(private path: string) {}
  get(): Playbook | null {
    try {
      const m = existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
      if (m !== this.mtime) {
        this.mtime = m;
        this.cached = m ? loadPlaybook(this.path) : null;
      }
    } catch {
      /* keep the last good copy */
    }
    return this.cached;
  }
}
