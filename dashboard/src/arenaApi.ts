// The Arena's HTTP API as the pages use it.
import type { Locale } from "./i18n/locales";

export interface Member {
  id: string;
  email: string;
  handle: string;
  tier: "free" | "pro";
  locale: Locale;
  createdAt: number;
}

export interface Limits {
  bots: number;
  maxCoins: number;
  styles: string[];
  proThemes: boolean;
}

export interface ConsentState {
  needed: boolean;
  version: string;
}

export async function arena<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: T & { error?: string; code?: string } }> {
  const r = await fetch(`/arena/${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json", "x-arena": "1" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string; code?: string } };
}
