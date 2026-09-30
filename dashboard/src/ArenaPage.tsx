// #/arena: sign in with an e-mailed link, and the account page. The Arena is its own service (/arena/*), separate from the
// owner's engine and admin panel: nothing on this page can reach them, and they cannot reach a member's data.
import { useCallback, useEffect, useRef, useState } from "react";
import { PageNav } from "./LabPage";
import { arenaView, looksLikeEmail, memberSince, resendIn, TIER_LABEL } from "./arenaModel";

interface Member {
  id: string;
  email: string;
  tier: "free" | "pro";
  createdAt: number;
}

async function arena<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const r = await fetch(`/arena/${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", "x-arena": "1" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

const DOWN = "The Arena is not reachable right now. Try again in a minute.";

// A sign-in link works once, and React's StrictMode runs effects twice in development: remember what was already spent.
const spent = new Set<string>();

function SignIn({ notice }: { notice?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (sentAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sentAt]);

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "auth/request", { email });
      if (r.status === 200) {
        setNow(Date.now());
        setSentAt(Date.now());
      }
      else setError(r.data.error ?? DOWN);
    } catch {
      setError(DOWN);
    } finally {
      setBusy(false);
    }
  };

  if (sentAt !== null) {
    const wait = resendIn(sentAt, now);
    return (
      <div className="pcard login arena-card">
        <h2>Check your inbox</h2>
        <p>
          If <strong className="mono">{email.trim().toLowerCase()}</strong> can sign in, a link is on its way. It works once and expires in 15 minutes.
        </p>
        <p className="dim small">Nothing arrived? Look in spam, or ask for a new link.</p>
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy || wait > 0} onClick={() => void send()}>
            {wait > 0 ? `Send again in ${wait}s` : "Send again"}
          </button>
          <button className="linkbtn" onClick={() => setSentAt(null)}>
            Use another e-mail
          </button>
        </div>
        {error && <p className="bad">{error}</p>}
      </div>
    );
  }

  return (
    <div className="pcard login arena-card">
      <h2>Sign in to the Arena</h2>
      <p className="dim">No password. Enter your e-mail and we send a one-time link. New here? The same link creates your account.</p>
      {notice && <p className="bad">{notice}</p>}
      <form
        className="arena-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input className="pinput" type="email" inputMode="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        <button className="pbtn" disabled={busy || !looksLikeEmail(email)}>
          {busy ? "Sending…" : "Send me a link"}
        </button>
      </form>
      {error && <p className="bad">{error}</p>}
      <p className="dim small">Paper trading only for now: simulated money, real prices. Not financial advice.</p>
    </div>
  );
}

function Account({ me, onOut }: { me: Member; onOut: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const out = async () => {
    setBusy(true);
    try {
      await arena("POST", "auth/logout");
    } finally {
      onOut();
    }
  };
  const erase = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await arena("POST", "account/delete", { confirm });
      if (r.status === 200) onOut();
      else setError(r.data.error ?? DOWN);
    } catch {
      setError(DOWN);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="pcard arena-card">
        <div className="arena-who">
          <div>
            <div className="eyebrow">Signed in as</div>
            <div className="arena-email mono">{me.email}</div>
            <div className="dim small">{memberSince(me.createdAt)}</div>
          </div>
          <span className={`badge ${me.tier === "pro" ? "ok" : ""}`}>{TIER_LABEL[me.tier]}</span>
        </div>
        <div className="arena-actions">
          <button className="pbtn ghost" disabled={busy} onClick={() => void out()}>
            Sign out
          </button>
        </div>
      </div>

      <div className="pcard arena-card">
        <h3>Your bunnies</h3>
        <p className="dim">Creating and running your own bunny is the next step. Your account is ready: it has its own private database that nobody else, including the platform's owner, has a route to.</p>
      </div>

      <div className="pcard arena-card arena-danger">
        <h3>Delete my account</h3>
        <p className="dim small">Removes your account, your sessions and your whole private database. This cannot be undone.</p>
        {!open ? (
          <button className="pbtn ghost small" onClick={() => setOpen(true)}>
            Delete my account…
          </button>
        ) : (
          <form
            className="arena-form"
            onSubmit={(e) => {
              e.preventDefault();
              void erase();
            }}
          >
            <input className="pinput" type="email" placeholder={`Type ${me.email} to confirm`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus />
            <button className="pbtn danger" disabled={busy || confirm.trim().toLowerCase() !== me.email}>
              {busy ? "Deleting…" : "Delete forever"}
            </button>
          </form>
        )}
        {error && <p className="bad">{error}</p>}
      </div>
    </>
  );
}

export function ArenaPage() {
  const [view, setView] = useState(() => arenaView(location.hash));
  const [me, setMe] = useState<Member | null | "loading">("loading");
  const [notice, setNotice] = useState("");
  const [down, setDown] = useState(false);
  const verifying = useRef(false);

  useEffect(() => {
    const on = () => setView(arenaView(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await arena<{ user?: Member }>("GET", "me");
      setDown(false);
      setMe(r.status === 200 && r.data.user ? r.data.user : null);
    } catch {
      setDown(true);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    if (view.kind === "verify") {
      const token = view.token;
      if (spent.has(token) || verifying.current) return;
      spent.add(token);
      verifying.current = true;
      void (async () => {
        try {
          const r = await arena<{ user?: Member }>("POST", "auth/verify", { token });
          if (r.status === 200 && r.data.user) setMe(r.data.user);
          else {
            setNotice(r.data.error ?? "This link is invalid, expired or already used.");
            setMe(null);
          }
        } catch {
          setDown(true);
          setMe(null);
        } finally {
          verifying.current = false;
          // The token is spent either way: take it out of the address bar and the history.
          history.replaceState(null, "", "#/arena");
          setView({ kind: "account" });
        }
      })();
    } else void load();
  }, [view, load]);

  return (
    <div className="page">
      <PageNav current="arena" />
      <div className="page-inner arena-page">
        <h1>Arena</h1>
        <p className="lead">Bring your own bunnies and race them on real prices with simulated money.</p>
        {me === "loading" || (view.kind === "verify" && me === null && !notice) ? (
          <div className="pcard arena-card dim">{view.kind === "verify" ? "Signing you in…" : "Loading…"}</div>
        ) : down ? (
          <div className="pcard arena-card">
            <p className="bad">{DOWN}</p>
            <button className="pbtn ghost" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : me ? (
          <Account
            me={me}
            onOut={() => {
              setNotice("");
              setMe(null);
            }}
          />
        ) : (
          <SignIn notice={notice} />
        )}
      </div>
    </div>
  );
}
