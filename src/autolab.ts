// Autonomous strategy-lab maintenance. Heavy history downloads and tournaments run in a child process so an engine
// tick, stop or reconciliation is never held up by research. The last attempt/success lives in the engine DB, which
// prevents restarts from multiplying public API traffic or repeatedly consuming CPU.
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Db } from "./db.js";
import { log } from "./log.js";
import { safeError } from "./redact.js";

export type AutoLabJob = "ranking" | "scalp";
export type LabCommand = readonly string[];

export interface AutoLabOpts {
  db: Pick<Db, "getMeta" | "setMeta">;
  intervalHours: number;
  scalpIntervalHours: number;
  startDelayMin: number;
  instruments: string[];
  /** A function keeps wildcard universes fresh as volume/risk gates change. */
  scalpCoins: string[] | (() => string[]);
  /** Number of rotating instruments per run. Omit to test the whole fixed list (legacy behaviour). */
  scalpBatchSize?: number;
  /** Instruments with a currently passing rule remain in every batch while the rest rotate. */
  scalpPinned?: () => string[];
  scalpEnabled: boolean;
  run: (args: LabCommand) => Promise<void>;
  /** Runs after the report was written but before the job is marked successful. */
  onScalpReport?: () => Promise<void> | void;
  now?: () => number;
  pollMs?: number;
}

export interface AutoLabState {
  running: AutoLabJob | null;
  ranking: { lastAttemptAt: number | null; lastSuccessAt: number | null; due: boolean };
  scalp: { lastAttemptAt: number | null; lastSuccessAt: number | null; due: boolean };
}

const HOUR = 3_600_000;
const meta = (job: AutoLabJob, what: "attempt" | "success") => `autolab_${job}_${what}_at`;
const SCALP_CURSOR = "autolab_scalp_cursor";
const SCALP_PENDING = "autolab_scalp_pending";

interface ScalpBatch { coins: string[]; rotateCount: number }

export class AutoLab {
  private timer: NodeJS.Timeout | null = null;
  private running: AutoLabJob | null = null;
  private now: () => number;

  constructor(private o: AutoLabOpts) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer || (!this.o.intervalHours && !(this.o.scalpEnabled && this.o.scalpIntervalHours))) return;
    this.timer = setTimeout(() => void this.tick(), this.o.startDelayMin * 60_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  state(at = this.now()): AutoLabState {
    const one = (job: AutoLabJob, hours: number, enabled: boolean) => {
      const lastAttemptAt = this.read(meta(job, "attempt"));
      const lastSuccessAt = this.read(meta(job, "success"));
      return { lastAttemptAt, lastSuccessAt, due: enabled && this.due(job, hours, at) };
    };
    return {
      running: this.running,
      ranking: one("ranking", this.o.intervalHours, this.o.intervalHours > 0),
      scalp: one("scalp", this.o.scalpIntervalHours, this.o.scalpEnabled && this.scalpCoins().length > 0 && this.o.scalpIntervalHours > 0),
    };
  }

  /**
   * Asks for a job sooner than its interval (the lab brain queued new rules). At most once per `minGapHours`, and the
   * usual attempt backoff still applies, so requests can never hammer the exchange or the CPU. Returns whether it took.
   */
  request(job: AutoLabJob, minGapHours = 6, at = this.now()): boolean {
    const key = `autolab_${job}_requested_at`;
    const last = this.read(key) ?? 0;
    if (at - last < minGapHours * HOUR) return false;
    if (job === "scalp" && !(this.o.scalpEnabled && this.o.scalpIntervalHours > 0)) return false;
    this.o.db.setMeta(key, String(at));
    // A success older than any interval makes the job due; the attempt backoff (due()) is untouched.
    this.o.db.setMeta(meta(job, "success"), "1");
    if (this.timer && !this.running) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.tick(), 60_000);
    }
    return true;
  }

  /** Public for a deterministic unit test and an optional future Admin "run now" action. */
  async runDue(at = this.now()): Promise<AutoLabJob[]> {
    if (this.running) return [];
    const done: AutoLabJob[] = [];
    if (this.o.intervalHours > 0 && this.due("ranking", this.o.intervalHours, at)) {
      try {
        await this.runJob("ranking", [
          ["fetch", "--inst", this.o.instruments.join(","), "--bar", "1H", "--days", "365"],
          ["run", "--bar", "1H"],
        ], at);
        done.push("ranking");
      } catch (err) {
        log.warn("autonomous lab job failed", { job: "ranking", err: safeError(err) });
      }
    }
    if (this.o.scalpEnabled && this.scalpCoins().length > 0 && this.o.scalpIntervalHours > 0 && this.due("scalp", this.o.scalpIntervalHours, at)) {
      const batch = this.scalpBatch();
      try {
        await this.runJob("scalp", [
          ["fetch", "--inst", batch.coins.join(","), "--bar", "1m", "--days", "14"],
          ["scalp", "--inst", batch.coins.join(",")],
        ], at, batch.coins, this.o.onScalpReport);
        const cursor = Number(this.o.db.getMeta(SCALP_CURSOR)) || 0;
        this.o.db.setMeta(SCALP_CURSOR, String(cursor + batch.rotateCount));
        this.o.db.setMeta(SCALP_PENDING, "");
        done.push("scalp");
      } catch (err) {
        log.warn("autonomous lab job failed", { job: "scalp", err: safeError(err) });
      }
    }
    return done;
  }

  private async tick(): Promise<void> {
    this.timer = null;
    try {
      await this.runDue();
    } catch (err) {
      log.warn("autonomous lab cycle failed", { job: this.running, err: safeError(err) });
    } finally {
      // Hourly due checks make failed work self-healing, while the durable attempt backoff prevents hammering.
      this.timer = setTimeout(() => void this.tick(), this.o.pollMs ?? HOUR);
    }
  }

  private async runJob(job: AutoLabJob, commands: LabCommand[], at: number, instruments = this.o.instruments, after?: () => Promise<void> | void): Promise<void> {
    this.running = job;
    this.o.db.setMeta(meta(job, "attempt"), String(at));
    log.info("autonomous lab started", { job, instruments });
    try {
      for (const command of commands) await this.o.run(command);
      await after?.();
      this.o.db.setMeta(meta(job, "success"), String(this.now()));
      log.info("autonomous lab completed", { job });
    } finally {
      this.running = null;
    }
  }

  private due(job: AutoLabJob, hours: number, at: number): boolean {
    if (hours <= 0) return false;
    const interval = hours * HOUR;
    const success = this.read(meta(job, "success")) ?? 0;
    if (at - success < interval) return false;
    const attempt = this.read(meta(job, "attempt")) ?? 0;
    return at - attempt >= Math.min(HOUR, Math.max(60_000, interval / 4));
  }

  private read(key: string): number | null {
    const n = Number(this.o.db.getMeta(key));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private scalpCoins(): string[] {
    const raw = typeof this.o.scalpCoins === "function" ? this.o.scalpCoins() : this.o.scalpCoins;
    return [...new Set(raw.map((x) => x.trim().toUpperCase()).filter(Boolean))];
  }

  /** Persisting the pending batch makes retries deterministic even if the live universe moves meanwhile. */
  private scalpBatch(): ScalpBatch {
    const pending = this.o.db.getMeta(SCALP_PENDING);
    if (pending) {
      try {
        const parsed = JSON.parse(pending) as ScalpBatch;
        if (Array.isArray(parsed.coins) && parsed.coins.length && Number.isFinite(parsed.rotateCount)) return parsed;
      } catch { /* replace malformed old state below */ }
    }
    const universe = this.scalpCoins();
    const requested = this.o.scalpBatchSize;
    const size = requested === undefined ? universe.length : Math.min(universe.length, Math.max(1, Math.floor(requested)));
    const cursor = Math.max(0, Number(this.o.db.getMeta(SCALP_CURSOR)) || 0);
    const rotating = Array.from({ length: size }, (_, i) => universe[(cursor + i) % universe.length]!).filter(Boolean);
    const pinned = this.o.scalpPinned?.().map((x) => x.trim().toUpperCase()).filter(Boolean) ?? [];
    const batch = { coins: [...new Set([...pinned, ...rotating])], rotateCount: rotating.length };
    this.o.db.setMeta(SCALP_PENDING, JSON.stringify(batch));
    return batch;
  }
}

/** Runs the already-compiled lab CLI with a small environment and bounded output/time. */
export function labProcessRunner(settingsPath: string, timeoutMs = 45 * 60_000): (args: LabCommand) => Promise<void> {
  const built = fileURLToPath(new URL("./tools/lab.js", import.meta.url));
  const source = fileURLToPath(new URL("./tools/lab.ts", import.meta.url));
  const script = existsSync(built) ? built : source;
  const command = script.endsWith(".js") ? process.execPath : join(process.cwd(), "node_modules", ".bin", "tsx");
  const baseArgs = script.endsWith(".js") ? [script] : [script];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/(KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD)/i.test(key))) as NodeJS.ProcessEnv;
  env.SETTINGS_PATH = settingsPath;
  return (args) => new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...baseArgs, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-8_000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`lab ${args[0] ?? "command"} failed (${signal ?? code ?? "unknown"}): ${tail.slice(-2_000)}`));
    });
  });
}
