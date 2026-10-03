import { describe, expect, it } from "vitest";
import { AutoLab, type LabCommand } from "../src/autolab.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 1, 12);

class MetaStore {
  values = new Map<string, string>();
  getMeta(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function lab(db: MetaStore, run: (args: LabCommand) => Promise<void>, now: () => number, overrides: Partial<ConstructorParameters<typeof AutoLab>[0]> = {}) {
  return new AutoLab({
    db,
    intervalHours: 24,
    scalpIntervalHours: 168,
    startDelayMin: 5,
    instruments: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    scalpCoins: ["BTC-USDT-SWAP"],
    scalpEnabled: true,
    run,
    now,
    ...overrides,
  });
}

describe("autonomous lab", () => {
  it("refreshes ranking and scalp evidence, then follows their independent durable schedules", async () => {
    const db = new MetaStore();
    const commands: LabCommand[] = [];
    let clock = NOW;
    const auto = lab(db, async (args) => { commands.push(args); }, () => clock);

    expect(await auto.runDue(clock)).toEqual(["ranking", "scalp"]);
    expect(commands).toEqual([
      ["fetch", "--inst", "BTC-USDT-SWAP,ETH-USDT-SWAP", "--bar", "1H", "--days", "365"],
      ["run", "--bar", "1H"],
      ["fetch", "--inst", "BTC-USDT-SWAP", "--bar", "1m", "--days", "14"],
      ["scalp", "--inst", "BTC-USDT-SWAP"],
    ]);
    expect(db.getMeta("autolab_ranking_success_at")).toBe(String(NOW));
    expect(db.getMeta("autolab_scalp_success_at")).toBe(String(NOW));

    clock = NOW + HOUR;
    expect(await auto.runDue(clock)).toEqual([]);
    clock = NOW + 24 * HOUR;
    expect(await auto.runDue(clock)).toEqual(["ranking"]);
    expect(auto.state(clock).scalp.due).toBe(false);
  });

  it("backs off a failed job and still runs the other job", async () => {
    const db = new MetaStore();
    let clock = NOW;
    let rankingFailures = 0;
    const auto = lab(db, async (args) => {
      if (args.includes("1H") && rankingFailures++ === 0) throw new Error("temporary history failure");
    }, () => clock);

    expect(await auto.runDue(clock)).toEqual(["scalp"]);
    expect(db.getMeta("autolab_ranking_success_at")).toBeNull();
    expect(db.getMeta("autolab_ranking_attempt_at")).toBe(String(NOW));

    clock = NOW + 30 * 60_000;
    expect(await auto.runDue(clock)).toEqual([]);
    clock = NOW + HOUR;
    expect(await auto.runDue(clock)).toEqual(["ranking"]);
  });

  it("does nothing when autonomous maintenance is disabled", async () => {
    const db = new MetaStore();
    let calls = 0;
    const auto = lab(db, async () => { calls++; }, () => NOW, { intervalHours: 0, scalpIntervalHours: 0 });
    expect(await auto.runDue()).toEqual([]);
    expect(calls).toBe(0);
  });
});
