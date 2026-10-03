import { describe, expect, it } from "vitest";
import { axisPrice, extent, indexAt, linePath, scale, ticks } from "../dashboard/src/arenaChart.js";

describe("the chart geometry", () => {
  it("pads the extent, and gives a flat series some height", () => {
    const [lo, hi] = extent([10, 20]);
    expect(lo).toBeLessThan(10);
    expect(hi).toBeGreaterThan(20);
    const [a, b] = extent([5, 5, 5]);
    expect(b).toBeGreaterThan(a);
    expect(extent([])).toEqual([0, 1]);
  });
  it("makes round ticks inside the range", () => {
    expect(ticks(0, 100, 4)).toEqual([0, 50, 100]);
    const t = ticks(2012.3, 2087.9, 4);
    expect(t.every((x) => x >= 2012.3 && x <= 2087.9)).toBe(true);
    expect(t.length).toBeGreaterThanOrEqual(3);
  });
  it("maps prices to pixels with the high on top", () => {
    const y = scale(100, 200, 300, 0);
    expect(y(100)).toBe(300);
    expect(y(200)).toBe(0);
    expect(y(150)).toBe(150);
  });
  it("lifts the pen over a gap", () => {
    expect(linePath([1, null, 2, 3], (i) => i * 10, (v) => v)).toBe("M0.0 1.0M20.0 2.0L30.0 3.0");
  });
  it("finds the nearest bar and writes prices by their size", () => {
    expect(indexAt([0, 100, 200], 140)).toBe(1);
    expect(indexAt([], 1)).toBe(-1);
    expect(axisPrice(2345.678, "en")).toBe("2,346");
    expect(axisPrice(0.12345, "en")).toBe("0.1235");
  });
});
