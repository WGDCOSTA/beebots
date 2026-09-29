// Charts for a bunny's profile page. One series per chart (the card title names it, so no legend box), recessive grid,
// thin marks, and a hover layer on every plot: a crosshair on time, the mark itself as the hit target on bars.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Width and height of a container, kept current. */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

function Tip({ x, y, w, children }: { x: number; y: number; w: number; children: ReactNode }) {
  return (
    <div className="tooltip" style={{ left: Math.max(4, Math.min(x + 12, w - 170)), top: Math.max(4, y) }}>
      {children}
    </div>
  );
}

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** Tooltip lines under the value. */
  sub?: string[];
}

/**
 * Vertical bars from a zero line: positive up, negative down (polarity reads from direction and sign, not colour alone).
 * `tone` colours a bar: a series colour for one measure, or good/bad for P&L.
 */
export function BarChart({ bars, format, tone, empty, height = 180 }: { bars: Bar[]; format: (v: number) => string; tone: (v: number) => string; empty: string; height?: number }) {
  const { ref, w } = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const PAD = { top: 10, bottom: 22, left: 4, right: 56 };
  const g = useMemo(() => {
    if (!w || !bars.length) return null;
    const hi = Math.max(0, ...bars.map((b) => b.value));
    const lo = Math.min(0, ...bars.map((b) => b.value));
    const span = hi - lo || 1;
    const ih = height - PAD.top - PAD.bottom;
    const iw = w - PAD.left - PAD.right;
    const y = (v: number) => PAD.top + ((hi - v) / span) * ih;
    const step = iw / bars.length;
    const bw = Math.max(2, Math.min(28, step - 2));
    return { y, step, bw, iw, hi, lo, zero: y(0) };
  }, [w, bars, height]);
  const hb = hover !== null ? bars[hover] : null;
  return (
    <div className="pchart" ref={ref} style={{ height }} onPointerLeave={() => setHover(null)}>
      {g && (
        <svg width={w} height={height} role="img" aria-label={`${bars.length} bars`}>
          <line x1={PAD.left} x2={PAD.left + g.iw} y1={g.zero} y2={g.zero} className="baseline" />
          {g.hi > 0 && (
            <text x={PAD.left + g.iw + 6} y={g.y(g.hi)} className="axis" dominantBaseline="hanging">
              {format(g.hi)}
            </text>
          )}
          {g.lo < 0 && (
            <text x={PAD.left + g.iw + 6} y={g.y(g.lo)} className="axis" dominantBaseline="auto">
              {format(g.lo)}
            </text>
          )}
          {bars.map((b, i) => {
            const x = PAD.left + i * g.step + (g.step - g.bw) / 2;
            const top = Math.min(g.y(b.value), g.zero);
            const h = Math.max(1, Math.abs(g.y(b.value) - g.zero));
            return (
              <g key={b.key}>
                <rect x={x} y={top} width={g.bw} height={h} rx={Math.min(4, g.bw / 2)} fill={tone(b.value)} opacity={hover === null || hover === i ? 1 : 0.45} />
                {/* The hit target: the whole column, not just the painted bar. */}
                <rect x={PAD.left + i * g.step} y={PAD.top} width={g.step} height={height - PAD.top - PAD.bottom} fill="transparent" onPointerEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)} aria-label={`${b.label}: ${format(b.value)}`} />
              </g>
            );
          })}
          {bars.length > 0 && (
            <>
              <text x={PAD.left} y={height - 6} className="axis">
                {bars[0]!.label}
              </text>
              {bars.length > 1 && (
                <text x={PAD.left + g.iw} y={height - 6} className="axis" textAnchor="end">
                  {bars[bars.length - 1]!.label}
                </text>
              )}
            </>
          )}
        </svg>
      )}
      {g && hb && (
        <Tip x={PAD.left + hover! * g.step + g.step / 2} y={8} w={w}>
          <div className="tt-value">{format(hb.value)}</div>
          <div className="tt-sub">{hb.label}</div>
          {hb.sub?.map((s) => (
            <div className="tt-sub" key={s}>
              {s}
            </div>
          ))}
        </Tip>
      )}
      {!bars.length && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

export interface Dot {
  ts: number;
  value: number;
  label: string;
  sub?: string;
  /** Drawn hollow (e.g. a vetoed decision), so the difference never rests on colour. */
  hollow?: boolean;
}

/** Points over time on a 0..1 scale (confidence), hovered by nearest point so the pointer need not land on an 8px dot. */
export function DotStrip({ dots, color, empty, height = 170 }: { dots: Dot[]; color: string; empty: string; height?: number }) {
  const { ref, w } = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const PAD = { top: 10, bottom: 22, left: 4, right: 40 };
  const g = useMemo(() => {
    if (!w || !dots.length) return null;
    const t0 = Math.min(...dots.map((d) => d.ts));
    const t1 = Math.max(...dots.map((d) => d.ts));
    const iw = w - PAD.left - PAD.right;
    const ih = height - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + (t1 === t0 ? iw / 2 : ((t - t0) / (t1 - t0)) * iw);
    const y = (v: number) => PAD.top + (1 - Math.max(0, Math.min(1, v))) * ih;
    return { x, y, iw, ih, t0, t1 };
  }, [w, dots, height]);
  const onMove = (e: React.PointerEvent) => {
    if (!g) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best = -1;
    let bd = Infinity;
    dots.forEach((d, i) => {
      const dd = (g.x(d.ts) - px) ** 2 + (g.y(d.value) - py) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setHover(bd < 40 ** 2 ? best : null);
  };
  const hd = hover !== null ? dots[hover] : null;
  const when = (t: number) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="pchart" ref={ref} style={{ height }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
      {g && (
        <svg width={w} height={height} role="img" aria-label={`${dots.length} decisions by confidence`}>
          {[0, 0.5, 1].map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + g.iw} y1={g.y(v)} y2={g.y(v)} className="gridline" />
              <text x={PAD.left + g.iw + 6} y={g.y(v)} className="axis" dominantBaseline="middle">
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          {dots.map((d, i) => (
            <circle
              key={`${d.ts}-${i}`}
              cx={g.x(d.ts)}
              cy={g.y(d.value)}
              r={hover === i ? 6 : 4}
              fill={d.hollow ? "var(--card)" : color}
              stroke={d.hollow ? color : "var(--card)"}
              strokeWidth={d.hollow ? 1.5 : 1}
              opacity={hover === null || hover === i ? 0.9 : 0.35}
            />
          ))}
          <text x={PAD.left} y={height - 6} className="axis">
            {when(g.t0)}
          </text>
          <text x={PAD.left + g.iw} y={height - 6} className="axis" textAnchor="end">
            {when(g.t1)}
          </text>
        </svg>
      )}
      {g && hd && (
        <Tip x={g.x(hd.ts)} y={Math.max(4, g.y(hd.value) - 60)} w={w}>
          <div className="tt-value">{Math.round(hd.value * 100)}%</div>
          <div className="tt-sub">{hd.label}</div>
          {hd.sub && <div className="tt-sub">{hd.sub}</div>}
          <div className="tt-sub">{when(hd.ts)}</div>
        </Tip>
      )}
      {!dots.length && <div className="chart-empty">{empty}</div>}
    </div>
  );
}

/** Horizontal bars from a shared zero, one row per item, value at the end in text ink; the row is the hover target. */
export function HBars({ rows, format, tone }: { rows: Array<{ key: string; label: string; value: number; note?: string }>; format: (v: number) => string; tone: (v: number) => string }) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  const hasNeg = rows.some((r) => r.value < 0);
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar-row" key={r.key} title={r.note ? `${r.label}: ${format(r.value)} · ${r.note}` : `${r.label}: ${format(r.value)}`}>
          <span className="hbar-label">{r.label}</span>
          <span className={`hbar-track ${hasNeg ? "split" : ""}`}>
            <i
              style={{
                width: `${Math.max(1.5, (Math.abs(r.value) / max) * (hasNeg ? 50 : 100))}%`,
                background: tone(r.value),
                ...(hasNeg ? (r.value >= 0 ? { left: "50%" } : { right: "50%" }) : { left: 0 }),
              }}
            />
          </span>
          <span className="hbar-val num">{format(r.value)}</span>
          {r.note && <span className="hbar-note dim small">{r.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** A ring gauge for one share (win rate, health): the number in the middle, the arc as a quick read. */
export function Ring({ value, max = 100, color, label, text }: { value: number | null; max?: number; color: string; label: string; text: string }) {
  const f = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const R = 26;
  const C = 2 * Math.PI * R;
  return (
    <div className="ring" role="img" aria-label={`${label}: ${text}`}>
      <svg viewBox="0 0 64 64" width="64" height="64">
        <circle cx="32" cy="32" r={R} fill="none" stroke="var(--muted-bar)" strokeWidth="6" />
        <circle cx="32" cy="32" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${C * f} ${C}`} transform="rotate(-90 32 32)" className="ring-arc" />
      </svg>
      <span className="ring-text num">{text}</span>
    </div>
  );
}
