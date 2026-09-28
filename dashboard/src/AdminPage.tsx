// #/admin: everything the owner configures, behind the owner password (the same one as joining the Hive).
// The password lives only in this page's memory; every call sends it and the engine checks it (with a lockout).
// The trading mode, LIVE_ACK and exchange keys are not here on purpose: real money stays an .env decision.
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageNav } from "./LabPage";
import { adminCall, ApiError, BRAIN_LABEL, when, type AdminField, type AdminState, type KeyName } from "./panelTypes";
import { WatchChips } from "./WatchChips";
import { TIER_INFO } from "./types";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "keys", label: "API keys" },
  { id: "bees", label: "Bees" },
  { id: "settings", label: "Settings" },
  { id: "lab", label: "Lab, skills & evolution" },
  { id: "security", label: "Security" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const KEY_INFO: Record<KeyName, { label: string; help: string; placeholder: string; removable: boolean }> = {
  jev: { label: "Jev (TypeSafe AI)", help: "Makes every trading decision. console.typesafe.ai/keys", placeholder: "Jev API key", removable: false },
  openai: { label: "OpenAI (ChatGPT)", help: "Bee designs and portraits on Setup, and the ChatGPT brain.", placeholder: "sk-…", removable: true },
  anthropic: { label: "Anthropic (Claude)", help: "The Claude brain. console.anthropic.com", placeholder: "sk-ant-…", removable: true },
  kimi: { label: "Moonshot (Kimi)", help: "The Kimi brain. platform.moonshot.ai", placeholder: "sk-…", removable: true },
};

const MODE_TEXT: Record<AdminState["mode"], string> = {
  dry: "Paper trading: real prices, simulated money.",
  demo: "OKX demo trading: fake money on OKX's side.",
  live: "LIVE: real money.",
};

function Login({ onIn }: { onIn: (pw: string, s: AdminState) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      onIn(pw, await adminCall("login", pw));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pcard login">
      <h2>Owner sign-in</h2>
      <p className="dim">The owner password you picked on Setup (or OWNER_PASSWORD). Too many wrong tries lock the panel for 15 minutes.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <input className="pinput" type="password" autoComplete="current-password" placeholder="Owner password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        <button className="pbtn" disabled={busy || pw.length < 8}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
      {error && <p className="bad">{error}</p>}
    </div>
  );
}

function Overview({ s, setTab }: { s: AdminState; setTab: (t: Tab) => void }) {
  const keysSet = (Object.keys(s.keys) as KeyName[]).filter((k) => s.keys[k].set);
  const brains = ["BEE1_BRAIN", "BEE2_BRAIN", "BEE3_BRAIN"].map((k) => s.fields.find((f) => f.key === k)?.value);
  const job = s.lab.job;
  return (
    <>
      <div className="ptiles">
        <div className="ptile">
          <div className="eyebrow">Trading mode</div>
          <div className={`ptile-value mode-${s.mode}`}>{s.mode === "live" ? "● LIVE" : s.mode === "demo" ? "OKX demo" : "Paper"}</div>
          <div className="dim ptile-sub">{MODE_TEXT[s.mode]} Set in .env only (MODE, DRY_RUN, LIVE_ACK).</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">API keys</div>
          <div className="ptile-value num">{keysSet.length} / 4</div>
          <div className="dim ptile-sub">{keysSet.map((k) => KEY_INFO[k].label.split(" ")[0]).join(", ") || "none"}</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Brains</div>
          <div className="ptile-value">{brains.map((b) => BRAIN_LABEL[String(b)] ?? "–").join(" · ")}</div>
          <div className="dim ptile-sub">bee 1 · bee 2 · bee 3</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Hive mind</div>
          <div className="ptile-value num">{s.lab.graph.skill ?? 0} skills</div>
          <div className="dim ptile-sub">
            {s.lab.graph.lesson ?? 0} lessons · {s.lab.graph.message ?? 0} messages · {s.lab.graph.edges ?? 0} links
          </div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Lab job</div>
          <div className="ptile-value">{job ? `${job.command}: ${job.state}` : "idle"}</div>
          <div className="dim ptile-sub">{job ? `started ${when(job.startedAt)}` : "nothing run since the engine started"}</div>
        </div>
        <div className="ptile">
          <div className="eyebrow">Version</div>
          <div className="ptile-value mono">{s.version}</div>
          <div className="dim ptile-sub">{s.hasSettingsFile ? "Setup file present" : "keys and bees from .env"}</div>
        </div>
      </div>
      <div className="pcard">
        <h3>Shortcuts</h3>
        <div className="row-actions">
          <button className="pbtn ghost" onClick={() => setTab("keys")}>
            Add Claude / Kimi keys
          </button>
          <button className="pbtn ghost" onClick={() => setTab("lab")}>
            Run the lab
          </button>
          <button className="pbtn ghost" onClick={() => setTab("settings")}>
            Risk limits
          </button>
          <a className="pbtn ghost" href="#/lab">
            See ranking & graph
          </a>
        </div>
      </div>
    </>
  );
}

function KeysTab({ s, call }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  const [draft, setDraft] = useState<Partial<Record<KeyName, string>>>({});
  return (
    <div className="pcard">
      <h3>API keys</h3>
      <p className="dim">Keys are write-only: this page never shows them, only whether one is set and where from. Each new key is tested with a free call before it is saved.</p>
      {(Object.keys(KEY_INFO) as KeyName[]).map((k) => {
        const st = s.keys[k];
        const env = st.source === "env";
        return (
          <div key={k} className="key-row">
            <div className="key-meta">
              <strong>{KEY_INFO[k].label}</strong>
              <span className={`badge ${st.set ? "ok" : ""}`}>{st.set ? (env ? "✓ set in .env" : "✓ set") : "not set"}</span>
              <div className="dim small">{KEY_INFO[k].help}</div>
            </div>
            {env ? (
              <span className="dim small">Change it in the environment (.env), then restart.</span>
            ) : !s.hasSettingsFile ? (
              <span className="dim small">No Setup file: keys come from .env.</span>
            ) : (
              <div className="key-edit">
                <input
                  className="pinput mono"
                  type="password"
                  autoComplete="off"
                  placeholder={st.set ? "Replace key…" : KEY_INFO[k].placeholder}
                  value={draft[k] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                />
                <button
                  className="pbtn"
                  disabled={(draft[k] ?? "").trim().length < 8}
                  onClick={() => void call("keys", { keys: { [k]: draft[k]!.trim() } }, `${KEY_INFO[k].label} key checked and saved.`).then(() => setDraft({ ...draft, [k]: "" }))}
                >
                  Test & save
                </button>
                {st.set && KEY_INFO[k].removable && (
                  <button className="pbtn ghost" onClick={() => confirm(`Remove the ${KEY_INFO[k].label} key?`) && void call("keys", { remove: [k] }, "Key removed.")}>
                    Remove
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type BeeDraft = { slot: string; name: string; tagline: string; rules: string; coins: string[]; style: string; brain: string; extra: boolean; running: boolean; flat: boolean; isNew?: boolean };

/** Asset picker: chips for the coins tradable right now, plus free text when the market is not loaded. */
function CoinPicker({ all, value, onChange }: { all: string[]; value: string[]; onChange: (c: string[]) => void }) {
  const [q, setQ] = useState("");
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c].slice(0, 20));
  if (!all.length)
    return <input className="pinput mono" value={value.join(", ")} placeholder="BTC, ETH (empty = any coin)" onChange={(e) => onChange(e.target.value.split(/[\s,]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))} />;
  const shown = all.filter((c) => !q || c.includes(q.toUpperCase())).slice(0, 60);
  return (
    <div className="coin-picker">
      <div className="coin-selected">
        {value.length ? (
          value.map((c) => (
            <button key={c} className="chip on" onClick={() => toggle(c)} title="Remove">
              {c} ×
            </button>
          ))
        ) : (
          <span className="dim small">Any coin (none picked)</span>
        )}
      </div>
      <input className="pinput small" placeholder={`Search ${all.length} coins…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="coin-list">
        {shown.map((c) => (
          <button key={c} className={`chip ${value.includes(c) ? "on" : ""}`} onClick={() => toggle(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}

function BeesTab({ s, call }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  const [bees, setBees] = useState<BeeDraft[] | null>(
    () => s.bees?.map((b) => ({ slot: b.slot, name: b.name, tagline: b.tagline, rules: b.rules, coins: b.coins, style: b.style, brain: b.brain ?? "openai", extra: b.extra, running: b.running, flat: b.flat })) ?? null,
  );
  if (!bees) return <div className="pcard">The original three bees run without a Setup file, so there is nothing to edit here. Design your own bees on Setup to customise them.</div>;
  const evo = new Map((s.evolution?.board ?? []).map((r) => [r.bee, r]));
  const set = (i: number, patch: Partial<BeeDraft>) => setBees(bees.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const add = () =>
    setBees([
      ...bees,
      { slot: `bee${bees.length + 1}`, name: "", tagline: "", rules: "", coins: [], style: "boozy", brain: ["openai", "claude", "kimi"][bees.length % 3]!, extra: true, running: false, flat: true, isNew: true },
    ]);
  const save = () =>
    call(
      "bees",
      { bees: bees.map((b) => ({ name: b.name.trim(), tagline: b.tagline, rules: b.rules, style: b.style, coins: b.coins, ...(b.extra ? { brain: b.brain } : {}) })) },
      "Bees saved. Restart the engine to apply.",
    );
  const last = bees.length - 1;
  return (
    <>
      <div className="bee-edit-grid">
        {bees.map((b, i) => {
          const e = evo.get(b.slot);
          const t = e ? TIER_INFO[e.tier] : null;
          return (
            <div className="pcard" key={b.slot}>
              <div className="bee-card-head">
                <h3>
                  {b.name || "New bee"} <span className="dim mono small">{b.slot}</span>
                </h3>
                {b.extra && <span className="badge">extra</span>}
                {b.isNew || !b.running ? <span className="badge">starts after restart</span> : null}
              </div>
              {e && t && (
                <div className={`evo-line ${t.tone}`}>
                  {t.icon} {t.label} · health {e.health.toFixed(1)}% · L{e.level} · {e.points} pts{e.deaths ? ` · ${e.deaths} death${e.deaths > 1 ? "s" : ""}` : ""}
                </div>
              )}
              <div className="row-actions compact">
                {e?.tier === "dead" && (
                  <button className="pbtn small" disabled={!b.flat} title={b.flat ? "" : "Flat first"} onClick={() => confirm(`Revive ${b.name} with fresh paper money? It keeps half its points and all its lessons.`) && void call("revive", { bee: b.slot }, `${b.name} revived.`)}>
                    ✚ Revive
                  </button>
                )}
                {b.running && e?.tier !== "dead" && (
                  <button className="pbtn ghost small" onClick={() => void call("council", { bee: b.slot }, `Council convened for ${b.name}.`)}>
                    Convene its brains
                  </button>
                )}
              </div>
              <label className="plabel">
                Name
                <input className="pinput" value={b.name} maxLength={24} onChange={(ev) => set(i, { name: ev.target.value })} />
              </label>
              <label className="plabel">
                Tagline
                <input className="pinput" value={b.tagline} maxLength={40} onChange={(ev) => set(i, { tagline: ev.target.value })} />
              </label>
              <div className="form-grid two">
                <label className="plabel">
                  Trading style
                  <select className="pinput" value={b.style} onChange={(ev) => set(i, { style: ev.target.value })}>
                    {s.styles.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </label>
                {b.extra ? (
                  <label className="plabel">
                    Thinks with
                    <select className="pinput" value={b.brain} onChange={(ev) => set(i, { brain: ev.target.value })}>
                      {["openai", "claude", "kimi"].map((x) => (
                        <option key={x} value={x}>
                          {BRAIN_LABEL[x]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="plabel dim small">Brain: Settings → Brains and models</div>
                )}
              </div>
              <span className="dim small">{s.styles.find((x) => x.id === b.style)?.blurb} Breakout needs coins within BTC/ETH/SOL/HYPE and Trend within BTC/ETH; otherwise the bee runs on Momentum.</span>
              <div className="plabel">
                Assets it may trade
                <CoinPicker all={s.coins} value={b.coins} onChange={(c) => set(i, { coins: c })} />
              </div>
              {s.lab.playbook?.bees[b.slot]?.watchlist?.length ? (
                <div className="plabel">
                  Watchlist its AI brains chose (within the assets above)
                  <WatchChips items={s.lab.playbook.bees[b.slot]!.watchlist!} />
                  <span className="dim small">Set by the council, the coach and survival councils from lab evidence. Turn off with “AI-chosen coins” in Settings → Learning.</span>
                </div>
              ) : null}
              <label className="plabel">
                Rules Jev reads every tick
                <textarea className="pinput" rows={4} maxLength={500} value={b.rules} onChange={(ev) => set(i, { rules: ev.target.value })} />
                <span className="dim small num">{b.rules.length}/500</span>
              </label>
              {b.extra && i === last && (
                <button
                  className="pbtn ghost small"
                  disabled={!b.flat}
                  title={b.flat ? "" : "It holds a position: it must be flat first"}
                  onClick={() => confirm(`Remove ${b.name || "this bee"}? Its history stays in the database.`) && setBees(bees.slice(0, -1))}
                >
                  Remove this bee
                </button>
              )}
            </div>
          );
        })}
        {bees.length < s.maxBees && (
          <button className="pcard add-bee" onClick={add}>
            <span className="add-plus">+</span>
            <span>Add a bee</span>
            <span className="dim small">
              {bees.length}/{s.maxBees} · starts with fresh paper money after a restart
            </span>
          </button>
        )}
      </div>
      <div className="row-actions">
        <button className="pbtn" disabled={bees.some((b) => !b.name.trim())} onClick={() => void save()}>
          Save bees
        </button>
        <span className="dim small">
          Extra bees race here and in the lab; the Hive leaderboard shows the main three. Outside paper trading an extra bee needs its own exchange keys in .env (BEE4_OKX_DEMO_API_KEY, …) or it sits out.
        </span>
      </div>
    </>
  );
}

function FieldInput({ f, value, onChange }: { f: AdminField; value: unknown; onChange: (v: unknown) => void }) {
  const disabled = f.lockedByEnv;
  if (f.type === "bool")
    return (
      <label className="switch">
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{value ? "On" : "Off"}</span>
      </label>
    );
  if (f.type === "enum")
    return (
      <select className="pinput" value={String(value ?? "")} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {f.options!.map((o) => (
          <option key={o} value={o}>
            {BRAIN_LABEL[o] ?? o}
          </option>
        ))}
      </select>
    );
  if (f.type === "number")
    return <input className="pinput num" type="number" min={f.min} max={f.max} step={f.step ?? 1} value={value === null || value === undefined ? "" : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
  return (
    <input
      className="pinput mono"
      type={f.secret ? "password" : "text"}
      placeholder={f.secret ? (f.set ? "set: type to replace" : "not set") : ""}
      value={String(value ?? "")}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function SettingsTab({ s, call, only }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; only?: string[] }) {
  const groups = s.groups.filter((g) => !only || only.includes(g.id));
  const [group, setGroup] = useState(groups[0]?.id ?? "");
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const fields = s.fields.filter((f) => f.group === group);
  const dirty = Object.keys(draft).filter((k) => fields.some((f) => f.key === k));
  const save = () =>
    call("settings", { values: Object.fromEntries(dirty.map((k) => [k, draft[k]])) }, "Saved. Restart the engine to apply.").then(() =>
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !dirty.includes(k)))),
    );
  const g = groups.find((x) => x.id === group);
  return (
    <div className="settings">
      {groups.length > 1 && (
        <div className="chips" role="tablist">
          {groups.map((x) => (
            <button key={x.id} role="tab" aria-selected={group === x.id} className={`chip ${group === x.id ? "on" : ""}`} onClick={() => setGroup(x.id)}>
              {x.title}
            </button>
          ))}
        </div>
      )}
      <div className="pcard">
        <h3>{g?.title}</h3>
        <p className="dim">{g?.help}</p>
        <div className="fields">
          {fields.map((f) => {
            const value = f.key in draft ? draft[f.key] : f.secret ? "" : f.value;
            return (
              <div className={`field ${f.key in draft ? "changed" : ""}`} key={f.key}>
                <div className="field-head">
                  <label>{f.label}</label>
                  {f.lockedByEnv && <span className="badge">set in .env</span>}
                  {!f.lockedByEnv && f.overridden && <span className="badge ok">changed here</span>}
                </div>
                <FieldInput f={f} value={value} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                <div className="dim small">
                  {f.help}
                  {!f.secret && f.default !== undefined && f.default !== null ? (
                    <>
                      {" "}
                      Default: <span className="mono">{String(f.default)}</span>.
                    </>
                  ) : null}
                  {f.type === "number" && f.min !== undefined ? ` Range ${f.min} to ${f.max}.` : ""}
                </div>
                {!f.lockedByEnv && f.overridden && (
                  <button className="linkbtn" onClick={() => void call("settings", { values: { [f.key]: null } }, `${f.label} back to default.`)}>
                    Reset to default
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="row-actions">
          <button className="pbtn" disabled={!dirty.length} onClick={() => void save()}>
            Save {dirty.length ? `${dirty.length} change${dirty.length > 1 ? "s" : ""}` : ""}
          </button>
          {dirty.length > 0 && (
            <button className="pbtn ghost" onClick={() => setDraft({})}>
              Discard
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ImportSkill({ password }: { password: string }) {
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async () => {
    setBusy(true);
    setOut(null);
    try {
      const r = await adminCall<{ skill: { id: string }; backtest: { score: number; returnPct: number; stabilityPct: number; trades: number; maxDrawdownPct: number } }>("skills/import", password, { json });
      const b = r.backtest;
      setOut({
        ok: b.score > 0,
        text: `${r.skill.id} saved.${b.score > 0 ? "" : " It did not beat its costs out of sample, so councils will pass on it unless new data says otherwise."} Quick walk-forward backtest: score ${b.score.toFixed(2)}, out of sample ${b.returnPct.toFixed(1)}%, stable ${b.stabilityPct.toFixed(0)}%, ${b.trades} trades, max drawdown ${b.maxDrawdownPct.toFixed(1)}%. It joins every lab run from now on.`,
      });
      setJson("");
    } catch (e) {
      setOut({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pcard">
      <h3>Import a skill</h3>
      <p className="dim">
        Paste a skill in the JSON rule language (see <span className="mono">skills/README.md</span>; Freqtrade-style <span className="mono">roi</span> / <span className="mono">stoploss</span> /{" "}
        <span className="mono">trailing</span> exits work). It is compiled, backtested walk-forward and saved; the lab ranks it with the others and a council can adopt it.
      </p>
      <textarea className="pinput mono" rows={8} value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"id":"my_dip","name":"My dip","family":"mean_reversion","long":{"entry":[{"left":"rsi(14)","op":"<","right":30}],"exit":[{"left":"rsi(14)","op":">","right":55}]}}' />
      <button className="pbtn" disabled={busy || json.trim().length < 10} onClick={() => void go()}>
        {busy ? "Backtesting…" : "Import & backtest"}
      </button>
      {out && <p className={out.ok ? "good" : "bad"}>{out.text}</p>}
    </div>
  );
}

function LabTab({ s, call, refresh, password }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; refresh: () => Promise<void>; password: string }) {
  const [cmd, setCmd] = useState<"cycle" | "fetch" | "run" | "council">("cycle");
  const [source, setSource] = useState<"okx" | "ccxt" | "synthetic">("okx");
  const [symbols, setSymbols] = useState("BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP");
  const [exchange, setExchange] = useState("binance");
  const [bar, setBar] = useState("1H");
  const [days, setDays] = useState(365);
  const [folds, setFolds] = useState(3);
  const [leverage, setLeverage] = useState(1);
  const [synthetic, setSynthetic] = useState(3);
  const [longOnly, setLongOnly] = useState(false);
  const job = s.lab.job;

  useEffect(() => {
    if (job?.state !== "running") return;
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [job?.state, refresh]);

  const fetches = cmd === "fetch" || cmd === "cycle";
  const runs = cmd === "run" || cmd === "cycle";
  const start = () =>
    call(
      "lab",
      {
        command: cmd,
        args: {
          source,
          bar,
          ...(fetches && source !== "synthetic" ? { days, symbols: symbols.trim() || undefined } : {}),
          ...(fetches && source === "ccxt" ? { exchange } : {}),
          ...(runs ? { folds, leverage, longOnly, ...(source === "synthetic" ? { synthetic } : {}) } : {}),
        },
      },
      `Lab ${cmd} started.`,
    );

  return (
    <>
      <div className="pcard">
        <h3>Run the lab</h3>
        <p className="dim">
          <strong>cycle</strong> = fetch history if missing, rank every skill walk-forward, then the council (each bee's brain picks skills). Runs in the background;
          the engine keeps trading.
        </p>
        <div className="form-grid">
          <label className="plabel">
            Command
            <select className="pinput" value={cmd} onChange={(e) => setCmd(e.target.value as typeof cmd)}>
              <option value="cycle">cycle (fetch + run + council)</option>
              <option value="fetch">fetch history</option>
              <option value="run">run the tournament</option>
              <option value="council">council only</option>
            </select>
          </label>
          {cmd !== "council" && (
            <label className="plabel">
              Data
              <select className="pinput" value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
                <option value="okx">OKX history (public)</option>
                <option value="ccxt">Another exchange (CCXT)</option>
                <option value="synthetic">Synthetic markets (offline test)</option>
              </select>
            </label>
          )}
          {cmd !== "council" && (
            <label className="plabel">
              Bar
              <select className="pinput" value={bar} onChange={(e) => setBar(e.target.value)}>
                {["15m", "1H", "4H", "1D"].map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
          )}
          {fetches && source === "ccxt" && (
            <label className="plabel">
              Exchange (CCXT id)
              <input className="pinput mono" value={exchange} onChange={(e) => setExchange(e.target.value.toLowerCase())} />
            </label>
          )}
          {fetches && source !== "synthetic" && (
            <>
              <label className="plabel wide">
                {source === "ccxt" ? "Symbols" : "OKX instruments"}
                <input className="pinput mono" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder={source === "ccxt" ? "BTC/USDT,ETH/USDT" : "BTC-USDT-SWAP,ETH-USDT-SWAP"} />
              </label>
              <label className="plabel">
                Days of history
                <input className="pinput num" type="number" min={7} max={2000} value={days} onChange={(e) => setDays(Number(e.target.value))} />
              </label>
            </>
          )}
          {runs && (
            <>
              <label className="plabel">
                Walk-forward folds
                <input className="pinput num" type="number" min={2} max={8} value={folds} onChange={(e) => setFolds(Number(e.target.value))} />
              </label>
              <label className="plabel">
                Leverage (max 2)
                <input className="pinput num" type="number" min={0.1} max={2} step={0.1} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />
              </label>
              {source === "synthetic" && (
                <label className="plabel">
                  Synthetic markets
                  <input className="pinput num" type="number" min={1} max={8} value={synthetic} onChange={(e) => setSynthetic(Number(e.target.value))} />
                </label>
              )}
              <label className="switch">
                <input type="checkbox" checked={longOnly} onChange={(e) => setLongOnly(e.target.checked)} />
                <span>Long only</span>
              </label>
            </>
          )}
        </div>
        <div className="row-actions">
          <button className="pbtn" disabled={job?.state === "running"} onClick={() => void start()}>
            Start {cmd}
          </button>
          {job?.state === "running" && (
            <button className="pbtn ghost" onClick={() => void call("lab/stop", {}, "Stopping the job.")}>
              Stop
            </button>
          )}
          <a className="pbtn ghost" href="#/lab">
            See the ranking
          </a>
        </div>
      </div>

      <div className="pcard">
        <h3>
          Job {job ? `#${job.id} · ${job.command} ${job.args.join(" ")}` : ""}{" "}
          {job && <span className={`badge ${job.state === "done" ? "ok" : job.state === "failed" ? "err" : ""}`}>{job.state === "running" ? "● running" : job.state === "done" ? "✓ done" : "✗ failed"}</span>}
        </h3>
        {job ? <pre className="joblog">{job.log.slice(-120).join("\n") || "…"}</pre> : <p className="dim">No job since the engine started.</p>}
      </div>

      <div className="pcard">
        <h3>Coach</h3>
        <p className="dim">Each brain reviews its bee's last 24 h (closed trades, P&L, fees, risk vetoes) and re-weights the skills it already uses. It never adds a new one.</p>
        <button className="pbtn ghost" disabled={!s.coachAvailable} onClick={() => void call("coach", {}, "Coach review started.")}>
          Run a coach review now
        </button>
        {!s.coachAvailable && <p className="dim small">Needs at least one brain key (API keys tab).</p>}
      </div>

      <ImportSkill password={password} />

      <SettingsTab s={s} call={call} only={["learning", "evolution"]} />
    </>
  );
}

function SecurityTab({ call }: { call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  return (
    <div className="pcard">
      <h3>Owner password</h3>
      <p className="dim">Guards this panel and joining or leaving the Hive. Stored only as a salted scrypt hash.</p>
      <input className="pinput" type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={a} onChange={(e) => setA(e.target.value)} />
      <input className="pinput" type="password" autoComplete="new-password" placeholder="Type it again" value={b} onChange={(e) => setB(e.target.value)} />
      {b && a !== b && <p className="bad small">The two don't match.</p>}
      <button className="pbtn" disabled={a.length < 8 || a !== b} onClick={() => void call("password", { next: a }, "Password changed. Sign in again with the new one.")}>
        Change password
      </button>
      <h3>Not configurable here, on purpose</h3>
      <ul className="dim small">
        <li>Trading mode (MODE, DRY_RUN) and LIVE_ACK: moving real money is an .env decision.</li>
        <li>OKX demo and live API keys: they belong in the server's environment, never in a web form.</li>
        <li>Paths, ports and the public domain.</li>
      </ul>
    </div>
  );
}

export function AdminPage() {
  const [pw, setPw] = useState<string | null>(null);
  const [s, setS] = useState<AdminState | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const signOut = useCallback((why?: string) => {
    setPw(null);
    setS(null);
    if (why) setToast({ ok: false, text: why });
  }, []);

  const call = useCallback(
    async (path: string, body: unknown, ok: string) => {
      if (!pw) return;
      setBusy(true);
      try {
        const r = await adminCall<AdminState & { ok?: boolean }>(path, pw, body);
        if (path === "password") signOut("Password changed. Sign in with the new one.");
        else if ("fields" in r) setS(r);
        setToast({ ok: true, text: ok });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) signOut("Signed out: the password no longer matches.");
        else setToast({ ok: false, text: (e as Error).message });
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [pw, signOut],
  );
  const safeCall = useCallback((path: string, body: unknown, ok: string) => call(path, body, ok).catch(() => undefined), [call]);
  const refresh = useCallback(async () => {
    if (!pw) return;
    try {
      setS(await adminCall("state", pw));
    } catch {
      /* keep the last state */
    }
  }, [pw]);

  const restart = () => {
    if (!pw || !confirm("Restart the engine now? Open positions are kept; trading pauses for a few seconds.")) return;
    void adminCall("restart", pw).then(
      () => setToast({ ok: true, text: "Restarting… this page reconnects in a few seconds." }),
      (e: Error) => setToast({ ok: false, text: e.message }),
    );
  };

  const pending = useMemo(() => s?.pendingRestart, [s]);

  return (
    <div className="page">
      <PageNav current="admin" />
      <div className="page-inner">
        <div className="admin-head">
          <h1>Admin</h1>
          {s && (
            <button className="pbtn ghost small" onClick={() => signOut()}>
              Lock
            </button>
          )}
        </div>
        {!pw || !s ? (
          <Login
            onIn={(p, st) => {
              setPw(p);
              setS(st);
            }}
          />
        ) : (
          <>
            {pending && (
              <div className="banner">
                <span>⟳ Saved changes apply after an engine restart.</span>
                <button className="pbtn" onClick={restart}>
                  Restart engine
                </button>
              </div>
            )}
            {s.mode === "live" && <div className="banner danger">● This engine trades REAL MONEY. Change settings with care.</div>}
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className={busy ? "busy" : ""}>
              {tab === "overview" && <Overview s={s} setTab={setTab} />}
              {tab === "keys" && <KeysTab s={s} call={safeCall} />}
              {tab === "bees" && <BeesTab key={JSON.stringify(s.bees)} s={s} call={safeCall} />}
              {tab === "settings" && <SettingsTab s={s} call={safeCall} only={["brains", "risk", "breakout", "trend", "momentum", "engine"]} />}
              {tab === "lab" && <LabTab s={s} call={safeCall} refresh={refresh} password={pw} />}
              {tab === "security" && <SecurityTab call={safeCall} />}
            </div>
            <div className="row-actions end">
              <button className="pbtn ghost" onClick={restart}>
                Restart engine
              </button>
            </div>
          </>
        )}
      </div>
      {toast && (
        <div className={`ptoast ${toast.ok ? "ok" : "err"}`} role="status">
          {toast.ok ? "✓ " : "✗ "}
          {toast.text}
        </div>
      )}
    </div>
  );
}
