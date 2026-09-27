// The hive mind as a force-directed graph (plain SVG, no library). Node type is encoded twice: a validated categorical
// colour (fixed order, dark surface) and a shape, and the legend doubles as the type filter. Hover shows a node's
// details and lights its neighbours; click pins it and lists its links. A table view carries the same data.
import { useMemo, useState } from "react";
import type { GraphJson, GraphLink, GraphNode } from "./panelTypes";

/** Categorical slots 1-6 of the validated dark palette, in fixed order (checked against #13121a: all six pass). */
export const NODE_TYPES = [
  { id: "brain", label: "Brains", color: "#3987e5", shape: "square" },
  { id: "coin", label: "Coins", color: "#d95926", shape: "circle" },
  { id: "skill", label: "Skills", color: "#199e70", shape: "diamond" },
  { id: "bee", label: "Bees", color: "#c98500", shape: "circle-lg" },
  { id: "note", label: "Lessons & messages", color: "#d55181", shape: "triangle" },
  { id: "family", label: "Families", color: "#008300", shape: "ring" },
] as const;
type TypeId = (typeof NODE_TYPES)[number]["id"];
const TYPE_OF = (n: GraphNode): TypeId | null => (n.type === "lesson" || n.type === "message" ? "note" : NODE_TYPES.some((t) => t.id === n.type) ? (n.type as TypeId) : null);
const META = Object.fromEntries(NODE_TYPES.map((t) => [t.id, t])) as Record<TypeId, (typeof NODE_TYPES)[number]>;

const W = 900;
const H = 560;

interface Placed {
  n: GraphNode;
  t: TypeId;
  x: number;
  y: number;
}

/** Deterministic force layout (Fruchterman-Reingold with gravity). */
function layout(nodes: Array<{ n: GraphNode; t: TypeId }>, links: GraphLink[]): Placed[] {
  const N = nodes.length;
  if (!N) return [];
  const idx = new Map(nodes.map((x, i) => [x.n.id, i]));
  const order = NODE_TYPES.map((t) => t.id);
  const pos = nodes.map((x, i) => {
    const ring = order.indexOf(x.t);
    const a = (i / N) * Math.PI * 2 + ring;
    const r = 80 + ring * 30;
    return { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r * 0.7 };
  });
  const edges = links.map((l) => [idx.get(l.source), idx.get(l.target)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined);
  const k = Math.sqrt((W * H) / N) * 0.95;
  let temp = W / 8;
  for (let it = 0; it < 320; it++) {
    const dx = new Float64Array(N);
    const dy = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let ex = pos[i]!.x - pos[j]!.x;
        let ey = pos[i]!.y - pos[j]!.y;
        let d2 = ex * ex + ey * ey;
        if (d2 < 0.01) {
          ex = (i - j) * 0.1;
          ey = 0.1;
          d2 = ex * ex + ey * ey;
        }
        const f = (k * k) / d2;
        dx[i] = dx[i]! + ex * f;
        dy[i] = dy[i]! + ey * f;
        dx[j] = dx[j]! - (ex * f);
        dy[j] = dy[j]! - (ey * f);
      }
    }
    for (const [a, b] of edges) {
      const ex = pos[a]!.x - pos[b]!.x;
      const ey = pos[a]!.y - pos[b]!.y;
      const d = Math.sqrt(ex * ex + ey * ey) || 0.1;
      // Softer springs than textbook FR: a coin linked to every skill must not pull them all into one knot.
      const f = (d / k) * 0.35;
      dx[a] = dx[a]! - (ex * f);
      dy[a] = dy[a]! - (ey * f);
      dx[b] = dx[b]! + ex * f;
      dy[b] = dy[b]! + ey * f;
    }
    for (let i = 0; i < N; i++) {
      dx[i] = dx[i]! + (W / 2 - pos[i]!.x) * 0.03;
      dy[i] = dy[i]! + (H / 2 - pos[i]!.y) * 0.05;
      const d = Math.sqrt(dx[i]! ** 2 + dy[i]! ** 2) || 1;
      pos[i]!.x += (dx[i]! / d) * Math.min(d, temp);
      pos[i]!.y += (dy[i]! / d) * Math.min(d, temp);
    }
    temp = Math.max(1, temp * 0.985);
  }
  // Fit into the frame with a margin.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const m = 40;
  const sx = (W - 2 * m) / Math.max(1, x1 - x0);
  const sy = (H - 2 * m) / Math.max(1, y1 - y0);
  const s = Math.min(sx, sy, 3);
  return nodes.map((x, i) => ({ ...x, x: m + (pos[i]!.x - x0) * s + (W - 2 * m - (x1 - x0) * s) / 2, y: m + (pos[i]!.y - y0) * s + (H - 2 * m - (y1 - y0) * s) / 2 }));
}

function Mark({ t, x, y, active }: { t: TypeId; x: number; y: number; active: boolean }) {
  const c = META[t].color;
  const ring = { stroke: "var(--card)", strokeWidth: 2 };
  const r = active ? 1.35 : 1;
  switch (META[t].shape) {
    case "square":
      return <rect x={x - 7 * r} y={y - 7 * r} width={14 * r} height={14 * r} rx={3} fill={c} {...ring} />;
    case "diamond":
      return <path d={`M${x},${y - 7 * r} L${x + 7 * r},${y} L${x},${y + 7 * r} L${x - 7 * r},${y} Z`} fill={c} {...ring} />;
    case "triangle":
      return <path d={`M${x},${y - 6 * r} L${x + 6 * r},${y + 5 * r} L${x - 6 * r},${y + 5 * r} Z`} fill={c} {...ring} />;
    case "ring":
      return <circle cx={x} cy={y} r={7 * r} fill="var(--card)" stroke={c} strokeWidth={3} />;
    case "circle-lg":
      return <circle cx={x} cy={y} r={11 * r} fill={c} {...ring} />;
    default:
      return <circle cx={x} cy={y} r={6 * r} fill={c} {...ring} />;
  }
}

function nodeDetails(n: GraphNode): Array<[string, string]> {
  const skip = new Set(["id", "type", "label", "created_at", "updated_at", "text"]);
  const rows: Array<[string, string]> = [];
  if (n.text) rows.push(["text", String(n.text)]);
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k) || v === null || v === undefined || v === "") continue;
    rows.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  rows.push(["updated", new Date(n.updated_at).toISOString().slice(0, 16).replace("T", " ")]);
  return rows.slice(0, 12);
}

export function HiveGraph({ graph }: { graph: GraphJson }) {
  const [hidden, setHidden] = useState<Set<TypeId>>(() => new Set<TypeId>(["family"]));
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  const typed = useMemo(() => graph.nodes.map((n) => ({ n, t: TYPE_OF(n) })).filter((x): x is { n: GraphNode; t: TypeId } => x.t !== null), [graph]);
  const visible = useMemo(() => typed.filter((x) => !hidden.has(x.t)), [typed, hidden]);
  const ids = useMemo(() => new Set(visible.map((x) => x.n.id)), [visible]);
  const links = useMemo(() => graph.links.filter((l) => ids.has(l.source) && ids.has(l.target)), [graph, ids]);
  const placed = useMemo(() => layout(visible, links), [visible, links]);
  const at = useMemo(() => new Map(placed.map((p) => [p.n.id, p])), [placed]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  // Skills a bee adopts are always labelled; the rest show their name on hover (33 labels at once is noise).
  const adopted = useMemo(() => new Set(graph.links.filter((l) => l.relation === "adopts").map((l) => l.target)), [graph]);
  const counts = useMemo(() => Object.fromEntries(NODE_TYPES.map((t) => [t.id, typed.filter((x) => x.t === t.id).length])), [typed]);

  const focus = hover ?? pinned;
  const neighbours = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of links) {
      if (l.source === focus) s.add(l.target);
      if (l.target === focus) s.add(l.source);
    }
    return s;
  }, [focus, links]);
  const pinnedLinks = pinned ? graph.links.filter((l) => l.source === pinned || l.target === pinned) : [];
  const hoverNode = hover ? at.get(hover) : null;

  const toggle = (t: TypeId) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  if (!graph.nodes.length) return <p className="dim">The hive mind is empty. Run the lab and the council (Admin → Lab) and it fills in.</p>;

  return (
    <div className="hg">
      <div className="hg-bar">
        <div className="hg-legend" role="group" aria-label="Node types (click to show or hide)">
          {NODE_TYPES.map((t) => (
            <button key={t.id} className={`hg-key ${hidden.has(t.id) ? "off" : ""}`} onClick={() => toggle(t.id)} aria-pressed={!hidden.has(t.id)}>
              <svg width="16" height="16" aria-hidden>
                <Mark t={t.id} x={8} y={8} active={false} />
              </svg>
              {t.label} <span className="dim num">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        <button className="pbtn ghost small" onClick={() => setTable((x) => !x)}>
          {table ? "Graph view" : "Table view"}
        </button>
      </div>

      {table ? (
        <div className="ptable-wrap">
          <table className="ptable">
            <thead>
              <tr>
                <th>Type</th>
                <th>Node</th>
                <th className="r">Links</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ n, t }) => (
                <tr key={n.id}>
                  <td>{META[t].label}</td>
                  <td>{n.text ? String(n.text) : n.label}</td>
                  <td className="r num">{graph.links.filter((l) => l.source === n.id || l.target === n.id).length}</td>
                  <td className="num dim">{new Date(n.updated_at).toISOString().slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="hg-stage">
          <svg viewBox={`0 0 ${W} ${H}`} className="hg-svg" role="img" aria-label="Hive mind knowledge graph" onClick={() => setPinned(null)}>
            {links.map((l, i) => {
              const a = at.get(l.source)!;
              const b = at.get(l.target)!;
              const lit = neighbours && neighbours.has(l.source) && neighbours.has(l.target) && (l.source === focus || l.target === focus);
              return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`hg-edge ${lit ? "lit" : neighbours ? "dim" : ""}`} />;
            })}
            {placed.map((p) => {
              const on = !neighbours || neighbours.has(p.n.id);
              const labelled = p.t === "bee" || p.t === "brain" || p.t === "coin" || adopted.has(p.n.id) || (focus !== null && neighbours?.has(p.n.id));
              return (
                <g
                  key={p.n.id}
                  className={`hg-node ${on ? "" : "faded"}`}
                  tabIndex={0}
                  onPointerEnter={() => setHover(p.n.id)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(p.n.id)}
                  onBlur={() => setHover(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPinned(p.n.id);
                  }}
                >
                  <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
                  <Mark t={p.t} x={p.x} y={p.y} active={focus === p.n.id} />
                  {labelled && p.t !== "note" && (
                    <text x={p.x + 12} y={p.y + 4} className="hg-label">
                      {p.n.label.length > 22 ? `${p.n.label.slice(0, 21)}…` : p.n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hoverNode && (
            <div className="hg-tip" style={{ left: `${(hoverNode.x / W) * 100}%`, top: `${(hoverNode.y / H) * 100}%` }}>
              <strong>{hoverNode.n.text ? String(hoverNode.n.text).slice(0, 160) : hoverNode.n.label}</strong>
              <span className="dim">
                {META[hoverNode.t].label} · {links.filter((l) => l.source === hoverNode.n.id || l.target === hoverNode.n.id).length} links
              </span>
            </div>
          )}
        </div>
      )}

      {pinned && byId.get(pinned) && (
        <div className="hg-detail">
          <div className="hg-detail-head">
            <strong>{byId.get(pinned)!.label}</strong>
            <button className="pbtn ghost small" onClick={() => setPinned(null)}>
              Close
            </button>
          </div>
          <dl className="kv">
            {nodeDetails(byId.get(pinned)!).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="eyebrow">Links</div>
          <ul className="hg-links">
            {pinnedLinks.slice(0, 40).map((l, i) => {
              const out = l.source === pinned;
              const other = byId.get(out ? l.target : l.source);
              return (
                <li key={i}>
                  <span className="dim">{out ? `${l.relation} →` : `← ${l.relation}`}</span> {other?.text ? String(other.text).slice(0, 90) : (other?.label ?? (out ? l.target : l.source))}{" "}
                  <span className="num dim">{Number(l.weight).toFixed(2)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
