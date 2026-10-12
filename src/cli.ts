#!/usr/bin/env node
// Command-line entry: parses arguments, runs `run`, `results`, and `stop`
// against the state store, picks exit codes and next commands, and starts
// the detached supervisor (this same file, under a hidden subcommand).
// It never appends to events.jsonl; it only reads what the supervisor wrote.

import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bucketOf, isSettled, type CheckView } from "./checks.ts";
import { loadConfig, resolveRun } from "./config.ts";
import { AgentError, exitWithEnvelope } from "./errors.ts";
import { estimate, type RunEta } from "./eta.ts";
import { shellQuote } from "./names.ts";
import { signalGroup, signalPid, sleep } from "./processes.ts";
import { allPassedText, jsonLines, text } from "./report.ts";
import { RepoState, resolveRoot, type RunSnapshot } from "./store.ts";
import { supervise, SUPERVISE_COMMAND } from "./supervisor.ts";

const POLL_MS = 50;
const STOP_WAIT_MS = 5_000;

const HELP = `firstlight: run lint, typecheck, and tests in parallel; return at the first failure.

Usage:
  firstlight run [name|pattern|"command"...] [-- command...] [--cwd DIR] [--json]
  firstlight results [--wait] [--cwd DIR] [--json]
  firstlight stop [--cwd DIR] [--json]
  firstlight --help

run      Stop the previous run if it is still going, start the checks in
         parallel, and return at the first failed or timed-out check. The
         other checks keep running. Like npm-run-all's run-p:
           firstlight run lint typecheck test
           firstlight run "lint:*" test
           firstlight run "bundle exec rubocop" "bundle exec rspec"
           firstlight run lint -- make rspec
         With no arguments, every check in firstlight.json runs.
results  Report the latest run. --wait blocks until every check is done.
stop     Cancel the checks still running. Does nothing when none are.

Arguments of run:
  word       a check in firstlight.json (with its "after" checks), else a
             package.json script, run as "npm run <word>"
  pattern    a word with "*": every package.json script it matches, in
             package.json order. "*" stays inside one ":" segment, "**"
             crosses them: "lint:*" matches lint:js but not lint:js:fix
  "command"  an argument with whitespace is a shell command, and its name
             is the command itself
  -- ...     each argument after -- is a shell command, even one word

A running or pending check shows about how long it has left once an
earlier kept run passed the same check with the same command, for example
"test running (3.5s, about 8.0s left)". The "next:" line shows the time
left for the whole run. Without that history, no estimate is shown.

Checks come from firstlight.json at the repository root; "run" is any
shell command:
  {"checks": {"build": {"run": "make build"},
              "test": {"run": "bundle exec rspec", "after": ["build"], "timeoutSec": 600}}}
To run checks in order, give a check "after" in firstlight.json. Without
firstlight.json, "firstlight run" runs the package.json scripts lint,
typecheck, test, and archstrict.

Exit codes:
  0  every check passed (run), or no check failed or was cancelled
     (results), or stop finished
  1  a check failed, timed out, was skipped, was cancelled, or its
     result is unknown; or firstlight itself failed, with {"error","do"}
     on stderr

State: \${XDG_STATE_HOME:-~/.local/state}/firstlight/<repo-key>/
`;

interface Context {
  state: RepoState;
  json: boolean;
  cwdFlag: string;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === SUPERVISE_COMMAND) {
    const runDir = argv[1];
    if (runDir === undefined) {
      throw new AgentError("the supervisor needs a run directory", "this is an internal command; use `firstlight run`");
    }
    supervise(runDir);
    return new Promise(() => {});
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        cwd: { type: "string" },
        json: { type: "boolean", default: false },
        wait: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    throw new AgentError((err as Error).message, "run `firstlight --help` for the usage");
  }
  const { values, tokens } = parsed;
  if (values.help) {
    out(HELP);
    return 0;
  }
  // parseArgs folds the arguments after "--" into the positionals; the
  // tokens keep where the separator was.
  const separator = tokens.find((token) => token.kind === "option-terminator")?.index ?? Infinity;
  const positionals = tokens.filter((token) => token.kind === "positional");
  const [command, ...names] = positionals.filter((token) => token.index < separator).map((token) => token.value);
  const commands = positionals.filter((token) => token.index > separator).map((token) => token.value);
  if (command === undefined && commands.length > 0) {
    throw new AgentError("commands after -- need the run command first", `run \`firstlight run -- ${commands.map(shellQuote).join(" ")}\``);
  }
  if (command === undefined) {
    throw new AgentError("missing command", "run `firstlight run`, or `firstlight --help` for the usage");
  }
  if (!["run", "results", "stop"].includes(command)) {
    throw new AgentError(`unknown command: ${command}`, "run `firstlight --help` for the usage");
  }
  if (command !== "run" && (names.length > 0 || commands.length > 0)) {
    throw new AgentError(`${command} takes no check names`, `run \`firstlight ${command}\` without arguments`);
  }
  if (values.wait && command !== "results") {
    throw new AgentError("--wait belongs to results", "run `firstlight results --wait`");
  }

  const root = resolveRoot(path.resolve(values.cwd ?? process.cwd()));
  const ctx: Context = {
    state: new RepoState(root),
    json: values.json,
    cwdFlag: values.cwd === undefined ? "" : ` --cwd ${shellQuote(root)}`,
  };
  switch (command) {
    case "run":
      return runCommand(ctx, names, commands);
    case "results":
      return resultsCommand(ctx, values.wait);
    default:
      return stopCommand(ctx);
  }
}

async function runCommand(ctx: Context, names: string[], commands: string[]): Promise<number> {
  const checks =
    names.length === 0 && commands.length === 0
      ? loadConfig(ctx.state.root).checks
      : resolveRun(ctx.state.root, names, commands);

  const previous = ctx.state.currentId();
  if (previous !== null) await stopRun(ctx.state, previous);

  const run = ctx.state.createRun(checks);
  const runDir = ctx.state.runDir(run.id);
  // The supervisor has no terminal; its own stderr goes to a file so a
  // crash of firstlight itself is still visible after the fact.
  const errFd = openSync(path.join(runDir, "supervisor.log"), "a");
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), SUPERVISE_COMMAND, runDir], {
      cwd: ctx.state.root,
      detached: true,
      stdio: ["ignore", "ignore", errFd],
      env: process.env,
    });
  } finally {
    closeSync(errFd);
  }
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined) {
    throw new AgentError(`could not start the supervisor with ${process.execPath}`, "rerun `firstlight run`");
  }
  ctx.state.writeRun({ ...run, supervisor_pid: child.pid });
  ctx.state.setCurrent(run.id);
  ctx.state.prune();
  const typical = ctx.state.typicalDurations(run);

  for (;;) {
    const snapshot = ctx.state.snapshot(run.id);
    const eta = etaOf(snapshot, typical);
    const first = firstFailure(snapshot.checks);
    if (first !== null) {
      const next = snapshot.checks.every(isSettled) ? cmd(ctx, "run") : cmd(ctx, "results --wait");
      out(ctx.json ? jsonLines(snapshot, next, eta) : text(snapshot, next, eta, first.name));
      return 1;
    }
    if (snapshot.checks.every(isSettled)) {
      if (snapshot.checks.every((view) => view.status === "passed")) {
        out(ctx.json ? jsonLines(snapshot, null, eta) : allPassedText(snapshot));
        return 0;
      }
      const superseded = ctx.state.currentId() !== run.id;
      const next = superseded ? cmd(ctx, "results --wait") : cmd(ctx, "run");
      out(ctx.json ? jsonLines(snapshot, next, eta) : text(snapshot, next, eta));
      return 1;
    }
    await sleep(POLL_MS);
  }
}

async function resultsCommand(ctx: Context, wait: boolean): Promise<number> {
  const id = ctx.state.currentId();
  if (id === null) {
    throw new AgentError(`no run yet for ${ctx.state.root}`, cmd(ctx, "run"));
  }
  let snapshot = ctx.state.snapshot(id);
  while (wait && !snapshot.checks.every(isSettled)) {
    await sleep(POLL_MS);
    snapshot = ctx.state.snapshot(id);
  }
  const eta = etaOf(snapshot, ctx.state.typicalDurations(snapshot.run));
  const next = nextFor(ctx, snapshot);
  out(ctx.json ? jsonLines(snapshot, next, eta) : text(snapshot, next, eta));
  // A cancelled check proved nothing, so it does not count as a pass.
  const unproven = snapshot.checks.some((view) => {
    const bucket = bucketOf(view.status);
    return bucket === "failed" || bucket === "cancelled";
  });
  return unproven ? 1 : 0;
}

async function stopCommand(ctx: Context): Promise<number> {
  const id = ctx.state.currentId();
  const stopped = id === null ? false : await stopRun(ctx.state, id);
  if (!stopped || id === null) {
    if (ctx.json) {
      out(`${JSON.stringify({ type: "summary", run: id, failed: [], running: [], passed: [], cancelled: [], next: null, eta_ms: 0 })}\n`);
    } else {
      out("nothing running\n");
    }
    return 0;
  }
  const snapshot = ctx.state.snapshot(id);
  const next = cmd(ctx, "run");
  const eta = etaOf(snapshot, ctx.state.typicalDurations(snapshot.run));
  out(ctx.json ? jsonLines(snapshot, next, eta) : `stopped run ${id}\n${text(snapshot, next, eta)}`);
  return 0;
}

// The same path serves `stop` and the start of `run`. The supervisor gets
// SIGTERM and cancels its own checks; only if it fails to finish in time do
// we SIGKILL the groups it recorded, which leaves those checks unknown.
async function stopRun(state: RepoState, id: string): Promise<boolean> {
  let snapshot = state.snapshot(id);
  if (snapshot.outcome !== null || !snapshot.supervisorAlive) return false;
  const supervisor = snapshot.run.supervisor_pid!;
  signalPid(supervisor, "SIGTERM");
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    snapshot = state.snapshot(id);
    if (snapshot.outcome !== null || !snapshot.supervisorAlive) return true;
  }
  for (const view of snapshot.checks) {
    if (view.status === "running" && view.pid !== null) signalGroup(view.pid, "SIGKILL");
  }
  signalPid(supervisor, "SIGKILL");
  return true;
}

function firstFailure(views: CheckView[]): CheckView | null {
  const failed = views.filter((view) => view.status === "failed" || view.status === "timed_out");
  const endOf = (view: CheckView) => Date.parse(view.started_at ?? "") + (view.elapsed_ms ?? 0);
  failed.sort((a, b) => endOf(a) - endOf(b));
  return failed[0] ?? null;
}

function etaOf(snapshot: RunSnapshot, typical: ReadonlyMap<string, number>): RunEta {
  return estimate(snapshot.checks, snapshot.run.checks, typical, Date.now());
}

function nextFor(ctx: Context, snapshot: RunSnapshot): string | null {
  const buckets = snapshot.checks.map((view) => bucketOf(view.status));
  if (buckets.includes("running")) return cmd(ctx, "results --wait");
  if (buckets.includes("failed") || buckets.includes("cancelled")) return cmd(ctx, "run");
  return null;
}

function cmd(ctx: Context, rest: string): string {
  return `firstlight ${rest}${ctx.cwdFlag}`;
}

function out(textValue: string): void {
  writeSync(1, textValue);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => exitWithEnvelope(err),
);
