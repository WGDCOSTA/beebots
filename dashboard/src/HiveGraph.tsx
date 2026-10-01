// The warren memory as an interactive graph on React Flow. d3-force does the physics (kinds pulled to rings, links as springs,
// collision so nothing overlaps; drag a node and the rest reacts), React Flow does pan, zoom, minimap and hit-testing.
// Node kind is encoded twice, a validated categorical colour and a shape; link confidence is encoded by line style
// (fact = solid, inference = dashed, disputed = dotted) so it survives without colour. Hover a node for details, click to
// pin it and light its links, double-click to isolate its neighbourhood. A table view carries the same data.
import { Background, BackgroundVariant, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, getStraightPath, useInternalNode, useReactFlow } from "@xyflow/react";
import type { Edge, EdgeProps, Node, NodeChange, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { forceCollide, forceLink, forceManyBody, forceRadial, forceSimulation, forceX, forceY } from "d3-force";
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphJson } from "./panelTypes";
import { CONFIDENCES, KIND, KINDS, confidenceOf, degrees, freshIds, matches, seedPosition, titleOf, visibleGraph } from "./hiveGraphModel";
import type { Confidence, KindId, RawLink, RawNode } from "./hiveGraphModel";

/** Kept for callers that only need the legend entries. */
export const NODE_TYPES = KINDS;

interface HData extends Record<string, unknown> {
  kind: KindId;
  label: string;
  size: number;
  showLabel: boolean;
  dim: boolean;
  hit: boolean;
  fresh: boolean;
  pinned: boolean;
}
type HNode = Node<HData, "hive">;
interface EData extends Record<string, unknown> {
  conf: Confidence;
  state: "lit" | "dim" | "";
  w: number;
  relation: string;
  motion: boolean;
  label: boolean;
  selected: boolean;
}
type HEdge = Edge<EData, "float">;

const SIZE: Record<KindId, number> = { bee: 34, brain: 22, skill: 16, coin: 18, style: 20, experiment: 18, note: 12, memory: 14, family: 20 };
const nodeSize = (kind: KindId, degree: number) => Math.round(SIZE[kind] + Math.min(14, Math.sqrt(degree) * 1.6));

function HiveNode({ data }: NodeProps<HNode>) {
  const k = KIND[data.kind];
  return (
    <div className={`hgn hgn-${data.kind} ${data.dim ? "faded" : ""} ${data.hit ? "hit" : ""} ${data.fresh ? "fresh" : ""} ${data.pinned ? "pinned" : ""}`} style={{ width: data.size, height: data.size, ["--k" as string]: k.color }}>
      <Handle type="target" position={Position.Top} className="hgn-h" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="hgn-h" isConnectable={false} />
      <span className="hgn-mark" />
      {(data.showLabel || data.hit || data.pinned) && <span className="hgn-label">{data.label.length > 24 ? `${data.label.slice(0, 23)}…` : data.label}</span>}
    </div>
  );
}

/** A straight link between node centres, so links do not depend on where the handles sit. */
function FloatEdge({ id, source, target, data }: EdgeProps<HEdge>) {
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!a || !b || !data) return null;
  const c = (n: typeof a) => ({ x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2, y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2 });
  const p = c(a);
  const q = c(b);
  const [path] = getStraightPath({ sourceX: p.x, sourceY: p.y, targetX: q.x, targetY: q.y });
  return (
    <g className={data.selected ? "hge-group selected" : "hge-group"}>
      <path id={id} d={path} className={`hge hge-${data.conf.toLowerCase()} ${data.state}`} style={{ strokeWidth: 0.8 + Math.min(2.2, data.w) }} fill="none" />
      {data.motion && (data.state === "lit" || data.selected) && (
        <circle r="2.6" className="hge-particle">
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      {(data.label || data.selected) && (
        <text className="hge-label" dy="-5">
          <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">{data.relation.replaceAll("_", " ")}</textPath>
        </text>
      )}
    </g>
  );
}

const nodeTypes = { hive: HiveNode };
const edgeTypes = { float: FloatEdge };

interface Sim extends SimulationNodeDatum {
  id: string;
  kind: KindId;
  r: number;
}
type SimLink = SimulationLinkDatum<Sim> & { w: number };

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

function details(n: RawNode): Array<[string, string]> {
  const skip = new Set(["id", "type", "label", "created_at", "updated_at", "text"]);
  const rows: Array<[string, string]> = [];
  if (n.text) rows.push(["text", String(n.text)]);
  for (const [k, v] of Object.entries(n)) {
    if (skip.has(k) || v === null || v === undefined || v === "") continue;
    rows.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
  }
  rows.push(["updated", stamp(n.updated_at)]);
  return rows.slice(0, 12);
}

function Canvas({ graph, onRefresh }: { graph: GraphJson; onRefresh?: () => void }) {
  const rf = useReactFlow<HNode, HEdge>();
  const [hiddenKinds, setHiddenKinds] = useState<Set<KindId>>(() => new Set<KindId>(["family"]));
  const [hiddenConf, setHiddenConf] = useState<Set<Confidence>>(() => new Set());
  const [query, setQuery] = useState("");
  const [ego, setEgo] = useState<string | null>(null);
  const [hops, setHops] = useState(2);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [table, setTable] = useState(false);
  const [motion, setMotion] = useState(() => !(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches));
  const [linkLabels, setLinkLabels] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [nodes, setNodes] = useState<HNode[]>([]);

  // Live off freezes what is on screen; live on follows the poll.
  const frozen = useRef(graph);
  if (live) frozen.current = graph;
  const g = frozen.current;

  const prev = useRef<readonly RawNode[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const f = freshIds(prev.current, g.nodes as RawNode[]);
    prev.current = g.nodes as RawNode[];
    if (!f.size) return;
    setFresh(f);
    const t = setTimeout(() => setFresh(new Set()), 6000);
    return () => clearTimeout(t);
  }, [g]);

  const raw = g.nodes as RawNode[];
  const rawLinks = g.links as RawLink[];
  const byId = useMemo(() => new Map(raw.map((n) => [n.id, n])), [raw]);
  const view = useMemo(() => visibleGraph(raw, rawLinks, { hiddenKinds, hiddenConf, ego, hops }), [raw, rawLinks, hiddenKinds, hiddenConf, ego, hops]);
  const deg = useMemo(() => degrees(view.links), [view.links]);
  const adopted = useMemo(() => new Set(rawLinks.filter((l) => l.relation === "adopts").map((l) => l.target)), [rawLinks]);
  const counts = useMemo(() => {
    const c = Object.fromEntries(KINDS.map((k) => [k.id, 0])) as Record<KindId, number>;
    for (const n of visibleGraph(raw, rawLinks, { hiddenKinds: new Set(), hiddenConf: new Set(), ego: null, hops: 1 }).nodes) c[n.kind]++;
    return c;
  }, [raw, rawLinks]);
  const confCounts = useMemo(() => {
    const c: Record<Confidence, number> = { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 };
    for (const l of rawLinks) c[confidenceOf(l)]++;
    return c;
  }, [rawLinks]);

  const focus = hover ?? pinned;
  const related = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const l of view.links) {
      if (l.source === focus) s.add(l.target);
      if (l.target === focus) s.add(l.source);
    }
    return s;
  }, [focus, view.links]);
  const hits = useMemo(() => (query.trim() ? new Set(view.nodes.filter((n) => matches(n, query)).map((n) => n.id)) : null), [query, view.nodes]);

  // ---- physics -----------------------------------------------------------------------------------------------
  const pos = useRef(new Map<string, { x: number; y: number }>());
  const sim = useRef<Simulation<Sim, SimLink> | null>(null);
  const simNodes = useRef<Sim[]>([]);
  const raf = useRef(0);
  const style = useRef({ deg, related, hits, fresh, pinned, adopted, focus });
  style.current = { deg, related, hits, fresh, pinned, adopted, focus };

  /** Rebuild the node list from the physics positions and the current highlight state, keeping React Flow's measurements. */
  const sync = useCallback(() => {
    const s = style.current;
    setNodes((old) => {
      const had = new Map(old.map((n) => [n.id, n]));
      return view.nodes.map((n) => {
        const p = pos.current.get(n.id) ?? { x: 0, y: 0 };
        const size = nodeSize(n.kind, s.deg.get(n.id) ?? 0);
        const data: HData = {
          kind: n.kind,
          label: titleOf(n),
          size,
          showLabel: n.kind === "bee" || n.kind === "brain" || n.kind === "coin" || n.kind === "style" || s.adopted.has(n.id) || (s.focus !== null && (s.related?.has(n.id) ?? false)),
          dim: (s.related !== null && !s.related.has(n.id)) || (s.hits !== null && !s.hits.has(n.id)),
          hit: s.hits?.has(n.id) ?? false,
          fresh: s.fresh.has(n.id),
          pinned: s.pinned === n.id,
        };
        return { ...had.get(n.id), id: n.id, type: "hive", origin: [0.5, 0.5], position: { x: p.x, y: p.y }, data, draggable: true } as HNode;
      });
    });
  }, [view.nodes]);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const schedule = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      for (const n of simNodes.current) pos.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      syncRef.current();
    });
  }, []);

  useEffect(() => {
    sim.current?.stop();
    const existing = pos.current;
    const count = new Map<KindId, number>();
    const idx = new Map<KindId, number>();
    for (const n of view.nodes) count.set(n.kind, (count.get(n.kind) ?? 0) + 1);
    const ns: Sim[] = view.nodes.map((n) => {
      const i = idx.get(n.kind) ?? 0;
      idx.set(n.kind, i + 1);
      const p = existing.get(n.id) ?? seedPosition(n.kind, i, count.get(n.kind) ?? 1);
      return { id: n.id, kind: n.kind, r: nodeSize(n.kind, deg.get(n.id) ?? 0) / 2, x: p.x, y: p.y };
    });
    simNodes.current = ns;
    const links: SimLink[] = view.links.map((l) => ({ source: l.source, target: l.target, w: Math.max(0.2, Number(l.weight) || 0.5) }));
    const s = forceSimulation<Sim>(ns)
      .force("link", forceLink<Sim, SimLink>(links).id((n) => n.id).distance(95).strength(0.1))
      .force("charge", forceManyBody<Sim>().strength((n) => -110 - n.r * 8).distanceMax(420))
      .force("collide", forceCollide<Sim>().radius((n) => n.r + 8))
      .force("radial", forceRadial<Sim>((n) => KIND[n.kind].radius, 0, 0).strength((n) => (n.kind === "bee" ? 0.4 : 0.05)))
      .force("x", forceX<Sim>(0).strength(0.015))
      .force("y", forceY<Sim>(0).strength(0.015))
      .alpha(existing.size ? 0.35 : 1)
      .alphaDecay(0.03);
    sim.current = s;
    const still = !motion || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (still) {
      s.stop();
      s.tick(300);
      schedule();
    } else s.on("tick", schedule);
    schedule();
    const t = setTimeout(() => void rf.fitView({ padding: 0.15, duration: 500, maxZoom: 1.2 }), still ? 50 : 900);
    return () => {
      clearTimeout(t);
      s.stop();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.nodes, view.links, layoutEpoch, motion]);

  useEffect(() => syncRef.current(), [related, hits, fresh, pinned, focus]);

  const onNodesChange = useCallback((changes: NodeChange<HNode>[]) => {
    const rest: NodeChange<HNode>[] = [];
    for (const c of changes) {
      if (c.type === "position") {
        const sn = simNodes.current.find((n) => n.id === c.id);
        if (!sn) continue;
        if (c.dragging && c.position) {
          sn.fx = c.position.x;
          sn.fy = c.position.y;
          sim.current?.alphaTarget(0.25).restart();
        } else if (c.dragging === false) {
          sn.fx = null;
          sn.fy = null;
          sim.current?.alphaTarget(0);
        }
        continue;
      }
      rest.push(c);
    }
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
  }, []);

  const edges = useMemo<HEdge[]>(
    () =>
      view.links.map((l, i) => {
        const conf = confidenceOf(l);
        const on = focus !== null && (l.source === focus || l.target === focus);
        const id = `${l.source}>${l.target}>${l.relation}>${i}`;
        return {
          id,
          source: l.source,
          target: l.target,
          type: "float",
          data: {
            conf,
            state: on || selectedEdge === id ? "lit" : focus !== null || hits !== null || selectedEdge !== null ? "dim" : "",
            w: Number(l.weight) || 0.5,
            relation: l.relation,
            motion,
            label: linkLabels && (on || focus === null),
            selected: selectedEdge === id,
          },
        } as HEdge;
      }),
    [view.links, focus, hits, motion, linkLabels, selectedEdge],
  );

  const toggleKind = (k: KindId) => setHiddenKinds((h) => (h.has(k) ? new Set([...h].filter((x) => x !== k)) : new Set([...h, k])));
  const toggleConf = (c: Confidence) => setHiddenConf((h) => (h.has(c) ? new Set([...h].filter((x) => x !== c)) : new Set([...h, c])));
  const goTo = (ids: string[]) => void rf.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.4, duration: 500, maxZoom: 1.6 });
  const reflow = () => {
    pos.current.clear();
    setLayoutEpoch((n) => n + 1);
    setTimeout(() => void rf.fitView({ padding: 0.15, duration: 500, maxZoom: 1.2 }), 80);
  };

  if (!raw.length) return <p className="dim">The warren memory is empty. Run the lab and the council (Admin → Lab) and it fills in.</p>;

  const hoverNode = hover ? byId.get(hover) : null;
  const pin = pinned ? byId.get(pinned) : null;
  const pinLinks = pinned ? rawLinks.filter((l) => l.source === pinned || l.target === pinned) : [];
  const selectedLinkIndex = selectedEdge ? edges.findIndex((e) => e.id === selectedEdge) : -1;
  const selectedLink = selectedLinkIndex >= 0 ? view.links[selectedLinkIndex] : null;

  return (
    <div className="hg">
      <div className="hg-bar">
        <div className="hg-legend" role="group" aria-label="Node kinds (click to show or hide)">
          {KINDS.map((k) => (
            <button key={k.id} className={`hg-key ${hiddenKinds.has(k.id) ? "off" : ""}`} onClick={() => toggleKind(k.id)} aria-pressed={!hiddenKinds.has(k.id)}>
              <span className={`hgn-mark hgn-${k.id} hg-swatch`} style={{ ["--k" as string]: k.color }} aria-hidden />
              {k.label} <span className="dim num">{counts[k.id]}</span>
            </button>
          ))}
        </div>
        <div className="hg-tools">
          <input className="pinput hg-search" type="search" placeholder="Search nodes…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && hits && goTo([...hits])} aria-label="Search the warren memory" />
          <button className={`pbtn small ${live ? "" : "ghost"}`} onClick={() => setLive((x) => !x)} aria-pressed={live} title="Follow the 30 s refresh, or freeze the picture">
            {live ? "Live" : "Paused"}
          </button>
          <button className={`pbtn small ${motion ? "" : "ghost"}`} onClick={() => setMotion((x) => !x)} aria-pressed={motion} title="Animate graph physics and active knowledge flow">
            {motion ? "Dynamics" : "Still"}
          </button>
          <button className={`pbtn small ${linkLabels ? "" : "ghost"}`} onClick={() => setLinkLabels((x) => !x)} aria-pressed={linkLabels} title="Show relation names on links">
            Relations
          </button>
          <button className="pbtn ghost small" onClick={reflow} title="Rebuild the force layout">Reflow</button>
          {onRefresh && (
            <button className="pbtn ghost small" onClick={onRefresh}>
              Refresh
            </button>
          )}
          <button className="pbtn ghost small" onClick={() => setTable((x) => !x)}>
            {table ? "Graph view" : "Table view"}
          </button>
        </div>
      </div>
      <div className="hg-bar hg-sub">
        <div className="hg-legend" role="group" aria-label="Link confidence">
          {CONFIDENCES.map((c) => (
            <button key={c} className={`hg-key ${hiddenConf.has(c) ? "off" : ""}`} onClick={() => toggleConf(c)} aria-pressed={!hiddenConf.has(c)} title={c === "EXTRACTED" ? "Measured: a trade, a backtest, a setting" : c === "INFERRED" ? "Concluded by a brain: a lesson, an adoption" : "Facts that disagree"}>
              <svg width="26" height="8" aria-hidden>
                <line x1="1" y1="4" x2="25" y2="4" className={`hge hge-${c.toLowerCase()}`} />
              </svg>
              {c.toLowerCase()} <span className="dim num">{confCounts[c]}</span>
            </button>
          ))}
        </div>
        <div className="hg-tools">
          {ego ? (
            <>
              <span className="dim">Neighbourhood of {byId.get(ego)?.label ?? ego}</span>
              <select className="pinput" value={hops} onChange={(e) => setHops(Number(e.target.value))} aria-label="Hops from the node">
                {[1, 2, 3].map((h) => (
                  <option key={h} value={h}>
                    {h} hop{h > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
              <button className="pbtn ghost small" onClick={() => setEgo(null)}>
                Show all
              </button>
            </>
          ) : (
            <span className="dim">Hover for details · click to pin · double-click to isolate a neighbourhood</span>
          )}
        </div>
      </div>

      {table ? (
        <div className="ptable-wrap">
          <table className="ptable">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Node</th>
                <th className="r">Links</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {view.nodes
                .filter((n) => !hits || hits.has(n.id))
                .map((n) => (
                  <tr key={n.id}>
                    <td>{KIND[n.kind].label}</td>
                    <td>{titleOf(n)}</td>
                    <td className="r num">{deg.get(n.id) ?? 0}</td>
                    <td className="num dim">{stamp(n.updated_at)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="hg-stage">
          <ReactFlow<HNode, HEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeMouseEnter={(_, n) => setHover(n.id)}
            onNodeMouseLeave={() => setHover(null)}
            onNodeClick={(_, n) => {
              setPinned((p) => (p === n.id ? null : n.id));
              setSelectedEdge(null);
            }}
            onNodeDoubleClick={(_, n) => {
              setEgo(n.id);
              setPinned(n.id);
            }}
            onEdgeClick={(_, e) => {
              setSelectedEdge((x) => (x === e.id ? null : e.id));
              setPinned(null);
            }}
            onPaneClick={() => {
              setPinned(null);
              setSelectedEdge(null);
            }}
            nodesConnectable={false}
            elementsSelectable
            minZoom={0.15}
            maxZoom={2.5}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
            onlyRenderVisibleElements={raw.length > 400}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => KIND[(n.data as HData).kind].color} maskColor="rgba(10,10,16,.7)" />
          </ReactFlow>
          {hoverNode && hover !== pinned && (
            <div className="hg-tip" role="status">
              <strong>{titleOf(hoverNode).slice(0, 200)}</strong>
              <span className="dim">
                {KIND[kindOfNode(hoverNode)].label} · {deg.get(hoverNode.id) ?? 0} links · {stamp(hoverNode.updated_at)}
              </span>
            </div>
          )}
        </div>
      )}

      {pin && (
        <div className="hg-detail">
          <div className="hg-detail-head">
            <strong>{pin.label}</strong>
            <span className="hg-detail-actions">
              <button className="pbtn ghost small" onClick={() => goTo([pin.id])}>
                Centre
              </button>
              <button className="pbtn ghost small" onClick={() => setEgo(pin.id)}>
                Isolate
              </button>
              <button className="pbtn ghost small" onClick={() => setPinned(null)}>
                Close
              </button>
            </span>
          </div>
          <dl className="kv">
            {details(pin).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="eyebrow">Links ({pinLinks.length})</div>
          <ul className="hg-links">
            {pinLinks.slice(0, 40).map((l, i) => {
              const out = l.source === pinned;
              const otherId = out ? l.target : l.source;
              const other = byId.get(otherId);
              const conf = confidenceOf(l);
              return (
                <li key={i}>
                  <span className="dim">{out ? `${l.relation} →` : `← ${l.relation}`}</span>{" "}
                  <button className="hg-jump" onClick={() => (setPinned(otherId), goTo([otherId]))}>
                    {other ? titleOf(other).slice(0, 90) : otherId}
                  </button>{" "}
                  <span className={`hg-conf hg-conf-${conf.toLowerCase()}`}>{conf.toLowerCase()}</span> <span className="num dim">{Number(l.weight).toFixed(2)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {selectedLink && (
        <div className="hg-detail hg-edge-detail">
          <div className="hg-detail-head">
            <strong>{selectedLink.relation.replaceAll("_", " ")}</strong>
            <button className="pbtn ghost small" onClick={() => setSelectedEdge(null)}>Close</button>
          </div>
          <p>
            <button className="hg-jump" onClick={() => (setPinned(selectedLink.source), goTo([selectedLink.source]))}>{byId.get(selectedLink.source)?.label ?? selectedLink.source}</button>
            <span className="dim"> → </span>
            <button className="hg-jump" onClick={() => (setPinned(selectedLink.target), goTo([selectedLink.target]))}>{byId.get(selectedLink.target)?.label ?? selectedLink.target}</button>
          </p>
          <div className="hg-edge-metrics">
            <span className={`hg-conf hg-conf-${confidenceOf(selectedLink).toLowerCase()}`}>{confidenceOf(selectedLink).toLowerCase()}</span>
            <span className="num">weight {Number(selectedLink.weight).toFixed(3)}</span>
            {typeof selectedLink.count === "number" && <span className="num">{selectedLink.count} observations</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function kindOfNode(n: RawNode): KindId {
  return n.type === "lesson" || n.type === "message" ? "note" : n.type in KIND ? (n.type as KindId) : "note";
}

export function HiveGraph({ graph, onRefresh }: { graph: GraphJson; onRefresh?: () => void }) {
  return (
    <ReactFlowProvider>
      <Canvas graph={graph} onRefresh={onRefresh} />
    </ReactFlowProvider>
  );
}
