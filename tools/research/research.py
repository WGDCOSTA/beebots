"""Independent check of the lab: candlestick patterns (TA-Lib), chart patterns and known strategies on real OKX data.
Costs: 5 bp fee + 2 bp slippage per side, funding 0.01% per 8h held. Out of sample = the last 40% of each series."""
import glob, json, math, os, sys
import numpy as np, pandas as pd, talib
from scipy import stats

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
SIDE_COST = 0.0007
RT_COST = 2 * SIDE_COST
FUND_PER_H = 0.0001 / 8
OOS_FROM = 0.6


def load(pattern, key=None):
    out = {}
    for f in sorted(glob.glob(pattern)):
        j = json.load(open(f))
        rows = j["candles"] if isinstance(j, dict) else j
        df = pd.DataFrame(rows)
        if "confirmed" in df:
            df = df[df.confirmed != False]
        df["ts"] = pd.to_datetime(df.ts, unit="ms", utc=True)
        df = df.set_index("ts").sort_index()[["o", "h", "l", "c", "volUsd"]].astype(float)
        df = df[~df.index.duplicated()]
        name = os.path.basename(f).split("-")[0].split("_")[0].replace(".json", "")
        if len(df) > 300:
            out[name] = df
    return out


def resample(df, rule):
    return df.resample(rule, label="left", closed="left").agg({"o": "first", "h": "max", "l": "min", "c": "last", "volUsd": "sum"}).dropna()


H1 = load(f"{ROOT}/h1/*_1H.json")
D1 = load(f"{ROOT}/d1/*.json")
H4 = {k: resample(v, "4h") for k, v in H1.items()}
TF = {"1D": (D1, 5, 24), "4H": (H4, 6, 4), "1H": (H1, 12, 1)}  # data, horizon (bars), hours per bar
print({k: (len(v[0]), sum(len(d) for d in v[0].values())) for k, v in TF.items()}, flush=True)


# ---------- A + B: event studies ----------
def double_patterns(df, k=3, tol=0.015, gap=10, look=60):
    """Fractal pivots (k bars each side, known k bars later). Double bottom: two pivot lows within tol, at least `gap`
    bars apart; signal +1 on the first close above the highest high between them. Double top: the mirror, -1."""
    h, l, c = df.h.values, df.l.values, df.c.values
    n = len(c)
    sig = np.zeros(n)
    lows, highs = [], []
    for i in range(k, n - k):
        if l[i] == l[i - k:i + k + 1].min():
            lows.append(i)
        if h[i] == h[i - k:i + k + 1].max():
            highs.append(i)
    for piv, side in ((lows, 1), (highs, -1)):
        for a, b in zip(piv, piv[1:]):
            if b - a < gap or b - a > look:
                continue
            pa, pb = (l[a], l[b]) if side == 1 else (h[a], h[b])
            if abs(pb - pa) / pa > tol:
                continue
            neck = h[a:b + 1].max() if side == 1 else l[a:b + 1].min()
            for t in range(b + k, min(n, b + k + look)):  # pivot b is only known k bars later
                if (side == 1 and c[t] > neck) or (side == -1 and c[t] < neck):
                    sig[t] = side
                    break
                if (side == 1 and l[t] < min(pa, pb)) or (side == -1 and h[t] > max(pa, pb)):
                    break
    return sig


def events(tf):
    data, hzn, _ = TF[tf]
    rows = []
    pats = talib.get_function_groups()["Pattern Recognition"]
    for coin, df in data.items():
        o, h, l, c = (df[x].values for x in "ohlc")
        n = len(c)
        fwd = np.full(n, np.nan)
        fwd[:-hzn] = c[hzn:] / c[:-hzn] - 1
        frac = np.arange(n) / n
        is_m = np.nanmean(fwd[frac < OOS_FROM]); oos_m = np.nanmean(fwd[frac >= OOS_FROM])
        drift = np.where(frac < OOS_FROM, is_m, oos_m)
        sigs = {p: np.sign(getattr(talib, p)(o, h, l, c)) for p in pats}
        sigs["DOUBLE_BOTTOM_TOP"] = double_patterns(df)
        for p, s in sigs.items():
            last = -10**9
            for t in np.nonzero(s)[0]:
                if t - last < hzn or np.isnan(fwd[t]):
                    continue
                last = t
                d = s[t]
                rows.append((tf, p, "bull" if d > 0 else "bear", coin, frac[t] >= OOS_FROM, d * fwd[t] - RT_COST, d * (fwd[t] - drift[t])))
    return pd.DataFrame(rows, columns=["tf", "pattern", "dir", "coin", "oos", "net", "excess"])


def tstat(x):
    x = np.asarray(x)
    return x.mean() / (x.std(ddof=1) / math.sqrt(len(x))) if len(x) > 2 and x.std() > 0 else 0.0


ev = pd.read_pickle(f"{ROOT}/ev.pkl") if os.path.exists(f"{ROOT}/ev.pkl") else pd.concat([events(tf) for tf in TF]); ev.to_pickle(f"{ROOT}/ev.pkl")
agg = []
for (tf, p, d), g in ev.groupby(["tf", "pattern", "dir"]):
    i, o = g[~g.oos], g[g.oos]
    if len(i) < 30:
        continue
    ti = tstat(i.excess)
    agg.append(dict(tf=tf, pattern=p, dir=d, n_is=len(i), n_oos=len(o), is_net_bp=i.net.mean() * 1e4, is_excess_bp=i.excess.mean() * 1e4, t_is=ti,
                    p_is=2 * (1 - stats.norm.cdf(abs(ti))), oos_net_bp=o.net.mean() * 1e4 if len(o) else np.nan,
                    oos_excess_bp=o.excess.mean() * 1e4 if len(o) else np.nan, oos_win=(o.net > 0).mean() * 100 if len(o) else np.nan, t_oos=tstat(o.excess) if len(o) > 2 else 0))
agg = pd.DataFrame(agg)
# Benjamini-Hochberg on the in-sample p-values: how many of the "significant" patterns survive many tests.
m = len(agg)
agg = agg.sort_values("p_is").reset_index(drop=True)
agg["bh_ok"] = agg.p_is <= (np.arange(1, m + 1) / m) * 0.05
agg["bh_ok"] = agg.bh_ok[::-1].cummax()[::-1]
agg["survives"] = agg.bh_ok & (agg.is_excess_bp > 0) & (agg.n_oos >= 30) & (agg.oos_excess_bp > 0) & (agg.oos_net_bp > 0) & (agg.t_oos > 1.0)
agg.to_csv(f"{ROOT}/patterns.csv", index=False)


# ---------- C: strategies ----------
def sim(df, pos, hours, exit_px=None):
    """Daily-or-hourly bar returns of a position series (-1/0/1 or fractional), entered at the signal bar's close.
    exit_px: where a stop or ROI target filled inside a bar (NaN = the close)."""
    c = df.c.values
    px = c if exit_px is None else np.where(np.isnan(exit_px), c, exit_px)
    r = np.r_[0, px[1:] / c[:-1] - 1]
    p = np.nan_to_num(np.asarray(pos, float))
    held = np.r_[0, p[:-1]]
    turn = np.abs(np.diff(np.r_[0, p]))
    return pd.Series(held * r - turn * SIDE_COST - np.abs(held) * FUND_PER_H * hours, index=df.index)


def state_machine(df, entry, exit_sig, roi=None, stop=None, hours=1):
    """Long-only, one position: enter at close on `entry`, leave on `exit_sig`, the stop, or a minimal_roi target."""
    o, h, l, c = (df[x].values for x in "ohlc")
    pos = np.zeros(len(c)); xp = np.full(len(c), np.nan)
    inpos, e, t0 = False, 0.0, 0
    for t in range(len(c)):
        if inpos:
            mins = (t - t0) * hours * 60
            tgt = None
            if roi:
                for k in sorted(roi, key=float):
                    if mins >= float(k):
                        tgt = roi[k]
            # As the lab does: the stop first (at the low), then the ROI target (at the high), then the signal at the close.
            if stop is not None and l[t] <= e * (1 + stop):
                inpos, xp[t] = False, min(o[t], e * (1 + stop))
            elif tgt is not None and h[t] >= e * (1 + tgt):
                inpos, xp[t] = False, max(o[t], e * (1 + tgt))
            elif exit_sig[t]:
                inpos = False
        elif entry[t]:
            inpos, e, t0 = True, c[t], t
        pos[t] = 1.0 if inpos else 0.0
    return pos, xp


def strategies(tf):
    data, _, hours = TF[tf]
    S = {}
    for coin, df in data.items():
        o, h, l, c = (df[x].values for x in "ohlc")
        sma = lambda n: talib.SMA(c, n)
        rsi14 = talib.RSI(c, 14)
        up, mid, lo = talib.BBANDS(c, 20, 2, 2)
        res = {"buy_hold": np.ones(len(c))}
        # The lab's leaders, as the skill pack defines them (minimal_roi in minutes, fixed stoploss).
        res["ft_bb_rsi"] = state_machine(df, (rsi14 < 25) & (c < lo), rsi14 > 65, {"0": 0.06, "120": 0.03, "360": 0.01}, -0.08, hours)
        wr = talib.WILLR(h, l, c, 14)
        _, sd = talib.STOCH(h, l, c, 14, 3, 0, 3, 0)
        res["ft_willr_stoch"] = state_machine(df, (wr < -90) & (sd < 20) & (c > sma(200)), wr > -10, {"0": 0.05, "360": 0.02}, -0.08, hours)
        # Classic trend following (known to be robust on daily data in the literature).
        s50, s200 = sma(50), sma(200)
        res["golden_cross_50_200"] = np.where(s50 > s200, 1, 0)
        res["above_sma200"] = np.where(c > s200, 1, 0)
        res["tsmom_30_long"] = np.where(c > np.r_[np.full(30, np.nan), c[:-30]], 1, 0)
        res["tsmom_90_long"] = np.where(c > np.r_[np.full(90, np.nan), c[:-90]], 1, 0)
        res["tsmom_30_ls"] = np.where(np.isnan(np.r_[np.full(30, np.nan), c[:-30]]), 0, np.sign(c - np.r_[np.full(30, np.nan), c[:-30]]))
        hi20, lo10 = talib.MAX(h, 20), talib.MIN(l, 10)
        dz = np.zeros(len(c)); inp = False
        for t in range(1, len(c)):
            if not inp and c[t] > hi20[t - 1]: inp = True
            elif inp and c[t] < lo10[t - 1]: inp = False
            dz[t] = 1 if inp else 0
        res["donchian_20_10_long"] = dz
        rsi2 = talib.RSI(c, 2)
        res["connors_rsi2"] = state_machine(df, (rsi2 < 10) & (c > s200), c > sma(5), None, None, hours)
        # Trend + pullback: only buy RSI dips while above the 200 average, ride until the trend breaks.
        res["trend_dip"] = state_machine(df, (c > s200) & (rsi14 < 40), c < s200, None, -0.15, hours)
        # Volatility-scaled trend (risk parity flavour): long above SMA200, size = 2% daily vol target / realised vol.
        rv = pd.Series(c).pct_change().rolling(30).std().values * math.sqrt(24 / hours)
        res["above_sma200_voltgt"] = np.where(c > s200, np.clip(0.02 / np.where(rv > 0, rv, np.nan), 0, 2), 0)
        for k, pos in res.items():
            pos, xp = pos if isinstance(pos, tuple) else (pos, None)
            S.setdefault(k, {})[coin] = sim(df, pos, hours, xp)
    return S


def metrics(r, hours):
    per_year = 24 * 365 / hours
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    yrs = len(r) / per_year
    cagr = eq.iloc[-1] ** (1 / yrs) - 1 if yrs > 0 and eq.iloc[-1] > 0 else -1
    sh = r.mean() / r.std() * math.sqrt(per_year) if r.std() > 0 else 0
    return dict(total_pct=(eq.iloc[-1] - 1) * 100, cagr_pct=cagr * 100, sharpe=sh, maxdd_pct=dd * 100)


report = {}
for tf in ("1D", "1H"):
    S = strategies(tf)
    hours = TF[tf][2]
    rows = []
    for k, per in S.items():
        port = pd.DataFrame(per).fillna(0).mean(axis=1)  # equal weight across coins, rebalanced each bar
        n = len(port); cut = int(n * OOS_FROM)
        m_all, m_oos = metrics(port, hours), metrics(port.iloc[cut:], hours)
        yearly = port.groupby(port.index.year).apply(lambda x: ((1 + x).prod() - 1) * 100).round(1).to_dict()
        coins_pos = np.mean([((1 + s.iloc[int(len(s) * OOS_FROM):]).prod() - 1) > 0 for s in per.values()]) * 100
        rows.append(dict(strategy=k, **{f"all_{a}": b for a, b in m_all.items()}, **{f"oos_{a}": b for a, b in m_oos.items()}, oos_coins_positive_pct=coins_pos, yearly=yearly))
    report[tf] = rows
json.dump(report, open(f"{ROOT}/strategies.json", "w"), default=float, indent=1)

# ---------- print ----------
pd.set_option("display.width", 220); pd.set_option("display.max_columns", 30)
print("\n=== Candlestick + chart patterns: tests", len(agg), "| pass BH-FDR in-sample:", int(agg.bh_ok.sum()), "| also hold out of sample:", int(agg.survives.sum()))
print(agg[agg.bh_ok].head(30)[["tf", "pattern", "dir", "n_is", "is_excess_bp", "t_is", "n_oos", "oos_net_bp", "oos_excess_bp", "oos_win", "t_oos", "survives"]].round(2).to_string())
print("\nDouble bottom/top:"); print(agg[agg.pattern == "DOUBLE_BOTTOM_TOP"].round(2).to_string())
for tf, rows in report.items():
    print(f"\n=== Strategies {tf} (equal-weight portfolio of {len(TF[tf][0])} coins)")
    df = pd.DataFrame(rows).drop(columns=["yearly"]).sort_values("oos_sharpe", ascending=False)
    print(df.round(2).to_string(index=False))
    print("yearly %:"); [print(" ", r["strategy"], r["yearly"]) for r in rows]
