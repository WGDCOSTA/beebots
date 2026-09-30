// "Your bunnies" on the Arena page: the member's bots, and the form to make or change one. Plan limits are enforced by
// the server; the page shows what the plan leaves out as locked, with the reason, instead of hiding it.
import { useCallback, useEffect, useState } from "react";
import { draftProblem, runSummary, STYLE_LABEL, toggleCoin, type BotDraft, type RunStatus } from "./arenaModel";

interface Avatar {
  id: string;
  label: string;
  glyph: string;
  color: string;
}
interface Theme {
  id: string;
  label: string;
  blurb: string;
  tier: "free" | "pro";
  avatars: Avatar[];
}
interface Limits {
  bots: number;
  maxCoins: number;
  styles: string[];
  proThemes: boolean;
}
interface Bot extends BotDraft {
  id: string;
  image: boolean;
  version: number;
  createdAt: number;
}
interface Catalogue {
  themes: Theme[];
  coins: string[];
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await fetch(`/arena/${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", "x-arena": "1" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

interface AiStatus {
  enabled: boolean;
  designsLeft: number;
  portraitsLeft: number;
  canDesign: boolean;
  portraitBotId: string | null;
}

const EMPTY: BotDraft = { name: "", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "", tagline: "", look: "", listed: true };

function Portrait({ cat, theme, avatar, size = 44, botId }: { cat: Catalogue; theme: string; avatar: string; size?: number; botId?: string }) {
  const a = cat.themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar);
  if (botId) return <img className="ab-portrait ab-photo" src={`/arena/bot-image/${botId}`} width={size} height={size} alt="" />;
  return (
    <span className="ab-portrait" style={{ width: size, height: size, fontSize: size * 0.55, ["--av" as string]: a?.color ?? "#888" }} aria-hidden>
      {a?.glyph ?? "?"}
    </span>
  );
}

function Form({ cat, limits, ai, initial, editing, onDone, onCancel }: { cat: Catalogue; limits: Limits; ai: AiStatus | null; initial: BotDraft; editing: Bot | null; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<BotDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const theme = cat.themes.find((t) => t.id === d.theme);
  const problem = draftProblem(d, limits.maxCoins);
  const [idea, setIdea] = useState("");
  const [designing, setDesigning] = useState(false);
  const [note, setNote] = useState("");
  const [left, setLeft] = useState(ai?.designsLeft ?? 0);

  const design = async () => {
    setDesigning(true);
    setError("");
    setNote("");
    try {
      const r = await call<{ draft?: Partial<BotDraft> & { note?: string } }>("POST", "ai/design", { description: idea });
      if (r.status === 200 && r.data.draft) {
        const { note: n, ...f } = r.data.draft;
        setD((cur) => ({ ...cur, ...f, coins: f.coins ?? cur.coins }));
        setLeft((x) => Math.max(0, x - 1));
        setNote(n ?? "Here is the design. Read it, change anything you like, then press Create.");
      } else {
        if (r.status === 422) setLeft((x) => Math.max(0, x - 1));
        setError(r.data.error ?? "Could not design it. Try again.");
      }
    } catch {
      setError("The Arena is not reachable right now.");
    } finally {
      setDesigning(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await call("POST", editing ? "bots/update" : "bots/create", editing ? { ...d, id: editing.id } : d);
      if (r.status === 200) onDone();
      else setError(r.data.error ?? "Could not save. Try again.");
    } catch {
      setError("The Arena is not reachable right now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="ab-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{editing ? `Edit ${editing.name}` : "Create a bunny"}</h3>

      {!editing && ai?.canDesign && left > 0 && (
        <div className="ab-ai">
          <div className="eyebrow">Let the Arena design it</div>
          <p className="dim small">Describe your bunny in a sentence. The Arena writes its name, rules, coins and look for you, free for your first bunny ({left} {left === 1 ? "try" : "tries"} left). You can change everything before creating it.</p>
          <textarea className="pinput ab-rules" rows={2} maxLength={400} placeholder="e.g. a patient bunny that only buys sharp dips in BTC and ETH, and never trades on weekends" value={idea} onChange={(e) => setIdea(e.target.value)} />
          <div className="arena-actions">
            <button type="button" className="pbtn" disabled={designing || idea.trim().length < 8} onClick={() => void design()}>
              {designing ? "Designing…" : "Design it for me"}
            </button>
          </div>
          {note && <p className="dim small">{note}</p>}
        </div>
      )}

      <div className="eyebrow">Theme</div>
      <div className="ab-chips">
        {cat.themes.map((t) => {
          const locked = t.tier === "pro" && !limits.proThemes;
          return (
            <button key={t.id} type="button" className={`ab-chip ${d.theme === t.id ? "on" : ""}`} disabled={locked} title={locked ? "Pro members only" : t.blurb} onClick={() => setD({ ...d, theme: t.id, avatar: t.avatars[0]!.id })}>
              {t.label}
              {locked && <small> Pro</small>}
            </button>
          );
        })}
      </div>
      {theme && <p className="dim small">{theme.blurb}</p>}

      <div className="eyebrow">Avatar</div>
      <div className="ab-avatars">
        {theme?.avatars.map((a) => (
          <button key={a.id} type="button" className={`ab-avatar ${d.avatar === a.id ? "on" : ""}`} onClick={() => setD({ ...d, avatar: a.id })} aria-label={a.label} aria-pressed={d.avatar === a.id}>
            <Portrait cat={cat} theme={d.theme} avatar={a.id} size={52} />
            <span className="small">{a.label}</span>
          </button>
        ))}
      </div>

      <label className="eyebrow" htmlFor="ab-name">
        Name
      </label>
      <input id="ab-name" className="pinput" maxLength={24} placeholder="e.g. Fluffy Quant" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />

      <label className="ab-listed">
        <input type="checkbox" checked={d.listed} onChange={(e) => setD({ ...d, listed: e.target.checked })} />
        <span>
          <strong>Show on the public leaderboard</strong>
          <span className="dim small"> Others see its name, style, results and your public name. Never your e-mail, rules or open positions. You can turn this off any time.</span>
        </span>
      </label>

      <label className="eyebrow" htmlFor="ab-tag">
        Tagline <span className="dim">(optional)</span>
      </label>
      <input id="ab-tag" className="pinput" maxLength={40} placeholder="the sleepy dip hunter" value={d.tagline} onChange={(e) => setD({ ...d, tagline: e.target.value })} />

      <label className="eyebrow" htmlFor="ab-look">
        What it looks like <span className="dim">(for its portrait, optional)</span>
      </label>
      <input id="ab-look" className="pinput" maxLength={400} placeholder="a sleepy bunny in a nightcap, holding a tiny chart" value={d.look} onChange={(e) => setD({ ...d, look: e.target.value })} />

      <div className="eyebrow">Trading style</div>
      <div className="ab-styles">
        {Object.entries(STYLE_LABEL).map(([id, s]) => {
          const locked = !limits.styles.includes(id);
          return (
            <button key={id} type="button" className={`ab-style ${d.style === id ? "on" : ""}`} disabled={locked} onClick={() => setD({ ...d, style: id })}>
              <strong>
                {s.label}
                {locked && <small> Pro</small>}
              </strong>
              <span className="dim small">{s.blurb}</span>
            </button>
          );
        })}
      </div>

      <div className="eyebrow">
        Coins <span className="dim">({d.coins.length}/{limits.maxCoins})</span>
      </div>
      <div className="ab-chips">
        {cat.coins.map((c) => (
          <button key={c} type="button" className={`ab-chip ${d.coins.includes(c) ? "on" : ""}`} aria-pressed={d.coins.includes(c)} onClick={() => setD({ ...d, coins: toggleCoin(d.coins, c, limits.maxCoins) })}>
            {c}
          </button>
        ))}
      </div>

      <label className="eyebrow" htmlFor="ab-rules">
        Rules, in your own words
      </label>
      <textarea id="ab-rules" className="pinput ab-rules" rows={4} maxLength={500} placeholder="How should it trade? When should it stay out? What must it never do?" value={d.rules} onChange={(e) => setD({ ...d, rules: e.target.value })} />
      <div className="dim small">{d.rules.trim().length} / 500{editing ? ". Changing style, coins or rules starts a new version of this bunny, with a fresh paper account." : ""}</div>

      {error && <p className="bad">{error}</p>}
      <div className="arena-actions">
        <button className="pbtn" disabled={busy || problem !== null} title={problem ?? undefined}>
          {busy ? "Saving…" : editing ? "Save changes" : "Create bunny"}
        </button>
        <button type="button" className="pbtn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {problem && d.name.length + d.rules.length > 0 && <p className="dim small">{problem}</p>}
    </form>
  );
}

export function ArenaBots({ limits }: { limits: Limits }) {
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [mode, setMode] = useState<"list" | "new" | Bot>("list");
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [runner, setRunner] = useState<{ enabled: boolean; runs: Record<string, RunStatus> }>({ enabled: false, runs: {} });
  const [painting, setPainting] = useState<string | null>(null);
  const [paintError, setPaintError] = useState("");

  const load = useCallback(async () => {
    try {
      const [c, b, a] = await Promise.all([call<Catalogue>("GET", "catalogue"), call<{ bots: Bot[]; runner: { enabled: boolean; runs: Record<string, RunStatus> } }>("GET", "bots"), call<AiStatus>("GET", "ai/status")]);
      if (c.status === 200 && b.status === 200) {
        setCat(c.data);
        setBots(b.data.bots);
        setRunner(b.data.runner);
        setAi(a.status === 200 ? a.data : null);
      } else setError("Could not load your bunnies.");
    } catch {
      setError("The Arena is not reachable right now.");
    }
  }, []);
  useEffect(() => {
    void load();
    // A running bunny's account moves: look again every 15 seconds while the list is showing.
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (error) return <div className="pcard arena-card"><p className="bad">{error}</p></div>;
  if (!cat || !bots) return <div className="pcard arena-card dim">Loading your bunnies…</div>;

  if (mode !== "list")
    return (
      <div className="pcard arena-card">
        <Form
          cat={cat}
          limits={limits}
          ai={ai}
          editing={mode === "new" ? null : mode}
          initial={mode === "new" ? EMPTY : { name: mode.name, theme: mode.theme, avatar: mode.avatar, style: mode.style, coins: mode.coins, rules: mode.rules, tagline: mode.tagline, look: mode.look, listed: mode.listed }}
          onCancel={() => setMode("list")}
          onDone={() => {
            setMode("list");
            void load();
          }}
        />
      </div>
    );

  const full = bots.length >= limits.bots;
  return (
    <div className="pcard arena-card">
      <div className="arena-who">
        <h3>Your bunnies</h3>
        <span className="dim small">
          {bots.length} / {limits.bots}
        </span>
      </div>
      {bots.length === 0 && <p className="dim">You have no bunny yet. Make one, give it rules, and it will race on real prices with simulated money.</p>}
      {bots.map((b) => (
        <div className="ab-bot" key={b.id}>
          <Portrait cat={cat} theme={b.theme} avatar={b.avatar} botId={b.image ? b.id : undefined} />
          <div className="ab-bot-main">
            <div>
              <strong>{b.name}</strong> {b.tagline && <span className="dim small">{b.tagline} </span>}<span className="badge">{STYLE_LABEL[b.style]?.label ?? b.style}</span> <span className="dim small">v{b.version}</span> <span className={`badge ${b.listed ? "ok" : ""}`}>{b.listed ? "On the leaderboard" : "Private"}</span>
            </div>
            <div className="dim small">{b.coins.join(" · ")}</div>
            <div className="ab-rules-preview small">{b.rules}</div>
            {(() => {
              const sum = runSummary(runner.enabled, runner.runs[b.id]);
              return (
                <div className={`ab-run ${sum.tone}`}>
                  <strong>{sum.headline}</strong>
                  <span className="small">{sum.detail}</span>
                </div>
              );
            })()}
            <div className="arena-actions">
              <button className="pbtn ghost small" onClick={() => setMode(b)}>
                Edit
              </button>
              {ai?.portraitBotId === b.id && (
                <button
                  className="pbtn ghost small"
                  disabled={painting !== null}
                  title="Painted with the Arena's own image model, free for your first bunny"
                  onClick={async () => {
                    setPainting(b.id);
                    setPaintError("");
                    try {
                      const r = await call("POST", "ai/portrait", { id: b.id });
                      if (r.status !== 200) setPaintError(r.data.error ?? "Could not paint it. Try again.");
                    } catch {
                      setPaintError("The Arena is not reachable right now.");
                    } finally {
                      setPainting(null);
                      void load();
                    }
                  }}
                >
                  {painting === b.id ? "Painting… (up to a minute)" : `${b.image ? "Repaint" : "Paint"} its portrait (${ai.portraitsLeft} left)`}
                </button>
              )}
              {removing === b.id ? (
                <>
                  <button
                    className="pbtn danger small"
                    onClick={async () => {
                      await call("POST", "bots/delete", { id: b.id });
                      setRemoving(null);
                      void load();
                    }}
                  >
                    Delete forever
                  </button>
                  <button className="linkbtn" onClick={() => setRemoving(null)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button className="pbtn ghost small" onClick={() => setRemoving(b.id)}>
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {paintError && <p className="bad">{paintError}</p>}
      <div className="arena-actions">
        <button className="pbtn" disabled={full} onClick={() => setMode("new")}>
          Create a bunny
        </button>
        {full && <span className="dim small">{limits.bots === 1 ? "The Free plan has one bunny. Upgrade to Pro for more." : "You have reached your plan's limit."}</span>}
      </div>
      <p className="dim small">Your bunnies and their paper accounts live in your own private space. Simulated money only.</p>
    </div>
  );
}
