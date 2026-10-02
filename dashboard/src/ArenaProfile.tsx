// An agent's record drawn as a bunny's profile page draws one (BunnyPage.tsx): the big portrait with equity, position and
// health, the key numbers, the equity curve with axes and hover, P&L by day, the coins it trades, and every fill. The data
// is the same shape (bunnyProfile.ts on the agent's own database): GET /arena/bots/profile (the member's own agents) or
// /arena/showcase/profile (the platform's house agents, public).
import { useEffect, useMemo, useState } from "react";
import { Hero, Overview, RANGES, Trades, type BunnyProfile } from "./BunnyPage";
import { beeMeta, type PublicBee } from "./types";

export function ArenaProfile({ id, kind, bee, curve, rank = 0, of = 0 }: { id: string; kind: "own" | "house"; bee: PublicBee | undefined; curve?: Array<[number, number]>; rank?: number; of?: number }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<BunnyProfile | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let alive = true;
    const url = `/arena/${kind === "house" ? "showcase" : "bots"}/profile?id=${encodeURIComponent(id)}&days=${days}`;
    const load = () =>
      void fetch(url, { cache: "no-store", credentials: "same-origin" })
        .then(async (r) => {
          if (!alive) return;
          if (r.status === 404) setMissing(true);
          else if (r.ok) {
            setMissing(false);
            setData((await r.json()) as BunnyProfile);
          }
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, kind, days]);

  const m = beeMeta(id);
  const start = bee?.startEquityUsd ?? 1000;
  // The live curve (every 5 s) beats the profile's for the recent window; the profile's covers the longer ranges.
  const series = useMemo(() => {
    const since = Date.now() - days * 86_400_000;
    const liveCurve = (curve ?? []).filter((p) => p[0] >= since);
    return liveCurve.length >= 2 && days <= 7 ? liveCurve : (data?.equity ?? liveCurve);
  }, [curve, data, days]);

  return (
    <div className="ar-profile" style={{ ["--bee" as string]: m.color, ["--bee-glow" as string]: m.glow }}>
      <Hero slot={id} bee={bee} evo={null} rank={rank} of={of} start={start} />
      <div className="bp-filters ar-filters">
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
        {bee?.cap && <span className="ar-benched">{bee.last?.status ?? bee.cap}</span>}
      </div>
      {missing && !data ? (
        <div className="pcard arena-card dim">This agent is not running right now.</div>
      ) : (
        <div className="bp-body">
          <Overview data={data} curve={series} start={start} evo={null} slot={id} />
          <Trades data={data} />
        </div>
      )}
    </div>
  );
}
