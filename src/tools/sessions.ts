// The trading hours the engine is learning for stocks and commodities (market/sessions.ts). Public data only, no keys.
//   pnpm sessions                     print the calendar (<LAB_DIR>/sessions.json): verified share, open hours, a week grid
//   pnpm sessions record --minutes 60 sample OKX's public tickers once a minute into the same file (the engine does
//                                     this by itself while it runs; this is for a machine without the engine)
import { labEnv } from "../config.js";
import { calendarSummary, emptyCalendar, loadCalendar, saveCalendar, SessionRecorder, sessionInfo, watchedHours, type TickSample } from "../market/sessions.js";
import { createPublicApi } from "../okx/public.js";

const env = labEnv();
const path = `${env.dir.replace(/\/+$/, "")}/sessions.json`;
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv[2] === "record") {
  const minutes = Math.max(1, Number(arg("minutes") ?? 60));
  const api = createPublicApi(process.env.OKX_API_BASE || "https://eea.okx.com", process.argv.includes("--demo"));
  const rec = new SessionRecorder(loadCalendar(path) ?? emptyCalendar(Date.now()));
  const instruments = (await api.instruments()).filter((i) => i.state === "live" && (i.kind === "stock" || i.kind === "commodity"));
  console.log(`recording ${instruments.length} stock/commodity X-Perps for ${minutes} min -> ${path}`);
  for (let m = 0; m <= minutes; m++) {
    const tickers = await api.tickers().catch(() => null);
    if (tickers) {
      const ticks: TickSample[] = [];
      for (const i of instruments) {
        const t = tickers.get(i.instId);
        if (t) ticks.push({ coin: i.coin, kind: i.kind, ts: t.ts, last: t.last, vol24h: t.vol24hUsd, spreadBp: t.spreadBp });
      }
      rec.sample(ticks, Date.now());
      if (m % 10 === 0) saveCalendar(path, rec.calendar);
    }
    if (m < minutes) await new Promise((r) => setTimeout(r, 60_000));
  }
  saveCalendar(path, rec.calendar);
}

const cal = loadCalendar(path);
if (!cal) {
  console.log(`No calendar yet at ${path}. The engine records one while it runs, or run: pnpm sessions record --minutes 60`);
  process.exit(0);
}
const now = Date.now();
console.log(`Trading hours learned so far (${watchedHours(cal, now)} h watched; a full week verifies every hour).`);
console.log("# open  . closed  ? not verified yet      UTC hours 0..23, Monday first\n");
for (const c of calendarSummary(cal)) {
  const info = sessionInfo(cal, c.coin, now);
  console.log(`${c.coin.padEnd(8)} ${c.kind.padEnd(10)} verified ${String(c.verifiedPct).padStart(3)}%  open ${String(c.openHoursPerWeek).padStart(3)} h/week  spread ${c.meanSpreadBp ?? "–"} bp  now: ${info.status}`);
  for (const row of c.grid) console.log(`    ${row}`);
}
