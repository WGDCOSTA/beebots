// Where the visitors come from: a dotted world map with a glow per place, sized by visits, and the places watching right now
// pulsing. A place is the time zone the visitor's own page reported (no address is looked up), so a dot marks a zone's
// main city, not a person.
import { useEffect, useMemo, useState } from "react";
import { landDots, placesOf, project, radius } from "./mapModel";

const W = 720;
const H = 300;

interface MapData {
  total: number;
  watching: number;
  since: number;
  places: Array<[string, number]>;
  live: Array<[string, number]>;
}

export function VisitorMap({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<MapData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/visitors/map", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<MapData>) : Promise.reject(new Error(String(r.status)))))
        .then((d) => alive && setData(d))
        .catch(() => alive && setFailed(true));
    void load();
    const t = setInterval(load, 15_000);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const land = useMemo(() => landDots(), []);
  const all = useMemo(() => placesOf(data?.places ?? []), [data]);
  const live = useMemo(() => placesOf(data?.live ?? []), [data]);
  const max = Math.max(1, ...all.places.map((p) => p.n));
  const top = [...all.places].sort((a, b) => b.n - a.n).slice(0, 8);

  return (
    <div className="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal vmap" role="dialog" aria-modal="true" aria-labelledby="vmap-title">
        <button className="modal-x" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 id="vmap-title">Visitors around the world</h2>
        <p className="dim small">
          {data ? `${data.total.toLocaleString()} visitors · ${data.watching} watching now` : failed ? "The map is not available right now." : "Loading…"}
        </p>
        <svg className="vmap-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`World map with ${all.places.length} places`}>
          {land.map(([lat, lon], i) => {
            const [x, y] = project(lat, lon, W, H);
            return <circle key={i} className="vmap-land" cx={x} cy={y} r={1.6} />;
          })}
          {all.places.map((p) => {
            const [x, y] = project(p.lat, p.lon, W, H);
            return (
              <g key={p.tz}>
                <circle className="vmap-glow" cx={x} cy={y} r={radius(p.n, max) * 2.2} />
                <circle className="vmap-dot" cx={x} cy={y} r={radius(p.n, max)}>
                  <title>{`${p.city}: ${p.n.toLocaleString()} visits`}</title>
                </circle>
              </g>
            );
          })}
          {live.places.map((p) => {
            const [x, y] = project(p.lat, p.lon, W, H);
            return (
              <circle key={`l-${p.tz}`} className="vmap-live" cx={x} cy={y} r={4}>
                <title>{`${p.city}: ${p.n} watching now`}</title>
              </circle>
            );
          })}
        </svg>
        <div className="vmap-legend small">
          <span>
            <i className="vmap-key dot" /> visits since {data?.since ? new Date(data.since).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "the map began"}
          </span>
          <span>
            <i className="vmap-key live" /> watching now
          </span>
        </div>
        {top.length > 0 && (
          <ol className="vmap-top">
            {top.map((p) => (
              <li key={p.tz}>
                <span>{p.city}</span>
                <span className="num dim">{p.n.toLocaleString()}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="modal-disclaimer">Each place is the time zone a visitor's own browser reports, drawn at that zone's main city. No address is looked up or kept.</p>
      </div>
    </div>
  );
}
