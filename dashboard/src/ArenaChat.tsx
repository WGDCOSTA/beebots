// Talking to an agent. It looks at real market candles and answers: short for small talk, a full report with charts and
// figures when asked for a view. Read-only: it cannot trade or change anything from here.
//   own:   a member's own agent. The conversation is kept in the member's own database; questions count against the plan.
//   house: one of the Arena's house agents, open to anyone.  bunny: one of the main site's bunnies, open to anyone.
//   For these two the server keeps nothing: the page holds the conversation (for this tab only) and sends the last few messages.
import { useCallback, useEffect, useRef, useState } from "react";
import { arena } from "./arenaApi";
import type { ChatMsg } from "./arenaChart";
import { ArenaReport } from "./ArenaReport";
import { useI18n } from "./i18n/I18n";
import "./chat.css";

export type ChatSource = { kind: "own" | "house" | "bunny"; id: string };

const SUGGESTIONS = { own: ["chat.sug1", "chat.sug2", "chat.sug3"], public: ["chat.sugPublic", "chat.sug1", "chat.sug3"] } as const;

interface Reply {
  status: number;
  data: { message?: ChatMsg; used?: number; limit?: number; left?: number; error?: string; code?: string };
}

/** The public endpoints: the engine's for a bunny, the Arena's for a house agent. */
async function publicCall(src: ChatSource, method: "GET" | "POST", body?: Record<string, unknown>): Promise<Reply> {
  if (src.kind === "house") return method === "GET" ? arena("GET", `showcase/chat?id=${encodeURIComponent(src.id)}`) : arena("POST", "showcase/chat/send", { id: src.id, ...body });
  const r =
    method === "GET"
      ? await fetch(`/chat?bee=${encodeURIComponent(src.id)}`, { cache: "no-store" })
      : await fetch("/chat/send", { method: "POST", headers: { "content-type": "application/json", "x-chat": "1" }, body: JSON.stringify({ bee: src.id, ...body }) });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Reply["data"] };
}

const keyOf = (src: ChatSource) => `chat:${src.kind}:${src.id}`;
function remembered(src: ChatSource): ChatMsg[] {
  try {
    return JSON.parse(sessionStorage.getItem(keyOf(src)) ?? "[]") as ChatMsg[];
  } catch {
    return [];
  }
}
function remember(src: ChatSource, msgs: ChatMsg[]): void {
  try {
    // A report carries its chart data: keep the last few messages only.
    sessionStorage.setItem(keyOf(src), JSON.stringify(msgs.slice(-12)));
  } catch {
    /* private window or full: the conversation lasts until the page is left */
  }
}

export function ArenaChat({ source, name }: { source: ChatSource; name: string }) {
  const { t, locale } = useI18n();
  const pub = source.kind !== "own";
  const [msgs, setMsgs] = useState<ChatMsg[]>(() => (pub ? remembered(source) : []));
  const [open, setOpen] = useState(true);
  const [left, setLeft] = useState<{ n: number; max: number } | null>(null);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    if (pub) setMsgs(remembered(source));
    const load = pub
      ? publicCall(source, "GET").then((r) => {
          const d = r.data as { open?: boolean; perHour?: number; left?: number };
          if (!live) return;
          if (r.status === 200) {
            setOpen(!!d.open);
            setLeft({ n: d.left ?? 0, max: d.perHour ?? 0 });
          } else setOpen(false);
        })
      : arena<{ open: boolean; limit: number; used: number; messages: ChatMsg[] }>("GET", `bots/chat?id=${encodeURIComponent(source.id)}`).then((r) => {
          if (!live || r.status !== 200) return;
          setMsgs(r.data.messages);
          setOpen(r.data.open);
          setLeft({ n: Math.max(0, r.data.limit - r.data.used), max: r.data.limit });
        });
    void load.catch(() => live && setOpen(false)).finally(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [source.kind, source.id]);
  // Braces on purpose: newer browsers return a Promise from scrollIntoView, and an effect must return nothing or a cleanup
  // function. Returning that Promise made React call it as a cleanup when the chat closed, which crashed the page.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [msgs.length, waiting]);

  const send = useCallback(
    async (q: string) => {
      const asked = q.trim();
      if (!asked || waiting) return;
      setError("");
      setWaiting(asked);
      setText("");
      try {
        const now = Date.now();
        const r: Reply = pub
          ? await publicCall(source, "POST", { text: asked, locale, history: msgs.slice(-6).map((m) => ({ role: m.role, text: m.text || m.report?.headline || "" })) })
          : await arena("POST", "bots/chat/send", { id: source.id, text: asked });
        if (r.status === 200 && r.data.message) {
          if (pub) {
            const next = [...msgs, { id: now, role: "you" as const, ts: now, text: asked, report: null, unavailable: [] }, r.data.message];
            setMsgs(next);
            remember(source, next);
            setLeft((l) => ({ n: r.data.left ?? 0, max: l?.max ?? 0 }));
          } else {
            const list = await arena<{ messages: ChatMsg[] }>("GET", `bots/chat?id=${encodeURIComponent(source.id)}`);
            setMsgs(list.status === 200 ? list.data.messages : (m) => [...m, r.data.message!]);
            setLeft({ n: Math.max(0, (r.data.limit ?? 0) - (r.data.used ?? 0)), max: r.data.limit ?? 0 });
          }
        } else {
          setText(asked);
          const c = r.data.code;
          setError(c === "chat_limit" ? t(pub ? "chat.limitHour" : "chat.limit") : c === "chat_busy" ? t("chat.busy") : c === "chat_closed" ? t("chat.closed") : c === "no_key" ? t("chat.noKey") : t("chat.failed"));
          if (c === "chat_limit") setLeft((l) => ({ n: 0, max: l?.max ?? 0 }));
        }
      } catch {
        setText(asked);
        setError(t("common.down"));
      } finally {
        setWaiting(null);
      }
    },
    [source, pub, msgs, locale, waiting, t],
  );

  const clear = async () => {
    if (pub) {
      setMsgs([]);
      remember(source, []);
      return;
    }
    const r = await arena("POST", "bots/chat/clear", { id: source.id });
    if (r.status === 200) setMsgs([]);
  };
  const out = left !== null && left.n <= 0;

  return (
    <div className="ct">
      <p className="dim small">{t(pub ? "chat.introPublic" : "chat.intro", { name })}</p>
      {loaded && !open && <p className="bad small">{t("chat.closed")}</p>}
      <div className="ct-log" aria-live="polite">
        {loaded && msgs.length === 0 && !waiting && (
          <div className="ct-empty">
            <p className="small">{t("chat.try")}</p>
            <div className="ct-sugs">
              {SUGGESTIONS[pub ? "public" : "own"].map((k) => (
                <button key={k} className="pbtn ghost" disabled={!open || out} onClick={() => void send(t(k))}>
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={`${m.id}-${m.role}`} className={`ct-msg ${m.role}`}>
            {m.role === "you" ? (
              <p>{m.text}</p>
            ) : (
              <>
                {m.text && <p>{m.text}</p>}
                {m.unavailable.length > 0 && <p className="rp-warn small">{t("chat.unavailable", { assets: m.unavailable.join(", ") })}</p>}
                {m.report && <ArenaReport report={m.report} />}
              </>
            )}
          </div>
        ))}
        {waiting && (
          <>
            <div className="ct-msg you">
              <p>{waiting}</p>
            </div>
            <div className="ct-msg agent ct-think" role="status">
              <p className="dim">{t("chat.thinking", { name })}</p>
            </div>
          </>
        )}
        <div ref={end} />
      </div>
      {error && (
        <p className="bad small" role="alert">
          {error}
        </p>
      )}
      <form
        className="ct-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder={t("chat.placeholder")} aria-label={t("chat.placeholder")} disabled={!open || out || !!waiting} />
        <button className="pbtn" type="submit" disabled={!open || out || !!waiting || !text.trim()}>
          {t("chat.send")}
        </button>
      </form>
      <div className="ct-meta dim small">
        <span>{left ? t(pub ? "chat.leftHour" : "chat.left", { n: left.n, max: left.max }) : ""}</span>
        {msgs.length > 0 && (
          <button className="linkbtn" onClick={() => void clear()}>
            {t("chat.clear")}
          </button>
        )}
      </div>
      <p className="dim small">{t("chat.readonly")}</p>
    </div>
  );
}
