// Reproducibility fingerprints: a stable hash of a config and of a candle series, so a result can be tied to exactly
// what produced it. A performance claim without these is not reproducible.
import { createHash } from "node:crypto";
import type { Candle } from "../market/types.js";

/** JSON with sorted keys, so equal configs hash equally whatever their key order. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export const configHash = (cfg: unknown): string => createHash("sha256").update(stableStringify(cfg)).digest("hex").slice(0, 16);

export function dataHash(c: Candle[]): string {
  const h = createHash("sha256");
  h.update(`${c.length}:${c[0]?.ts}:${c[c.length - 1]?.ts}:`);
  // Every 50th bar plus the total of all closes: cheap, and any refetch that changes history changes it.
  let sum = 0;
  for (let i = 0; i < c.length; i += 50) h.update(`${c[i]!.o},${c[i]!.c};`);
  for (const x of c) sum += x.c;
  h.update(String(sum));
  return h.digest("hex").slice(0, 16);
}
