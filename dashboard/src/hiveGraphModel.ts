// Pure model behind the hive-mind graph: node kinds, link confidence, filtering, neighbourhoods. No React, so it is unit-tested from the root suite.
export interface RawNode {
  id: string;
  type: string;
  label: string;
  text?: unknown;
  updated_at: number;
  [k: string]: unknown;
}
export interface RawLink {
  source: string;
  target: string;
  relation: string;
  weight: number;
  confidence?: string;
  [k: string]: unknown;
}

/** Validated categorical slots of the dark palette, fixed order. Status colours (good/warn/bad) are not used for kinds. */
export const KINDS = [
  { id: "bee", label: "Bunnies", color: "#c98500", radius: 0 },
  { id: "brain", label: "Brains", color: "#3987e5", radius: 150 },
  { id: "skill", label: "Skills", color: "#199e70", radius: 260 },
  { id: "coin", label: "Coins", color: "#d95926", radius: 260 },
  { id: "style", label: "Styles", color: "#9085e9", radius: 200 },
  { id: "note", label: "Lessons & messages", color: "#d55181", radius: 340 },
  { id: "memory", label: "Memories", color: "#e66767", radius: 320 },
  { id: "family", label: "Families", color: "#008300", radius: 300 },
] as const;
export type KindId = (typeof KINDS)[number]["id"];
export const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<KindId, (typeof KINDS)[number]>;

export function kindOf(n: Pick<RawNode, "type">): KindId | null {
  if (n.type === "lesson" || n.type === "message") return "note";
  return n.type in KIND ? (n.type as KindId) : null;
}

export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
export const CONFIDENCES: Confidence[] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];
/** Mirrors src/graph/memory.ts: a measured fact is EXTRACTED, everything a brain concluded is INFERRED. */
const FACTS = new Set(["traded", "performs_on", "ranked", "authored", "restricted_to", "thinks_with", "to", "said", "learned"]);
export function confidenceOf(l: Pick<RawLink, "relation" | "confidence">): Confidence {
  if (l.confidence === "EXTRACTED" || l.confidence === "INFERRED" || l.confidence === "AMBIGUOUS") return l.confidence;
  return FACTS.has(l.relation) ? "EXTRACTED" : "INFERRED";
}

export interface View {
  hiddenKinds: ReadonlySet<KindId>;
  hiddenConf: ReadonlySet<Confidence>;
  query: string;
  /** Ego mode: only nodes within `hops` links of this node. */
  ego: string | null;
  hops: number;
}

export function titleOf(n: RawNode): string {
  return n.text ? String(n.text) : n.label;
}

/** Ids within `hops` links of `from` (undirected), over the given links. */
export function neighbourhood(from: string, links: readonly RawLink[], hops: number): Set<string> {
  const adj = new Map<string, string[]>();
  for (const l of links) {
    (adj.get(l.source) ?? adj.set(l.source, []).get(l.source)!).push(l.target);
    (adj.get(l.target) ?? adj.set(l.target, []).get(l.target)!).push(l.source);
  }
  const seen = new Set([from]);
  let frontier = [from];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) for (const o of adj.get(id) ?? []) if (!seen.has(o)) (seen.add(o), next.push(o));
    frontier = next;
  }
  return seen;
}

export function matches(n: RawNode, q: string): boolean {
  const s = q.trim().toLowerCase();
  return !s || titleOf(n).toLowerCase().includes(s) || n.label.toLowerCase().includes(s) || n.type.includes(s);
}

/** The subgraph the view shows: kind filter, confidence filter, ego network. Search does not filter, it highlights. */
export function visibleGraph(nodes: readonly RawNode[], links: readonly RawLink[], v: Omit<View, "query">): { nodes: Array<RawNode & { kind: KindId }>; links: RawLink[] } {
  let ns = nodes.flatMap((n) => {
    const kind = kindOf(n);
    return kind && !v.hiddenKinds.has(kind) ? [{ ...n, kind }] : [];
  });
  let ids = new Set(ns.map((n) => n.id));
  const ls = links.filter((l) => ids.has(l.source) && ids.has(l.target) && !v.hiddenConf.has(confidenceOf(l)));
  if (v.ego && ids.has(v.ego)) {
    const near = neighbourhood(v.ego, ls, v.hops);
    ns = ns.filter((n) => near.has(n.id));
    ids = new Set(ns.map((n) => n.id));
    return { nodes: ns, links: ls.filter((l) => ids.has(l.source) && ids.has(l.target)) };
  }
  return { nodes: ns, links: ls };
}

export function degrees(links: readonly RawLink[]): Map<string, number> {
  const d = new Map<string, number>();
  for (const l of links) {
    d.set(l.source, (d.get(l.source) ?? 0) + 1);
    d.set(l.target, (d.get(l.target) ?? 0) + 1);
  }
  return d;
}

/** Ids present in `next` but not in `prev` (what a live refresh brought in). Empty on the first load. */
export function freshIds(prev: readonly RawNode[] | null, next: readonly RawNode[]): Set<string> {
  if (!prev) return new Set();
  const old = new Set(prev.map((n) => n.id));
  return new Set(next.filter((n) => !old.has(n.id)).map((n) => n.id));
}

/** Deterministic start positions: each kind on its own ring so the physics begins near a readable layout. */
export function seedPosition(kind: KindId, i: number, count: number): { x: number; y: number } {
  const a = (i / Math.max(1, count)) * Math.PI * 2 + KINDS.findIndex((k) => k.id === kind);
  const r = KIND[kind].radius || 0;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}
