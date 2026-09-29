// #/admin: everything the owner configures, behind the owner password (the same one as joining the Hive).
// The password lives only in this page's memory; every call sends it and the engine checks it (with a lockout).
// The trading mode and LIVE_ACK are not here on purpose: real money stays an .env decision. Each bee's wallet and OKX
// sub-account are set when it is created, and the keys are checked (permissions, balance vs wallet) before it is.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageNav } from "./LabPage";
import { adminCall, ApiError, BRAIN_LABEL, when, type AdminField, type AdminState, type BrainsView, type McpGrant, type McpServerView, type DraftFull, type DraftSummary, type ExchangeCheck, type ExchangeKind, type KeyName } from "./panelTypes";
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
  zai: { label: "Z.ai (GLM)", help: "The GLM brain. z.ai. Model and API address: Settings → Brains and models.", placeholder: "Z.ai API key", removable: true },
  coinmarketcap: {
    label: "CoinMarketCap",
    help: "Market context: Fear & Greed, BTC dominance, market cap, and each coin's rank and all-exchange volume for Jev and the brains. pro.coinmarketcap.com",
    placeholder: "CMC Pro API key",
    removable: true,
  },
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

/**
 * Claude without an API key: sign in with an Anthropic Console account. The sign-in runs in the engine container with
 * the Anthropic CLI (the page cannot do it: the OAuth code comes back to that terminal), then this checks it.
 */
function AnthropicLogin({ login, keySet, call }: { login: NonNullable<AdminState["anthropicLogin"]>; keySet: boolean; call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  return (
    <div className="login-box">
      <div className="small">
        <strong>Or sign in instead of a key</strong> {login.active ? <span className="badge ok">✓ signed in</span> : null}
      </div>
      <ol className="dim small">
        <li>On the server, run:</li>
      </ol>
      <pre className="mono small login-cmd">{login.command}</pre>
      <ol className="dim small" start={2}>
        <li>Open the link it prints, sign in with your Anthropic Console account (platform.claude.com), pick the organisation, and paste the code back into the terminal.</li>
        <li>Check it here, then restart the engine.</li>
      </ol>
      <div className="row-actions">
        <button className="pbtn ghost small" onClick={() => void call("anthropic-login", {}, "Anthropic sign-in works. Restart the engine to use it.")}>
          Check sign-in
        </button>
        <span className="dim small">
          Uses your Console organisation's API billing, like a key{keySet ? "; the key above wins while it is set" : ""}. A claude.ai Pro/Max login cannot be used by other apps.
        </span>
      </div>
    </div>
  );
}

function KeysTab({ s, call, password }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; password: string }) {
  const [draft, setDraft] = useState<Partial<Record<KeyName, string>>>({});
  return (
    <>
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
              <span className={`badge ${st.set ? "ok" : ""}`}>{st.set ? (env ? "✓ set in .env" : st.source === "login" ? "✓ signed in" : "✓ set") : "not set"}</span>
              <div className="dim small">{KEY_INFO[k].help}</div>
              {k === "anthropic" && s.anthropicLogin && <AnthropicLogin login={s.anthropicLogin} keySet={st.source === "env" || st.source === "settings"} call={call} />}
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
    <CustomBrains s={s} call={call} password={password} />
    </>
  );
}

const JSON_MODE_HELP: Record<string, string> = {
  object: "JSON mode: the widest support (recommended).",
  schema: "Strict JSON schema: OpenAI-style servers that support it.",
  prompt: "No response format: for servers that reject both (the answer is still checked).",
};

/** Any OpenAI-compatible LLM as a brain: OpenRouter, DeepSeek, Together, a local Ollama... Keys are write-only. */
function CustomBrains({ s, call, password }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; password: string }) {
  const v: BrainsView = s.brains;
  const blank = { id: "", label: "", vendor: "", baseUrl: "https://", model: "", apiKey: "", jsonMode: "object" };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  const set = (k: keyof typeof blank, val: string) => {
    setTest(null);
    setF((p) => ({ ...p, [k]: val, ...(k === "label" && !editing ? { id: slug(val) } : {}) }));
  };
  const runTest = async () => {
    setBusy(true);
    try {
      const r = await adminCall<{ ok: boolean; error?: string }>("brains/test", password, { baseUrl: f.baseUrl, model: f.model, apiKey: f.apiKey || undefined, id: editing ? f.id : undefined, vendor: f.label });
      setTest({ ok: r.ok, text: r.ok ? "Connected: the address, key and model work together." : (r.error ?? "It did not answer.") });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = (force: boolean) =>
    void call("brains/save", { ...f, apiKey: f.apiKey || undefined, vendor: f.vendor || undefined, force }, `${f.label} saved. Restart the engine to bring it online.`).then(() => {
      setF(blank);
      setEditing(false);
      setTest(null);
    });
  const ready = f.id.length >= 2 && f.label.trim() && /^https?:\/\//.test(f.baseUrl) && f.model.trim();
  return (
    <div className="pcard">
      <h3>Custom brains</h3>
      <p className="dim">
        Add any LLM with an OpenAI-compatible API (OpenRouter, DeepSeek, Together, Groq, a local Ollama or LM Studio, ...) and use it anywhere a brain is chosen: a bee's brain, the skill agent, research. There is no limit
        beyond 50. The key is stored like the others, is never shown again, and is only ever sent to the address you give. Built in: ChatGPT, Claude, Kimi and GLM (Z.ai).
      </p>
      <ul className="checklist">
        {v.builtin.map((b) => (
          <li key={b.id}>
            <span className={b.ready ? "good" : "dim"}>{b.ready ? "✓" : "○"}</span> <strong>{b.label}</strong> <span className="dim small">{b.vendor} · built in{b.ready ? "" : " · no key yet"}</span>
          </li>
        ))}
        {v.custom.map((b) => (
          <li key={b.id}>
            <span className="good">✓</span> <strong>{b.label}</strong>{" "}
            <span className="dim small">
              {b.vendor} · {b.model} · {b.baseUrl.replace(/^https?:\/\//, "")} · {b.keySet ? "key saved" : "no key"} · {b.jsonMode}
              {b.usedBy.length ? ` · used by ${b.usedBy.join(", ")}` : ""}
            </span>{" "}
            <button
              className="pbtn ghost small"
              onClick={() => {
                setF({ id: b.id, label: b.label, vendor: b.vendor, baseUrl: b.baseUrl, model: b.model, apiKey: "", jsonMode: b.jsonMode });
                setEditing(true);
                setTest(null);
              }}
            >
              Edit
            </button>{" "}
            <button className="pbtn ghost small" disabled={b.usedBy.length > 0} title={b.usedBy.length ? "Give its bees another brain first" : ""} onClick={() => confirm(`Remove ${b.label}?`) && void call("brains/delete", { id: b.id }, `${b.label} removed.`)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {!v.canEdit ? (
        <p className="dim small">No Setup file on this server, so custom brains cannot be saved here.</p>
      ) : (
        <>
          <h4>{editing ? `Edit ${f.label}` : "Add a brain"}</h4>
          <div className="form-grid">
            <label className="plabel">
              Name
              <input className="pinput" maxLength={30} value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="DeepSeek" />
            </label>
            <label className="plabel">
              Id (short, fixed once saved)
              <input className="pinput mono" maxLength={30} disabled={editing} value={f.id} onChange={(e) => set("id", slug(e.target.value))} placeholder="deepseek" />
            </label>
            <label className="plabel wide">
              API address (base URL)
              <input className="pinput mono" value={f.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://api.deepseek.com/v1" />
            </label>
            <label className="plabel">
              Model
              <input className="pinput mono" value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="deepseek-chat" />
            </label>
            <label className="plabel">
              API key {editing ? "(leave empty to keep the saved one)" : "(empty for a local server)"}
              <input className="pinput mono" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set("apiKey", e.target.value)} />
            </label>
            <label className="plabel wide">
              How it is asked for JSON
              <select className="pinput" value={f.jsonMode} onChange={(e) => set("jsonMode", e.target.value)}>
                {Object.entries(JSON_MODE_HELP).map(([k, t]) => (
                  <option key={k} value={k}>
                    {k}: {t}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row-actions">
            <button className="pbtn ghost" disabled={!ready || busy} onClick={() => void runTest()}>
              {busy ? "Testing…" : "Test connection"}
            </button>
            <button className="pbtn" disabled={!ready} onClick={() => save(false)}>
              {editing ? "Test & save changes" : "Test & add brain"}
            </button>
            {test && !test.ok && (
              <button className="pbtn ghost" disabled={!ready} onClick={() => save(true)}>
                Save without testing
              </button>
            )}
            {editing && (
              <button className="pbtn ghost" onClick={() => (setF(blank), setEditing(false), setTest(null))}>
                Cancel
              </button>
            )}
          </div>
          {test && <p className={test.ok ? "good small" : "bad small"}>{test.text}</p>}
          <p className="dim small">A new or changed brain comes online after Restart engine.</p>
        </>
      )}
    </div>
  );
}

type ExchangeDraft = { kind: ExchangeKind; apiKey: string; secretKey: string; passphrase: string };
type BeeDraft = {
  slot: string;
  name: string;
  tagline: string;
  rules: string;
  coins: string[];
  style: string;
  brain: string;
  market: string;
  extra: boolean;
  running: boolean;
  flat: boolean;
  isNew?: boolean;
  walletUsd: number | "";
  /** Keys typed for this bee (never loaded from the server), the last check, and what it was run on. */
  exchange: ExchangeDraft | null;
  check: ExchangeCheck | null;
  checkedFor: string | null;
};

const exchangeFilled = (x: ExchangeDraft | null): x is ExchangeDraft => !!x && x.apiKey.trim().length >= 8 && x.secretKey.trim().length >= 8 && x.passphrase.length > 0;
const checkSig = (b: BeeDraft) => (b.exchange ? `${b.exchange.kind}|${b.exchange.apiKey}|${b.exchange.secretKey}|${b.exchange.passphrase}|${b.walletUsd}` : "");

/** Why a bee cannot be saved yet (null = ready): its wallet, and its exchange account when one is needed or typed. */
function beeBlocker(b: BeeDraft, s: AdminState): string | null {
  if (!b.name.trim()) return "Name it";
  if (b.extra && b.isNew && !(typeof b.walletUsd === "number" && b.walletUsd >= 10)) return "Set its wallet (at least $10)";
  if (exchangeFilled(b.exchange)) {
    if (!b.check || b.checkedFor !== checkSig(b)) return "Test its exchange connection";
    if (!b.check.ready) return "Its exchange check did not pass";
  } else if (b.isNew && s.exchangeRequired) return `Connect its OKX ${s.exchangeRequired} sub-account`;
  return null;
}

const usd0 = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/** Step 2 of creating a bee (and later, replacing its keys): its wallet and its OKX sub-account, checked live. */
function ExchangeStep({ b, s, password, onChange }: { b: BeeDraft; s: AdminState; password: string; onChange: (patch: Partial<BeeDraft>) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!!b.isNew);
  const status = s.bees?.find((x) => x.slot === b.slot)?.exchange;
  const kind: ExchangeKind = b.exchange?.kind ?? s.exchangeRequired ?? "demo";
  const x: ExchangeDraft = b.exchange ?? { kind, apiKey: "", secretKey: "", passphrase: "" };
  const setX = (patch: Partial<ExchangeDraft>) => onChange({ exchange: { ...x, ...patch } });
  const walletEditable = b.extra && (b.isNew || !b.running);
  const wallet = typeof b.walletUsd === "number" ? b.walletUsd : 0;
  const envLocked = status?.[kind]?.source === "env";
  const fresh = b.check && b.checkedFor === checkSig(b) ? b.check : null;
  const test = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await adminCall<ExchangeCheck>("exchange/check", password, { ...x, apiKey: x.apiKey.trim(), secretKey: x.secretKey.trim(), walletUsd: wallet || s.defaultWalletUsd, bee: b.slot });
      onChange({ check: r, checkedFor: checkSig(b) });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const need = b.isNew && s.exchangeRequired;
  return (
    <div className="xstep">
      <div className="xstep-head">
        <span className="xstep-num">{b.isNew ? "2" : "₿"}</span>
        <strong>Wallet &amp; exchange</strong>
        {need ? <span className="badge">required on {s.exchangeRequired}</span> : b.isNew ? <span className="badge">keys optional on paper</span> : null}
      </div>
      <label className="plabel">
        Wallet (USD it starts with)
        {walletEditable ? (
          <input className="pinput num" type="number" min={10} max={1_000_000} step={1} value={b.walletUsd} placeholder={String(s.defaultWalletUsd)} onChange={(e) => onChange({ walletUsd: e.target.value === "" ? "" : Number(e.target.value) })} />
        ) : (
          <span className="mono">{usd0(wallet)}</span>
        )}
        <span className="dim small">
          {b.extra
            ? walletEditable
              ? "Its paper book, health and death line are measured from this. On OKX the sub-account must hold at least this much USDC."
              : "Set when the bee was created. Revive keeps it."
            : "The main three share the start equity (Settings → Risk) so the Hive can compare them."}
        </span>
      </label>
      <div className="xstatus">
        {(["demo", "live"] as const).map((k) => {
          const st = status?.[k];
          return (
            <span key={k} className={`badge ${st?.set ? "ok" : ""}`} title={st?.checkedAt ? `checked ${when(st.checkedAt)}` : ""}>
              OKX {k}: {st?.set ? (st.source === "env" ? "✓ .env" : `✓ ${st.balanceUsd !== null ? usd0(st.balanceUsd) : "set"}`) : "not connected"}
            </span>
          );
        })}
        {!b.isNew && !open && (
          <button className="pbtn ghost small" disabled={!b.flat} title={b.flat ? "" : "Flat first"} onClick={() => setOpen(true)}>
            {status?.[kind]?.set ? "Replace keys" : "Connect OKX"}
          </button>
        )}
      </div>
      {open && (
        <>
          <div className="form-grid two">
            <label className="plabel">
              OKX environment
              <select className="pinput" value={x.kind} disabled={!!s.exchangeRequired && !!b.isNew} onChange={(e) => setX({ kind: e.target.value as ExchangeKind })}>
                <option value="demo">Demo</option>
                <option value="live">Live (real $)</option>
              </select>
            </label>
            <label className="plabel">
              Passphrase
              <input className="pinput mono" type="password" autoComplete="off" value={x.passphrase} disabled={envLocked} onChange={(e) => setX({ passphrase: e.target.value })} />
            </label>
          </div>
          <label className="plabel">
            API key
            <input className="pinput mono" type="password" autoComplete="off" value={x.apiKey} disabled={envLocked} placeholder="Read + Trade only, never Withdraw" onChange={(e) => setX({ apiKey: e.target.value })} />
          </label>
          <label className="plabel">
            Secret key
            <input className="pinput mono" type="password" autoComplete="off" value={x.secretKey} disabled={envLocked} onChange={(e) => setX({ secretKey: e.target.value })} />
          </label>
          {envLocked ? (
            <span className="dim small">This bee's {kind} keys are set in the environment (.env); change them there.</span>
          ) : (
            <div className="row-actions compact">
              <button className="pbtn small" disabled={busy || !exchangeFilled(b.exchange) || !s.exchangeCheck} onClick={() => void test()}>
                {busy ? "Checking…" : "Test connection & balance"}
              </button>
              <span className="dim small">Read-only: no orders, no transfers. Use one OKX sub-account per bee, EEA site.</span>
            </div>
          )}
          {err && <div className="xcheck bad">✗ {err}</div>}
          {fresh && (
            <ul className="xcheck">
              <li className={fresh.ok ? "good" : "bad"}>{fresh.ok ? "✓" : "✗"} Keys answer on OKX {fresh.kind}</li>
              {fresh.ok && (
                <>
                  <li className={fresh.canTrade ? "good" : "bad"}>{fresh.canTrade ? "✓" : "✗"} Trade permission</li>
                  <li className={fresh.canWithdraw ? "bad" : "good"}>{fresh.canWithdraw ? "✗ Has Withdraw permission" : "✓ No Withdraw permission"}</li>
                  <li className={fresh.subAccount ? "good" : "bad"}>{fresh.subAccount ? "✓" : "✗"} Its own sub-account</li>
                  <li className={fresh.usdcUsd !== null && fresh.usdcUsd >= (wallet || s.defaultWalletUsd) ? "good" : "bad"}>
                    {fresh.usdcUsd !== null && fresh.usdcUsd >= (wallet || s.defaultWalletUsd) ? "✓" : "✗"} Balance {fresh.usdcUsd === null ? "unreadable" : usd0(fresh.usdcUsd)} USDC · wallet {usd0(wallet || s.defaultWalletUsd)}
                  </li>
                </>
              )}
              {fresh.problems.map((p) => (
                <li key={p} className="bad">
                  → {p}
                </li>
              ))}
              {fresh.warnings.map((w) => (
                <li key={w} className="warn">
                  ⚠ {w}
                </li>
              ))}
              {fresh.ready && <li className="good strong">Ready: this bee can be created on this account.</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** The macro squad preset: a gold bee, an energy bee and a stocks bee (its brains pick the stocks). */
const MACRO_SQUAD: Array<Pick<BeeDraft, "name" | "tagline" | "rules" | "coins" | "market">> = [
  { name: "Goldie", tagline: "the safe haven", rules: "Trade gold and silver. Follow the trend, stay patient, avoid chasing spikes around US data releases.", coins: ["XAU", "XAG"], market: "commodities" },
  { name: "Crude", tagline: "the oil driller", rules: "Trade WTI and Brent oil. Ride breakouts, cut fast when a move fails.", coins: ["CL", "BZ"], market: "commodities" },
  { name: "Stonks", tagline: "the tape reader", rules: "Trade liquid stocks and ETFs during the session. Never hold a weak position into the close.", coins: [], market: "stocks" },
];

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

function BeesTab({ s, call, password }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; password: string }) {
  const [bees, setBees] = useState<BeeDraft[] | null>(
    () =>
      s.bees?.map((b) => ({
        slot: b.slot,
        name: b.name,
        tagline: b.tagline,
        rules: b.rules,
        coins: b.coins,
        style: b.style,
        brain: b.brain ?? "openai",
        market: b.market ?? "crypto",
        extra: b.extra,
        running: b.running,
        flat: b.flat,
        walletUsd: b.walletUsd,
        exchange: null,
        check: null,
        checkedFor: null,
      })) ?? null,
  );
  if (!bees) return <div className="pcard">The original three bees run without a Setup file, so there is nothing to edit here. Design your own bees on Setup to customise them.</div>;
  const evo = new Map((s.evolution?.board ?? []).map((r) => [r.bee, r]));
  const set = (i: number, patch: Partial<BeeDraft>) => setBees(bees.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const add = () =>
    setBees([
      ...bees,
      {
        slot: `bee${bees.length + 1}`,
        name: "",
        tagline: "",
        rules: "",
        coins: [],
        style: "boozy",
        brain: ["openai", "claude", "kimi"][bees.length % 3]!,
        market: "crypto",
        extra: true,
        running: false,
        flat: true,
        isNew: true,
        walletUsd: "",
        exchange: null,
        check: null,
        checkedFor: null,
      },
    ]);
  const hasSquad = bees.some((b) => b.market !== "crypto");
  const formSquad = () =>
    setBees([
      ...bees,
      ...MACRO_SQUAD.slice(0, s.maxBees - bees.length).map((m, k) => ({
        ...m,
        slot: `bee${bees.length + k + 1}`,
        style: "boozy",
        brain: ["claude", "openai", "kimi"][k % 3]!,
        extra: true,
        running: false,
        flat: true,
        isNew: true,
        walletUsd: "" as const,
        exchange: null,
        check: null,
        checkedFor: null,
      })),
    ]);
  const coinsFor = (m: string) => (m === "crypto" ? s.coins : m === "commodities" ? s.macroCoins.commodities : m === "stocks" ? s.macroCoins.stocks : [...s.macroCoins.commodities, ...s.macroCoins.stocks]);
  const save = () =>
    call(
      "bees",
      {
        bees: bees.map((b) => ({
          name: b.name.trim(),
          tagline: b.tagline,
          rules: b.rules,
          style: b.style,
          coins: b.coins,
          ...(b.extra ? { brain: b.brain, market: b.market, ...(typeof b.walletUsd === "number" ? { walletUsd: b.walletUsd } : {}) } : {}),
          ...(exchangeFilled(b.exchange) ? { exchange: { ...b.exchange, apiKey: b.exchange.apiKey.trim(), secretKey: b.exchange.secretKey.trim() } } : {}),
        })),
      },
      "Bees saved. Restart the engine to apply.",
    );
  const last = bees.length - 1;
  const blockers = bees.map((b) => beeBlocker(b, s));
  const firstBlock = blockers.findIndex((x) => x !== null);
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
              {b.isNew && (
                <div className="xstep-head">
                  <span className="xstep-num">1</span>
                  <strong>Bee &amp; brain</strong>
                </div>
              )}
              <label className="plabel">
                Name
                <input className="pinput" value={b.name} maxLength={24} onChange={(ev) => set(i, { name: ev.target.value })} />
              </label>
              <label className="plabel">
                Tagline
                <input className="pinput" value={b.tagline} maxLength={40} onChange={(ev) => set(i, { tagline: ev.target.value })} />
              </label>
              <div className="form-grid two">
                {b.market === "crypto" ? (
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
                ) : (
                  <div className="plabel">
                    Trading style
                    <span className="dim small">Macro: trend pullbacks and range reversions, at most 1x, closed before each session ends (Settings → Macro squad).</span>
                  </div>
                )}
                {b.extra ? (
                  <label className="plabel">
                    Thinks with
                    <select className="pinput" value={b.brain} onChange={(ev) => set(i, { brain: ev.target.value })}>
                      {[...s.brains.builtin, ...s.brains.custom].map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="plabel dim small">Brain: Settings → Brains and models</div>
                )}
              </div>
              {b.extra && (
                <label className="plabel">
                  Market
                  <select className="pinput" value={b.market} onChange={(ev) => set(i, { market: ev.target.value, coins: [] })}>
                    {s.markets.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.id !== "crypto" ? " · macro squad" : ""}
                      </option>
                    ))}
                  </select>
                  <span className="dim small">{s.markets.find((m) => m.id === b.market)?.blurb}</span>
                </label>
              )}
              {b.market === "crypto" && (
                <span className="dim small">{s.styles.find((x) => x.id === b.style)?.blurb} Breakout needs coins within BTC/ETH/SOL/HYPE and Trend within BTC/ETH; otherwise the bee runs on Momentum.</span>
              )}
              <div className="plabel">
                Assets it may trade
                <CoinPicker all={coinsFor(b.market)} value={b.coins} onChange={(c) => set(i, { coins: c })} />
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
              <ExchangeStep b={b} s={s} password={password} onChange={(patch) => set(i, patch)} />
              {b.isNew && <div className={`xready ${blockers[i] ? "" : "ok"}`}>{blockers[i] ? `Before it is created: ${blockers[i]}.` : "✓ Ready to create"}</div>}
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
        {!hasSquad && bees.length + MACRO_SQUAD.length <= s.maxBees && (
          <button className="pcard add-bee" onClick={formSquad}>
            <span className="add-plus">◆</span>
            <span>Form the macro squad</span>
            <span className="dim small">Goldie (gold, silver), Crude (oil) and Stonks (stocks). They trade only in verified open sessions and with ALLOW_NON_CRYPTO=true.</span>
          </button>
        )}
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
        <button className="pbtn" disabled={firstBlock >= 0} title={firstBlock >= 0 ? `${bees[firstBlock]!.name || bees[firstBlock]!.slot}: ${blockers[firstBlock]}` : ""} onClick={() => void save()}>
          {bees.some((b) => b.isNew) ? "Create & save bees" : "Save bees"}
        </button>
        <span className="dim small">
          {firstBlock >= 0
            ? `${bees[firstBlock]!.name || bees[firstBlock]!.slot}: ${blockers[firstBlock]}.`
            : "Extra bees race here and in the lab; the Hive leaderboard shows the main three. A new bee is created only after its wallet is set and, outside paper trading, its OKX sub-account passes the check."}
        </span>
      </div>
      {s.sessions && <SessionsCard sessions={s.sessions} />}
    </>
  );
}

/** The trading hours the engine is learning for stocks and commodities (market/sessions.ts). */
function SessionsCard({ sessions }: { sessions: NonNullable<AdminState["sessions"]> }) {
  const [open, setOpen] = useState<string | null>(null);
  const fmt = (m: number | null) => (m === null ? "–" : m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`);
  return (
    <div className="pcard sessions-card">
      <h3>Trading hours (macro squad)</h3>
      <p className="dim small">
        Learned from the market: every minute the engine checks which stock and commodity X-Perps are really quoting. Watched for {sessions.watchedHours} h
        {sessions.watchedHours < 168 ? " (a full week is needed before every hour is verified)" : ""}. Macro bees only open in a verified open hour, at least {sessions.noOpenMin} min before the close
        {sessions.allowNonCrypto ? "." : ", and only once ALLOW_NON_CRYPTO=true (now off: they watch and learn only)."}
      </p>
      {sessions.coins.length === 0 ? (
        <p className="dim">Nothing recorded yet.</p>
      ) : (
        <table className="ptable small">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Kind</th>
              <th className="num">Verified</th>
              <th className="num">Open h/week</th>
              <th className="num">Spread</th>
              <th>Now</th>
            </tr>
          </thead>
          <tbody>
            {sessions.coins.slice(0, 40).map((c) => (
              <Fragment key={c.coin}>
                <tr onClick={() => setOpen(open === c.coin ? null : c.coin)} className="clickable">
                  <td className="mono">{c.coin}</td>
                  <td className="dim">{c.kind}</td>
                  <td className="num">{c.verifiedPct}%</td>
                  <td className="num">{c.openHoursPerWeek}</td>
                  <td className="num">{c.meanSpreadBp === null ? "–" : `${c.meanSpreadBp}bp`}</td>
                  <td className={c.now.status === "open" ? "good" : "dim"}>
                    {c.now.status}
                    {c.now.status === "open" ? ` · closes in ${fmt(c.now.closesInMin)}` : c.now.opensInMin !== null ? ` · opens in ${fmt(c.now.opensInMin)}` : ""}
                  </td>
                </tr>
                {open === c.coin && (
                  <tr>
                    <td colSpan={6}>
                      <pre className="session-grid mono">{["    0         1         2   (UTC hour)", ...c.grid].join("\n")}</pre>
                      <span className="dim small"># open · . closed · ? not verified yet</span>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
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

const DRAFT_BADGE: Record<DraftFull["status"], { text: string; cls: string }> = {
  draft: { text: "draft", cls: "" },
  proposed: { text: "proposed by a bee", cls: "" },
  published: { text: "✓ live", cls: "ok" },
  discarded: { text: "discarded", cls: "err" },
};

/** Write, test and publish skills. A version is only ever live after a backtest; a bee's own drafts land here too. */
function SkillWorkshop({ s, password, refresh }: { s: AdminState; password: string; refresh: () => Promise<void> }) {
  const w = s.lab.workshop;
  const [draft, setDraft] = useState<DraftFull | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const latest = draft?.versions[draft.versions.length - 1] ?? null;
  const dirty = latest ? text !== latest.json : text.trim().length > 0;
  const bt = !dirty ? (latest?.backtest ?? null) : null;

  const run = async <T,>(what: string, f: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setMsg(null);
    try {
      return await f();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy("");
    }
  };
  const open = (key: string) =>
    void run("open", async () => {
      const r = await adminCall<{ draft: DraftFull }>("workspace/get", password, { key });
      setDraft(r.draft);
      setText(r.draft.versions[r.draft.versions.length - 1]?.json ?? "");
      setErrors([]);
      setForce(false);
    });
  const fresh = (json: string) => {
    setDraft(null);
    setText(json);
    setNote("");
    setErrors([]);
    setForce(false);
    setMsg(null);
  };
  const save = async (): Promise<DraftFull | null> => {
    const r = await run("save", () => adminCall<{ draft: DraftFull }>("workspace/save", password, { ...(draft ? { key: draft.key } : {}), json: text, ...(note ? { note } : {}) }));
    if (!r) return null;
    setDraft(r.draft);
    setNote("");
    void refresh();
    const v = r.draft.versions[r.draft.versions.length - 1]!;
    setErrors(v.errors);
    setMsg({ ok: v.valid, text: v.valid ? `Saved as version ${v.n}.` : "Saved as work in progress. It does not compile yet, so it cannot be tested or published." });
    return r.draft;
  };
  const check = () =>
    void run("check", async () => {
      const r = await adminCall<{ ok: boolean; errors?: string[]; id?: string }>("workspace/check", password, { json: text });
      setErrors(r.errors ?? []);
      setMsg({ ok: r.ok, text: r.ok ? `It compiles (${r.id}).` : "It does not compile yet." });
    });
  const backtest = async () => {
    const d = dirty ? await save() : draft;
    if (!d || !d.versions[d.versions.length - 1]?.valid) return;
    const r = await run("backtest", () => adminCall<{ draft: DraftFull }>("workspace/backtest", password, { key: d.key }));
    if (r) {
      setDraft(r.draft);
      void refresh();
    }
  };
  const publish = async () => {
    if (!draft) return;
    const r = await run("publish", () => adminCall<{ draft: DraftFull; note: string }>("workspace/publish", password, { key: draft.key, force }));
    if (r) {
      setDraft(r.draft);
      setMsg({ ok: true, text: r.note });
      void refresh();
    }
  };
  const discard = async () => {
    if (!draft) return;
    if (!window.confirm(`Discard the draft ${draft.key}? A published skill stays live.`)) return;
    const r = await run("discard", () => adminCall("workspace/discard", password, { key: draft.key }));
    if (r) {
      fresh("");
      void refresh();
    }
  };

  const [ask, setAsk] = useState("");
  const [agentBrain, setAgentBrain] = useState("");
  const [explained, setExplained] = useState("");
  const agents = w.agent;
  const askAgent = async () => {
    const revise = !!draft && !dirty;
    const r = await run("ai", () => adminCall<{ ok: boolean; json: string; explanation: string; errors: string[]; brainLabel: string; attempts: number; draft?: DraftFull }>("workspace/ai", password, { prompt: ask, ...(agentBrain ? { brain: agentBrain } : {}), ...(revise ? { key: draft!.key } : {}) }));
    if (!r) return;
    setText(r.json);
    setExplained(r.explanation);
    setErrors(r.errors);
    if (r.ok && r.draft) {
      setDraft(r.draft);
      setAsk("");
      void refresh();
      setMsg({ ok: true, text: `${r.brainLabel} drafted it${r.attempts > 1 ? " (after fixing its first attempt)" : ""} and saved it as version ${r.draft.versions.length}. It is only a draft: backtest it before anything else.` });
    } else {
      setDraft(null);
      setMsg({ ok: false, text: `${r.brainLabel} could not produce a skill that compiles. Its last attempt is in the editor with the errors below; fix it by hand or ask again.` });
    }
  };
  const canPublish = !!bt && !dirty && (force || (bt.pass && bt.data === "real"));
  return (
    <div className="pcard">
      <h3>Skill workshop</h3>
      <p className="dim">
        Write a skill in the JSON rule language, test it walk-forward on real history, keep every version, and publish it. Nothing reaches a bee until it is published, and even then it is one vote Jev may weigh. Skills the bees
        write themselves appear here too, so you can read, improve and re-test them.
      </p>
      <div className="agent-box">
        <h4>Ask the skill agent</h4>
        {agents.length === 0 ? (
          <p className="dim small">No brain can answer yet. Add a key (or a custom brain) under API keys, then restart the engine.</p>
        ) : (
          <>
            <textarea
              className="pinput"
              rows={3}
              maxLength={2000}
              value={ask}
              onChange={(e) => setAsk(e.target.value)}
              placeholder={draft && !dirty ? `Change ${draft.key}, e.g. “make the entry stricter and add a trailing stop”` : "Describe a strategy, e.g. “Buy a pullback to the 50 EMA when ADX shows a trend, exit on a close below the 20 EMA”"}
              aria-label="Describe the skill"
            />
            <div className="row-actions">
              <select className="pinput" style={{ maxWidth: 220 }} value={agentBrain} onChange={(e) => setAgentBrain(e.target.value)} aria-label="Brain">
                <option value="">Brain: {agents[0]!.label} (default)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
              <button className="pbtn" disabled={ask.trim().length < 8 || !!busy || (dirty && !!draft)} onClick={() => void askAgent()}>
                {busy === "ai" ? "Thinking…" : draft && !dirty ? `Revise ${draft.key}` : "Draft a skill"}
              </button>
            </div>
            <p className="dim small">
              The brain writes the JSON, the app compiles it (one automatic fix if it does not), and the result lands here as a <strong>draft</strong>: nothing is published, and the brain has no market data, so it cannot know how the idea performs.
              {dirty && draft ? " Save or revert your edits first to revise this draft." : ""}
            </p>
            {explained && <p className="small note-explain">{explained}</p>}
          </>
        )}
      </div>
      <div className="workshop">
        <div className="workshop-list">
          <div className="row-actions">
            <select className="pinput" value="" onChange={(e) => e.target.value && fresh(w.templates.find((t) => t.id === e.target.value)?.json ?? "")} aria-label="New draft from a template">
              <option value="">＋ New draft…</option>
              <option value="__blank">Blank</option>
              {w.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {w.drafts.length === 0 && <p className="dim small">No drafts yet.</p>}
          <ul className="draft-list">
            {w.drafts.map((d: DraftSummary) => (
              <li key={d.key}>
                <button className={`draft-item ${draft?.key === d.key ? "on" : ""}`} onClick={() => open(d.key)}>
                  <strong>{d.name}</strong>
                  <span className="dim small">
                    {d.author === "owner" ? "you" : d.author.startsWith("ai:") ? `AI · ${BRAIN_LABEL[d.author.slice(3)] ?? d.author.slice(3)}` : d.author} · v{d.versions} · <span className={`badge ${DRAFT_BADGE[d.status].cls}`}>{DRAFT_BADGE[d.status].text}</span>
                    {d.backtest ? ` · ${d.backtest.pass ? "✓" : "✗"} ${d.backtest.data === "real" ? "real" : "synthetic"} data` : d.valid ? "" : " · does not compile"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="workshop-edit">
          <textarea className="pinput mono" rows={18} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder="Pick a template, or paste a skill…" aria-label="Skill JSON" />
          {errors.length > 0 && (
            <ul className="bad small">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <div className="row-actions">
            <input className="pinput" style={{ maxWidth: 260 }} placeholder="What changed? (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            <button className="pbtn ghost" disabled={!text.trim() || !!busy} onClick={check}>
              Check
            </button>
            <button className="pbtn ghost" disabled={!text.trim() || !dirty || !!busy} onClick={() => void save()}>
              {busy === "save" ? "Saving…" : "Save version"}
            </button>
            <button className="pbtn" disabled={!text.trim() || !!busy} onClick={() => void backtest()}>
              {busy === "backtest" ? "Backtesting…" : dirty ? "Save & backtest" : "Backtest"}
            </button>
          </div>
          {msg && <p className={msg.ok ? "good small" : "bad small"}>{msg.text}</p>}

          {bt && (
            <div className="verdict">
              <div className="verdict-head">
                <strong>Walk-forward backtest</strong> <span className={`badge ${bt.pass ? "ok" : "err"}`}>{bt.pass ? "✓ clears the bar" : "✗ does not clear the bar"}</span>{" "}
                <span className={`badge ${bt.data === "real" ? "" : "err"}`}>{bt.data === "real" ? "real history" : "synthetic data"}</span>
              </div>
              <p className="small">
                Out of sample {bt.returnPct.toFixed(1)}% vs buy-and-hold {bt.benchmarkPct.toFixed(1)}% · score {bt.score.toFixed(2)} · positive in {bt.stabilityPct}% of folds · {bt.trades} trades · max drawdown {bt.maxDrawdownPct.toFixed(1)}% · Sharpe{" "}
                {bt.sharpe.toFixed(2)} · overfit gap {bt.overfitGap.toFixed(2)}
              </p>
              <p className="dim small">
                {bt.datasets.join(", ")}.{" "}
                {bt.data === "synthetic" ? "No real history is cached, so this only exercises the skill. Run the Real-data check first, then backtest again." : "The bar: a positive out-of-sample score with at least 50% of folds positive."}
              </p>
            </div>
          )}

          {draft && (
            <>
              <div className="row-actions">
                <button className="pbtn" disabled={!canPublish || !!busy} onClick={() => void publish()}>
                  {busy === "publish" ? "Publishing…" : draft.status === "published" && draft.publishedVersion === latest?.n ? "Published" : "Publish"}
                </button>
                {bt && (!bt.pass || bt.data === "synthetic") ? (
                  <label className="switch">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                    <span>Publish anyway (I accept it has no passing real-data backtest)</span>
                  </label>
                ) : null}
                <button className="pbtn ghost" disabled={!!busy} onClick={() => void discard()}>
                  Discard draft
                </button>
              </div>
              <details>
                <summary>Versions ({draft.versions.length})</summary>
                <ul className="checklist">
                  {[...draft.versions].reverse().map((v) => (
                    <li key={v.n}>
                      <button className="hg-jump" onClick={() => setText(v.json)}>
                        v{v.n}
                      </button>{" "}
                      <span className="dim small">
                        {v.author === "owner" ? "you" : v.author.startsWith("ai:") ? `AI · ${BRAIN_LABEL[v.author.slice(3)] ?? v.author.slice(3)}` : v.author} · {new Date(v.at).toISOString().slice(0, 16).replace("T", " ")}
                        {v.note ? ` · ${v.note}` : ""}
                        {v.n === draft.publishedVersion ? " · live" : ""}
                        {v.backtest ? ` · ${v.backtest.pass ? "✓" : "✗"} ${v.backtest.returnPct.toFixed(1)}% (${v.backtest.data})` : ""}
                        {!v.valid ? " · does not compile" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="dim small">Click a version to load it into the editor; Save version makes it the newest.</p>
              </details>
            </>
          )}
        </div>
      </div>
      <details>
        <summary>Rule language, in short</summary>
        <p className="dim small">
          A skill is JSON: <span className="mono">id</span>, <span className="mono">name</span>, <span className="mono">family</span> (trend, breakout, momentum, mean_reversion, hybrid), optional{" "}
          <span className="mono">params</span> with a grid to scan, exits (<span className="mono">stopAtr</span>, <span className="mono">stoploss</span>, <span className="mono">roi</span>, <span className="mono">trailing</span>), and a{" "}
          <span className="mono">long</span> and/or <span className="mono">short</span> side with <span className="mono">entry</span> and <span className="mono">exit</span> conditions. A condition is{" "}
          <span className="mono">{`{"left":…,"op":…,"right":…}`}</span> (ops: &lt; &lt;= &gt; &gt;= crosses_above crosses_below) or <span className="mono">{`{"any":[…]}`}</span>. Values: close open high low volume, sma(n) ema(n) rsi(n) atr(n) roc(n) zscore(n)
          highest(n) lowest(n) bb_*(n,k) macd_hist adx supertrend cci mfi willr…, numbers, or $param. Signals are read at a bar's close and filled at the next open. The id may not be a built-in's.
        </p>
      </details>
    </div>
  );
}

/** What each bee has been studying: the owner's background, and notes its brain drafted that wait for a yes. */
function ResearchNotes({ s, call, refresh }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void>; refresh: () => Promise<void> }) {
  const n = s.lab.notes;
  const bees = (s.bees ?? []).filter((b) => b.running);
  const [bee, setBee] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [coins, setCoins] = useState("");
  const target = bee || bees[0]?.slot || "hive";
  const label = (slot: string) => (slot === "hive" ? "Every bee" : (bees.find((b) => b.slot === slot)?.name ?? slot));
  const shown = n.notes.filter((x) => x.bee === target || (target !== "hive" && x.bee === "hive"));
  const pending = n.notes.filter((x) => x.status === "pending");
  const why = n.blocked[target];
  const busy = n.busy.includes(target);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [busy, refresh]);
  if (!n.available) return null;
  return (
    <div className="pcard">
      <h3>
        Research &amp; background {pending.length > 0 && <span className="badge">{pending.length} to review</span>}
      </h3>
      <p className="dim">
        What a bee has been studying. Write its <strong>background</strong> yourself (it applies at once), or ask its brain to <strong>research</strong>: it reads only what the app already holds (the lab ranking, the bee's trades,
        its peers, the market mood), cites that evidence, and its notes wait here until you approve them. Approved notes reach the brains as context and hypotheses, never as orders or facts, and show in the hive-mind graph.
      </p>
      <div className="row-actions">
        <select className="pinput" value={target} onChange={(e) => setBee(e.target.value)} aria-label="Bee">
          {bees.map((b) => (
            <option key={b.slot} value={b.slot}>
              {b.name} ({b.slot}){n.notes.some((x) => x.bee === b.slot && x.status === "pending") ? " · to review" : ""}
            </option>
          ))}
          <option value="hive">Every bee</option>
        </select>
        {target !== "hive" && (
          <button className="pbtn" disabled={!!why || busy} title={why ?? ""} onClick={() => void call("research", { bee: target }, "Research started: its notes appear here for your review in a minute or two.").then(() => setTimeout(() => void refresh(), 4000))}>
            {busy ? "Researching…" : `Ask ${label(target)}'s brain to research`}
          </button>
        )}
      </div>
      {target !== "hive" && why && !busy && <p className="dim small">Not now: {why}.</p>}
      <ul className="notes">
        {shown.length === 0 && <li className="dim small">No notes yet for {label(target)}.</li>}
        {shown.map((x) => (
          <li key={x.id} className={`note ${x.status}`}>
            <div className="note-head">
              <strong>{x.title}</strong>{" "}
              <span className={`badge ${x.status === "approved" ? "ok" : ""}`}>{x.status === "pending" ? "● waiting for you" : x.kind === "background" ? "✓ background" : "✓ approved"}</span>{" "}
              <span className="dim small">
                {x.author === "owner" ? "you" : `${x.brain ?? "brain"} (${x.author})`}
                {x.bee === "hive" ? " · every bee" : ""} · {x.kind === "research" ? `confidence ${x.confidence}` : "your words"}
                {x.coins.length ? ` · ${x.coins.join(", ")}` : ""}
              </span>
            </div>
            <p className="small">{x.text}</p>
            {x.evidence.length > 0 && (
              <ul className="dim small">
                {x.evidence.map((e, i) => (
                  <li key={i}>
                    {e.startsWith("external:") && <span className="badge">outside source, unverified</span>} {e}
                  </li>
                ))}
              </ul>
            )}
            <div className="row-actions">
              {x.status === "pending" && (
                <>
                  <button className="pbtn small" onClick={() => void call("notes/decide", { id: x.id, decision: "approve" }, "Note approved: the brains will read it.")}>
                    Approve
                  </button>
                  <button className="pbtn ghost small" onClick={() => void call("notes/decide", { id: x.id, decision: "reject" }, "Note rejected.")}>
                    Reject
                  </button>
                </>
              )}
              {x.status === "approved" && (
                <button className="pbtn ghost small" onClick={() => void call("notes/decide", { id: x.id, decision: "reject" }, "Note archived: the brains no longer read it.")}>
                  Archive
                </button>
              )}
              <button className="pbtn ghost small" onClick={() => window.confirm("Delete this note for good?") && void call("notes/delete", { id: x.id }, "Note deleted.")}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <h4>Write a background note for {label(target)}</h4>
      <div className="form-grid">
        <label className="plabel">
          Title
          <input className="pinput" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Study gold vs real yields" />
        </label>
        <label className="plabel">
          Coins (optional, comma separated)
          <input className="pinput mono" value={coins} onChange={(e) => setCoins(e.target.value)} placeholder="BTC, XAU" />
        </label>
        <label className="plabel wide">
          What it should know or keep in mind
          <textarea className="pinput" rows={3} maxLength={700} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>
      <button
        className="pbtn"
        disabled={!title.trim() || text.trim().length < 10}
        onClick={() => {
          void call("notes/add", { bee: target, title, text, coins: coins.split(",").map((c) => c.trim()).filter(Boolean) }, "Background note saved.");
          setTitle("");
          setText("");
          setCoins("");
        }}
      >
        Save background note
      </button>
    </div>
  );
}

/** Outside MCP servers for research. Read-only by rule: the owner grants named tools to named bees, nothing else is callable. */
function Connectors({ s, call }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  const v = s.lab.mcp;
  const blank = { id: "", label: "", url: "https://", transport: "http", authHeader: "Authorization", token: "", maxCallsDay: 50 };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  const set = (k: keyof typeof blank, val: string | number) => setF((p) => ({ ...p, [k]: val, ...(k === "label" && !editing ? { id: slug(String(val)) } : {}) }));
  const bees = (s.bees ?? []).filter((b) => b.running);
  if (!v.available) return null;
  const ready = f.id.length >= 2 && f.label.trim() && /^https?:\/\//.test(f.url);
  const save = (force: boolean) =>
    void call("mcp/save", { ...f, token: f.token || undefined, maxCallsDay: Number(f.maxCallsDay) || 50, force }, `${f.label} saved.`).then(
      () => {
        setF(blank);
        setEditing(false);
        setFailed(false);
      },
      () => setFailed(true),
    );
  return (
    <div className="pcard">
      <h3>Connectors (MCP)</h3>
      <p className="dim">
        Let the bees look things up on outside MCP servers while they research (news, data, documentation). Read-only by rule: a bee can call only the tools you grant it by name; a tool that the server does not declare read-only, or whose name reads
        like an action, needs your explicit confirmation before it can be granted; every call is capped per day, times out, is logged below, and its answer reaches the brain as untrusted data. Nothing here can place an order or change a
        setting. The token is stored like the other keys, never shown again and only sent to the server's address. Servers run elsewhere: beebots does not run plugins or local commands.
      </p>
      {v.servers.length === 0 && <p className="dim small">No connectors yet.</p>}
      {v.servers.map((m) => (
        <McpServerCard key={m.id} m={m} bees={bees} call={call} onEdit={() => (setF({ id: m.id, label: m.label, url: m.url, transport: m.transport, authHeader: m.authHeader, token: "", maxCallsDay: m.maxCallsDay }), setEditing(true), setFailed(false))} />
      ))}
      {!v.canEdit ? (
        <p className="dim small">No Setup file on this server, so connectors cannot be saved here.</p>
      ) : (
        <>
          <h4>{editing ? `Edit ${f.label}` : "Connect a server"}</h4>
          <div className="form-grid">
            <label className="plabel">
              Name
              <input className="pinput" maxLength={30} value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="News feed" />
            </label>
            <label className="plabel">
              Id (fixed once saved)
              <input className="pinput mono" maxLength={30} disabled={editing} value={f.id} onChange={(e) => set("id", slug(e.target.value))} placeholder="news_feed" />
            </label>
            <label className="plabel wide">
              Server address (MCP URL)
              <input className="pinput mono" value={f.url} onChange={(e) => (setFailed(false), set("url", e.target.value))} placeholder="https://mcp.example.com/mcp" />
            </label>
            <label className="plabel">
              Transport
              <select className="pinput" value={f.transport} onChange={(e) => set("transport", e.target.value)}>
                <option value="http">Streamable HTTP (current)</option>
                <option value="sse">SSE (older servers)</option>
              </select>
            </label>
            <label className="plabel">
              Token header
              <input className="pinput mono" value={f.authHeader} onChange={(e) => set("authHeader", e.target.value)} placeholder="Authorization" />
            </label>
            <label className="plabel">
              Token {editing ? "(empty keeps the saved one)" : "(if it needs one)"}
              <input className="pinput mono" type="password" autoComplete="off" value={f.token} onChange={(e) => set("token", e.target.value)} />
            </label>
            <label className="plabel">
              Calls per day (all bees)
              <input className="pinput num" type="number" min={1} max={500} value={f.maxCallsDay} onChange={(e) => set("maxCallsDay", Number(e.target.value))} />
            </label>
          </div>
          <div className="row-actions">
            <button className="pbtn" disabled={!ready} onClick={() => save(false)}>
              {editing ? "Test & save changes" : "Test & connect"}
            </button>
            {failed && (
              <button className="pbtn ghost" disabled={!ready} onClick={() => save(true)}>
                Save without testing
              </button>
            )}
            {editing && (
              <button className="pbtn ghost" onClick={() => (setF(blank), setEditing(false), setFailed(false))}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
      {v.log.length > 0 && (
        <details>
          <summary>Recent calls ({v.log.length})</summary>
          <ul className="checklist">
            {v.log.map((l, i) => (
              <li key={i} className={l.ok ? "" : "bad"}>
                <span>{l.ok ? "✓" : "✗"}</span> <span className="num dim small">{new Date(l.at).toISOString().slice(0, 16).replace("T", " ")}</span> {l.bee} → <strong>{l.server}/{l.tool}</strong>{" "}
                <span className="dim small mono">{l.args}</span> <span className="dim small">· {l.bytes} bytes · {l.ms} ms{l.note ? ` · ${l.note}` : ""}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function McpServerCard({ m, bees, call, onEdit }: { m: McpServerView; bees: Array<{ slot: string; name: string }>; call: (path: string, body: unknown, ok: string) => Promise<void>; onEdit: () => void }) {
  const init = () => Object.fromEntries(m.grants.map((g) => [g.tool, { bees: g.bees, confirmed: !!g.confirmed }]));
  const [g, setG] = useState<Record<string, { bees: string[]; confirmed: boolean }>>(init);
  const [open, setOpen] = useState(false);
  const key = JSON.stringify(m.grants);
  useEffect(() => setG(init()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleBee = (tool: string, bee: string) =>
    setG((p) => {
      const cur = p[tool]?.bees ?? [];
      const next = bee === "all" ? (cur.includes("all") ? [] : ["all"]) : cur.includes(bee) ? cur.filter((x) => x !== bee) : [...cur.filter((x) => x !== "all"), bee];
      const out = { ...p };
      if (next.length) out[tool] = { bees: next, confirmed: p[tool]?.confirmed ?? false };
      else delete out[tool];
      return out;
    });
  const body: McpGrant[] = Object.entries(g).map(([tool, x]) => ({ tool, bees: x.bees, ...(x.confirmed ? { confirmed: true } : {}) }));
  const blocked = m.tools.filter((t) => t.needsConfirm && g[t.name] && !g[t.name]!.confirmed);
  return (
    <div className="verdict mcp-server">
      <div className="verdict-head">
        <strong>{m.label}</strong> <span className="dim small mono">{m.url.replace(/^https?:\/\//, "")}</span> <span className="badge">{m.tokenSet ? "token saved" : "no token"}</span>{" "}
        <span className="dim small num">
          {m.usedToday}/{m.maxCallsDay} calls today · {m.tools.length} tools · {m.grants.length} granted
        </span>
      </div>
      <div className="row-actions">
        <button className="pbtn ghost small" onClick={() => setOpen((x) => !x)}>
          {open ? "Hide tools" : "Tools & grants"}
        </button>
        <button className="pbtn ghost small" onClick={() => void call("mcp/discover", { id: m.id }, "Tools refreshed.")}>
          Refresh tools
        </button>
        <button className="pbtn ghost small" onClick={onEdit}>
          Edit
        </button>
        <button className="pbtn ghost small" onClick={() => confirm(`Remove ${m.label}?`) && void call("mcp/delete", { id: m.id }, `${m.label} removed.`)}>
          Remove
        </button>
      </div>
      {open && (
        <>
          {m.tools.length === 0 && <p className="dim small">The server offers no tools (or its tools were never read: Refresh tools).</p>}
          <ul className="mcp-tools">
            {m.tools.map((t) => {
              const on = g[t.name];
              return (
                <li key={t.name}>
                  <div>
                    <strong className="mono">{t.name}</strong>{" "}
                    <span className={`badge ${t.readOnly === true && !t.looksLikeAction ? "ok" : ""}`}>{t.looksLikeAction ? "reads like an action" : t.readOnly === true ? "declared read-only" : t.readOnly === false ? "declared NOT read-only" : "read-only not declared"}</span>
                    <div className="dim small">{t.description || "No description."}</div>
                  </div>
                  <div className="mcp-bees">
                    <label>
                      <input type="checkbox" checked={!!on?.bees.includes("all")} onChange={() => toggleBee(t.name, "all")} /> all bees
                    </label>
                    {bees.map((b) => (
                      <label key={b.slot}>
                        <input type="checkbox" checked={!!on?.bees.includes(b.slot) || !!on?.bees.includes("all")} disabled={!!on?.bees.includes("all")} onChange={() => toggleBee(t.name, b.slot)} /> {b.name}
                      </label>
                    ))}
                    {on && t.needsConfirm && (
                      <label className="warn">
                        <input type="checkbox" checked={on.confirmed} onChange={(e) => setG((p) => ({ ...p, [t.name]: { ...p[t.name]!, confirmed: e.target.checked } }))} /> I checked that this tool only reads
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="row-actions">
            <button className="pbtn" disabled={blocked.length > 0} title={blocked.length ? `Confirm: ${blocked.map((t) => t.name).join(", ")}` : ""} onClick={() => void call("mcp/grant", { id: m.id, grants: body }, "Grants saved.")}>
              Save grants
            </button>
            {blocked.length > 0 && <span className="dim small">Confirm or untick: {blocked.map((t) => t.name).join(", ")}</span>}
          </div>
        </>
      )}
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
      <RealCheck s={s} call={call} />

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

      <SkillWorkshop s={s} password={password} refresh={refresh} />

      <ResearchNotes s={s} call={call} refresh={refresh} />

      <Connectors s={s} call={call} />

      <ImportSkill password={password} />

      <SettingsTab s={s} call={call} only={["learning", "evolution"]} />
    </>
  );
}

const STAGE_LABEL: Record<string, string> = {
  skills: "Skills: hourly history, walk-forward ranking",
  scalper: "Scalper: 1-minute history, does it survive costs?",
  gold: "Gold breakout: walk-forward, Monte Carlo, stability (needs an MT5 export)",
  council: "Council: each bee's brain picks skills",
  report: "Hive mind report",
};
const VERDICT: Record<string, { text: string; cls: string }> = {
  pass: { text: "✓ passed", cls: "ok" },
  fail: { text: "✗ no edge", cls: "err" },
  stale: { text: "● out of date", cls: "" },
  incomplete: { text: "● incomplete", cls: "" },
  none: { text: "○ not run", cls: "" },
};
const STEP_MARK: Record<string, string> = { pending: "○", running: "●", done: "✓", failed: "✗", skipped: "–" };

/** The roteiro as one button: public data, no orders, a verdict per stage. */
function RealCheck({ s, call }: { s: AdminState; call: (path: string, body: unknown, ok: string) => Promise<void> }) {
  const c = s.lab.check;
  const [picked, setPicked] = useState<string[]>(() => c.stages.filter((x) => x !== "gold" || c.goldFiles.length > 0));
  const job = s.lab.job?.command === "check" ? s.lab.job : null;
  const running = s.lab.job?.state === "running";
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <div className="pcard">
      <h3>Real-data check</h3>
      <p className="dim">
        Downloads real public candles from OKX and runs the whole roteiro in the background: skill ranking, scalper cost test, gold validation, council and hive report. It places no orders and needs no exchange account; the engine keeps
        running. Each stage ends with a verdict. Nothing here turns a feature on.
      </p>
      <ul className="checklist">
        {c.preflight.map((i) => (
          <li key={i.id}>
            <span className={i.ok ? "good" : "dim"}>{i.ok ? "✓" : "○"}</span> <strong>{i.label}</strong> <span className="dim small">{i.note}</span>
          </li>
        ))}
      </ul>
      <ul className="checklist stages">
        {c.stages.map((id) => (
          <li key={id}>
            <label>
              <input type="checkbox" checked={picked.includes(id)} disabled={running} onChange={() => toggle(id)} /> {STAGE_LABEL[id] ?? id}
            </label>
          </li>
        ))}
      </ul>
      <div className="row-actions">
        <button className="pbtn" disabled={running || !picked.length} onClick={() => void call("check", { stages: picked }, "Real-data check started.")}>
          {running ? "Running…" : "Run the real-data check"}
        </button>
        {running && job && (
          <button className="pbtn ghost" onClick={() => void call("lab/stop", {}, "Stopping the check.")}>
            Stop
          </button>
        )}
      </div>
      {job?.steps && (
        <ul className="checklist">
          {job.steps.map((st) => (
            <li key={st.id} className={st.state === "failed" ? "bad" : ""}>
              <span>{STEP_MARK[st.state]}</span> {st.label} {st.note && <span className="dim small">· {st.note}</span>}
              {st.startedAt && st.endedAt ? <span className="dim small num"> · {Math.max(1, Math.round((st.endedAt - st.startedAt) / 1000))}s</span> : null}
            </li>
          ))}
        </ul>
      )}
      <h4>Verdicts</h4>
      <div className="verdicts">
        {c.verdicts.map((v) => (
          <div className="verdict" key={v.stage}>
            <div className="verdict-head">
              <strong>{v.title}</strong> <span className={`badge ${VERDICT[v.status]!.cls}`}>{VERDICT[v.status]!.text}</span>
              {v.at ? <span className="dim small num"> {new Date(v.at).toISOString().slice(0, 16).replace("T", " ")}</span> : null}
            </div>
            <p className="small">{v.headline}</p>
            {v.details.length > 0 && (
              <ul className="dim small">
                {v.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="dim small">
        Gold needs your own XAUUSD bar export from MT5: put the CSV in <code>{c.goldDir}</code> {c.goldFiles.length ? `(found: ${c.goldFiles.join(", ")})` : "(none there yet)"}. A test that did not run counts as not passed.
      </p>
    </div>
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
  // Custom brains carry their own labels; this keeps every BRAIN_LABEL lookup on the page in step.
  for (const c of s?.brains?.custom ?? []) BRAIN_LABEL[c.id] = c.label;
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
              {tab === "keys" && <KeysTab s={s} call={safeCall} password={pw} />}
              {tab === "bees" && <BeesTab key={JSON.stringify(s.bees)} s={s} call={safeCall} password={pw} />}
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
