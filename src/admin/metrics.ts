// The admin console's numbers (dashboard/src/AdminConsole.tsx): everything the engine already records, aggregated per
// time bucket over a chosen range. Read-only SQL over the engine database; nothing here calls an exchange or a brain.
import type { DatabaseSync } from "node:sqlite";
import { blockers } from "../bunnyProfile.js";
import { priceOf } from "../brains/usage.js";

export const RANGES = { "24h": { hours: 24, bucketH: 1 }, "7d": { hours: 168, bucketH: 6 }, "30d": { hours: 720, bucketH: 24 }, "90d": { hours: 2160, bucketH: 24 } } as const;
export type RangeId = keyof typeof RANGES;

export interface MetricsBee {
  slot: string;
  name: string;
  style: string;
  startEquityUsd: number | null;
}

export interface MetricsOpts {
  db: DatabaseSync;
  bees: MetricsBee[];
  range: RangeId;
  now: number;
  prices: Map<string, { inUsd: number; outUsd: number }>;
  jevDailyCapUsd: number;
}

const H = 3_600_000;
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : Number(x ?? 0) || 0);
const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null);
const has = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

export function adminMetrics(o: MetricsOpts) {
  const { db, now } = o;
  const R = RANGES[o.range];
  const size = R.bucketH * H;
  // Buckets end at the next bucket boundary after now, so the last one is "now".
  const end = Math.ceil(now / size) * size;
  const n = Math.round((R.hours * H) / size);
  const start = end - n * size;
  const buckets = Array.from({ length: n }, (_, i) => start + i * size);
  const slots = o.bees.map((b) => b.slot);
  const zero = () => new Array<number>(n).fill(0);
  const perBee = <T>(f: () => T) => Object.fromEntries(slots.map((s) => [s, f()])) as Record<string, T>;
  const bucketExpr = `CAST((ts - ${start}) / ${size} AS INTEGER)`;

  // ---- equity: the last snapshot in each bucket, carried forward through empty ones ----
  const equity = perBee(() => new Array<number | null>(n).fill(null));
  for (const r of db
    .prepare(`SELECT e.bee AS bee, x.b AS b, e.equity_usd AS eq FROM equity_snapshots e JOIN (SELECT bee, ${bucketExpr} AS b, MAX(ts) AS mt FROM equity_snapshots WHERE ts >= ? GROUP BY bee, b) x ON e.bee = x.bee AND e.ts = x.mt`)
    .all(start) as Array<{ bee: string; b: number; eq: number }>) {
    if (equity[r.bee] && r.b >= 0 && r.b < n) equity[r.bee]![r.b] = num(r.eq);
  }
  for (const s of slots) {
    const before = db.prepare("SELECT equity_usd AS eq FROM equity_snapshots WHERE bee = ? AND ts < ? ORDER BY ts DESC LIMIT 1").get(s, start) as { eq: number } | undefined;
    let last: number | null = before ? num(before.eq) : null;
    const row = equity[s]!;
    for (let i = 0; i < n; i++) {
      if (row[i] === null) row[i] = last;
      else last = row[i]!;
    }
  }
  const equityTotal = buckets.map((_, i) => {
    const vals = slots.map((s) => equity[s]![i]).filter((v): v is number => v !== null);
    return vals.length ? r2(vals.reduce((a, b) => a + b, 0)) : null;
  });

  // ---- trading: realised P&L, fees, volume, wins per bucket and bunny; funding ----
  const realised = perBee(zero);
  const fees = perBee(zero);
  const volume = perBee(zero);
  const totals = perBee(() => ({ realisedUsd: 0, feesUsd: 0, fundingUsd: 0, volumeUsd: 0, fills: 0, closes: 0, wins: 0 }));
  for (const r of db
    .prepare(`SELECT bee, ${bucketExpr} AS b, SUM(realised_usd) AS rl, SUM(fee_usd) AS fee, SUM(notional_usd) AS vol, COUNT(*) AS n, SUM(CASE WHEN realised_usd <> 0 THEN 1 ELSE 0 END) AS closes, SUM(CASE WHEN realised_usd - fee_usd > 0 AND realised_usd <> 0 THEN 1 ELSE 0 END) AS wins FROM fills WHERE ts >= ? GROUP BY bee, b`)
    .all(start) as Array<Record<string, number | string>>) {
    const s = String(r.bee);
    const b = num(r.b);
    if (!totals[s] || b < 0 || b >= n) continue;
    realised[s]![b] = r2(num(r.rl));
    fees[s]![b] = r4(num(r.fee));
    volume[s]![b] = r2(num(r.vol));
    const t = totals[s]!;
    t.realisedUsd += num(r.rl);
    t.feesUsd += num(r.fee);
    t.volumeUsd += num(r.vol);
    t.fills += num(r.n);
    t.closes += num(r.closes);
    t.wins += num(r.wins);
  }
  const funding = perBee(zero);
  for (const r of db.prepare(`SELECT bee, ${bucketExpr} AS b, SUM(amount_usd) AS a FROM funding WHERE ts >= ? GROUP BY bee, b`).all(start) as Array<Record<string, number | string>>) {
    const s = String(r.bee);
    const b = num(r.b);
    if (!totals[s] || b < 0 || b >= n) continue;
    funding[s]![b] = r4(num(r.a));
    totals[s]!.fundingUsd += num(r.a);
  }
  const netPnl = perBee(zero);
  for (const s of slots) for (let i = 0; i < n; i++) netPnl[s]![i] = r2(realised[s]![i]! - fees[s]![i]! + funding[s]![i]!);

  // ---- decisions and Jev ----
  const dec = { total: zero(), opened: zero(), vetoed: zero(), forced: zero(), waited: zero(), errors: zero() };
  const jevCost = perBee(zero);
  const decByBee = perBee(() => ({ decisions: 0, opened: 0, vetoed: 0, errors: 0, jevUsd: 0, tokens: 0 }));
  for (const r of db
    .prepare(
      `SELECT bee, ${bucketExpr} AS b, COUNT(*) AS n,
        SUM(CASE WHEN json_extract(action_json, '$.kind') = 'open' AND vetoed_by IS NULL THEN 1 ELSE 0 END) AS opened,
        SUM(CASE WHEN vetoed_by IS NOT NULL THEN 1 ELSE 0 END) AS vetoed,
        SUM(CASE WHEN forced_by IS NOT NULL THEN 1 ELSE 0 END) AS forced,
        SUM(CASE WHEN jev_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
        SUM(jev_cost_usd) AS cost, SUM(COALESCE(input_tokens, 0)) AS tok
       FROM decisions WHERE ts >= ? GROUP BY bee, b`,
    )
    .all(start) as Array<Record<string, number | string>>) {
    const s = String(r.bee);
    const b = num(r.b);
    if (b < 0 || b >= n) continue;
    dec.total[b]! += num(r.n);
    dec.opened[b]! += num(r.opened);
    dec.vetoed[b]! += num(r.vetoed);
    dec.forced[b]! += num(r.forced);
    dec.errors[b]! += num(r.errors);
    dec.waited[b]! += Math.max(0, num(r.n) - num(r.opened) - num(r.vetoed) - num(r.forced) - num(r.errors));
    if (jevCost[s]) jevCost[s]![b] = r4(num(r.cost));
    const t = decByBee[s];
    if (t) {
      t.decisions += num(r.n);
      t.opened += num(r.opened);
      t.vetoed += num(r.vetoed);
      t.errors += num(r.errors);
      t.jevUsd += num(r.cost);
      t.tokens += num(r.tok);
    }
  }
  const lat = (db.prepare("SELECT latency_ms AS l FROM decisions WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY id DESC LIMIT 5000").all(start) as Array<{ l: number }>).map((r) => num(r.l)).sort((a, b) => a - b);
  const dayStart = Math.floor(now / (24 * H)) * 24 * H;
  const jevToday = num((db.prepare("SELECT SUM(jev_cost_usd) AS c FROM decisions WHERE ts >= ?").get(dayStart) as { c: number | null }).c);

  // ---- LLM brains (brains/usage.ts) ----
  const llmBrains: string[] = [];
  const llmTokens: Record<string, number[]> = {};
  const purposes: Array<{ purpose: string; calls: number; errors: number; inTokens: number; outTokens: number; avgLatencyMs: number; costUsd: number | null }> = [];
  const models: Array<{ brain: string; model: string; calls: number; errors: number; inTokens: number; outTokens: number; costUsd: number | null }> = [];
  const llmCost = zero();
  let llmCalls = 0;
  let llmTodayTokens = 0;
  let llmTodayCost = 0;
  let unpriced = 0;
  if (has(db, "llm_usage")) {
    for (const r of db.prepare(`SELECT brain, ${bucketExpr} AS b, SUM(in_tokens + out_tokens) AS t FROM llm_usage WHERE ts >= ? GROUP BY brain, b`).all(start) as Array<Record<string, number | string>>) {
      const br = String(r.brain);
      const b = num(r.b);
      if (b < 0 || b >= n) continue;
      if (!llmTokens[br]) {
        llmTokens[br] = zero();
        llmBrains.push(br);
      }
      llmTokens[br]![b] = num(r.t);
    }
    const costOf = (model: string, inTok: number, outTok: number) => {
      const p = priceOf(o.prices, model);
      return p ? (inTok * p.inUsd + outTok * p.outUsd) / 1e6 : null;
    };
    for (const r of db.prepare(`SELECT model, ${bucketExpr} AS b, SUM(in_tokens) AS i, SUM(out_tokens) AS o FROM llm_usage WHERE ts >= ? GROUP BY model, b`).all(start) as Array<Record<string, number | string>>) {
      const b = num(r.b);
      const c = costOf(String(r.model), num(r.i), num(r.o));
      if (b >= 0 && b < n && c !== null) llmCost[b]! += c;
    }
    for (const r of db.prepare("SELECT brain, model, COUNT(*) AS n, SUM(1 - ok) AS err, SUM(in_tokens) AS i, SUM(out_tokens) AS o FROM llm_usage WHERE ts >= ? GROUP BY brain, model ORDER BY SUM(in_tokens + out_tokens) DESC").all(start) as Array<Record<string, number | string>>) {
      const c = costOf(String(r.model), num(r.i), num(r.o));
      if (c === null && num(r.i) + num(r.o) > 0) unpriced++;
      llmCalls += num(r.n);
      models.push({ brain: String(r.brain), model: String(r.model), calls: num(r.n), errors: num(r.err), inTokens: num(r.i), outTokens: num(r.o), costUsd: c === null ? null : r4(c) });
    }
    const byPurposeModel = db.prepare("SELECT purpose, model, COUNT(*) AS n, SUM(1 - ok) AS err, SUM(in_tokens) AS i, SUM(out_tokens) AS o, SUM(latency_ms) AS l FROM llm_usage WHERE ts >= ? GROUP BY purpose, model").all(start) as Array<Record<string, number | string>>;
    const pmap = new Map<string, (typeof purposes)[number] & { lat: number }>();
    for (const r of byPurposeModel) {
      const k = String(r.purpose);
      const p = pmap.get(k) ?? { purpose: k, calls: 0, errors: 0, inTokens: 0, outTokens: 0, avgLatencyMs: 0, costUsd: 0 as number | null, lat: 0 };
      const c = costOf(String(r.model), num(r.i), num(r.o));
      p.calls += num(r.n);
      p.errors += num(r.err);
      p.inTokens += num(r.i);
      p.outTokens += num(r.o);
      p.lat += num(r.l);
      p.costUsd = p.costUsd === null || c === null ? (c === null && num(r.i) + num(r.o) > 0 ? null : p.costUsd) : p.costUsd + c;
      pmap.set(k, p);
    }
    for (const p of [...pmap.values()].sort((a, b) => b.inTokens + b.outTokens - (a.inTokens + a.outTokens))) {
      purposes.push({ purpose: p.purpose, calls: p.calls, errors: p.errors, inTokens: p.inTokens, outTokens: p.outTokens, avgLatencyMs: p.calls ? Math.round(p.lat / p.calls) : 0, costUsd: p.costUsd === null ? null : r4(p.costUsd) });
    }
    for (const r of db.prepare("SELECT model, SUM(in_tokens) AS i, SUM(out_tokens) AS o FROM llm_usage WHERE ts >= ? GROUP BY model").all(dayStart) as Array<Record<string, number | string>>) {
      llmTodayTokens += num(r.i) + num(r.o);
      llmTodayCost += costOf(String(r.model), num(r.i), num(r.o)) ?? 0;
    }
  }

  // ---- system ----
  const orders = (db.prepare("SELECT state, COUNT(*) AS n FROM orders WHERE ts >= ? GROUP BY state ORDER BY n DESC").all(start) as Array<{ state: string; n: number }>).map((r) => ({ state: r.state, n: num(r.n) }));
  const orderErrors = (db.prepare("SELECT error, COUNT(*) AS n FROM orders WHERE ts >= ? AND error IS NOT NULL GROUP BY error ORDER BY n DESC LIMIT 8").all(start) as Array<{ error: string; n: number }>).map((r) => ({ error: String(r.error).slice(0, 160), n: num(r.n) }));
  const recon = db.prepare("SELECT SUM(ok) AS ok, COUNT(*) AS n FROM reconciliations WHERE ts >= ?").get(start) as { ok: number | null; n: number };
  const caps = (db.prepare("SELECT cap, COUNT(*) AS n FROM caps WHERE ts >= ? GROUP BY cap ORDER BY n DESC LIMIT 12").all(start) as Array<{ cap: string; n: number }>).map((r) => ({ cap: r.cap, n: num(r.n) }));
  const events = (db.prepare("SELECT type, COUNT(*) AS n FROM events WHERE ts >= ? GROUP BY type ORDER BY n DESC LIMIT 16").all(start) as Array<{ type: string; n: number }>).map((r) => ({ type: r.type, n: num(r.n) }));
  const recentFills = (db.prepare("SELECT bee, ts, inst_id AS inst, side, notional_usd AS notional, px, fee_usd AS fee, realised_usd AS realised FROM fills ORDER BY ts DESC, id DESC LIMIT 25").all() as Array<Record<string, number | string>>).map((r) => ({
    bee: String(r.bee), ts: num(r.ts), coin: String(r.inst).split("-")[0]!, side: String(r.side), notionalUsd: r2(num(r.notional)), px: num(r.px), feeUsd: r4(num(r.fee)), realisedUsd: r2(num(r.realised)),
  }));

  const hours = R.hours;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const bees = o.bees.map((b) => {
    const t = totals[b.slot]!;
    const d = decByBee[b.slot]!;
    const eq = equity[b.slot]!;
    const first = eq.find((v) => v !== null) ?? null;
    const last = [...eq].reverse().find((v) => v !== null) ?? null;
    let peak = -Infinity;
    let maxDd = 0;
    for (const v of eq) {
      if (v === null) continue;
      peak = Math.max(peak, v);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - v) / peak) * 100);
    }
    return {
      ...b,
      equityUsd: last === null ? null : r2(last),
      changeUsd: first !== null && last !== null ? r2(last - first) : null,
      changePct: first ? r2(((last! - first) / first) * 100) : null,
      maxDrawdownPct: r2(maxDd),
      realisedUsd: r2(t.realisedUsd),
      feesUsd: r2(t.feesUsd),
      fundingUsd: r2(t.fundingUsd),
      netUsd: r2(t.realisedUsd - t.feesUsd + t.fundingUsd),
      volumeUsd: r2(t.volumeUsd),
      fills: t.fills,
      closes: t.closes,
      winRatePct: t.closes ? Math.round((t.wins / t.closes) * 100) : null,
      decisions: d.decisions,
      opened: d.opened,
      vetoed: d.vetoed,
      jevErrors: d.errors,
      jevUsd: r4(d.jevUsd),
      jevTokens: d.tokens,
      blockers: blockers(db, b.slot, now, Math.min(hours, 168)).top.slice(0, 4),
    };
  });

  return {
    range: o.range,
    at: now,
    start,
    bucketMs: size,
    buckets,
    bees,
    series: {
      equity,
      equityTotal,
      netPnl,
      realised,
      fees,
      funding,
      volume,
      jevCost,
      decisions: dec,
      llmTokens,
      llmCostUsd: llmCost.map(r4),
    },
    totals: {
      equityUsd: equityTotal[n - 1] ?? null,
      netPnlUsd: r2(sum(slots.map((s) => sum(netPnl[s]!)))),
      feesUsd: r2(sum(slots.map((s) => sum(fees[s]!)))),
      fundingUsd: r2(sum(slots.map((s) => sum(funding[s]!)))),
      volumeUsd: r2(sum(slots.map((s) => sum(volume[s]!)))),
      decisions: sum(dec.total),
      opened: sum(dec.opened),
      vetoed: sum(dec.vetoed),
      jevErrors: sum(dec.errors),
      jevUsd: r4(sum(slots.map((s) => sum(jevCost[s]!)))),
      jevTodayUsd: r4(jevToday),
      jevDailyCapUsd: o.jevDailyCapUsd,
      jevLatencyMs: { p50: pct(lat, 50), p95: pct(lat, 95) },
      llmCalls,
      llmTokens: sum(Object.values(llmTokens).map(sum)),
      llmCostUsd: r4(sum(llmCost)),
      llmTodayTokens,
      llmTodayCostUsd: r4(llmTodayCost),
      llmUnpricedModels: unpriced,
    },
    llm: { brains: llmBrains, purposes, models },
    system: { orders, orderErrors, reconciliations: { ok: num(recon.ok), total: num(recon.n) }, caps, events },
    recentFills,
  };
}

export type AdminMetrics = ReturnType<typeof adminMetrics>;
