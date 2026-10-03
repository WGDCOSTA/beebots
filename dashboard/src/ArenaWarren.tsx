// The Warren: members' agents in public. Listed agents post their closed trades with the result, their milestones and new
// versions; two members' agents that took opposite sides of one coin are paired as a rivalry. Anyone reads it; members
// follow agents and cheer posts. Results only: open positions and rules never appear here, as on the leaderboard.
import { useCallback, useEffect, useState } from "react";
import { arena } from "./arenaApi";
import { fmtUsd } from "./arenaModel";
import { Portrait, type Catalogue } from "./ArenaParts";
import { useAgo } from "./ArenaDecisions";
import { useI18n } from "./i18n/I18n";

const REACTIONS = [
  ["carrot", "🥕"],
  ["fire", "🔥"],
  ["eyes", "👀"],
  ["clap", "👏"],
] as const;
type Reaction = (typeof REACTIONS)[number][0];

interface Card {
  botId: string;
  name: string;
  avatar: string;
  theme: string;
  handle: string;
  image: boolean;
}
interface Post {
  id: number;
  ts: number;
  kind: "closed" | "milestone" | "version" | "rivalry";
  agent: Card;
  other: Card | null;
  data: Record<string, number | string | null>;
  reactions: Record<Reaction, number>;
  mine: Reaction[];
  following: boolean;
  own: boolean;
}

export function ArenaWarren({ signedIn }: { signedIn: boolean }) {
  const { t, locale } = useI18n();
  const ago = useAgo();
  const [filter, setFilter] = useState<"all" | "following">("all");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [following, setFollowing] = useState<string[]>([]);
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(
    async (before?: number) => {
      try {
        const r = await arena<{ posts: Post[]; following: string[] }>("GET", `social?filter=${filter}${before ? `&before=${before}` : ""}`);
        if (r.status !== 200) return setError(r.data.error ?? t("common.down"));
        setPosts((p) => (before && p ? [...p, ...r.data.posts] : r.data.posts));
        setFollowing(r.data.following);
        setMore(r.data.posts.length >= 30);
      } catch {
        setError(t("common.down"));
      }
    },
    [filter, t],
  );
  useEffect(() => {
    setPosts(null);
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    void fetch("/arena/catalogue").then((r) => r.json() as Promise<Catalogue>).then(setCat).catch(() => {});
  }, []);

  const react = async (p: Post, kind: Reaction) => {
    if (!signedIn) return setError(t("warren.signIn"));
    const r = await arena<{ reactions: Record<Reaction, number> }>("POST", "social/react", { post: p.id, kind });
    if (r.status === 200) setPosts((list) => list?.map((x) => (x.id === p.id ? { ...x, reactions: r.data.reactions, mine: x.mine.includes(kind) ? x.mine.filter((k) => k !== kind) : [...x.mine, kind] } : x)) ?? null);
  };
  const follow = async (botId: string, on: boolean) => {
    if (!signedIn) return setError(t("warren.signIn"));
    const r = await arena<{ following: string[] }>("POST", "social/follow", { bot: botId, on });
    if (r.status === 200) setFollowing(r.data.following);
  };

  const pnl = (v: unknown) => <strong className={Number(v) >= 0 ? "good" : "bad"}>{fmtUsd(Number(v), locale, true)}</strong>;
  const side = (s: unknown) => t(s === "short" ? "side.short" : "side.long");
  const what = (p: Post) => {
    const d = p.data;
    if (p.kind === "closed") return t("warren.closed", { side: side(d.side), coin: String(d.coin) });
    if (p.kind === "milestone") return t(Number(d.pct) >= 0 ? "warren.milestoneUp" : "warren.milestoneDown", { pct: Math.abs(Number(d.pct)) });
    if (p.kind === "version") return t("warren.version", { v: String(d.version) });
    return t("warren.rivalry", { coin: String(d.coin), other: p.other?.name ?? "?" });
  };

  return (
    <div className="wr">
      <div className="arena-who">
        <h1 className="as-title">{t("warren.title")}</h1>
        <span className="dim small">{t("warren.sub")}</span>
      </div>
      <div className="wr-filter seg" role="group" aria-label={t("warren.title")}>
        {(["all", "following"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} aria-pressed={filter === f} onClick={() => (f === "following" && !signedIn ? setError(t("warren.signIn")) : setFilter(f))}>
            {t(f === "all" ? "warren.all" : "warren.following")}
          </button>
        ))}
      </div>
      {error && <p className="bad small">{error}</p>}
      {posts === null ? (
        <div className="pcard arena-card dim">{t("common.loading")}</div>
      ) : posts.length === 0 ? (
        <div className="pcard arena-card dim">{t(filter === "following" ? "warren.emptyFollowing" : "warren.empty")}</div>
      ) : (
        <ol className="wr-list">
          {posts.map((p) => {
            const isFollowing = following.includes(p.agent.botId);
            return (
              <li key={p.id} className={`pcard arena-card wr-post k-${p.kind}`}>
                <div className="wr-top">
                  {cat && <Portrait cat={cat} theme={p.agent.theme} avatar={p.agent.avatar} size={40} />}
                  <div className="wr-who">
                    <strong>{p.agent.name}</strong>
                    <span className="dim small">
                      {p.own ? t("warren.you") : t("warren.by", { handle: p.agent.handle })} · {ago(p.ts)}
                    </span>
                  </div>
                  {!p.own && (
                    <button className={`pbtn ghost small wr-follow ${isFollowing ? "on" : ""}`} aria-pressed={isFollowing} onClick={() => void follow(p.agent.botId, !isFollowing)}>
                      {isFollowing ? t("warren.unfollow") : t("warren.follow")}
                    </button>
                  )}
                </div>
                <p className="wr-text">
                  {what(p)}
                  {p.kind === "closed" && <> {pnl(p.data.pnlUsd)}</>}
                  {p.kind === "milestone" && <> ({String(p.data.now)}%)</>}
                </p>
                {p.kind === "rivalry" && p.other && (
                  <div className="wr-vs">
                    <span>
                      {p.agent.name} · {side(p.data.side)} {pnl(p.data.pnlUsd)}
                    </span>
                    <span className="wr-vs-mark">vs</span>
                    <span>
                      {p.other.name} · {side(p.data.otherSide)} {pnl(p.data.otherPnlUsd)}
                    </span>
                  </div>
                )}
                <div className="wr-reacts">
                  {REACTIONS.map(([k, emoji]) => (
                    <button key={k} className={`wr-react ${p.mine.includes(k) ? "on" : ""}`} aria-pressed={p.mine.includes(k)} aria-label={t(`warren.react.${k}` as const)} onClick={() => void react(p, k)}>
                      {emoji} {p.reactions[k] > 0 ? <span className="num">{p.reactions[k]}</span> : null}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {more && posts && posts.length > 0 && (
        <button className="pbtn ghost" onClick={() => void load(posts[posts.length - 1]!.id)}>
          {t("warren.more")}
        </button>
      )}
    </div>
  );
}
