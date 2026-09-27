// Built-in trading skills: classic, well-documented rules from each family. None of them is advice; they are
// hypotheses the tournament tests on history before any bee may lean on one.
import type { Candle } from "../../market/types.js";
import * as S from "../series.js";
import { positions, type Params, type Skill } from "./types.js";

const DAY = 86_400_000;
const both = (p: Params) => (p.shorts ?? 1) >= 1;

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: "buy_hold",
    name: "Buy and hold",
    family: "benchmark",
    description: "Long from the first bar to the last. The bar every other skill must clear.",
    defaults: {},
    grid: {},
    source: "builtin",
    signal: (c) => new Int8Array(c.length).fill(1),
  },
  {
    id: "sma_cross",
    name: "SMA crossover",
    family: "trend",
    description: "Long while the fast simple average is above the slow one, short while below.",
    defaults: { fast: 20, slow: 50, shorts: 1 },
    grid: { fast: [10, 20, 30], slow: [50, 100, 200], shorts: [0, 1] },
    valid: (p) => p.fast! < p.slow!,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const f = S.sma(x, p.fast!);
      const s = S.sma(x, p.slow!);
      return positions(c.length, {
        longEntry: (i) => f[i]! > s[i]!,
        longExit: (i) => f[i]! < s[i]!,
        shortEntry: both(p) ? (i) => f[i]! < s[i]! : undefined,
        shortExit: (i) => f[i]! > s[i]!,
      });
    },
  },
  {
    id: "ema_cross",
    name: "EMA crossover",
    family: "trend",
    description: "Faster-reacting crossover on exponential averages.",
    defaults: { fast: 12, slow: 26, shorts: 1 },
    grid: { fast: [8, 12, 21], slow: [26, 55, 89], shorts: [0, 1] },
    valid: (p) => p.fast! < p.slow!,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const f = S.ema(x, p.fast!);
      const s = S.ema(x, p.slow!);
      return positions(c.length, {
        longEntry: (i) => f[i]! > s[i]!,
        longExit: (i) => f[i]! < s[i]!,
        shortEntry: both(p) ? (i) => f[i]! < s[i]! : undefined,
        shortExit: (i) => f[i]! > s[i]!,
      });
    },
  },
  {
    id: "triple_ema",
    name: "Triple EMA stack",
    family: "trend",
    description: "Long only when fast > mid > slow EMA (a clean stack), short on the mirror; flat when tangled.",
    defaults: { fast: 9, mid: 21, slow: 55, shorts: 1 },
    grid: { fast: [5, 9], mid: [21, 34], slow: [55, 100], shorts: [0, 1] },
    valid: (p) => p.fast! < p.mid! && p.mid! < p.slow!,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const f = S.ema(x, p.fast!);
      const m = S.ema(x, p.mid!);
      const s = S.ema(x, p.slow!);
      const up = (i: number) => f[i]! > m[i]! && m[i]! > s[i]!;
      const dn = (i: number) => f[i]! < m[i]! && m[i]! < s[i]!;
      return positions(c.length, { longEntry: up, longExit: (i) => !up(i), shortEntry: both(p) ? dn : undefined, shortExit: (i) => !dn(i) });
    },
  },
  {
    id: "macd_trend",
    name: "MACD histogram",
    family: "trend",
    description: "Long while the MACD histogram is positive, short while negative.",
    defaults: { fast: 12, slow: 26, sig: 9, shorts: 1 },
    grid: { fast: [8, 12], slow: [26, 34], sig: [9], shorts: [0, 1] },
    valid: (p) => p.fast! < p.slow!,
    source: "builtin",
    signal(c, p) {
      const h = S.macd(S.closes(c), p.fast, p.slow, p.sig).hist;
      return positions(c.length, {
        longEntry: (i) => h[i]! > 0,
        longExit: (i) => h[i]! < 0,
        shortEntry: both(p) ? (i) => h[i]! < 0 : undefined,
        shortExit: (i) => h[i]! > 0,
      });
    },
  },
  {
    id: "supertrend",
    name: "Supertrend",
    family: "trend",
    description: "ATR band that flips with the trend; ride the band's direction.",
    defaults: { n: 10, mult: 3, shorts: 1 },
    grid: { n: [7, 10, 14], mult: [2, 3, 4], shorts: [0, 1] },
    source: "builtin",
    signal(c, p) {
      const d = S.supertrend(c, p.n, p.mult);
      return positions(c.length, {
        longEntry: (i) => d[i] === 1,
        longExit: (i) => d[i] === -1,
        shortEntry: both(p) ? (i) => d[i] === -1 : undefined,
        shortExit: (i) => d[i] === 1,
      });
    },
  },
  {
    id: "donchian_turtle",
    name: "Donchian breakout (turtle)",
    family: "breakout",
    description: "Enter on a close beyond the prior N-bar channel, exit on a close beyond the shorter opposite channel.",
    defaults: { entry: 20, exit: 10, shorts: 1 },
    grid: { entry: [20, 55, 100], exit: [10, 20], shorts: [0, 1] },
    valid: (p) => p.exit! < p.entry!,
    stopAtr: 2,
    source: "builtin",
    signal(c, p) {
      const hi = S.priorHigh(c, p.entry!);
      const lo = S.priorLow(c, p.entry!);
      const xhi = S.priorHigh(c, p.exit!);
      const xlo = S.priorLow(c, p.exit!);
      return positions(c.length, {
        longEntry: (i) => c[i]!.c > hi[i]!,
        longExit: (i) => c[i]!.c < xlo[i]!,
        shortEntry: both(p) ? (i) => c[i]!.c < lo[i]! : undefined,
        shortExit: (i) => c[i]!.c > xhi[i]!,
      });
    },
  },
  {
    id: "bollinger_breakout",
    name: "Bollinger breakout",
    family: "breakout",
    description: "Enter when price closes outside the band (volatility expansion), exit back at the mid line.",
    defaults: { n: 20, k: 2, shorts: 1 },
    grid: { n: [20, 40], k: [1.5, 2, 2.5], shorts: [0, 1] },
    stopAtr: 2,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const b = S.bollinger(x, p.n, p.k);
      return positions(c.length, {
        longEntry: (i) => x[i]! > b.upper[i]!,
        longExit: (i) => x[i]! < b.mid[i]!,
        shortEntry: both(p) ? (i) => x[i]! < b.lower[i]! : undefined,
        shortExit: (i) => x[i]! > b.mid[i]!,
      });
    },
  },
  {
    id: "keltner_breakout",
    name: "Keltner breakout",
    family: "breakout",
    description: "EMA +/- ATR channel; enter on a close outside it, exit at the EMA.",
    defaults: { n: 20, mult: 2, shorts: 1 },
    grid: { n: [20, 50], mult: [1.5, 2, 3], shorts: [0, 1] },
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const m = S.ema(x, p.n!);
      const a = S.atr(c, p.n);
      return positions(c.length, {
        longEntry: (i) => x[i]! > m[i]! + p.mult! * a[i]!,
        longExit: (i) => x[i]! < m[i]!,
        shortEntry: both(p) ? (i) => x[i]! < m[i]! - p.mult! * a[i]! : undefined,
        shortExit: (i) => x[i]! > m[i]!,
      });
    },
  },
  {
    id: "williams_vol_breakout",
    name: "Volatility breakout (Larry Williams)",
    family: "breakout",
    description: "Long when price clears today's open + k x yesterday's range (short on the mirror), out at the UTC day close. Bizzy's classic.",
    defaults: { k: 0.5, shorts: 1 },
    grid: { k: [0.3, 0.5, 0.7], shorts: [0, 1] },
    source: "builtin",
    signal(c, p) {
      const n = c.length;
      const dayOf = (i: number) => Math.floor(c[i]!.ts / DAY);
      const open = new Float64Array(n).fill(NaN);
      const range = new Float64Array(n).fill(NaN);
      let curDay = -1;
      let dOpen = NaN;
      let hi = -Infinity;
      let lo = Infinity;
      let prevRange = NaN;
      for (let i = 0; i < n; i++) {
        const d = dayOf(i);
        if (d !== curDay) {
          if (curDay !== -1) prevRange = d === curDay + 1 ? hi - lo : NaN;
          curDay = d;
          dOpen = c[i]!.o;
          hi = -Infinity;
          lo = Infinity;
        }
        hi = Math.max(hi, c[i]!.h);
        lo = Math.min(lo, c[i]!.l);
        open[i] = dOpen;
        range[i] = prevRange;
      }
      // The last bar of each UTC day closes the position (bar timestamps are known in advance, prices are not).
      const lastOfDay = (i: number) => i + 1 >= n || dayOf(i + 1) !== dayOf(i);
      return positions(n, {
        longEntry: (i) => !lastOfDay(i) && c[i]!.c > open[i]! + p.k! * range[i]!,
        longExit: lastOfDay,
        shortEntry: both(p) ? (i) => !lastOfDay(i) && c[i]!.c < open[i]! - p.k! * range[i]! : undefined,
        shortExit: lastOfDay,
      });
    },
  },
  {
    id: "roc_momentum",
    name: "Rate-of-change momentum",
    family: "momentum",
    description: "Long when the N-bar return is above +x%, short below -x%, flat in between. Boozy's instinct, in code.",
    defaults: { n: 24, x: 2, shorts: 1 },
    grid: { n: [12, 24, 72, 168], x: [0.5, 2, 5], shorts: [0, 1] },
    stopAtr: 2,
    source: "builtin",
    signal(c, p) {
      const r = S.roc(S.closes(c), p.n!);
      return positions(c.length, {
        longEntry: (i) => r[i]! > p.x!,
        longExit: (i) => r[i]! < 0,
        shortEntry: both(p) ? (i) => r[i]! < -p.x! : undefined,
        shortExit: (i) => r[i]! > 0,
      });
    },
  },
  {
    id: "rsi_momentum",
    name: "RSI momentum",
    family: "momentum",
    description: "Strength begets strength: long above an RSI threshold, out when it fades below 50.",
    defaults: { n: 14, hi: 60, shorts: 1 },
    grid: { n: [7, 14, 21], hi: [55, 60, 65], shorts: [0, 1] },
    source: "builtin",
    signal(c, p) {
      const r = S.rsi(S.closes(c), p.n);
      return positions(c.length, {
        longEntry: (i) => r[i]! > p.hi!,
        longExit: (i) => r[i]! < 50,
        shortEntry: both(p) ? (i) => r[i]! < 100 - p.hi! : undefined,
        shortExit: (i) => r[i]! > 50,
      });
    },
  },
  {
    id: "rsi_reversion",
    name: "RSI mean reversion",
    family: "mean_reversion",
    description: "Buy oversold RSI, sell overbought RSI, exit as it returns to 50.",
    defaults: { n: 14, lo: 30, shorts: 1 },
    grid: { n: [2, 7, 14], lo: [10, 20, 30], shorts: [0, 1] },
    stopAtr: 3,
    source: "builtin",
    signal(c, p) {
      const r = S.rsi(S.closes(c), p.n);
      return positions(c.length, {
        longEntry: (i) => r[i]! < p.lo!,
        longExit: (i) => r[i]! > 50,
        shortEntry: both(p) ? (i) => r[i]! > 100 - p.lo! : undefined,
        shortExit: (i) => r[i]! < 50,
      });
    },
  },
  {
    id: "bollinger_reversion",
    name: "Bollinger mean reversion",
    family: "mean_reversion",
    description: "Fade closes outside the band, take profit back at the mid line.",
    defaults: { n: 20, k: 2, shorts: 1 },
    grid: { n: [20, 40], k: [2, 2.5, 3], shorts: [0, 1] },
    stopAtr: 3,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const b = S.bollinger(x, p.n, p.k);
      return positions(c.length, {
        longEntry: (i) => x[i]! < b.lower[i]!,
        longExit: (i) => x[i]! > b.mid[i]!,
        shortEntry: both(p) ? (i) => x[i]! > b.upper[i]! : undefined,
        shortExit: (i) => x[i]! < b.mid[i]!,
      });
    },
  },
  {
    id: "zscore_reversion",
    name: "Z-score reversion",
    family: "mean_reversion",
    description: "Fade a close more than z standard deviations from its average, exit near the average.",
    defaults: { n: 48, z: 2, shorts: 1 },
    grid: { n: [24, 48, 96], z: [1.5, 2, 2.5], shorts: [0, 1] },
    stopAtr: 3,
    source: "builtin",
    signal(c, p) {
      const z = S.zscore(S.closes(c), p.n!);
      return positions(c.length, {
        longEntry: (i) => z[i]! < -p.z!,
        longExit: (i) => z[i]! > -0.25,
        shortEntry: both(p) ? (i) => z[i]! > p.z! : undefined,
        shortExit: (i) => z[i]! < 0.25,
      });
    },
  },
  {
    id: "stoch_reversion",
    name: "Stochastic reversion",
    family: "mean_reversion",
    description: "Buy when %K is deeply oversold, sell deeply overbought, exit at mid-range.",
    defaults: { n: 14, lo: 15, shorts: 1 },
    grid: { n: [14, 28], lo: [5, 15, 25], shorts: [0, 1] },
    stopAtr: 3,
    source: "builtin",
    signal(c, p) {
      const k = S.stochK(c, p.n);
      return positions(c.length, {
        longEntry: (i) => k[i]! < p.lo!,
        longExit: (i) => k[i]! > 50,
        shortEntry: both(p) ? (i) => k[i]! > 100 - p.lo! : undefined,
        shortExit: (i) => k[i]! < 50,
      });
    },
  },
  {
    id: "trend_pullback",
    name: "Trend filter + RSI pullback",
    family: "hybrid",
    description: "Only long above the long average (shorts below it), entered on an RSI dip against that trend, out when RSI recovers.",
    defaults: { trend: 200, n: 5, lo: 25, shorts: 1 },
    grid: { trend: [100, 200], n: [3, 5, 14], lo: [15, 25, 35], shorts: [0, 1] },
    stopAtr: 3,
    source: "builtin",
    signal(c, p) {
      const x = S.closes(c);
      const t = S.sma(x, p.trend!);
      const r = S.rsi(x, p.n);
      return positions(c.length, {
        longEntry: (i) => x[i]! > t[i]! && r[i]! < p.lo!,
        longExit: (i) => r[i]! > 60 || x[i]! < t[i]!,
        shortEntry: both(p) ? (i) => x[i]! < t[i]! && r[i]! > 100 - p.lo! : undefined,
        shortExit: (i) => r[i]! < 40 || x[i]! > t[i]!,
      });
    },
  },
  {
    id: "squeeze_breakout",
    name: "Volatility squeeze breakout",
    family: "hybrid",
    description: "Wait for Bollinger width to be in its narrowest quantile, then take the breakout from the squeeze.",
    defaults: { n: 20, look: 120, q: 0.2, shorts: 1 },
    grid: { n: [20], look: [120, 240], q: [0.1, 0.2, 0.3], shorts: [0, 1] },
    stopAtr: 2,
    source: "builtin",
    signal(c: Candle[], p) {
      const x = S.closes(c);
      const b = S.bollinger(x, p.n, 2);
      const width = b.mid.map((m, i) => (m > 0 ? (b.upper[i]! - b.lower[i]!) / m : NaN));
      const squeezed = new Uint8Array(c.length);
      for (let i = p.look!; i < c.length; i++) {
        const w = Array.from(width.subarray(i - p.look!, i)).filter(Number.isFinite).sort((a, z) => a - z);
        if (w.length < p.look! / 2) continue;
        squeezed[i] = width[i - 1]! <= w[Math.floor(w.length * p.q!)]! ? 1 : 0;
      }
      return positions(c.length, {
        longEntry: (i) => squeezed[i] === 1 && x[i]! > b.upper[i]!,
        longExit: (i) => x[i]! < b.mid[i]!,
        shortEntry: both(p) ? (i) => squeezed[i] === 1 && x[i]! < b.lower[i]! : undefined,
        shortExit: (i) => x[i]! > b.mid[i]!,
      });
    },
  },
];
