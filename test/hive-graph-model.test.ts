import { describe, expect, it } from "vitest";
import { confidenceOf, freshIds, kindOf, neighbourhood, visibleGraph, type RawLink, type RawNode } from "../dashboard/src/hiveGraphModel.js";

const n = (id: string, type: string): RawNode => ({ id, type, label: id, updated_at: 1 });
const l = (source: string, target: string, relation = "adopts"): RawLink => ({ source, target, relation, weight: 1 });
const nodes = [n("a", "bee"), n("b", "skill"), n("c", "coin"), n("d", "lesson"), n("e", "run"), n("f", "memory")];
const links = [l("a", "b"), l("b", "c", "performs_on"), l("c", "d"), l("a", "f")];
const none = { hiddenKinds: new Set<never>(), hiddenConf: new Set<never>(), ego: null, hops: 1 };

describe("hive graph model", () => {
  it("maps kinds, folding lessons and messages, dropping unknown types", () => {
    expect(kindOf(n("x", "lesson"))).toBe("note");
    expect(kindOf(n("x", "message"))).toBe("note");
    expect(kindOf(n("x", "style"))).toBe("style");
    expect(kindOf(n("x", "run"))).toBeNull();
  });
  it("classifies confidence, preferring what the server sent", () => {
    expect(confidenceOf(l("a", "b", "traded"))).toBe("EXTRACTED");
    expect(confidenceOf(l("a", "b", "adopts"))).toBe("INFERRED");
    expect(confidenceOf({ relation: "adopts", confidence: "AMBIGUOUS" })).toBe("AMBIGUOUS");
  });
  it("walks the neighbourhood by hops", () => {
    expect([...neighbourhood("a", links, 1)].sort()).toEqual(["a", "b", "f"]);
    expect([...neighbourhood("a", links, 2)].sort()).toEqual(["a", "b", "c", "f"]);
    expect(neighbourhood("a", links, 0).size).toBe(1);
  });
  it("filters by kind, confidence and ego, and never leaves dangling links", () => {
    expect(visibleGraph(nodes, links, none).nodes.map((x) => x.id)).toEqual(["a", "b", "c", "d", "f"]);
    const noSkill = visibleGraph(nodes, links, { ...none, hiddenKinds: new Set(["skill" as const]) });
    expect(noSkill.links.every((k) => k.source !== "b" && k.target !== "b")).toBe(true);
    const facts = visibleGraph(nodes, links, { ...none, hiddenConf: new Set(["INFERRED" as const]) });
    expect(facts.links).toEqual([links[1]]);
    const ego = visibleGraph(nodes, links, { ...none, ego: "c", hops: 1 });
    expect(ego.nodes.map((x) => x.id).sort()).toEqual(["b", "c", "d"]);
  });
  it("finds what a refresh added, and nothing on the first load", () => {
    expect(freshIds(null, nodes).size).toBe(0);
    expect([...freshIds(nodes.slice(0, 4), nodes)].sort()).toEqual(["e", "f"]);
  });
});
