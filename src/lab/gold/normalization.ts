// Parameter normalisation. Distances in a profile are written at a reference gold price (and reference volatility);
// a fixed dollar distance means something very different at 1800 and at 5000, so they are scaled to the market.
import type { Candle } from "../../market/types.js";
import * as S from "../series.js";
import type { NormalizationConfig } from "./types.js";

export interface ScaleInputs {
  price: number;
  /** ATR (price units) on the strategy's entry timeframe now, or null if not ready. */
  atr: number | null;
  /** ATR at the reference (see referenceAtr), or null. */
  refAtr: number | null;
}

/** The factor every base distance is multiplied by. */
export function scaleFactor(n: Pick<NormalizationConfig, "mode" | "reference_gold_price" | "price_weight" | "atr_weight" | "scale_min" | "scale_max">, i: ScaleInputs): number {
  const priceScale = n.reference_gold_price > 0 && i.price > 0 ? i.price / n.reference_gold_price : 1;
  const volScale = i.atr !== null && i.refAtr !== null && i.refAtr > 0 && Number.isFinite(i.atr) ? i.atr / i.refAtr : null;
  let f = 1;
  if (n.mode === "PRICE_RATIO") f = priceScale;
  else if (n.mode === "ATR") f = volScale ?? 1;
  else if (n.mode === "HYBRID") {
    const w = n.price_weight + n.atr_weight;
    // Without a usable ATR the hybrid falls back to its price half rather than to nothing.
    f = w > 0 && volScale !== null ? (n.price_weight * priceScale + n.atr_weight * volScale) / w : priceScale;
  }
  return Math.min(n.scale_max, Math.max(n.scale_min, f));
}

/**
 * The reference ATR when a profile gives none: the median ATR over the first `windowBars` bars after the indicator is
 * ready. It uses only data at the very start of the series, so it never looks at the period being tested.
 */
export function referenceAtr(bars: Candle[], period: number, windowBars = 500): number | null {
  const a = S.atr(bars, period);
  const vals: number[] = [];
  for (let i = period; i < Math.min(bars.length, period + windowBars); i++) if (Number.isFinite(a[i]!)) vals.push(a[i]!);
  if (!vals.length) return null;
  vals.sort((x, y) => x - y);
  return vals[Math.floor(vals.length / 2)]!;
}
