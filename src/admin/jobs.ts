// Runs the strategy lab from the admin panel. Each run is a child process (`src/tools/lab.ts`, or `dist/tools/lab.js`
// in the image), so a long tournament never blocks the engine's tick. One job at a time; the last lines of its output
// are kept for the panel. Arguments are built here from checked fields, never passed through from the page.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactString } from "../redact.js";
import { checkPlan, type CheckOpts, type CheckStage, type CheckStep } from "./check.js";

export const LAB_COMMANDS = ["fetch", "run", "council", "cycle"] as const;
export type LabCommand = (typeof LAB_COMMANDS)[number];

export interface LabArgs {
  source?: "okx" | "ccxt" | "alpaca" | "synthetic";
  /** OKX instIds or CCXT symbols, comma separated. */
  symbols?: string;
  exchange?: string;
  bar?: "15m" | "1H" | "4H" | "1D";
  days?: number;
  folds?: number;
  leverage?: number;
  synthetic?: number;
  longOnly?: boolean;
}

export interface StepStatus {
  id: string;
  stage: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  note: string;
  startedAt: number | null;
  endedAt: number | null;
}

export interface JobStatus {
  id: number;
  command: LabCommand | "check";
  /** Set on a real-data check: one entry per step, in order. */
  steps?: StepStatus[];
  args: string[];
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  log: string[];
}

const MAX_LINES = 400;
const SYMBOLS = /^[A-Za-z0-9/:_-]{2,40}(,[A-Za-z0-9/:_-]{2,40}){0,19}$/;
const EXCHANGE = /^[a-z0-9]{2,30}$/;

/** Checked page input -> CLI arguments. Throws a readable error on anything off. */
export function labArgv(command: LabCommand, a: LabArgs): string[] {
  const out: string[] = [command];
  if (command === "council") return out;
  const bar = a.bar ?? "1H";
  if (!["15m", "1H", "4H", "1D"].includes(bar)) throw new Error("bar: 15m, 1H, 4H or 1D");
  out.push("--bar", bar);
  if (command === "fetch" || command === "cycle") {
    const days = Math.round(a.days ?? 365);
    if (!(days >= 7 && days <= 2000)) throw new Error("days: 7 to 2000");
    if (a.source !== "synthetic") out.push("--days", String(days));
    if (a.source === "ccxt") {
      if (!a.exchange || !EXCHANGE.test(a.exchange)) throw new Error("exchange: a CCXT id like binance");
      out.push("--exchange", a.exchange);
      if (a.symbols) {
        if (!SYMBOLS.test(a.symbols)) throw new Error("symbols: like BTC/USDT,ETH/USDT");
        out.push("--symbol", a.symbols);
      }
    } else if (a.source === "alpaca") {
      out.push("--source", "alpaca");
      if (a.symbols) {
        if (!SYMBOLS.test(a.symbols)) throw new Error("symbols: like SPY,QQQ,BTC/USD");
        out.push("--symbol", a.symbols);
      }
    } else if (a.symbols && a.source !== "synthetic") {
      if (!SYMBOLS.test(a.symbols)) throw new Error("instruments: like BTC-USDT-SWAP,ETH-USDT-SWAP");
      out.push("--inst", a.symbols);
    }
  }
  if (command === "run" || command === "cycle") {
    const folds = Math.round(a.folds ?? 3);
    if (!(folds >= 2 && folds <= 8)) throw new Error("folds: 2 to 8");
    out.push("--folds", String(folds));
    const lev = a.leverage ?? 1;
    if (!(lev > 0 && lev <= 2)) throw new Error("leverage: above 0, at most 2");
    out.push("--leverage", String(lev));
    if (a.synthetic) {
      const n = Math.round(a.synthetic);
      if (!(n >= 1 && n <= 8)) throw new Error("synthetic markets: 1 to 8");
      out.push("--synthetic", String(n));
    }
    if (a.longOnly) out.push("--long-only");
  }
  return out;
}

/** The lab CLI next to this build: .ts under tsx (dev), .js in dist (the image). */
export function labScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = extname(fileURLToPath(import.meta.url)) || ".js";
  return join(here, "..", "tools", `lab${ext}`);
}

export class LabJobs {
  private seq = 0;
  private current: JobStatus | null = null;
  private child: ChildProcess | null = null;

  constructor(
    private env: () => NodeJS.ProcessEnv,
    private onDone?: (job: JobStatus) => void,
    private spawnFn: typeof spawn = spawn,
    private script: string = labScript(),
  ) {}

  status(): JobStatus | null {
    return this.current;
  }

  get busy(): boolean {
    return this.current?.state === "running";
  }

  start(command: LabCommand, args: LabArgs): JobStatus {
    if (this.busy) throw new Error("A lab job is already running. Wait for it to finish.");
    if (!existsSync(this.script)) throw new Error("The lab tool is not in this build.");
    const argv = labArgv(command, args);
    const job: JobStatus = { id: ++this.seq, command, args: argv.slice(1), state: "running", startedAt: Date.now(), endedAt: null, exitCode: null, log: [] };
    this.current = job;
    void this.spawnOne(job, this.script, argv).then((code) => {
      job.exitCode = code;
      job.state = code === 0 ? "done" : "failed";
      job.endedAt = Date.now();
      this.onDone?.(job);
    });
    return job;
  }

  /** The real-data check: the plan's steps one after another as a single job. A failed step skips the rest of its stage. */
  startCheck(stages: readonly CheckStage[], o: CheckOpts): JobStatus {
    if (this.busy) throw new Error("A lab job is already running. Wait for it to finish.");
    if (!existsSync(this.script)) throw new Error("The lab tool is not in this build.");
    const plan = checkPlan(stages, o);
    if (!plan.length) throw new Error("Pick at least one stage.");
    const steps: StepStatus[] = plan.map((p) => ({ id: p.id, stage: p.stage, label: p.label, state: "pending", note: "", startedAt: null, endedAt: null }));
    const job: JobStatus = { id: ++this.seq, command: "check", args: [], steps, state: "running", startedAt: Date.now(), endedAt: null, exitCode: null, log: [] };
    this.current = job;
    this.aborted = false;
    void this.runPlan(job, plan).finally(() => {
      job.endedAt = Date.now();
      job.state = steps.some((s) => s.state === "failed") || this.aborted ? "failed" : "done";
      job.exitCode = job.state === "done" ? 0 : 1;
      this.onDone?.(job);
    });
    return job;
  }

  private aborted = false;

  private async runPlan(job: JobStatus, plan: CheckStep[]): Promise<void> {
    const steps = job.steps!;
    const failedStages = new Set<string>();
    for (const [i, p] of plan.entries()) {
      const st = steps[i]!;
      if (this.aborted) {
        st.state = "skipped";
        st.note = "stopped";
        continue;
      }
      if (p.skip || failedStages.has(p.stage)) {
        st.state = "skipped";
        st.note = p.skip ?? "an earlier step of this stage failed";
        job.log.push(`- skipped: ${p.label} (${st.note})`);
        continue;
      }
      st.state = "running";
      st.startedAt = Date.now();
      job.log.push(`> ${p.label}`);
      let soft = 0;
      const script = p.tool === "gold" ? this.script.replace(/lab(\.[cm]?[jt]s)$/, "gold$1") : this.script;
      const code = existsSync(script) ? await this.spawnOne(job, script, p.argv, (l) => {
            if (/\bfailed: |no data$/.test(l)) soft++;
          }) : -1;
      st.endedAt = Date.now();
      // A download that fails prints "failed:" and still exits 0: say so instead of a green tick.
      if (code !== 0) {
        st.state = "failed";
        st.note = existsSync(script) ? `exit code ${code}` : "the tool is not in this build";
        failedStages.add(p.stage);
      } else {
        st.state = "done";
        if (soft) st.note = `${soft} download${soft > 1 ? "s" : ""} failed: see the log`;
      }
    }
  }

  private spawnOne(job: JobStatus, script: string, argv: string[], onLine?: (line: string) => void): Promise<number> {
    return new Promise((resolve) => {
      // Same Node and loader flags as the engine (tsx in dev), so the .ts script runs there too.
      const child = this.spawnFn(process.execPath, [...process.execArgv, "--disable-warning=ExperimentalWarning", script, ...argv], {
        env: this.env(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const push = (buf: Buffer) => {
        for (const raw of buf.toString("utf8").split(/\r|\n/)) {
          const line = redactString(raw.trimEnd());
          if (!line) continue;
        job.log.push(line);
        onLine?.(line);
        }
        if (job.log.length > MAX_LINES) job.log.splice(0, job.log.length - MAX_LINES);
      };
      child.stdout?.on("data", push);
      child.stderr?.on("data", push);
      child.on("error", (err) => {
        job.log.push(`could not start: ${err.message}`);
        this.child = null;
        resolve(-1);
      });
      child.on("close", (code) => {
        this.child = null;
        resolve(code ?? -1);
      });
    });
  }

  stop(): void {
    this.aborted = true;
    this.child?.kill("SIGTERM");
  }
}
