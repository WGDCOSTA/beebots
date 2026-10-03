// The Farmer on the main page: who he is, when he looks next, what he said last (big), his recent lines, and a link to
// everything he did (the #/farmer page: every round, every rewrite with the old and the new rules side by side).
import { useEffect, useState } from "react";
import { PageNav } from "./LabPage";
import { beeMeta, type FarmerEntry, type FarmerSummary } from "./types";

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function until(ts: number | null): string {
  if (!ts) return "soon";
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}

/** His face: the painted portrait once the engine made it, else the drawn one (public/farmer.svg). */
function Portrait({ small = false, src }: { small?: boolean; src?: string }) {
  const [url, setUrl] = useState(src ?? "/farmer.svg");
  useEffect(() => setUrl(src ?? "/farmer.svg"), [src]);
  return <img className={`farmer-face ${small ? "sm" : ""}`} src={url} alt="" onError={() => setUrl("/farmer.svg")} />;
}

const line = (e: FarmerEntry) => (e.kind === "say" ? e.text : `${e.text}${e.reason ? ` ${e.reason}` : ""}`);

export function FarmerCard({ farmer }: { farmer: FarmerSummary | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!farmer?.enabled) return null;
  const [last, ...rest] = farmer.recent;
  return (
    <section className="farmer" aria-label={farmer.name}>
      <div className="farmer-head">
        <Portrait src={farmer.image} />
        <div className="farmer-who">
          <div className="farmer-name">{farmer.name.toUpperCase()}</div>
          <div className="dim small">
            checks every bunny every {farmer.everyMin >= 60 ? `${Math.round(farmer.everyMin / 60)} h` : `${farmer.everyMin} min`} · {farmer.rewrites} rewrite{farmer.rewrites === 1 ? "" : "s"} so far
            {farmer.mode === "advise" ? " · real money: he only suggests" : ""}
          </div>
        </div>
        <div className="farmer-next">
          <span className="dim small">next round</span>
          <strong>{until(farmer.nextAt)}</strong>
        </div>
      </div>
      {last ? (
        <div className="farmer-quote">
          <Portrait small src={farmer.image} />
          <div>
            <p>“{line(last)}”</p>
            <div className="farmer-quote-foot">
              <span>{last.kind === "rewrite" ? "Rewrote rules" : last.kind === "suggest" ? "Suggestion" : "Hands off"}</span>
              <span className="dim">{ago(last.ts)}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="dim farmer-quiet">He has not done his first round yet.</p>
      )}
      {rest.length > 0 && (
        <ul className="farmer-list">
          {rest.slice(0, 6).map((e) => (
            <li key={e.id}>
              <Portrait small src={farmer.image} />
              <span className={e.kind !== "say" ? "farmer-act" : ""}>{line(e)}</span>
              <span className="dim small">{ago(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
      <a className="farmer-more" href="#/farmer">
        Read what he did, in full →
      </a>
      {farmer.model && <div className="farmer-by dim small">Thinks with {farmer.model}</div>}
    </section>
  );
}

/** #/farmer: every round he did, newest first, with each rewrite's old and new rules. */
export function FarmerPage() {
  const [farmer, setFarmer] = useState<FarmerSummary | null>(null);
  const [entries, setEntries] = useState<FarmerEntry[]>([]);
  const [more, setMore] = useState(true);
  const load = (before?: number) =>
    fetch(`/farmer?limit=50${before ? `&before=${before}` : ""}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ farmer: FarmerSummary; entries: FarmerEntry[] }>)
      .then((j) => {
        setFarmer(j.farmer);
        setEntries((x) => (before ? [...x, ...j.entries] : j.entries));
        setMore(j.entries.length === 50);
      })
      .catch(() => setMore(false));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="bp">
      <PageNav current="farmer" />
      <div className="bp-wrap farmer-page">
        <a href="#/" className="bp-back">
          ← Live board
        </a>
        <div className="farmer-page-head">
          <Portrait src={farmer?.image} />
          <h1>{farmer?.name ?? "The Farmer"}</h1>
        </div>
        <p className="dim">
          He looks at every bunny every {farmer ? Math.round(farmer.everyMin / 60) || 1 : 2} h and says one thing. He may rewrite a bunny's rules (never its coins, style or money), at most once per bunny per day.
          {farmer?.mode === "advise" ? " This warren trades real money, so he only suggests: the owner decides." : ""}
        </p>
        <ol className="farmer-log">
          {entries.map((e) => (
            <li key={e.id} className={`k-${e.kind}`}>
              <div className="farmer-log-top">
                <strong>{e.kind === "say" ? "Said" : e.kind === "rewrite" ? `Rewrote ${e.bee ? beeMeta(e.bee).short : ""}` : `Suggested for ${e.bee ? beeMeta(e.bee).short : ""}`}</strong>
                <span className="dim small">{new Date(e.ts).toLocaleString()}</span>
              </div>
              <p>{e.kind === "say" ? `“${e.text}”` : e.reason}</p>
              {e.newRules !== null && (
                <div className="farmer-diff">
                  <div>
                    <span className="eyebrow">Before</span>
                    <p>{e.oldRules || <span className="dim">(no rules)</span>}</p>
                  </div>
                  <div>
                    <span className="eyebrow">{e.kind === "rewrite" ? "After" : "Suggested"}</span>
                    <p>{e.newRules}</p>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
        {entries.length === 0 && <p className="dim">Nothing yet.</p>}
        {more && entries.length > 0 && (
          <button className="pbtn ghost" onClick={() => void load(entries[entries.length - 1]!.id)}>
            Older
          </button>
        )}
      </div>
    </div>
  );
}
