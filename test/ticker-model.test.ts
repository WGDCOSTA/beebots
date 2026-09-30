import { describe, expect, it } from "vitest";
import { ago, groupDecisions, humanLabel, type StreamDecision } from "../dashboard/src/tickerModel.js";

const dec = (o: Partial<StreamDecision>): StreamDecision => ({
  ts: 0, bee: "bee1", choice: "WAIT", action: "hold", vetoedBy: null, forcedBy: null, jev: "ok", ...o,
});

describe("humanLabel", () => {
  it("names known calls in plain words", () => {
    expect(humanLabel("WAIT")).toBe("Wait");
    expect(humanLabel("HOLD_WINNER")).toBe("Hold the winner");
  });
  it("turns skill ids into readable text", () => {
    expect(humanLabel("FT_BB_RSI_LONG_ETH")).toBe("BB RSI long ETH");
  });
  it("explains a missing call", () => {
    expect(humanLabel(null)).toBe("No call");
    expect(humanLabel(null, "unreachable")).toBe("Jev unreachable");
  });
});

describe("ago", () => {
  it("formats relative times", () => {
    expect(ago(1000, 2000)).toBe("now");
    expect(ago(0, 30_000)).toBe("30s");
    expect(ago(0, 120_000)).toBe("2m");
    expect(ago(0, 7_200_000)).toBe("2h");
  });
});

describe("groupDecisions", () => {
  it("folds a bunny's repeated identical calls into one row, newest first", () => {
    const rows = groupDecisions([dec({ ts: 3 }), dec({ ts: 2 }), dec({ ts: 1 }), dec({ ts: 4, bee: "bee2" })].sort((a, b) => b.ts - a.ts));
    expect(rows).toHaveLength(2);
    const one = rows.find((r) => r.d.bee === "bee1")!;
    expect(one.n).toBe(3);
    expect(one.d.ts).toBe(3);
  });
  it("keeps different calls separate", () => {
    expect(groupDecisions([dec({ ts: 2, choice: "HOLD" }), dec({ ts: 1 })])).toHaveLength(2);
  });
});
