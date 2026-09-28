// Seeded synthetic candles for the lab tests: they exercise the code paths, they prove nothing about a market.
import { rng } from "../src/lab/history.js";
import type { Candle } from "../src/market/types.js";

/** Gaussian returns of `volBps` per bar with AR(1) coefficient `phi` (momentum if > 0, reversion if < 0). */
export function walk(seed: number, bars: number, volBps: number, phi = 0, barMs = 60_000, startPx = 3000, t0 = Date.UTC(2026, 0, 1)): Candle[] {
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
    out.push({ ts: t0 + i * barMs, o, h: Math.max(o, c) + w, l: Math.min(o, c) - w, c, volUsd: 1e6 * (1 + r() * (1 + Math.abs(ret) / (volBps / 1e4))), confirmed: true });
    px = c;
  }
  return out;
}

/** n identical bars around `px` with a fixed high-low range (so ATR is exactly the range). */
export function flat(n: number, px = 100, range = 0.2, t0 = Date.UTC(2026, 0, 1), barMs = 60_000): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ ts: t0 + i * barMs, o: px, h: px + range / 2, l: px - range / 2, c: px, volUsd: 1e6, confirmed: true }));
}

/** Overwrite fields of one bar. */
export function set(c: Candle[], i: number, patch: Partial<Candle>): Candle[] {
  c[i] = { ...c[i]!, ...patch };
  return c;
}
