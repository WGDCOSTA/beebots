// The only door between the bees and outside MCP servers, and it is a narrow one:
//   - servers are the owner's (Admin), reached over https (or localhost) with a header token that never leaves the server;
//   - a bee can call only the tools the owner granted to it by name, and a tool that is not proven read-only needs the
//     owner's explicit confirmation before it can be granted at all;
//   - calls are capped per server per UTC day, time out, and their output is cut, stripped of control characters and
//     handed on as DATA (it may contain instructions or lies; nothing here ever executes or obeys it);
//   - every call is logged (bee, server, tool, arguments, size, time, outcome).
// Only research uses it (brains/research.ts); it never touches Jev, the risk layer or an order.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { log } from "../log.js";
import { safeError } from "../redact.js";

export interface ToolInfo {
  name: string;
  description: string;
  /** The server's own claim (annotations.readOnlyHint). Not trusted: it only saves the owner a confirmation. */
  readOnly: boolean | null;
  inputSchema: Record<string, unknown>;
}

export interface McpServerDef {
  id: string;
  label: string;
  url: string;
  transport: "http" | "sse";
  authHeader: string;
  token?: string | undefined;
  maxCallsDay: number;
  tools: ToolInfo[];
  grants: Array<{ tool: string; bees: string[]; confirmed?: boolean | undefined }>;
}

export interface McpConn {
  listTools(): Promise<ToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}
export type McpConnect = (s: Pick<McpServerDef, "url" | "transport" | "authHeader" | "token">) => Promise<McpConn>;

export const LIMITS = { connectMs: 15_000, callMs: 20_000, outputChars: 4000, argChars: 1000, argString: 300, argDepth: 3, callsPerResearch: 3, logKept: 300 };

/** Tool names that suggest a write or an action. Never proof either way: they only add a confirmation step. */
const ACTION_NAME = /(^|[_\-.])(send|post|write|delete|remove|create|update|edit|transfer|pay|buy|sell|order|trade|withdraw|deposit|execute|run|exec|set|publish|submit|cancel|approve|sign|commit|push|kill)([_\-.]|$)/i;
export const looksLikeAction = (name: string): boolean => ACTION_NAME.test(name);

/** What the owner must confirm before granting this tool: the server did not claim read-only, or the name says action. */
export const needsConfirmation = (t: Pick<ToolInfo, "name" | "readOnly">): boolean => t.readOnly !== true || looksLikeAction(t.name);

const headerValue = (authHeader: string, token: string): string => (authHeader.toLowerCase() === "authorization" && !/^\w+\s/.test(token) ? `Bearer ${token}` : token);

/** The real connection, through the official MCP SDK. One connection per call: nothing stays open. */
export const sdkConnect: McpConnect = async (s) => {
  const headers: Record<string, string> = s.token ? { [s.authHeader]: headerValue(s.authHeader, s.token) } : {};
  const url = new URL(s.url);
  const transport: Transport =
    s.transport === "sse"
      ? new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }) } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: "beebots", version: "1.0.0" }, { capabilities: {} });
  const timer = AbortSignal.timeout(LIMITS.connectMs);
  await Promise.race([client.connect(transport), new Promise<never>((_, rej) => timer.addEventListener("abort", () => rej(new Error("connection timed out")), { once: true }))]).catch(async (err) => {
    await client.close().catch(() => undefined);
    throw err;
  });
  return {
    async listTools() {
      const out: ToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await client.listTools(cursor ? { cursor } : {}, { timeout: LIMITS.connectMs });
        for (const t of r.tools) out.push({ name: t.name, description: (t.description ?? "").slice(0, 600), readOnly: t.annotations?.readOnlyHint ?? null, inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> });
        cursor = r.nextCursor;
        if (!cursor) break;
      }
      return out.slice(0, 100);
    },
    async callTool(name, args, timeoutMs) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
      const parts = (Array.isArray(r.content) ? r.content : []) as Array<{ type: string; text?: string }>;
      const text = parts.map((p) => (p.type === "text" ? String(p.text ?? "") : `[${p.type} omitted]`)).join("\n");
      return { text, isError: !!r.isError };
    },
    close: () => client.close().catch(() => undefined),
  };
};

/** Control, zero-width and bidi-override characters: they hide text from a human reader while a model still reads it. */
function invisible(code: number): boolean {
  if (code === 9 || code === 10) return false;
  return code < 32 || code === 127 || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** Strip what could confuse a terminal or a prompt reader, keep the words, cut to a size. */
export function sanitize(text: string, max = LIMITS.outputChars, secret?: string): { text: string; truncated: boolean } {
  let t = text.replace(/\r\n?/g, "\n");
  t = Array.from(t)
    .filter((ch) => !invisible(ch.codePointAt(0)!))
    .join("");
  if (secret && secret.length >= 6) t = t.split(secret).join("[redacted]");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? { text: `${t.slice(0, max)}…`, truncated: true } : { text: t, truncated: false };
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * A model's tool arguments, checked before they leave: an object of plain values, small, shallow, and (when the tool
 * publishes a JSON schema) carrying its required fields with the right basic types. The server validates again.
 */
export function checkArgs(schema: Record<string, unknown>, raw: string): { ok: true; args: Record<string, Json> } | { ok: false; error: string } {
  if (raw.length > LIMITS.argChars) return { ok: false, error: `arguments too long (max ${LIMITS.argChars} characters)` };
  let v: unknown;
  try {
    v = JSON.parse(raw || "{}");
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "arguments must be a JSON object" };
  const walk = (x: unknown, depth: number): string | null => {
    if (depth > LIMITS.argDepth) return "arguments nested too deep";
    if (typeof x === "string") return x.length > LIMITS.argString ? `a text argument is over ${LIMITS.argString} characters` : null;
    if (x === null || typeof x === "number" || typeof x === "boolean") return null;
    if (Array.isArray(x)) return x.length > 20 ? "a list argument is over 20 items" : (x.map((i) => walk(i, depth + 1)).find(Boolean) ?? null);
    if (typeof x === "object") {
      for (const k of Object.keys(x as object)) if (k === "__proto__" || k === "constructor" || k === "prototype") return `argument name "${k}" is not allowed`;
      return Object.values(x as object).map((i) => walk(i, depth + 1)).find(Boolean) ?? null;
    }
    return "arguments must be plain values";
  };
  const bad = walk(v, 1);
  if (bad) return { ok: false, error: bad };
  const obj = v as Record<string, Json>;
  const props = (schema.properties ?? {}) as Record<string, { type?: string }>;
  for (const k of Array.isArray(schema.required) ? (schema.required as string[]) : []) if (!(k in obj)) return { ok: false, error: `missing required argument "${k}"` };
  for (const [k, val] of Object.entries(obj)) {
    const t = props[k]?.type;
    if (!t) continue;
    const actual = Array.isArray(val) ? "array" : val === null ? "null" : typeof val === "number" && Number.isInteger(val) && t === "integer" ? "integer" : typeof val;
    const okType = t === "number" ? typeof val === "number" : t === actual || (t === "integer" && Number.isInteger(val));
    if (!okType) return { ok: false, error: `argument "${k}" should be ${t}` };
  }
  return { ok: true, args: obj };
}

export interface CallLog {
  at: number;
  bee: string;
  server: string;
  tool: string;
  args: string;
  ok: boolean;
  bytes: number;
  ms: number;
  note: string;
}

export interface McpResult {
  ok: boolean;
  text: string;
  truncated: boolean;
  note: string;
}

export class McpError extends Error {}

export interface GatewayOpts {
  servers: () => McpServerDef[];
  /** <LAB_DIR>/mcp.json: today's call counts and the call log. */
  path: string;
  connect?: McpConnect;
  now?: () => number;
}

interface Book {
  day: string;
  counts: Record<string, number>;
  log: CallLog[];
}

export class McpGateway {
  private connect: McpConnect;
  private now: () => number;

  constructor(private o: GatewayOpts) {
    this.connect = o.connect ?? sdkConnect;
    this.now = o.now ?? Date.now;
  }

  private read(): Book {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    try {
      if (existsSync(this.o.path)) {
        const b = JSON.parse(readFileSync(this.o.path, "utf8")) as Book;
        return { day, counts: b.day === day ? (b.counts ?? {}) : {}, log: b.log ?? [] };
      }
    } catch {
      /* start fresh */
    }
    return { day, counts: {}, log: [] };
  }

  private write(b: Book): void {
    mkdirSync(dirname(this.o.path), { recursive: true });
    writeFileSync(`${this.o.path}.tmp`, JSON.stringify({ ...b, log: b.log.slice(-LIMITS.logKept) }));
    renameSync(`${this.o.path}.tmp`, this.o.path);
  }

  usedToday(): Record<string, number> {
    return this.read().counts;
  }

  recent(n = 30): CallLog[] {
    return this.read().log.slice(-n).reverse();
  }

  /** The tools this bee may call: granted to it (or to all), still offered by the server, and confirmed if they needed it. */
  granted(bee: string): Array<{ server: string; serverLabel: string; tool: string; description: string; inputSchema: Record<string, unknown>; left: number }> {
    const used = this.usedToday();
    const out: ReturnType<McpGateway["granted"]> = [];
    for (const s of this.o.servers()) {
      const left = s.maxCallsDay - (used[s.id] ?? 0);
      for (const g of s.grants) {
        if (!g.bees.includes("all") && !g.bees.includes(bee)) continue;
        const t = s.tools.find((x) => x.name === g.tool);
        if (!t || (needsConfirmation(t) && !g.confirmed)) continue;
        out.push({ server: s.id, serverLabel: s.label, tool: t.name, description: t.description, inputSchema: t.inputSchema, left });
      }
    }
    return out;
  }

  /** Connect and list what the server offers (Admin: save and refresh). */
  async discover(s: Pick<McpServerDef, "url" | "transport" | "authHeader" | "token">): Promise<ToolInfo[]> {
    const c = await this.connect(s);
    try {
      return await c.listTools();
    } finally {
      await c.close();
    }
  }

  /** One granted call. Never throws for a refusal or a failing server: the answer says why, and it is logged. */
  async call(bee: string, serverId: string, tool: string, args: Record<string, unknown>): Promise<McpResult> {
    const s = this.o.servers().find((x) => x.id === serverId);
    const started = this.now();
    const book = this.read();
    const record = (ok: boolean, bytes: number, note: string) => {
      book.log.push({ at: started, bee, server: serverId, tool, args: JSON.stringify(args).slice(0, 200), ok, bytes, ms: this.now() - started, note });
      this.write(book);
    };
    const refuse = (note: string): McpResult => {
      record(false, 0, note);
      return { ok: false, text: "", truncated: false, note };
    };
    if (!s) return refuse("no such server");
    if (!this.granted(bee).some((g) => g.server === serverId && g.tool === tool)) return refuse("that tool is not granted to this bee");
    if ((book.counts[serverId] ?? 0) >= s.maxCallsDay) return refuse(`the daily cap of ${s.maxCallsDay} calls for ${s.label} is used up`);
    book.counts[serverId] = (book.counts[serverId] ?? 0) + 1;
    let conn: McpConn | null = null;
    try {
      conn = await this.connect(s);
      const r = await conn.callTool(tool, args, LIMITS.callMs);
      const clean = sanitize(r.text, LIMITS.outputChars, s.token);
      record(!r.isError, r.text.length, r.isError ? "the tool reported an error" : clean.truncated ? "output cut" : "");
      return { ok: !r.isError, text: clean.text, truncated: clean.truncated, note: r.isError ? "the tool reported an error" : "" };
    } catch (err) {
      const msg = safeError(err).message.slice(0, 200);
      log.warn("mcp: call failed", { server: serverId, tool, err: msg });
      record(false, 0, msg);
      return { ok: false, text: "", truncated: false, note: msg };
    } finally {
      await conn?.close();
    }
  }
}
