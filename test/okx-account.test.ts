// The read-only account check a bee must pass before it is created (okx/account.ts).
import { describe, expect, it } from "vitest";
import { OkxCliError, type CliCall, type OkxCli } from "../src/okx/cli.js";
import { checkOkxAccount } from "../src/okx/account.js";

const creds = { apiKey: "k-123456789", secretKey: "s-123456789", passphrase: "p" };

function fakeCli(cfg: Record<string, string> | Error, usdc: string | Error = "1000"): OkxCli & { calls: CliCall[] } {
  const calls: CliCall[] = [];
  return {
    calls,
    async run<T>(call: CliCall): Promise<T> {
      calls.push(call);
      if (call.args[1] === "config") {
        if (cfg instanceof Error) throw cfg;
        return [cfg] as T;
      }
      if (usdc instanceof Error) throw usdc;
      return [{ details: [{ ccy: "USDC", eq: usdc }] }] as T;
    },
  };
}

const sub = { uid: "222", mainUid: "111", perm: "read_only,trade", ip: "1.2.3.4", posMode: "net_mode" };

describe("checkOkxAccount", () => {
  it("a funded, trade-only sub-account passes, with a hashed UID and no secrets", async () => {
    const cli = fakeCli(sub, "1500.5");
    const f = await checkOkxAccount(cli, creds, "live", 1000);
    expect(f).toMatchObject({ ok: true, canTrade: true, canWithdraw: false, subAccount: true, ipBound: true, usdcUsd: 1500.5, problems: [] });
    expect(f.uidHash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(f)).not.toContain("222");
    expect(cli.calls.every((c) => c.demo === false && c.creds === creds)).toBe(true);
  });

  it("blocks a balance below the wallet, withdraw rights, no trade, and the main account", async () => {
    expect((await checkOkxAccount(fakeCli(sub, "250"), creds, "demo", 1000)).problems.join(" ")).toMatch(/holds \$250\.00 USDC, less than the bee's \$1000\.00 wallet/);
    expect((await checkOkxAccount(fakeCli({ ...sub, perm: "read_only,trade,withdraw" }), creds, "demo", 10)).problems.join(" ")).toMatch(/Withdraw/);
    expect((await checkOkxAccount(fakeCli({ ...sub, perm: "read_only" }), creds, "demo", 10)).problems.join(" ")).toMatch(/no Trade permission/);
    expect((await checkOkxAccount(fakeCli({ ...sub, mainUid: "222" }), creds, "demo", 10)).problems.join(" ")).toMatch(/main account/);
  });

  it("explains refused keys and unreadable balances; warns on unbound live keys", async () => {
    const bad = await checkOkxAccount(fakeCli(new OkxCliError("50111", "Invalid OK-ACCESS-KEY")), creds, "demo", 10);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual(["The API key, secret or passphrase is wrong."]);
    const noBal = await checkOkxAccount(fakeCli(sub, new OkxCliError("50001", "down")), creds, "demo", 10);
    expect(noBal.problems.join(" ")).toMatch(/could not be read \(50001\)/);
    const unbound = await checkOkxAccount(fakeCli({ ...sub, ip: "" }), creds, "live", 10);
    expect(unbound.problems).toEqual([]);
    expect(unbound.warnings.join(" ")).toMatch(/not IP-bound/);
  });
});
