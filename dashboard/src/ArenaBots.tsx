// "Your bunnies" on the Arena page: the member's bots, and the form to make or change one. Plan limits are enforced by
// the server; the page shows what the plan leaves out as locked, with the reason, instead of hiding it.
import { useCallback, useEffect, useState } from "react";
import { draftProblem, STYLE_LABEL, toggleCoin, type BotDraft } from "./arenaModel";

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

const EMPTY: BotDraft = { name: "", theme: "bunnies", avatar: "scout", style: "breezy", coins: ["BTC"], rules: "" };

function Portrait({ cat, theme, avatar, size = 44 }: { cat: Catalogue; theme: string; avatar: string; size?: number }) {
  const a = cat.themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar);
  return (
    <span className="ab-portrait" style={{ width: size, height: size, fontSize: size * 0.55, ["--av" as string]: a?.color ?? "#888" }} aria-hidden>
      {a?.glyph ?? "?"}
    </span>
  );
}

function Form({ cat, limits, initial, editing, onDone, onCancel }: { cat: Catalogue; limits: Limits; initial: BotDraft; editing: Bot | null; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<BotDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const theme = cat.themes.find((t) => t.id === d.theme);
  const problem = draftProblem(d, limits.maxCoins);

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
      <textarea id="ab-rules" className="pinput ab-rules" rows={4} maxLength={2000} placeholder="How should it trade? When should it stay out? What must it never do?" value={d.rules} onChange={(e) => setD({ ...d, rules: e.target.value })} />
      <div className="dim small">{d.rules.trim().length} / 2000{editing ? ". Changing style, coins or rules starts a new version of this bunny." : ""}</div>

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

  const load = useCallback(async () => {
    try {
      const [c, b] = await Promise.all([call<Catalogue>("GET", "catalogue"), call<{ bots: Bot[] }>("GET", "bots")]);
      if (c.status === 200 && b.status === 200) {
        setCat(c.data);
        setBots(b.data.bots);
      } else setError("Could not load your bunnies.");
    } catch {
      setError("The Arena is not reachable right now.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="pcard arena-card"><p className="bad">{error}</p></div>;
  if (!cat || !bots) return <div className="pcard arena-card dim">Loading your bunnies…</div>;

  if (mode !== "list")
    return (
      <div className="pcard arena-card">
        <Form
          cat={cat}
          limits={limits}
          editing={mode === "new" ? null : mode}
          initial={mode === "new" ? EMPTY : { name: mode.name, theme: mode.theme, avatar: mode.avatar, style: mode.style, coins: mode.coins, rules: mode.rules }}
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
          <Portrait cat={cat} theme={b.theme} avatar={b.avatar} />
          <div className="ab-bot-main">
            <div>
              <strong>{b.name}</strong> <span className="badge">{STYLE_LABEL[b.style]?.label ?? b.style}</span> <span className="dim small">v{b.version}</span>
            </div>
            <div className="dim small">{b.coins.join(" · ")}</div>
            <div className="ab-rules-preview small">{b.rules}</div>
            <div className="arena-actions">
              <button className="pbtn ghost small" onClick={() => setMode(b)}>
                Edit
              </button>
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
      <div className="arena-actions">
        <button className="pbtn" disabled={full} onClick={() => setMode("new")}>
          Create a bunny
        </button>
        {full && <span className="dim small">{limits.bots === 1 ? "The Free plan has one bunny. Upgrade to Pro for more." : "You have reached your plan's limit."}</span>}
      </div>
      <p className="dim small">Bunnies created here are saved to your private database. Running them on the race track is the next step.</p>
    </div>
  );
}
