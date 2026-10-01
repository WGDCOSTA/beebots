// Small pieces the Arena's agent screens share: the portrait, the little equity curve, the state pill, and the data they read.
import { useCallback, useEffect, useState } from "react";
import { arena, type Limits } from "./arenaApi";
import { sparkPath, statePill, type AgentState, type BotDraft, type RunStatus } from "./arenaModel";
import { useI18n } from "./i18n/I18n";

export interface Avatar {
  id: string;
  label: string;
  glyph: string;
  color: string;
}
export interface Theme {
  id: string;
  label: string;
  blurb: string;
  tier: "free" | "pro";
  avatars: Avatar[];
}
export interface Catalogue {
  themes: Theme[];
  coins: string[];
}
export interface Agent extends BotDraft {
  id: string;
  image: boolean;
  state: AgentState;
  quarantinedAt: number | null;
  brainKey: string | null;
  version: number;
  createdAt: number;
}
export interface AiStatus {
  enabled: boolean;
  designsLeft: number;
  portraitsLeft: number;
  canDesign: boolean;
  portraitBotId: string | null;
}
export interface KeyView {
  id: string;
  provider: string;
  label: string;
  model: string;
  last4: string;
  dailyUsd: number | null;
  createdAt: number;
}
export interface KeysState {
  open: boolean;
  max: number;
  providers: Array<{ id: string; model: string }>;
  keys: KeyView[];
}

export interface Template extends BotDraft {
  id: string;
  kind: "steady" | "breakout" | "momentum";
  pro: boolean;
}

export interface ArenaData {
  cat: Catalogue;
  agents: Agent[];
  runner: { enabled: boolean; runs: Record<string, RunStatus> };
  curves: Record<string, number[]>;
  ai: AiStatus | null;
  templates: Template[];
  keys: KeysState;
  reload: () => Promise<void>;
}

/** Loads the member's agents with their running state, and looks again every 15 seconds while a screen is open. */
export function useArenaData(): { data: ArenaData | null; error: "load" | "down" | null } {
  const [data, setData] = useState<Omit<ArenaData, "reload"> | null>(null);
  const [error, setError] = useState<"load" | "down" | null>(null);
  const load = useCallback(async () => {
    try {
      const [c, b, a, t, k] = await Promise.all([
        arena<Catalogue>("GET", "catalogue"),
        arena<{ bots: Agent[]; curves: Record<string, number[]>; runner: ArenaData["runner"] }>("GET", "bots"),
        arena<AiStatus>("GET", "ai/status"),
        arena<{ templates: Template[] }>("GET", "templates"),
        arena<KeysState>("GET", "keys"),
      ]);
      if (c.status === 200 && b.status === 200) {
        setData({ cat: c.data, agents: b.data.bots, runner: b.data.runner, curves: b.data.curves ?? {}, ai: a.status === 200 ? a.data : null, templates: t.data.templates ?? [], keys: k.status === 200 ? k.data : { open: false, max: 5, providers: [], keys: [] } });
        setError(null);
      } else setError("load");
    } catch {
      setError("down");
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);
  return { data: data ? { ...data, reload: load } : null, error };
}

export type { Limits };

export function Portrait({ cat, theme, avatar, size = 44, botId }: { cat: Catalogue; theme: string; avatar: string; size?: number; botId?: string }) {
  const a = cat.themes.find((t) => t.id === theme)?.avatars.find((x) => x.id === avatar);
  if (botId) return <img className="ab-portrait ab-photo" src={`/arena/bot-image/${botId}`} width={size} height={size} alt="" />;
  return (
    <span className="ab-portrait" style={{ width: size, height: size, fontSize: size * 0.55, ["--av" as string]: a?.color ?? "#888" }} aria-hidden>
      {a?.glyph ?? "?"}
    </span>
  );
}

/** A small curve of an agent's paper account. Decorative: the numbers beside it say the same thing. */
export function Spark({ values, w = 120, h = 36, tone = "flat" }: { values: number[]; w?: number; h?: number; tone?: "good" | "bad" | "flat" }) {
  const d = sparkPath(values, w, h, 2, (values[0] ?? 0) * 0.01);
  if (!d) return <span className="ag-spark empty" style={{ width: w, height: h }} aria-hidden />;
  return (
    <svg className={`ag-spark ${tone}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={d} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function StatePill({ enabled, state, run }: { enabled: boolean; state: AgentState; run: RunStatus | undefined }) {
  const { t } = useI18n();
  const p = statePill(enabled, state, run);
  return <span className={`ag-pill ${p.tone}`}>{t(p.key)}</span>;
}
