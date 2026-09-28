// Read-only check of one bee's OKX account before it is created or its keys change (admin panel): the keys work,
// they can trade and cannot withdraw, they belong to a sub-account, and it holds enough USDC for the bee's wallet.
// No orders, no transfers. Returns sanitised facts only: never a key, UID, label or IP (the UID leaves as a hash, so
// two bees on the same account can be caught without storing it).
import { createHash } from "node:crypto";
import type { OkxCreds } from "../config.js";
import { safeError } from "../redact.js";
import type { OkxCli } from "./cli.js";

export interface AccountFacts {
  /** The keys answered. */
  ok: boolean;
  kind: "demo" | "live";
  perms: string[];
  canTrade: boolean;
  canWithdraw: boolean;
  subAccount: boolean;
  ipBound: boolean;
  /** USDC equity on the trading account (null when unreadable). */
  usdcUsd: number | null;
  /** sha256 of the account UID, to spot two bees on one account. */
  uidHash: string | null;
  /** What blocks creating the bee with these keys ([] = good to go). */
  problems: string[];
  /** Worth knowing, not blocking. */
  warnings: string[];
}

type Row = Record<string, string>;

/** Why OKX refused, in words an owner can act on. */
export function okxHint(code: string, message: string): string {
  if (code === "50110" || /\bip\b/i.test(message)) return "OKX refused this machine's IP: add the server's IP to the key's IP list.";
  if (code === "50119") return "Wrong site for this key: EEA keys only work on eea.okx.com.";
  if (code === "50111" || code === "50113" || code === "50105") return "The API key, secret or passphrase is wrong.";
  if (code === "50101") return "Demo/live mismatch: this key belongs to the other environment.";
  return `OKX said: ${message}`;
}

export async function checkOkxAccount(cli: OkxCli, creds: OkxCreds, kind: "demo" | "live", walletUsd: number): Promise<AccountFacts> {
  const facts: AccountFacts = { ok: false, kind, perms: [], canTrade: false, canWithdraw: false, subAccount: false, ipBound: false, usdcUsd: null, uidHash: null, problems: [], warnings: [] };
  const run = <T>(args: string[]) => cli.run<T>({ args, creds, demo: kind === "demo" });
  let cfg: Row | undefined;
  try {
    [cfg] = await run<Row[]>(["account", "config"]);
  } catch (err) {
    const e = safeError(err);
    facts.problems.push(okxHint(e.code, e.message));
    return facts;
  }
  if (!cfg) {
    facts.problems.push("OKX returned no account configuration for these keys.");
    return facts;
  }
  facts.ok = true;
  facts.perms = (cfg.perm ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  facts.canTrade = facts.perms.includes("trade");
  facts.canWithdraw = facts.perms.some((x) => /withdraw/i.test(x));
  facts.subAccount = !!cfg.uid && !!cfg.mainUid && cfg.uid !== cfg.mainUid;
  facts.ipBound = (cfg.ip ?? "").split(",").some((x) => x.trim());
  facts.uidHash = cfg.uid ? createHash("sha256").update(`beebots:${cfg.uid}`).digest("hex").slice(0, 32) : null;
  try {
    const [bal] = await run<Array<{ details?: Row[] }>>(["account", "balance", "USDC"]);
    const d = bal?.details?.find((x) => x.ccy === "USDC");
    facts.usdcUsd = d ? Number(d.eq || 0) : 0;
  } catch (err) {
    facts.problems.push(`The USDC balance could not be read (${safeError(err).code}).`);
  }
  if (facts.canWithdraw) facts.problems.push("The key has Withdraw permission: create a key with Read + Trade only.");
  if (!facts.canTrade) facts.problems.push("The key has no Trade permission: the bee could not place orders.");
  if (!facts.subAccount) facts.problems.push("These keys belong to the main account: give each bee its own sub-account.");
  if (facts.usdcUsd !== null && !(facts.usdcUsd >= walletUsd))
    facts.problems.push(`The account holds $${facts.usdcUsd.toFixed(2)} USDC, less than the bee's $${walletUsd.toFixed(2)} wallet. Fund the sub-account first.`);
  if (kind === "live" && !facts.ipBound) facts.warnings.push("The key is not IP-bound: OKX expires unbound Trade keys after 14 idle days. Bind it to the server's IP.");
  if (cfg.posMode && cfg.posMode !== "net_mode") facts.warnings.push(`Position mode is ${cfg.posMode}; the engine switches it to net_mode.`);
  return facts;
}
