// The hive mind: an internal knowledge graph (SQLite) the bees, their LLM brains and the strategy lab all write to and
// read from. Nodes are things (bees, brains, skills, coins, lessons, messages, lab runs); edges are what we learned
// about how they relate (a skill performs on a coin, a bee adopts a skill, a brain recommends it, a bee said something
// to the hive). Every write is additive and timestamped, so the graph is the bees' long-term memory: each council or
// coach round starts from the context the previous ones left.
//
// export() writes NetworkX node-link JSON ({ nodes, links }), the graph.json format graphify and most graph tools read.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const NODE_TYPES = ["bee", "brain", "skill", "family", "coin", "lesson", "message", "run", "regime"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  props: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  src: string;
  rel: string;
  dst: string;
  weight: number;
  props: Record<string, unknown>;
  count: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS g_nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, label TEXT NOT NULL, props TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS g_nodes_type ON g_nodes(type, updated_at);
CREATE TABLE IF NOT EXISTS g_edges (src TEXT NOT NULL, rel TEXT NOT NULL, dst TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1,
  props TEXT NOT NULL DEFAULT '{}', count INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, PRIMARY KEY (src, rel, dst));
CREATE INDEX IF NOT EXISTS g_edges_dst ON g_edges(dst, rel);
`;

export const nodeId = (type: NodeType, key: string) => `${type}:${key}`;

type Row = Record<string, string | number | null>;

export class KnowledgeGraph {
  readonly raw: DatabaseSync;
  private now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
    this.now = now;
  }

  close(): void {
    this.raw.close();
  }

  /** Create or update a node; props are merged into what is already there. Returns its id. */
  upsert(type: NodeType, key: string, label: string, props: Record<string, unknown> = {}): string {
    const id = nodeId(type, key);
    const t = this.now();
    const old = this.node(id);
    const merged = JSON.stringify({ ...(old?.props ?? {}), ...props });
    this.raw
      .prepare(
        `INSERT INTO g_nodes (id, type, label, props, created_at, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, props = excluded.props, updated_at = excluded.updated_at`,
      )
      .run(id, type, label.slice(0, 200), merged, t, t);
    return id;
  }

  /**
   * Link two nodes. `mode: "set"` replaces the weight (a measurement, e.g. a score); `"add"` accumulates it (evidence,
   * e.g. P&L of each closed trade). Props are merged; `count` counts how often the link was reinforced.
   */
  link(src: string, rel: string, dst: string, weight = 1, props: Record<string, unknown> = {}, mode: "set" | "add" = "set"): void {
    const t = this.now();
    const old = this.edge(src, rel, dst);
    const w = old && mode === "add" ? old.weight + weight : weight;
    const merged = JSON.stringify({ ...(old?.props ?? {}), ...props });
    this.raw
      .prepare(
        `INSERT INTO g_edges (src, rel, dst, weight, props, count, updated_at) VALUES (?,?,?,?,?,1,?)
         ON CONFLICT(src, rel, dst) DO UPDATE SET weight = ?, props = excluded.props, count = count + 1, updated_at = excluded.updated_at`,
      )
      .run(src, rel, dst, w, merged, t, w);
  }

  unlink(src: string, rel: string, dst?: string): void {
    if (dst) this.raw.prepare("DELETE FROM g_edges WHERE src = ? AND rel = ? AND dst = ?").run(src, rel, dst);
    else this.raw.prepare("DELETE FROM g_edges WHERE src = ? AND rel = ?").run(src, rel);
  }

  node(id: string): GraphNode | null {
    const r = this.raw.prepare("SELECT * FROM g_nodes WHERE id = ?").get(id) as Row | undefined;
    return r ? toNode(r) : null;
  }

  edge(src: string, rel: string, dst: string): GraphEdge | null {
    const r = this.raw.prepare("SELECT * FROM g_edges WHERE src = ? AND rel = ? AND dst = ?").get(src, rel, dst) as Row | undefined;
    return r ? toEdge(r) : null;
  }

  nodes(type: NodeType, limit = 500): GraphNode[] {
    return (this.raw.prepare("SELECT * FROM g_nodes WHERE type = ? ORDER BY updated_at DESC LIMIT ?").all(type, limit) as Row[]).map(toNode);
  }

  /** Edges leaving `src` (optionally one relation), strongest first. */
  out(src: string, rel?: string, limit = 100): GraphEdge[] {
    const rows = rel
      ? this.raw.prepare("SELECT * FROM g_edges WHERE src = ? AND rel = ? ORDER BY weight DESC, updated_at DESC LIMIT ?").all(src, rel, limit)
      : this.raw.prepare("SELECT * FROM g_edges WHERE src = ? ORDER BY weight DESC, updated_at DESC LIMIT ?").all(src, limit);
    return (rows as Row[]).map(toEdge);
  }

  /** Edges arriving at `dst` (optionally one relation), newest first. */
  in(dst: string, rel?: string, limit = 100): GraphEdge[] {
    const rows = rel
      ? this.raw.prepare("SELECT * FROM g_edges WHERE dst = ? AND rel = ? ORDER BY updated_at DESC LIMIT ?").all(dst, rel, limit)
      : this.raw.prepare("SELECT * FROM g_edges WHERE dst = ? ORDER BY updated_at DESC LIMIT ?").all(dst, limit);
    return (rows as Row[]).map(toEdge);
  }

  // ---------- memory and messages ----------

  /** A lesson learned by `bee` (or by the lab, bee = null), optionally about other nodes (skills, coins). */
  learn(author: string, text: string, about: string[] = [], props: Record<string, unknown> = {}): string {
    const t = this.now();
    const key = `${t.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const id = this.upsert("lesson", key, text.slice(0, 200), { text: text.slice(0, 600), author, ...props });
    this.link(author, "learned", id, 1, {}, "set");
    for (const a of about) if (this.node(a)) this.link(id, "about", a);
    return id;
  }

  /** A message from one bee to another bee, or to the whole hive (`to` = "hive"). */
  post(from: string, to: string | "hive", text: string, props: Record<string, unknown> = {}): string {
    const t = this.now();
    const key = `${t.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const id = this.upsert("message", key, text.slice(0, 200), { text: text.slice(0, 600), from, to, ...props });
    this.link(from, "said", id);
    if (to !== "hive") this.link(id, "to", to);
    return id;
  }

  /** Messages a bee should read: addressed to it or to the hive, not its own, newest first. */
  inbox(bee: string, limit = 8): Array<{ from: string; text: string; ts: number }> {
    const rows = this.raw
      .prepare("SELECT * FROM g_nodes WHERE type = 'message' ORDER BY updated_at DESC LIMIT ?")
      .all(limit * 6) as Row[];
    return rows
      .map(toNode)
      .filter((n) => n.props.from !== bee && (n.props.to === "hive" || n.props.to === bee))
      .slice(0, limit)
      .map((n) => ({ from: String(n.props.from), text: String(n.props.text ?? n.label), ts: n.updatedAt }));
  }

  lessons(author: string, limit = 6): Array<{ text: string; ts: number }> {
    return this.out(author, "learned", 200)
      .map((e) => this.node(e.dst))
      .filter((n): n is GraphNode => !!n)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((n) => ({ text: String(n.props.text ?? n.label), ts: n.updatedAt }));
  }

  /** Delete lessons and messages older than `beforeMs` (they have been folded into newer ones by then). */
  prune(beforeMs: number): number {
    const old = this.raw.prepare("SELECT id FROM g_nodes WHERE type IN ('lesson','message') AND updated_at < ?").all(beforeMs) as Array<{ id: string }>;
    for (const r of old) {
      this.raw.prepare("DELETE FROM g_edges WHERE src = ? OR dst = ?").run(r.id, r.id);
      this.raw.prepare("DELETE FROM g_nodes WHERE id = ?").run(r.id);
    }
    return old.length;
  }

  stats(): Record<string, number> {
    const rows = this.raw.prepare("SELECT type, COUNT(*) AS n FROM g_nodes GROUP BY type").all() as Row[];
    const out: Record<string, number> = Object.fromEntries(rows.map((r) => [String(r.type), Number(r.n)]));
    out.edges = Number((this.raw.prepare("SELECT COUNT(*) AS n FROM g_edges").get() as Row).n);
    return out;
  }

  /** NetworkX node-link JSON (graphify's graph.json shape). */
  export(): { directed: true; multigraph: false; graph: Record<string, unknown>; nodes: unknown[]; links: unknown[] } {
    const nodes = (this.raw.prepare("SELECT * FROM g_nodes").all() as Row[]).map(toNode);
    const links = (this.raw.prepare("SELECT * FROM g_edges").all() as Row[]).map(toEdge);
    return {
      directed: true,
      multigraph: false,
      graph: { name: "beebots hive mind", exportedAt: this.now() },
      nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, ...n.props, created_at: n.createdAt, updated_at: n.updatedAt })),
      links: links.map((e) => ({ source: e.src, target: e.dst, relation: e.rel, weight: e.weight, count: e.count, ...e.props, updated_at: e.updatedAt })),
    };
  }
}

function toNode(r: Row): GraphNode {
  return {
    id: String(r.id),
    type: String(r.type) as NodeType,
    label: String(r.label),
    props: JSON.parse(String(r.props ?? "{}")) as Record<string, unknown>,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toEdge(r: Row): GraphEdge {
  return {
    src: String(r.src),
    rel: String(r.rel),
    dst: String(r.dst),
    weight: Number(r.weight),
    props: JSON.parse(String(r.props ?? "{}")) as Record<string, unknown>,
    count: Number(r.count),
    updatedAt: Number(r.updated_at),
  };
}
