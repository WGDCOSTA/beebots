// Talking to one's agent. It looks at real market candles and answers: short for small talk, a full report with charts and
// figures when asked for a view. Read-only: it cannot trade or change anything from here. Each question counts against the plan's
// daily messages. The conversation is kept in the member's own database.
import { useCallback, useEffect, useRef, useState } from "react";
import { arena } from "./arenaApi";
import type { ChatMsg } from "./arenaChart";
import { ArenaReport } from "./ArenaReport";
import { useI18n } from "./i18n/I18n";

const SUGGESTIONS = ["chat.sug1", "chat.sug2", "chat.sug3"] as const;

export function ArenaChat({ id, name }: { id: string; name: string }) {
  const { t } = useI18n();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [open, setOpen] = useState(true);
  const [left, setLeft] = useState<{ used: number; limit: number } | null>(null);
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void arena<{ open: boolean; limit: number; used: number; messages: ChatMsg[] }>("GET", `bots/chat?id=${encodeURIComponent(id)}`)
      .then((r) => {
        if (!live) return;
        if (r.status === 200) {
          setMsgs(r.data.messages);
          setOpen(r.data.open);
          setLeft({ used: r.data.used, limit: r.data.limit });
        }
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [id]);
  useEffect(() => end.current?.scrollIntoView?.({ block: "end", behavior: "smooth" }), [msgs.length, waiting]);

  const send = useCallback(
    async (q: string) => {
      const asked = q.trim();
      if (!asked || waiting) return;
      setError("");
      setWaiting(asked);
      setText("");
      try {
        const r = await arena<{ message: ChatMsg; used: number; limit: number }>("POST", "bots/chat/send", { id, text: asked });
        if (r.status === 200) {
          const list = await arena<{ messages: ChatMsg[] }>("GET", `bots/chat?id=${encodeURIComponent(id)}`);
          setMsgs(list.status === 200 ? list.data.messages : (m) => [...m, r.data.message]);
          setLeft({ used: r.data.used, limit: r.data.limit });
        } else {
          setText(asked);
          setError(r.data.code === "chat_limit" ? t("chat.limit") : r.data.code === "chat_busy" ? t("chat.busy") : r.data.code === "chat_closed" ? t("chat.closed") : r.data.code === "no_key" ? t("chat.noKey") : t("chat.failed"));
        }
      } catch {
        setText(asked);
        setError(t("common.down"));
      } finally {
        setWaiting(null);
      }
    },
    [id, waiting, t],
  );

  const clear = async () => {
    const r = await arena("POST", "bots/chat/clear", { id });
    if (r.status === 200) setMsgs([]);
  };
  const out = left !== null && left.used >= left.limit;

  return (
    <div className="ct">
      <p className="dim small">{t("chat.intro", { name })}</p>
      {!open && <p className="bad small">{t("chat.closed")}</p>}
      <div className="ct-log" aria-live="polite">
        {loaded && msgs.length === 0 && !waiting && (
          <div className="ct-empty">
            <p className="small">{t("chat.try")}</p>
            <div className="ct-sugs">
              {SUGGESTIONS.map((k) => (
                <button key={k} className="pbtn ghost" disabled={!open || out} onClick={() => void send(t(k))}>
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`ct-msg ${m.role}`}>
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
        <span>{left ? t("chat.left", { n: Math.max(0, left.limit - left.used), max: left.limit }) : ""}</span>
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
