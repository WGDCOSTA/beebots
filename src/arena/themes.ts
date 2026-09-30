// Theme categories and their avatars, as data: a new pack is a new entry here, no other code changes. Avatars are
// generic archetypes on purpose (a knight, a masked vigilante, a robot), never known characters or real people, so no
// pack ships someone else's trademark. Art is a glyph and a colour for now; painted portraits replace the glyphs later.
import type { Tier } from "./store.js";

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
  /** Packs marked pro are for Pro members only. */
  tier: Tier;
  avatars: Avatar[];
}

const a = (id: string, label: string, glyph: string, color: string): Avatar => ({ id, label, glyph, color });

export const THEMES: Theme[] = [
  {
    id: "bunnies",
    label: "Bunnies",
    blurb: "The original Warren.",
    tier: "free",
    avatars: [a("scout", "Scout", "🐰", "#f5a524"), a("hopper", "Hopper", "🐇", "#7dd3fc"), a("burrower", "Burrower", "🥕", "#fb923c"), a("moon", "Moon bunny", "🌙", "#a78bfa")],
  },
  {
    id: "cats",
    label: "Cats",
    blurb: "Patient hunters.",
    tier: "free",
    avatars: [a("tabby", "Tabby", "🐱", "#f59e0b"), a("panther", "Panther", "🐈‍⬛", "#94a3b8"), a("lynx", "Lynx", "🐆", "#eab308"), a("lion", "Lion", "🦁", "#f97316")],
  },
  {
    id: "dogs",
    label: "Dogs",
    blurb: "Loyal and relentless.",
    tier: "free",
    avatars: [a("retriever", "Retriever", "🐶", "#fbbf24"), a("husky", "Husky", "🐺", "#93c5fd"), a("hound", "Hound", "🦮", "#d97706"), a("pup", "Pup", "🐕", "#fca5a5")],
  },
  {
    id: "robots",
    label: "Robots",
    blurb: "Cold, exact, tireless.",
    tier: "free",
    avatars: [a("unit", "Unit", "🤖", "#67e8f9"), a("drone", "Drone", "🛸", "#a5b4fc"), a("core", "Core", "⚙️", "#cbd5e1"), a("circuit", "Circuit", "🔌", "#86efac")],
  },
  {
    id: "zombies",
    label: "Zombies",
    blurb: "They never stop.",
    tier: "pro",
    avatars: [a("walker", "Walker", "🧟", "#86efac"), a("grave", "Gravekeeper", "🪦", "#a3a3a3"), a("bones", "Bones", "💀", "#e5e5e5"), a("ghoul", "Ghoul", "👻", "#c4b5fd")],
  },
  {
    id: "gods",
    label: "Gods",
    blurb: "Original deities of markets and storms.",
    tier: "pro",
    avatars: [a("storm", "Storm lord", "⚡", "#fde047"), a("sun", "Sun king", "☀️", "#fbbf24"), a("tide", "Tide mother", "🌊", "#38bdf8"), a("forge", "Forge father", "🔥", "#f87171")],
  },
  {
    id: "heroes",
    label: "Heroes",
    blurb: "Archetypes, never known characters.",
    tier: "pro",
    avatars: [a("knight", "Knight", "🛡️", "#93c5fd"), a("ranger", "Ranger", "🏹", "#86efac"), a("mage", "Mage", "🪄", "#c084fc"), a("vigilante", "Vigilante", "🦇", "#94a3b8")],
  },
  {
    id: "memes",
    label: "Memes",
    blurb: "Original jokes, no borrowed faces.",
    tier: "pro",
    avatars: [a("diamond", "Diamond hands", "💎", "#67e8f9"), a("rocket", "To the moon", "🚀", "#fca5a5"), a("clown", "Clown market", "🤡", "#fdba74"), a("frog", "Frog", "🐸", "#86efac")],
  },
];

const BY_ID = new Map(THEMES.map((t) => [t.id, t]));

export const themeById = (id: string): Theme | undefined => BY_ID.get(id);
export const avatarOf = (themeId: string, avatarId: string): Avatar | undefined => BY_ID.get(themeId)?.avatars.find((x) => x.id === avatarId);
