import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANTHROPIC_PROFILE, anthropicConfigDir, checkClaudeKey, hasAnthropicLogin } from "../src/brains/llm.js";
import { brainCreds, parseEnv } from "../src/config.js";

const saved = { dir: process.env.ANTHROPIC_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
afterEach(() => {
  for (const [k, v] of [["ANTHROPIC_CONFIG_DIR", saved.dir], ["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_BASE_URL", saved.base]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** What `ant --profile beebots auth login` leaves behind: a user_oauth config and a 0600 credentials file. */
function signIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "anthropic-"));
  mkdirSync(join(dir, "configs"));
  mkdirSync(join(dir, "credentials"));
  writeFileSync(join(dir, "configs", `${ANTHROPIC_PROFILE}.json`), JSON.stringify({ version: "1.0", authentication: { type: "user_oauth" } }));
  const cred = join(dir, "credentials", `${ANTHROPIC_PROFILE}.json`);
  writeFileSync(cred, JSON.stringify({ version: "1.0", type: "oauth_token", access_token: "sk-ant-oat-test-token", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  chmodSync(cred, 0o600);
  return dir;
}

describe("Claude through an Anthropic Console sign-in", () => {
  it("finds the profile ant writes, and uses it only when no key is set", () => {
    const dir = signIn();
    const env = parseEnv({}) as Parameters<typeof brainCreds>[0];
    process.env.ANTHROPIC_CONFIG_DIR = dir;
    expect(anthropicConfigDir()).toBe(dir);
    expect(hasAnthropicLogin()).toBe(true);
    expect(brainCreds(env, null).claude).toMatchObject({ profile: ANTHROPIC_PROFILE });
    expect(brainCreds(env, null).claude?.apiKey).toBeUndefined();
    // A key wins over the sign-in.
    expect(brainCreds({ ...env, ANTHROPIC_API_KEY: "sk-ant-key-123456" }, null).claude).toMatchObject({ apiKey: "sk-ant-key-123456" });
    expect(brainCreds({ ...env, ANTHROPIC_API_KEY: "sk-ant-key-123456" }, null).claude?.profile).toBeUndefined();
    // No sign-in, no key: no Claude brain.
    process.env.ANTHROPIC_CONFIG_DIR = mkdtempSync(join(tmpdir(), "anthropic-empty-"));
    expect(hasAnthropicLogin()).toBe(false);
    expect(brainCreds(env, null).claude).toBeUndefined();
  });

  it("calls the API with the OAuth token, not a blank key from the environment", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      process.env.ANTHROPIC_CONFIG_DIR = signIn();
      // Never the real API from a test.
      process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // docker compose passes "" for an unset key: it must not shadow the sign-in.
      process.env.ANTHROPIC_API_KEY = "";
      expect(await checkClaudeKey({ profile: ANTHROPIC_PROFILE })).toBeNull();
      expect(seen[0]?.authorization).toBe("Bearer sk-ant-oat-test-token");
      expect(seen[0]?.["x-api-key"]).toBeUndefined();
      expect(String(seen[0]?.["anthropic-beta"])).toContain("oauth-2025-04-20");
    } finally {
      server.close();
    }
  });

  it("explains how to sign in when there is no sign-in yet", async () => {
    process.env.ANTHROPIC_CONFIG_DIR = mkdtempSync(join(tmpdir(), "anthropic-none-"));
    expect(await checkClaudeKey({ profile: ANTHROPIC_PROFILE })).toMatch(/ant --profile beebots auth login/);
  });
});
