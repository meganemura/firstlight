// The per-run supervisor: a detached process that starts each check when
// its `after` checks have passed, waits on it, enforces its timeout, and
// appends every status change to events.jsonl. It is the only writer of
// that file, so it also records the results the CLI chose to reuse, before
// it starts anything, and their dependents start at once. It exits when every check is terminal, or after SIGTERM once
// it has cancelled what was left. It prints nothing; the CLI reads the file.

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import path from "node:path";
import {
  advance,
  initialState,
  isTerminal,
  type CheckEvent,
  type CheckSpec,
  type CheckState,
  type CheckStatus,
  type RunOutcome,
} from "./checks.ts";
import { signalGroup } from "./processes.ts";
import { appendEvent, logPaths, type RunRecord } from "./store.ts";

export const SUPERVISE_COMMAND = "__supervise";
export const GRACE_MS = 3_000;
const KILL_WAIT_MS = 2_000;

interface Running {
  pid: number;
  startedMs: number;
  timedOut: boolean;
  timer: NodeJS.Timeout;
  exited: Promise<void>;
}

export function supervise(runDir: string): void {
  const run = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8")) as RunRecord;
  new Supervisor(run, runDir).start();
}

class Supervisor {
  private readonly run: RunRecord;
  private readonly runDir: string;
  private readonly logs: Map<string, string>;
  private readonly states = new Map<string, CheckState>();
  private readonly running = new Map<string, Running>();
  private stopping = false;
  private finished = false;

  constructor(run: RunRecord, runDir: string) {
    this.run = run;
    this.runDir = runDir;
    this.logs = logPaths(runDir, run.checks);
    for (const check of run.checks) this.states.set(check.name, initialState(check.name));
  }

  start(): void {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(signal, () => {
        void this.stop();
      });
    }
    for (const check of this.run.checks) {
      const reuse = this.run.reused?.[check.name];
      if (reuse === undefined) continue;
      const log = this.logs.get(check.name)!;
      if (reuse.status === "failed") {
        // The earlier output is copied so the tail and the diagnostics read
        // as they did; the note goes last, where the tail shows it.
        let earlier = "";
        try {
          earlier = readFileSync(reuse.log!, "utf8");
        } catch {
          earlier = "firstlight: the log of that run is gone\n";
        }
        writeFileSync(
          log,
          `${earlier}${earlier.endsWith("\n") || earlier === "" ? "" : "\n"}firstlight: not run; failed in run ${reuse.run} on the same working tree with the same command. Change something, or run it again with --no-cache if the failure came from outside the tree or may be flaky\n`,
        );
        this.record(check.name, "failed", { exit_code: reuse.exit_code!, elapsed_ms: reuse.elapsed_ms, cached_from: reuse.run });
        continue;
      }
      // The log is written so its path in the output points at something
      // that says why this run has no output of its own.
      writeFileSync(log, `firstlight: not run; passed in run ${reuse.run} on the same working tree with the same command\n`);
      this.record(check.name, "passed", { exit_code: 0, elapsed_ms: reuse.elapsed_ms, cached_from: reuse.run });
    }
    this.schedule();
  }

  private record(name: string, status: CheckStatus, extra: Partial<CheckEvent> = {}): void {
    const event: CheckEvent = { type: "check", check: name, status, ...extra, at: new Date().toISOString() };
    this.states.set(name, advance(this.states.get(name)!, event));
    appendEvent(this.runDir, event);
  }

  private status(name: string): CheckStatus {
    return this.states.get(name)!.status;
  }

  private schedule(): void {
    if (this.stopping || this.finished) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (const check of this.run.checks) {
        if (this.status(check.name) !== "pending") continue;
        const deps = check.after.map((dep) => this.status(dep));
        if (deps.some((status) => isTerminal(status) && status !== "passed")) {
          this.record(check.name, "skipped");
          changed = true;
        } else if (deps.every((status) => status === "passed")) {
          this.launch(check);
          changed = true;
        }
      }
    }
    if (this.run.checks.every((check) => isTerminal(this.status(check.name)))) {
      this.finish("done");
    }
  }

  private launch(check: CheckSpec): void {
    const log = this.logs.get(check.name)!;
    const fd = openSync(log, "a");
    let child;
    try {
      // detached gives the check its own process group, so one signal to
      // -pid reaches everything the shell started.
      child = spawn("/bin/sh", ["-c", this.run.narrowed?.[check.name]?.command ?? check.run], {
        cwd: this.run.root,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      });
    } finally {
      closeSync(fd);
    }
    const startedMs = Date.now();
    const pid = child.pid;
    if (pid === undefined) {
      child.once("error", (err) => {
        appendFileSync(log, `firstlight: could not start /bin/sh: ${err.message}\n`);
      });
      this.record(check.name, "running");
      this.record(check.name, "failed", { exit_code: null, elapsed_ms: 0 });
      return;
    }

    let markExited: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const entry: Running = {
      pid,
      startedMs,
      timedOut: false,
      exited,
      timer: setTimeout(() => {
        entry.timedOut = true;
        void this.terminate(entry);
      }, check.timeoutSec * 1000),
    };
    this.running.set(check.name, entry);
    this.record(check.name, "running", { pid });

    child.on("exit", (code, signal) => {
      clearTimeout(entry.timer);
      this.running.delete(check.name);
      const exitCode = exitCodeOf(code, signal);
      const status: CheckStatus = entry.timedOut
        ? "timed_out"
        : this.stopping
          ? "cancelled"
          : exitCode === 0
            ? "passed"
            : "failed";
      this.record(check.name, status, { pid, exit_code: exitCode, elapsed_ms: Date.now() - startedMs });
      markExited();
      this.schedule();
    });
  }

  // SIGKILL only while the shell is still unreaped: once it has exited its
  // pid, and with it the group id, may belong to a process we did not start.
  private async terminate(entry: Running): Promise<void> {
    signalGroup(entry.pid, "SIGTERM");
    const gone = await Promise.race([entry.exited.then(() => true), delay(GRACE_MS).then(() => false)]);
    if (!gone) signalGroup(entry.pid, "SIGKILL");
  }

  private async stop(): Promise<void> {
    if (this.stopping || this.finished) return;
    this.stopping = true;
    const entries = [...this.running.values()];
    await Promise.all(entries.map((entry) => this.terminate(entry)));
    await Promise.race([Promise.all(entries.map((entry) => entry.exited)), delay(KILL_WAIT_MS)]);
    for (const check of this.run.checks) {
      if (!isTerminal(this.status(check.name))) {
        this.record(check.name, "cancelled", this.status(check.name) === "running" ? { exit_code: null } : {});
      }
    }
    this.finish("cancelled");
  }

  private finish(outcome: RunOutcome): void {
    if (this.finished) return;
    this.finished = true;
    appendEvent(this.runDir, { type: "run", status: outcome, at: new Date().toISOString() });
    process.exit(0);
  }
}

// A signal death is recorded with the shell convention, 128 plus the
// signal number, because the signal was observed rather than guessed.
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number | null {
  if (code !== null) return code;
  if (signal !== null) {
    const number = constants.signals[signal];
    if (number !== undefined) return 128 + number;
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
