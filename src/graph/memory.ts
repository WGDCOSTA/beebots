// Graph memory in the spirit of graphify (github.com/Graphify-Labs/graphify): instead of pasting a growing pile of
// notes into every prompt, a brain gets a small, relevant slice of the hive mind.
//
// - Confidence on every edge: EXTRACTED (a fact the engine or the lab measured: a trade, a backtest), INFERRED (what a
//   brain concluded: a lesson, an adoption, a recommendation) or AMBIGUOUS (facts that disagree: the lab says a skill
//   works on a coin, the bee's real trades there lose money). Brains are told to trust facts over inferences.
// - Communities: weighted label propagation groups nodes that belong together (a bee, its skills, its coins); each gets
//   a label from its most connected members.
// - Scoped recall: `subgraph(focus)` walks out from the nodes that matter to this decision (the bee, the coins it
//   holds or watches, its method) and keeps the strongest, freshest links within a budget.
// - Consolidation: older lessons are folded into one memory per community (by the bee's own brain, or by rules), so
//   nothing is lost and the context stays small. Originals are kept, marked consolidated.
// - `query`, `path`, `explain` and a report (god nodes, surprising connections, communities, specialisations).
import type { GraphEdge, GraphNode, KnowledgeGraph } from "./graph.js";

export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/** Relations that record something measured (a fill, a backtest, a configuration), not an opinion. */
const FACT_RELS = new Set(["traded", "performs_on", "ranked", "authored", "tested", "tested_skill", "restricted_to", "thinks_with", "to", "said", "learned"]);

export function confidenceOf(e: Pick<GraphEdge, "rel">): Confidence {
  return FACT_RELS.has(e.rel) ? "EXTRACTED" : "INFERRED";
}

/** Nodes that are text, not entities: they hang off the entity graph and never shape communities. */
const TEXT_TYPES = new Set(["lesson", "message", "memory"]);

interface Loaded {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  adj: Map<string, Array<{ to: string; e: GraphEdge }>>;
}

function load(g: KnowledgeGraph, limit = 20_000): Loaded {
  const nodes = new Map<string, GraphNode>();
  for (const n of g.allNodes(limit)) nodes.set(n.id, n);
  const edges = g.allEdges(limit * 3).filter((e) => nodes.has(e.src) && nodes.has(e.dst));
  const adj = new Map<string, Array<{ to: string; e: GraphEdge }>>();
  const add = (a: string, b: string, e: GraphEdge) => {
    const l = adj.get(a) ?? [];
    l.push({ to: b, e });
    adj.set(a, l);
  };
  for (const e of edges) {
    add(e.src, e.dst, e);
    add(e.dst, e.src, e);
  }
  return { nodes, edges, adj };
}

const strength = (e: GraphEdge) => Math.log1p(Math.abs(e.weight) + e.count);

// ---------- communities ----------

export interface Community {
  id: string;
  label: string;
  size: number;
  members: string[];
}

/**
 * Weighted label propagation over the entity graph (lessons and messages left out), deterministic: nodes in id order,
 * each takes the label its neighbours carry most strongly (ties to the smallest label), until nothing changes.
 */
export function communities(g: KnowledgeGraph, maxIter = 20): { byNode: Map<string, string>; list: Community[] } {
  const { nodes, adj } = load(g);
  const ids = [...nodes.keys()].filter((id) => !TEXT_TYPES.has(nodes.get(id)!.type)).sort();
  const label = new Map(ids.map((id) => [id, id]));
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (const id of ids) {
      const score = new Map<string, number>();
      for (const { to, e } of adj.get(id) ?? []) {
        const l = label.get(to);
        if (l) score.set(l, (score.get(l) ?? 0) + strength(e));
      }
      if (!score.size) continue;
      const best = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const groups = new Map<string, string[]>();
  for (const [id, l] of label) groups.set(l, [...(groups.get(l) ?? []), id]);
  const degree = (id: string) => (adj.get(id) ?? []).reduce((a, x) => a + strength(x.e), 0);
  const list = [...groups.values()]
    .map((members) => {
      const top = [...members].sort((a, b) => degree(b) - degree(a)).slice(0, 3);
      return { id: top[0]!, label: top.map((id) => nodes.get(id)?.label ?? id).join(" · "), size: members.length, members };
    })
    .sort((a, b) => b.size - a.size);
  const byNode = new Map<string, string>();
  for (const c of list) for (const m of c.members) byNode.set(m, c.id);
  return { byNode, list };
}

// ---------- god nodes and surprising connections ----------

/** The most connected entities: what the hive's knowledge revolves around. */
export function godNodes(g: KnowledgeGraph, k = 8): Array<{ id: string; label: string; type: string; degree: number }> {
  const { nodes, adj } = load(g);
  return [...nodes.values()]
    .filter((n) => !TEXT_TYPES.has(n.type))
    .map((n) => ({ id: n.id, label: n.label, type: n.type, degree: (adj.get(n.id) ?? []).length }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, k);
}

export interface Conflict {
  bee: string;
  coin: string;
  skill: string;
  labScore: number;
  realNetUsd: number;
  trades: number;
  confidence: "AMBIGUOUS";
  text: string;
}

/**
 * Facts that disagree: a skill the bee adopted scores well out of sample on a coin, but the bee's real trades on that
 * coin lose money (or the other way round). These are the connections worth a brain's attention.
 */
export function conflicts(g: KnowledgeGraph, beeId?: string): Conflict[] {
  const out: Conflict[] = [];
  const bees = beeId ? [beeId] : g.nodes("bee", 50).map((n) => n.id);
  for (const b of bees) {
    const adopted = g.out(b, "adopts", 20).map((e) => e.dst);
    for (const t of g.out(b, "traded", 50)) {
      const trades = Number(t.props.trades ?? 0);
      if (trades < 3) continue;
      for (const s of adopted) {
        const perf = g.edge(s, "performs_on", t.dst);
        if (!perf) continue;
        if (Math.sign(perf.weight) !== 0 && Math.sign(perf.weight) !== Math.sign(t.weight)) {
          const coin = t.dst.replace(/^coin:/, "");
          const skill = s.replace(/^skill:/, "");
          out.push({
            bee: b.replace(/^bee:/, ""),
            coin,
            skill,
            labScore: +perf.weight.toFixed(2),
            realNetUsd: +t.weight.toFixed(2),
            trades,
            confidence: "AMBIGUOUS",
            text: `${skill} scores ${perf.weight.toFixed(2)} on ${coin} in the lab, but ${trades} real trades there netted $${t.weight.toFixed(2)}`,
          });
        }
      }
    }
  }
  return out;
}

// ---------- scoped recall ----------

export interface Slice {
  nodes: Array<{ id: string; type: string; label: string }>;
  edges: Array<{ src: string; rel: string; dst: string; w: number; confidence: Confidence }>;
}

/**
 * The part of the graph that matters around `focus`: best-first walk (strong, fresh, factual links first) up to
 * `hops` away, at most `maxNodes` entities. Text nodes (lessons, messages) are left to the memory layer.
 */
export function subgraph(g: KnowledgeGraph, focus: string[], o: { hops?: number; maxNodes?: number } = {}): Slice {
  const { nodes, adj } = load(g);
  const hops = o.hops ?? 2;
  const maxNodes = o.maxNodes ?? 30;
  const newest = Math.max(1, ...[...nodes.values()].map((n) => n.updatedAt));
  const seen = new Map<string, number>();
  const keep: GraphEdge[] = [];
  let frontier = focus.filter((f) => nodes.has(f));
  for (const f of frontier) seen.set(f, 0);
  for (let h = 1; h <= hops && seen.size < maxNodes; h++) {
    const cand: Array<{ to: string; e: GraphEdge; score: number }> = [];
    for (const id of frontier) {
      for (const { to, e } of adj.get(id) ?? []) {
        const n = nodes.get(to);
        if (!n || TEXT_TYPES.has(n.type)) continue;
        const fresh = 0.5 + 0.5 * (e.updatedAt / newest);
        const score = strength(e) * fresh * (confidenceOf(e) === "EXTRACTED" ? 1.5 : 1);
        cand.push({ to, e, score });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const next: string[] = [];
    for (const c of cand) {
      if (!seen.has(c.to)) {
        if (seen.size >= maxNodes) break;
        seen.set(c.to, h);
        next.push(c.to);
      }
      if (seen.has(c.e.src) && seen.has(c.e.dst) && !keep.includes(c.e)) keep.push(c.e);
    }
    frontier = next;
  }
  return {
    nodes: [...seen.keys()].map((id) => ({ id, type: nodes.get(id)!.type, label: nodes.get(id)!.label })),
    edges: keep.slice(0, maxNodes * 2).map((e) => ({ src: e.src, rel: e.rel, dst: e.dst, w: +e.weight.toFixed(3), confidence: confidenceOf(e) })),
  };
}

/** Shortest undirected path between two nodes (ids or labels), as "a -rel-> b" steps; null when unconnected. */
export function path(g: KnowledgeGraph, from: string, to: string): string[] | null {
  const { nodes, adj } = load(g);
  const a = resolve(nodes, from);
  const b = resolve(nodes, to);
  if (!a || !b) return null;
  const prev = new Map<string, { from: string; e: GraphEdge }>();
  const q = [a];
  const seen = new Set([a]);
  while (q.length) {
    const id = q.shift()!;
    if (id === b) break;
    for (const { to: n, e } of adj.get(id) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, { from: id, e });
      q.push(n);
    }
  }
  if (!seen.has(b)) return null;
  const steps: string[] = [];
  for (let cur = b; cur !== a; ) {
    const p = prev.get(cur)!;
    steps.unshift(`${nodes.get(p.e.src)?.label ?? p.e.src} -${p.e.rel}-> ${nodes.get(p.e.dst)?.label ?? p.e.dst}`);
    cur = p.from;
  }
  return steps;
}

/** A node and its connections, strongest first, with confidence. */
export function explain(g: KnowledgeGraph, what: string) {
  const { nodes, adj } = load(g);
  const id = resolve(nodes, what);
  if (!id) return null;
  const n = nodes.get(id)!;
  const links = (adj.get(id) ?? [])
    .sort((x, y) => strength(y.e) - strength(x.e))
    .slice(0, 25)
    .map(({ to, e }) => ({ rel: e.src === id ? e.rel : `<-${e.rel}`, node: nodes.get(to)?.label ?? to, type: nodes.get(to)?.type, w: +e.weight.toFixed(3), confidence: confidenceOf(e) }));
  return { id, type: n.type, label: n.label, props: n.props, links };
}

/** A question in words: the nodes whose id or label matches its words become the focus of a scoped slice. */
export function query(g: KnowledgeGraph, q: string, o: { hops?: number; maxNodes?: number } = {}): Slice & { focus: string[] } {
  const words = q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 2);
  const focus = g
    .allNodes(20_000)
    .filter((n) => !TEXT_TYPES.has(n.type))
    .filter((n) => words.some((w) => n.id.toLowerCase().split(/[:_\s-]/).includes(w) || n.label.toLowerCase().split(/[\s·_-]+/).includes(w)))
    .slice(0, 8)
    .map((n) => n.id);
  return { focus, ...subgraph(g, focus, o) };
}

function resolve(nodes: Map<string, GraphNode>, what: string): string | null {
  if (nodes.has(what)) return what;
  const w = what.toLowerCase();
  for (const n of nodes.values()) if (n.label.toLowerCase() === w || n.id.toLowerCase().endsWith(`:${w}`)) return n.id;
  return null;
}

// ---------- consolidation ----------

/**
 * Fold a bee's older lessons into memories so its context stays small without forgetting: every lesson beyond the
 * `keepRecent` newest is grouped by the community of what it is about, and each group is merged into that community's
 * memory node (`summarize` = the bee's brain; without one, a rules digest). Returns how many lessons were folded.
 */
export async function consolidate(
  g: KnowledgeGraph,
  author: string,
  o: { keepRecent?: number; summarize?: (previous: string | null, lessons: string[]) => Promise<string> } = {},
): Promise<number> {
  const keep = o.keepRecent ?? 6;
  const lessons = g
    .out(author, "learned", 500)
    .map((e) => g.node(e.dst))
    .filter((n): n is GraphNode => !!n && n.type === "lesson" && !n.props.consolidated)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(keep);
  if (!lessons.length) return 0;
  const { byNode } = communities(g);
  const groups = new Map<string, GraphNode[]>();
  for (const l of lessons) {
    const about = g.out(l.id, "about", 5).map((e) => byNode.get(e.dst)).find(Boolean) ?? "general";
    groups.set(about, [...(groups.get(about) ?? []), l]);
  }
  for (const [community, items] of groups) {
    const key = `${author.replace(/^[a-z]+:/, "")}:${community}`;
    const memId = `memory:${key}`;
    const prev = g.node(memId);
    const texts = items.map((l) => String(l.props.text ?? l.label));
    let text: string;
    try {
      text = o.summarize ? await o.summarize(prev ? String(prev.props.text ?? "") : null, texts) : rulesDigest(prev ? String(prev.props.text ?? "") : null, texts);
    } catch {
      text = rulesDigest(prev ? String(prev.props.text ?? "") : null, texts);
    }
    const communityLabel = g.node(community)?.label ?? community;
    g.upsert("memory", key, `memory: ${communityLabel}`, { text: text.slice(0, 1200), author, community, lessons: Number(prev?.props.lessons ?? 0) + items.length });
    g.link(author, "remembers", memId, 1);
    if (community !== "general" && g.node(community)) g.link(memId, "about", community);
    for (const l of items) {
      g.upsert("lesson", l.id.replace(/^lesson:/, ""), l.label, { consolidated: true, memory: memId });
      g.link(l.id, "folded_into", memId);
    }
  }
  return lessons.length;
}

/** No brain: keep the distinct lessons, newest first, within a budget. */
export function rulesDigest(previous: string | null, lessons: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const t of [...lessons, ...(previous ? previous.split(" | ") : [])]) {
    const k = t.trim().toLowerCase().slice(0, 60);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    parts.push(t.trim().slice(0, 200));
  }
  return parts.join(" | ").slice(0, 1200);
}

/** A bee's memories (consolidated lessons), strongest first. */
export function memories(g: KnowledgeGraph, author: string, limit = 4): Array<{ about: string; text: string; lessons: number }> {
  return g
    .out(author, "remembers", 50)
    .map((e) => g.node(e.dst))
    .filter((n): n is GraphNode => !!n)
    .sort((a, b) => Number(b.props.lessons ?? 0) - Number(a.props.lessons ?? 0))
    .slice(0, limit)
    .map((n) => ({ about: n.label.replace(/^memory: /, ""), text: String(n.props.text ?? ""), lessons: Number(n.props.lessons ?? 0) }));
}

// ---------- report ----------

/** HIVE_REPORT.md: what the hive knows, graphify-style. */
export function hiveReport(g: KnowledgeGraph): string {
  const s = g.stats();
  const gods = godNodes(g, 10);
  const comms = communities(g).list.slice(0, 10);
  const conf = conflicts(g);
  const bees = g.nodes("bee", 20);
  const lines = [
    "# Hive report",
    "",
    `Nodes: ${Object.entries(s)
      .filter(([k]) => k !== "edges")
      .map(([k, v]) => `${v} ${k}`)
      .join(", ")}; ${s.edges ?? 0} edges.`,
    "",
    "## God nodes (most connected)",
    ...gods.map((n) => `- **${n.label}** (${n.type}, ${n.degree} links)`),
    "",
    "## Communities",
    ...comms.map((c) => `- ${c.label}: ${c.size} nodes`),
    "",
    "## Surprising connections (facts that disagree)",
    ...(conf.length ? conf.slice(0, 10).map((c) => `- ${c.bee}: ${c.text}`) : ["- none yet"]),
    "",
    "## Specialisations",
    ...bees.map((b) => {
      const sp = g.out(b.id, "specialises_in", 1)[0];
      return `- ${b.label}: ${sp ? `${g.node(sp.dst)?.label ?? sp.dst}${sp.props.reason ? ` (${String(sp.props.reason).slice(0, 120)})` : ""}` : "its own style"}`;
    }),
    "",
    "## Memories",
    ...bees.flatMap((b) => memories(g, b.id, 3).map((m) => `- ${b.label} / ${m.about} (${m.lessons} lessons): ${m.text.slice(0, 200)}`)),
    "",
  ];
  return lines.join("\n");
}
