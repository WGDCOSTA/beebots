// Live lab votes: the skills in a bee's playbook, run on the latest confirmed 1h candles of each coin in its snapshot.
// The weighted vote (-1 = all adopted skills short, +1 = all long) goes into Jev's state as `lab`, a tiebreaker Jev
// may weigh. It never places or blocks an order by itself: the menu and the risk layer are unchanged.
import type { Candle } from "../market/types.js";
import type { Skill } from "../lab/skills/types.js";
import type { Playbook } from "./playbook.js";

export const LAB_NOTE = "state.lab: per-coin vote of this bee's backtested skills on 1h bars (-1 all short, +1 all long). A tiebreaker, not an order.";

export class LabSignals {
  private cache = new Map<string, { lastTs: number; vote: number | null }>();

  constructor(
    private skills: Map<string, Skill>,
    private playbook: () => Playbook | null,
  ) {}

  /** A skill a bee just wrote and backtested (brains/survival.ts): usable in votes right away. */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
    this.cache.clear();
  }

  /** `coins` maps instId -> coin ticker. Returns null when the bee has no playbook or no vote could be computed. */
  votes(slot: string, coins: Array<{ instId: string; coin: string }>, candles: (instId: string) => Candle[]): Record<string, number> | null {
    const plan = this.playbook()?.bees[slot];
    if (!plan?.skills.length) return null;
    const planKey = plan.skills.map((s) => `${s.id}:${s.weight}`).join("|");
    const out: Record<string, number> = {};
    for (const { instId, coin } of coins) {
      const c = candles(instId).filter((x) => x.confirmed);
      if (c.length < 30) continue;
      const lastTs = c[c.length - 1]!.ts;
      const key = `${slot}|${instId}|${planKey}`;
      const hit = this.cache.get(key);
      let vote: number | null;
      if (hit && hit.lastTs === lastTs) vote = hit.vote;
      else {
        vote = this.compute(plan.skills, c);
        this.cache.set(key, { lastTs, vote });
      }
      if (vote !== null) out[coin] = vote;
    }
    if (this.cache.size > 500) this.cache.clear();
    return Object.keys(out).length ? out : null;
  }

  private compute(adopted: Array<{ id: string; params: Record<string, number>; weight: number }>, c: Candle[]): number | null {
    let sum = 0;
    let w = 0;
    for (const a of adopted) {
      const skill = this.skills.get(a.id);
      if (!skill || a.weight <= 0) continue;
      try {
        const sig = skill.signal(c, { ...skill.defaults, ...a.params });
        sum += a.weight * sig[sig.length - 1]!;
        w += a.weight;
      } catch {
        /* a broken imported skill votes nothing */
      }
    }
    return w > 0 ? Math.round((sum / w) * 100) / 100 : null;
  }
}
