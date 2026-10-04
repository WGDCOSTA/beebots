// One skill, one bee (brains/specialization.ts): no two bees specialise in the same skill, and each sees its own style's
// family first. Without it every council read the same ranking and every bee ended on the same champion skill.
import { describe, expect, it } from "vitest";
import { freeSpec, methodOptions, resolvePick, takenSkills } from "../src/brains/specialization.js";

const result = (skillId: string, family: string, score: number) => ({ skillId, family, score, stabilityPct: 60, params: {}, oos: { returnPct: 5, maxDrawdownPct: 3 } });
const ranking = { createdAt: 1, results: [result("ft_bb_rsi", "reversion", 1.12), result("trend_ema", "trend", 0.9), result("brk_donchian", "breakout", 0.7), result("mom_roc", "momentum", 0.5)] } as never;
const spec = (id: string) => ({ kind: "skill" as const, id, params: {}, reason: "", decidedAt: 0 });

describe("one skill, one bee", () => {
  it("lists the skills the other bees hold, not its own", () => {
    const bees = { bee1: { specialization: spec("ft_bb_rsi") }, bee2: { specialization: spec("ft_bb_rsi") }, bee3: { specialization: { kind: "style" as const, id: "boozy", params: {}, reason: "", decidedAt: 0 } } };
    expect(takenSkills(bees, "bee1")).toEqual(["ft_bb_rsi"]);
    expect(takenSkills(bees, "bee3")).toEqual(["ft_bb_rsi", "ft_bb_rsi"]);
  });

  it("gives up a shared skill and keeps a free one", () => {
    expect(freeSpec(spec("ft_bb_rsi"), ["ft_bb_rsi"])).toBeUndefined();
    expect(freeSpec(spec("trend_ema"), ["ft_bb_rsi"])).toMatchObject({ id: "trend_ema" });
    expect(freeSpec(undefined, ["x"])).toBeUndefined();
  });

  it("does not offer a taken skill, puts its own family first, and refuses a pick of a taken one", () => {
    const m = methodOptions({ market: "crypto", current: { kind: "own", id: "bizzy" }, ranking, taken: ["ft_bb_rsi"], family: "breakout" });
    expect(m.skills.map((s) => s.id)).toEqual(["brk_donchian", "trend_ema", "mom_roc"]);
    expect(resolvePick({ kind: "skill", id: "ft_bb_rsi", reason: "best score" } as never, m, 0)).toBeNull();
    expect(resolvePick({ kind: "skill", id: "brk_donchian", reason: "fits" } as never, m, 0)).toMatchObject({ id: "brk_donchian" });
  });

  it("keeps Degen's native scalp identity while its brain evolves rules in the coin book", () => {
    expect(methodOptions({ market: "crypto", current: { kind: "skill", id: "ft_bb_rsi" }, ranking, family: "scalp", extraStyles: ["scalp"] }))
      .toEqual({ current: { kind: "own", id: "degen" }, styles: [], skills: [] });
  });
});
