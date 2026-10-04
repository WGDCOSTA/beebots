// Charts for the admin console (AdminConsole.tsx). Plain SVG, no chart library. The rules they follow:
//   - one y-axis per chart;
//   - thin marks, a recessive grid, 4px rounded bar ends at the baseline;
//   - a legend whenever there are 2+ series, and each entry toggles its series;
//   - a hover layer on every plot: a crosshair with every visible value on time charts, a per-bar tooltip on bars;
//   - text in text colours, never the series colour;
//   - colour follows the entity: a bunny keeps its colour, and other series take the categorical slots in fixed order.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Categorical slots for the dark surface, in their validated order (never cycled past 8: fold into "Other"). */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
/** Each official bunny style's own colour (styles.css), so a bunny looks the same here as everywhere else. */
const STYLE_COLOR: Record<string, string> = { bizzy: "#c98500", breezy: "#9085e9", boozy: "#d55181", degen: "#19c7c9" };
const EXTRA = ["#3987e5", "#d95926", "#199e70", "#e66767", "#008300"];
export function bunnyColor(style: string, slot: string): string {
  return STYLE_COLOR[style] ?? EXTRA[(Number(slot.replace(/\D/g, "")) || 0) % EXTRA.length]!;
}

export interface Series {
  id: string;
  label: string;
  color: string;
  values: Array<number | null>;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

/** Round, readable ticks between lo and hi. */
function ticks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0];
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v / step) * step);
  return out;
}

export const timeLabel = (ts: number, bucketMs: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return bucketMs >= 86_400_000 ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}` : `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)} ${pad(d.getUTCHours())}h`;
};

function Legend({ series, hidden, toggle }: { series: Series[]; hidden: Set<string>; toggle: (id: string) => void }) {
  if (series.length < 2) return null;
  return (
    <div className="cx-legend" role="group" aria-label="Series">
      {series.map((s) => (
        <button key={s.id} className={`cx-key ${hidden.has(s.id) ? "off" : ""}`} onClick={() => toggle(s.id)} aria-pressed={!hidden.has(s.id)}>
          <span className="cx-swatch" style={{ background: s.color }} />
          {s.label}
        </button>
      ))}
    </div>
  );
}

function useHidden() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return { hidden, toggle };
}

const PAD = { l: 52, r: 14, t: 10, b: 24 };

/** Time labels that fit: about one per 130px, never more than `max`, always the first and the last. */
function xTicks(n: number, w: number, max = 4): number[] {
  if (!n) return [];
  const k = Math.max(2, Math.min(max, Math.floor(w / 130)));
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1))))];
}

/** Lines over time, one y-axis. `zero` draws the zero line (P&L); `ref` draws a labelled reference (a cap). */
export function LineChart({ x, series, format, bucketMs, height = 220, zero, refLine, area }: { x: number[]; series: Series[]; format: (v: number) => string; bucketMs: number; height?: number; zero?: boolean; refLine?: { value: number; label: string }; area?: boolean }) {
  const { ref, w } = useSize<HTMLDivElement>();
  const { hidden, toggle } = useHidden();
  const [hover, setHover] = useState<number | null>(null);
  const shown = series.filter((s) => !hidden.has(s.id));
  const vals = shown.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (refLine) vals.push(refLine.value);
  if (zero) vals.push(0);
  const empty = !vals.length;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const padY = (hi - lo || Math.abs(hi) || 1) * 0.08;
  // A measure that cannot go negative (a cost, a rate) keeps its floor at zero.
  const floorAtZero = lo >= 0 && !!zero;
  lo = floorAtZero ? 0 : lo - padY;
  hi += padY;
  const tk = ticks(lo, hi).filter((t) => !floorAtZero || t >= 0);
  lo = Math.min(lo, tk[0]!);
  hi = Math.max(hi, tk[tk.length - 1]!);
  const iw = Math.max(10, w - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const X = (i: number) => PAD.l + (x.length < 2 ? iw / 2 : (i / (x.length - 1)) * iw);
  const Y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const path = (vs: Array<number | null>) => {
    let d = "";
    let pen = false;
    vs.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const xt = xTicks(x.length, w);
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (x.length - 1));
    setHover(Math.max(0, Math.min(x.length - 1, i)));
  };
  const lastIdx = (vs: Array<number | null>) => {
    for (let i = vs.length - 1; i >= 0; i--) if (vs[i] !== null) return i;
    return -1;
  };
  return (
    <div className="cx-chart" ref={ref}>
      <Legend series={series} hidden={hidden} toggle={toggle} />
      {empty ? (
        <div className="cx-empty" style={{ height }}>
          No data in this range yet.
        </div>
      ) : (
        w > 0 && (
          <svg width={w} height={height} role="img" aria-label={series.map((s) => s.label).join(", ")}>
            {tk.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" strokeWidth={1} />
                <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="cx-axis">
                  {format(t)}
                </text>
              </g>
            ))}
            {zero && lo < 0 && hi > 0 && <line x1={PAD.l} x2={w - PAD.r} y1={Y(0)} y2={Y(0)} stroke="var(--axis)" strokeWidth={1} />}
            {refLine && (
              <g>
                <line x1={PAD.l} x2={w - PAD.r} y1={Y(refLine.value)} y2={Y(refLine.value)} stroke="var(--warning)" strokeDasharray="4 4" strokeWidth={1} />
                <text x={w - PAD.r} y={Y(refLine.value) - 4} textAnchor="end" className="cx-axis">
                  {refLine.label}
                </text>
              </g>
            )}
            {xt.map((i) => (
              <text key={i} x={X(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === x.length - 1 ? "end" : "middle"} className="cx-axis">
                {timeLabel(x[i]!, bucketMs)}
              </text>
            ))}
            {area &&
              shown.length === 1 &&
              (() => {
                const s = shown[0]!;
                const first = s.values.findIndex((v) => v !== null);
                const last = lastIdx(s.values);
                if (first < 0) return null;
                const base = Y(Math.max(lo, Math.min(hi, zero ? 0 : lo)));
                return <path d={`${path(s.values)}L${X(last).toFixed(1)},${base}L${X(first).toFixed(1)},${base}Z`} fill={s.color} opacity={0.12} />;
              })()}
            {shown.map((s) => (
              <path key={s.id} d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {shown.length <= 4 &&
              shown.length > 1 &&
              shown.map((s) => {
                const i = lastIdx(s.values);
                return i < 0 ? null : <circle key={s.id} cx={X(i)} cy={Y(s.values[i]!)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} />;
              })}
            {hover !== null && (
              <g>
                <line x1={X(hover)} x2={X(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--axis)" strokeWidth={1} />
                {shown.map((s) => (s.values[hover] !== null && s.values[hover] !== undefined ? <circle key={s.id} cx={X(hover)} cy={Y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--card)" strokeWidth={2} /> : null))}
              </g>
            )}
            <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )
      )}
      {hover !== null && w > 0 && (
        <div className="tooltip cx-tip" style={{ left: Math.min(Math.max(4, X(hover) + 12), w - 200), top: 28 }}>
          <div className="tt-sub">{timeLabel(x[hover]!, bucketMs)}</div>
          {shown.map((s) => (
            <div key={s.id} className="cx-tip-row">
              <span className="cx-swatch" style={{ background: s.color }} />
              <span className="cx-tip-label">{s.label}</span>
              <span className="tt-value">{s.values[hover] === null || s.values[hover] === undefined ? "–" : format(s.values[hover]!)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Stacked columns over time (positive parts), 2px gaps between segments, a tooltip per column. */
export function StackedBars({ x, series, format, bucketMs, height = 200 }: { x: number[]; series: Series[]; format: (v: number) => string; bucketMs: number; height?: number }) {
  const { ref, w } = useSize<HTMLDivElement>();
  const { hidden, toggle } = useHidden();
  const [hover, setHover] = useState<number | null>(null);
  const shown = series.filter((s) => !hidden.has(s.id));
  const totals = x.map((_, i) => shown.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const tk = ticks(0, max || 1);
  const hi = Math.max(max, tk[tk.length - 1]!);
  const iw = Math.max(10, w - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const bw = iw / Math.max(1, x.length);
  const Y = (v: number) => PAD.t + ih - (v / (hi || 1)) * ih;
  const xt = xTicks(x.length, w, 3);
  return (
    <div className="cx-chart" ref={ref}>
      <Legend series={series} hidden={hidden} toggle={toggle} />
      {max === 0 ? (
        <div className="cx-empty" style={{ height }}>
          Nothing in this range yet.
        </div>
      ) : (
        w > 0 && (
          <svg width={w} height={height} role="img" aria-label={series.map((s) => s.label).join(", ")}>
            {tk.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" />
                <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="cx-axis">
                  {format(t)}
                </text>
              </g>
            ))}
            {x.map((_, i) => {
              let acc = 0;
              const gx = PAD.l + i * bw + Math.min(2, bw * 0.15);
              const gw = Math.max(1, bw - Math.min(4, bw * 0.3));
              return (
                <g key={i} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {shown.map((s, k) => {
                    const v = Math.max(0, s.values[i] ?? 0);
                    if (!v) return null;
                    const y0 = Y(acc);
                    acc += v;
                    const y1 = Y(acc);
                    const top = k === shown.length - 1 || shown.slice(k + 1).every((n) => !(n.values[i] ?? 0));
                    const h = Math.max(1, y0 - y1 - 2);
                    return <rect key={s.id} x={gx} y={y1} width={gw} height={h} rx={top ? Math.min(4, gw / 2) : 0} fill={s.color} />;
                  })}
                  <rect x={PAD.l + i * bw} y={PAD.t} width={bw} height={ih} fill="transparent" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
                </g>
              );
            })}
            {xt.map((i) => (
              <text key={i} x={PAD.l + i * bw + bw / 2} y={height - 6} textAnchor={i === 0 ? "start" : i === x.length - 1 ? "end" : "middle"} className="cx-axis">
                {timeLabel(x[i]!, bucketMs)}
              </text>
            ))}
          </svg>
        )
      )}
      {hover !== null && w > 0 && (
        <div className="tooltip cx-tip" style={{ left: Math.min(Math.max(4, PAD.l + hover * bw + bw + 8), w - 200), top: 28 }}>
          <div className="tt-sub">{timeLabel(x[hover]!, bucketMs)}</div>
          <div className="tt-value">{format(totals[hover]!)}</div>
          {shown.map((s) =>
            s.values[hover] ? (
              <div key={s.id} className="cx-tip-row">
                <span className="cx-swatch" style={{ background: s.color }} />
                <span className="cx-tip-label">{s.label}</span>
                <span className="tt-value">{format(s.values[hover]!)}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/** Diverging columns from zero (net P&L per bucket): sign is shape and colour, good up and bad down. */
export function PnlBars({ x, values, format, bucketMs, height = 180 }: { x: number[]; values: number[]; format: (v: number) => string; bucketMs: number; height?: number }) {
  const { ref, w } = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const tk = ticks(lo, hi || 1);
  const L = Math.min(lo, tk[0]!);
  const Hh = Math.max(hi, tk[tk.length - 1]!);
  const iw = Math.max(10, w - PAD.l - PAD.r);
  const ih = height - PAD.t - PAD.b;
  const bw = iw / Math.max(1, x.length);
  const Y = (v: number) => PAD.t + ih - ((v - L) / (Hh - L || 1)) * ih;
  const xt = xTicks(x.length, w, 3);
  return (
    <div className="cx-chart" ref={ref}>
      {values.every((v) => !v) ? (
        <div className="cx-empty" style={{ height }}>
          No realised P&amp;L in this range yet.
        </div>
      ) : (
        w > 0 && (
          <svg width={w} height={height} role="img" aria-label="Net P&L per period">
            {tk.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={w - PAD.r} y1={Y(t)} y2={Y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
                <text x={PAD.l - 6} y={Y(t) + 4} textAnchor="end" className="cx-axis">
                  {format(t)}
                </text>
              </g>
            ))}
            {values.map((v, i) => {
              const gx = PAD.l + i * bw + Math.min(2, bw * 0.15);
              const gw = Math.max(1, bw - Math.min(4, bw * 0.3));
              const y = v >= 0 ? Y(v) : Y(0);
              const h = Math.max(v ? 1 : 0, Math.abs(Y(v) - Y(0)));
              return (
                <g key={i}>
                  {v !== 0 && <rect x={gx} y={y} width={gw} height={h} rx={Math.min(3, gw / 2)} fill={v > 0 ? "var(--good)" : "var(--critical)"} opacity={hover === null || hover === i ? 1 : 0.55} />}
                  <rect x={PAD.l + i * bw} y={PAD.t} width={bw} height={ih} fill="transparent" onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} />
                </g>
              );
            })}
            {xt.map((i) => (
              <text key={i} x={PAD.l + i * bw + bw / 2} y={height - 6} textAnchor={i === 0 ? "start" : i === x.length - 1 ? "end" : "middle"} className="cx-axis">
                {timeLabel(x[i]!, bucketMs)}
              </text>
            ))}
          </svg>
        )
      )}
      {hover !== null && w > 0 && (
        <div className="tooltip cx-tip" style={{ left: Math.min(Math.max(4, PAD.l + hover * bw + bw + 8), w - 170), top: 8 }}>
          <div className="tt-sub">{timeLabel(x[hover]!, bucketMs)}</div>
          <div className="tt-value">
            {values[hover]! > 0 ? "▲ " : values[hover]! < 0 ? "▼ " : ""}
            {format(values[hover]!)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars (magnitude by label), the value always printed beside the bar. */
export function HBars({ rows, format, color = SERIES[0]! }: { rows: Array<{ label: string; value: number; sub?: string; color?: string }>; format: (v: number) => string; color?: string }) {
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.value)));
  if (!rows.length) return <div className="cx-empty">Nothing yet.</div>;
  return (
    <div className="cx-hbars">
      {rows.map((r) => (
        <div key={r.label} className="cx-hbar" title={r.sub ?? ""}>
          <div className="cx-hbar-label">{r.label}</div>
          <div className="cx-hbar-track">
            <div className="cx-hbar-fill" style={{ width: `${max ? (Math.abs(r.value) / max) * 100 : 0}%`, background: r.color ?? color }} />
          </div>
          <div className="cx-hbar-value num">{format(r.value)}</div>
          {r.sub && <div className="cx-hbar-sub dim">{r.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/** A tiny line for a KPI tile: shape only, no axes (the tile names the measure). */
export function Spark({ values, color = SERIES[0]! }: { values: Array<number | null>; color?: string }) {
  const v = values.map((x) => (x === null ? null : x));
  const nums = v.filter((x): x is number => x !== null);
  if (nums.length < 2) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const W = 120;
  const Hh = 28;
  let d = "";
  let pen = false;
  v.forEach((x, i) => {
    if (x === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${((i / (v.length - 1)) * W).toFixed(1)},${(Hh - 2 - ((x - lo) / (hi - lo || 1)) * (Hh - 4)).toFixed(1)}`;
    pen = true;
  });
  return (
    <svg className="cx-spark" viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** A used-of-limit meter (a daily cap). Status colour plus the numbers in text. */
export function Meter({ value, max, format }: { value: number; max: number; format: (v: number) => string }) {
  const p = max > 0 ? Math.min(1, value / max) : 0;
  const tone = p >= 0.9 ? "var(--critical)" : p >= 0.7 ? "var(--warning)" : "var(--good)";
  return (
    <div className="cx-meter" role="meter" aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      <div className="cx-meter-track">
        <div className="cx-meter-fill" style={{ width: `${p * 100}%`, background: tone }} />
      </div>
      <div className="dim small num">
        {format(value)} of {format(max)} ({Math.round(p * 100)}%){p >= 0.9 ? " ⚠ near the cap" : ""}
      </div>
    </div>
  );
}

export interface Col<T> {
  key: string;
  label: string;
  value: (r: T) => string | number | null;
  render?: (r: T) => ReactNode;
  num?: boolean;
}

/** A sortable table that can download itself as CSV. */
export function DataTable<T>({ rows, cols, name, empty = "Nothing yet." }: { rows: T[]; cols: Array<Col<T>>; name: string; empty?: string }) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = cols.find((x) => x.key === sort.key);
    if (!c) return rows;
    return [...rows].sort((a, b) => {
      const va = c.value(a);
      const vb = c.value(b);
      if (va === vb) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va > vb ? 1 : -1) * sort.dir;
    });
  }, [rows, cols, sort]);
  return (
    <div>
      <div className="ptable-wrap">
        <table className="ptable">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={`${c.num ? "r" : ""} sortable ${sort?.key === c.key ? "on" : ""}`} onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key ? ((-s.dir) as 1 | -1) : -1 }))} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  {c.label}
                  {sort?.key === c.key ? (sort.dir === 1 ? " ▴" : " ▾") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={cols.length} className="dim">
                  {empty}
                </td>
              </tr>
            )}
            {sorted.map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c.key} className={c.num ? "r num" : ""}>
                    {c.render ? c.render(r) : (c.value(r) ?? "–")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="pbtn ghost small cx-csv" onClick={() => downloadCsv(name, [cols.map((c) => c.label), ...sorted.map((r) => cols.map((c) => c.value(r)))])}>
        ⤓ CSV
      </button>
    </div>
  );
}

export function downloadCsv(name: string, rows: Array<Array<string | number | null>>): void {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const blob = new Blob([rows.map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
