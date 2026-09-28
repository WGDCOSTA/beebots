// A seeded random walk for the CLI demo and offline runs. It exercises the code and proves nothing about gold.
import { rng } from "../../history.js";
import type { Candle } from "../../../market/types.js";

/** Gaussian returns of `volBps` per bar with AR(1) coefficient `phi` (momentum if > 0). */
export function walk(seed: number, bars: number, volBps: number, phi = 0, barMs = 300_000, startPx = 2500, t0 = Date.UTC(2024, 0, 1)): Candle[] {
  const r = rng(seed);
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  const out: Candle[] = [];
  let px = startPx;
  let prev = 0;
  for (let i = 0; i < bars; i++) {
    const ret = phi * prev + (volBps / 1e4) * g();
    prev = ret;
    const o = px;
    const c = o * Math.exp(ret);
    const w = Math.abs((volBps / 1e4) * g()) * o * 0.5;
    out.push({ ts: t0 + i * barMs, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, volUsd: 0, confirmed: true });
    px = c;
  }
  return out;
}
