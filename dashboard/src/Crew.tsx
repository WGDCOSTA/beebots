// The crew on the main page, beside the Farmer: the Owl (coach), the Rat (market analyst) and the Pig (accountant). Each card
// shows who it is, what it said last, its latest notes and when it looks next; #/crew/<id> shows everything it wrote.
import { useEffect, useState } from "react";
import { PageNav } from "./LabPage";
import { beeMeta, type CrewEntry, type CrewSummary } from "./types";

const EMOJI: Record<string, string> = { owl: "🦉", rat: "🐀", pig: "🐷" };

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function until(ts: number | null): string {
  if (!ts) return "soon";
  const m = Math.max(0, Math.round((ts - Date.now()) / 60_000));
  return m < 1 ? "now" : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
}
const every = (min: number) => (min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`);

/** Its face: the painted portrait once the engine made it, else its animal. */
function Face({ m, small = false }: { m: Pick<CrewSummary, "id" | "image">; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (m.image && !broken) return <img className={`farmer-face crew-face ${small ? "sm" : ""}`} src={m.image} alt="" onError={() => setBroken(true)} />;
  return (
    <span className={`farmer-face crew-face crew-emoji ${small ? "sm" : ""}`} aria-hidden>
      {EMOJI[m.id] ?? "•"}
    </span>
  );
}

const forBee = (e: CrewEntry) => (e.bee ? beeMeta(e.bee).short : "Warren");

function CrewCard({ m }: { m: CrewSummary }) {
  return (
    <section className={`farmer crew-card crew-${m.id}`} aria-label={m.name}>
      <div className="farmer-head">
        <Face m={m} />
        <div className="farmer-who">
          <div className="farmer-name">{m.name.toUpperCase()}</div>
          <div className="dim small">
            {m.role} · every {every(m.everyMin)}
          </div>
        </div>
        <div className="farmer-next">
          <span className="dim small">next</span>
          <strong>{until(m.nextAt)}</strong>
        </div>
      </div>
      <p className="dim small crew-job">{m.job}</p>
      {m.said ? (
        <div className="farmer-quote">
          <div>
            <p>“{m.said.text}”</p>
            <div className="farmer-quote-foot">
              <span>Said</span>
              <span className="dim">{ago(m.said.ts)}</span>
            </div>
          </div>
        </div>
      ) : (
        <p className="dim farmer-quiet">{m.error ? `Could not finish his round: ${m.error}` : "Has not done his first round yet."}</p>
      )}
      {m.notes.length > 0 && (
        <ul className="farmer-list crew-notes">
          {m.notes.slice(0, 3).map((n) => (
            <li key={n.id}>
              <span className={`crew-level l-${n.level ?? "info"}`}>{n.level === "act" ? "act" : n.level === "watch" ? "watch" : "note"}</span>
              <span>
                <strong>{forBee(n)}</strong> · {n.title ? `${n.title}: ` : ""}
                {n.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      <a className="farmer-more" href={`#/crew/${m.id}`}>
        Everything he wrote →
      </a>
      {m.model && <div className="farmer-by dim small">Thinks with {m.model}</div>}
    </section>
  );
}

/** The three crew cards in a row, under the Farmer. */
export function CrewRow({ crew }: { crew: CrewSummary[] | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const on = (crew ?? []).filter((m) => m.enabled);
  if (!on.length) return null;
  return (
    <div className="crew-row">
      {on.map((m) => (
        <CrewCard key={m.id} m={m} />
      ))}
    </div>
  );
}

/** #/crew/<id>: everything one crew member wrote, newest first. */
const readId = () => location.hash.replace(/^#\/?/, "").split(/[/?]/)[1] ?? "owl";

export function CrewPage() {
  const [id, setId] = useState(readId);
  useEffect(() => {
    const on = () => setId(readId());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const [m, setM] = useState<CrewSummary | null>(null);
  const [entries, setEntries] = useState<CrewEntry[]>([]);
  const [more, setMore] = useState(true);
  const [missing, setMissing] = useState(false);
  const load = (before?: number) =>
    fetch(`/crew/${id}?limit=50${before ? `&before=${before}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setMissing(true);
          return;
        }
        const j = (await r.json()) as { member: CrewSummary; entries: CrewEntry[] };
        setM(j.member);
        setEntries((x) => (before ? [...x, ...j.entries] : j.entries));
        setMore(j.entries.length === 50);
      })
      .catch(() => setMore(false));
  useEffect(() => {
    setEntries([]);
    setM(null);
    setMissing(false);
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="bp">
      <PageNav current="crew" />
      <div className="bp-wrap farmer-page">
        <a href="#/" className="bp-back">
          ← Live board
        </a>
        <div className="crew-tabs">
          {(["owl", "rat", "pig"] as const).map((x) => (
            <a key={x} href={`#/crew/${x}`} className={x === id ? "on" : ""}>
              {EMOJI[x]} {x === "owl" ? "The Owl" : x === "rat" ? "The Rat" : "The Pig"}
            </a>
          ))}
        </div>
        {missing ? (
          <p className="dim">No such crew member.</p>
        ) : (
          <>
            <div className="farmer-page-head">
              {m && <Face m={m} />}
              <h1>{m?.name ?? ""}</h1>
            </div>
            {m && (
              <p className="dim">
                The {m.role}. {m.job} Every {every(m.everyMin)}. He advises; he never trades, moves money or changes a bunny's coins, style or size.
                {m.model ? ` Thinks with ${m.model}.` : ""}
              </p>
            )}
            <ol className="farmer-log">
              {entries.map((e) => (
                <li key={e.id} className={`k-${e.kind}`}>
                  <div className="farmer-log-top">
                    <strong>{e.kind === "say" ? "Said" : `${forBee(e)} · ${e.title ?? ""}`}</strong>
                    {e.level && <span className={`crew-level l-${e.level}`}>{e.level}</span>}
                    <span className="dim small">{new Date(e.ts).toLocaleString()}</span>
                  </div>
                  <p>{e.kind === "say" ? `“${e.text}”` : e.text}</p>
                </li>
              ))}
            </ol>
            {entries.length === 0 && <p className="dim">{m?.error ? `His last round failed: ${m.error}` : "Nothing yet: his first round is coming."}</p>}
            {more && entries.length > 0 && (
              <button className="pbtn ghost" onClick={() => void load(entries[entries.length - 1]!.id)}>
                Older
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
