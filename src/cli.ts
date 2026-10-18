#!/usr/bin/env node
// Command-line entry: parses arguments, runs `run`, `results`, `follow`,
// and `stop` against the state store, picks exit codes and next commands,
// and starts the detached supervisor (this same file, under a hidden
// subcommand).
// It never appends to events.jsonl; it only reads what the supervisor wrote.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareFailures, isFailure, isUnproven, type Outcome } from "./baseline.ts";
import { cacheKey, cacheKeys, type Reuse } from "./cache.ts";
import { bucketOf, IllegalTransition, isSettled, presentChecks, replay, type CheckSpec, type CheckView } from "./checks.ts";
import {
  CONFIG_FILE,
  configText,
  configuredChecks,
  loadConfig,
  proposeChecks,
  resolveRun,
  selectFailed,
  suggestTimeoutSec,
  withParsers,
} from "./config.ts";
import { AgentError, exitWithEnvelope, nodeVersionError } from "./errors.ts";
import { estimate, type RunEta } from "./eta.ts";
import { shellQuote } from "./names.ts";
import { signalGroup, signalPid, sleep } from "./processes.ts";
import {
  allPassedText,
  changeText,
  checkDiagnostics,
  checkJson,
  jsonLines,
  newJsonLines,
  newText,
  summarize,
  summaryText,
  text,
  type Comparison,
} from "./report.ts";
import {
  gateChanges,
  narrowedKeyCommand,
  narrowTo,
  parseNameStatus,
  PROTOCOL_VERSION,
  readSelector,
  RECORD_ENV,
  SELECTOR_TIMEOUT_MS,
  type FullRun,
  type Narrowing,
  type SelectorExit,
  type SelectorInput,
} from "./selection.ts";
import { eventsPath, readEvents, RepoState, resolveRoot, type RunSnapshot } from "./store.ts";
import { supervise, SUPERVISE_COMMAND } from "./supervisor.ts";
import { changedPaths, treeKey } from "./tree.ts";

const POLL_MS = 50;
const STOP_WAIT_MS = 5_000;

const HELP = `firstlight: run lint, typecheck, and tests in parallel; return at the first failure.

Usage:
  firstlight run [name|pattern|"command"...] [-- command...] [--no-cache] [--full] [--cwd DIR] [--json]
  firstlight run --failed [--no-cache] [--full] [--cwd DIR] [--json]
  firstlight results [--wait] [--new] [--cwd DIR] [--json]
  firstlight follow [--cwd DIR] [--json]
  firstlight stop [--cwd DIR] [--json]
  firstlight init [script|pattern...] [--write [--force]] [--cwd DIR] [--json]
  firstlight --help

run      Stop the previous run if it is still going, start the checks in
         parallel, and return at the first failed or timed-out check. The
         other checks keep running. Like npm-run-all's run-p:
           firstlight run lint typecheck test
           firstlight run "lint:*" test
           firstlight run "bundle exec rubocop" "bundle exec rspec"
           firstlight run lint -- make rspec
         With no arguments, every check in firstlight.json runs.
         --failed runs only the checks that did not pass in the latest
         run, each resolved like a name given to run (a configured check
         brings its "after" checks); a check removed from firstlight.json
         since is left out.
results  Report the latest run. --wait blocks until every check is done.
         --new reports only the failures that were not there before: each
         check is compared with the newest earlier kept run in which the
         same check (same name, same command) passed, failed, or timed
         out. A diagnostic is new when that run has none with the same
         file, rule, and message (line and column do not count); a failure
         without diagnostics is new when that run passed. Passes and known
         failures become counts. Exit 1 only for a new failure, or for a
         check that is still running, cancelled, or unknown.
follow   Print one line for each status change of the latest run, from its
         first one, as it happens, then the summary of results --wait, and
         exit as results --wait would. Each line is flushed on its own, so
         a log watcher sees it at once.
stop     Cancel the checks still running. Does nothing when none are.
init     Propose a firstlight.json from the package.json scripts and print
         it. --write writes it; --force lets --write replace an existing
         one. With no names, it holds the scripts lint, typecheck, test,
         and archstrict; names and patterns pick other scripts:
           firstlight init typecheck test check:architecture
         Each check runs "npm run <script>", gets the parser inferred from
         the script, and gets a timeoutSec when an earlier run passed it in
         more than a third of the 600s default. It names the scripts that
         look like checks and were left out.

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

A check that passed in a kept run on the same working tree (tracked and
untracked files, not ignored ones) with the same command, and whose
"after" checks did the same, is not run again: "test passed (cached from
run 01K..., 10.4s originally)". Environment variables and files outside
the repository are not part of that comparison; --no-cache runs every
check anyway. A failure is reused the same way once it has failed twice
on that tree with that command and never passed there: "test failed
(cached from run 01K..., 10.4s originally)", with that run's log. Only in
a git repository.

A check in firstlight.json with "select" and "runSelected" runs only
the tests its selector picks, once it has passed in full. During a full
run, FIRSTLIGHT_RECORD names a directory the check may record into. A
later run gives the selector, on stdin, the files changed since that full
pass and that directory; the selector prints {"tests":[{"id":"..."}]} or
{"full":"<reason>"}, and firstlight runs "runSelected" with the quoted
ids in place of {tests}: "test passed (selected 2 tests for 3 changed
files since run 01K..., 3.1s)". No test selected passes without running.
A file matching one of its "fullOn" globs, a selector that fails or
prints anything else, or --full runs the full command: "test passed
(full run: <reason>, 10.2s)". firstlight ships no selector.

A failed or timed-out check whose log a parser reads prints its
diagnostics, at most 20, as "file:line:col rule message" lines before a
10-line log tail, in run, results, and follow; --json prints them as
{"type":"diagnostic",...} lines after the check. The parsers are tsc,
vitest, node-test (node --test), and archstrict. Each check's parser comes from its "parser" in firstlight.json,
or from its command: tsc, vitest, node --test, archstrict, or "npm run
<script>" (and "npm test") whose script runs one of them; an && list
gets each of its commands' parsers, like ["tsc", "vitest"]. "parser":
"none" turns this off for one check. A vitest diagnostic whose test
depug's reporter named also gets "evidence: <path>" and "rerun:
<command>" lines under it, and "evidence" and "rerun" fields in --json.

Checks come from firstlight.json at the repository root; "run" is any
shell command:
  {"checks": {"build": {"run": "make build"},
              "test": {"run": "bundle exec rspec", "after": ["build"], "timeoutSec": 600},
              "types": {"run": "make types", "parser": "tsc"}}}
To run checks in order, give a check "after" in firstlight.json. Without
firstlight.json, "firstlight run" runs the package.json scripts lint,
typecheck, test, and archstrict, and names the other scripts that start
with one of those words or with "check" (check:architecture, test:e2e)
on a "not run:" line, without running them.

Exit codes:
  0  every check passed (run), or no check failed or was cancelled
     (results, follow), or no failure is new and every check finished
     (results --new), or stop finished
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
        failed: { type: "boolean", default: false },
        new: { type: "boolean", default: false },
        "no-cache": { type: "boolean", default: false },
        full: { type: "boolean", default: false },
        write: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
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
  if (!["run", "results", "follow", "stop", "init"].includes(command)) {
    throw new AgentError(`unknown command: ${command}`, "run `firstlight --help` for the usage");
  }
  if (command === "init" && commands.length > 0) {
    throw new AgentError("init picks package.json scripts and takes no commands after --", `add the commands to ${CONFIG_FILE} by hand`);
  }
  if (command !== "run" && command !== "init" && (names.length > 0 || commands.length > 0)) {
    throw new AgentError(`${command} takes no check names`, `run \`firstlight ${command}\` without arguments`);
  }
  if (values.wait && command !== "results") {
    throw new AgentError("--wait belongs to results", "run `firstlight results --wait`");
  }
  if (values.new && command !== "results") {
    throw new AgentError("--new belongs to results", "run `firstlight results --new`");
  }
  if (values["no-cache"] && command !== "run") {
    throw new AgentError("--no-cache belongs to run", "run `firstlight run --no-cache`");
  }
  if (values.full && command !== "run") {
    throw new AgentError("--full belongs to run", "run `firstlight run --full`");
  }
  if (values.write && command !== "init") {
    throw new AgentError("--write belongs to init", "run `firstlight init --write`");
  }
  if (values.force && !values.write) {
    throw new AgentError("--force only lets init --write replace a firstlight.json", "run `firstlight init --write --force`");
  }
  if (values.failed && command !== "run") {
    throw new AgentError("--failed belongs to run", "run `firstlight run --failed`");
  }
  if (values.failed && (names.length > 0 || commands.length > 0)) {
    throw new AgentError(
      "--failed picks the checks itself, so it takes no check names",
      "run `firstlight run --failed` without names, or name the checks without --failed",
    );
  }

  const root = resolveRoot(path.resolve(values.cwd ?? process.cwd()));
  const ctx: Context = {
    state: new RepoState(root),
    json: values.json,
    cwdFlag: values.cwd === undefined ? "" : ` --cwd ${shellQuote(root)}`,
  };
  switch (command) {
    case "run":
      return runCommand(ctx, values.failed ? "failed" : { names, commands }, !values["no-cache"], !values.full);
    case "results":
      return resultsCommand(ctx, values.wait, values.new);
    case "follow":
      return followCommand(ctx);
    case "init":
      return initCommand(ctx, names, values.write, values.force);
    default:
      return stopCommand(ctx);
  }
}

type Selection = "failed" | { names: string[]; commands: string[] };

async function runCommand(ctx: Context, selection: Selection, useCache: boolean, narrow: boolean): Promise<number> {
  const previous = ctx.state.currentId();
  let checks: CheckSpec[];
  let notRun: string[] = [];
  if (selection === "failed") {
    if (previous === null) {
      throw new AgentError(`no run yet for ${ctx.state.root}, so no check has failed`, cmd(ctx, "run"));
    }
    // Read before the stop, so a broken firstlight.json stops nothing; the
    // selection comes after it, so a check the stop cancelled counts as one
    // that did not pass.
    const configured = configuredChecks(ctx.state.root);
    await stopRun(ctx.state, previous);
    checks = failedChecks(ctx, previous, configured);
  } else {
    const { names, commands } = selection;
    if (names.length === 0 && commands.length === 0) {
      const config = loadConfig(ctx.state.root);
      checks = config.checks;
      notRun = config.notRun;
    } else {
      checks = resolveRun(ctx.state.root, names, commands);
    }
    if (previous !== null) await stopRun(ctx.state, previous);
  }
  checks = withParsers(ctx.state.root, checks);

  // After the stop, so a check of the previous run that was still writing
  // into the tree has finished before the tree is hashed. Keys are recorded
  // even under --no-cache, so a later run can reuse this one.
  const tree = treeKey(ctx.state.root);
  const keys = tree === null ? new Map<string, string>() : cacheKeys(checks, tree);
  const reused = useCache ? ctx.state.reusable(keys) : new Map();
  const selected: Selected =
    tree === null || !narrow ? { narrowed: new Map(), fullRun: new Map() } : await selectTests(ctx, checks, tree, keys, reused, useCache);
  const run = ctx.state.createRun(checks, keys, reused, tree, selected.narrowed, selected.fullRun);
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
      const next = snapshot.checks.every(isSettled) ? cmd(ctx, "run --failed") : cmd(ctx, "results --wait");
      out(ctx.json ? jsonLines(snapshot, next, eta, notRun) : text(snapshot, next, eta, first.name, notRun));
      return 1;
    }
    if (snapshot.checks.every(isSettled)) {
      if (snapshot.checks.every((view) => view.status === "passed")) {
        out(ctx.json ? jsonLines(snapshot, null, eta, notRun) : allPassedText(snapshot, notRun));
        return 0;
      }
      const superseded = ctx.state.currentId() !== run.id;
      const next = superseded ? cmd(ctx, "results --wait") : cmd(ctx, "run --failed");
      out(ctx.json ? jsonLines(snapshot, next, eta, notRun) : text(snapshot, next, eta, null, notRun));
      return 1;
    }
    await sleep(POLL_MS);
  }
}

interface Selected {
  narrowed: Map<string, Narrowing>;
  fullRun: Map<string, FullRun>;
}

// A check with a selector and no result to reuse asks its selector which
// tests the changes since its newest full pass reach. Its key then names
// the narrowed command, so a narrowed pass is never mistaken for a full
// one, and running again on the same tree reuses it like any other result.
// The selectors run here, before the supervisor starts, so the supervisor
// stays the only writer of events.jsonl and only runs what run.json says.
async function selectTests(
  ctx: Context,
  checks: readonly CheckSpec[],
  tree: string,
  keys: Map<string, string>,
  reused: Map<string, Reuse>,
  useCache: boolean,
): Promise<Selected> {
  const selected: Selected = { narrowed: new Map(), fullRun: new Map() };
  await Promise.all(
    checks.map(async (check) => {
      const selector = check.selector;
      if (selector === undefined || reused.has(check.name)) return;
      const base = ctx.state.narrowBase(check);
      if (base === null) return;
      const output = changedPaths(ctx.state.root, base.tree, tree);
      const gate = gateChanges(selector.fullOn, output === null ? null : parseNameStatus(output));
      if ("full" in gate) {
        selected.fullRun.set(check.name, { base: base.run, reason: gate.full });
        return;
      }
      const input: SelectorInput = { version: PROTOCOL_VERSION, check: check.name, tree, base, changes: gate.changes };
      const answer = readSelector(await runSelector(ctx.state.root, selector.select, `${JSON.stringify(input)}\n`));
      if ("full" in answer) {
        selected.fullRun.set(check.name, { base: base.run, reason: answer.full });
        return;
      }
      const narrowing = narrowTo(base.run, gate.changes, answer.tests, selector.runSelected);
      const key = cacheKey(tree, narrowedKeyCommand(narrowing, selector.runSelected), check.after.map((dep) => keys.get(dep)!));
      keys.set(check.name, key);
      selected.narrowed.set(check.name, narrowing);
      if (!useCache) return;
      const reuse = ctx.state.reusable(new Map([[check.name, key]])).get(check.name);
      if (reuse !== undefined) reused.set(check.name, reuse);
    }),
  );
  return selected;
}

// The selector gets its own process group, like a check, so a timeout
// stops whatever it started too.
function runSelector(root: string, command: string, input: string): Promise<SelectorExit> {
  const env = { ...process.env };
  delete env[RECORD_ENV];
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: root, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
    }, SELECTOR_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    // A selector may exit without reading its input.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ error: err.message, timedOut: false, code: null, signal: null, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ error: null, timedOut, code, signal, stdout, stderr });
    });
  });
}

function failedChecks(ctx: Context, previous: string, configured: CheckSpec[]): CheckSpec[] {
  const snapshot = ctx.state.snapshot(previous);
  const specs = new Map(snapshot.run.checks.map((spec) => [spec.name, spec]));
  const { checks, dropped } = selectFailed(
    configured,
    snapshot.checks.map((view) => ({ spec: specs.get(view.name)!, status: view.status })),
  );
  if (checks.length > 0) return checks;
  if (dropped.length > 0) {
    throw new AgentError(
      `the checks that did not pass in run ${previous} are no longer in firstlight.json: ${dropped.join(", ")}`,
      cmd(ctx, "run"),
    );
  }
  throw new AgentError(`run ${previous} has no check that did not pass`, cmd(ctx, "run"));
}

async function resultsCommand(ctx: Context, wait: boolean, onlyNew: boolean): Promise<number> {
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
  if (onlyNew) {
    const comparison = compare(ctx, snapshot);
    const failing = [...comparison.checks.values()].some((check) => check.isNew);
    const running = snapshot.checks.some((view) => bucketOf(view.status) === "running");
    const unproven = snapshot.checks.some((view) => isUnproven(view.status));
    const next = running ? cmd(ctx, "results --new --wait") : failing || unproven ? cmd(ctx, "run --failed") : null;
    out(ctx.json ? newJsonLines(snapshot, comparison, next, eta) : newText(snapshot, comparison, next, eta));
    return failing || unproven ? 1 : 0;
  }
  const next = nextFor(ctx, snapshot);
  out(ctx.json ? jsonLines(snapshot, next, eta) : text(snapshot, next, eta));
  return resultsCode(snapshot);
}

// Reads the logs of the latest run and of each check's baseline; the
// comparison itself is pure.
function compare(ctx: Context, snapshot: RunSnapshot): Comparison {
  const baselines = ctx.state.baselines(snapshot.run);
  const earlier = new Map<string, Outcome>();
  for (const [name, baseline] of baselines) {
    const failed = isFailure(baseline.status);
    const dir = ctx.state.runDir(baseline.run);
    earlier.set(name, { failed, diagnostics: failed ? checkDiagnostics(baseline.record, dir, name) : [] });
  }
  const latest = snapshot.checks.map((view) => {
    const failed = isFailure(view.status);
    return { name: view.name, failed, diagnostics: failed ? checkDiagnostics(snapshot.run, snapshot.dir, view.name) : [] };
  });
  return {
    baselines: new Map([...baselines].map(([name, baseline]) => [name, baseline.run])),
    checks: new Map(compareFailures(latest, earlier).map((check) => [check.name, check])),
  };
}

// A cancelled check proved nothing, so it does not count as a pass.
function resultsCode(snapshot: RunSnapshot): number {
  const unproven = snapshot.checks.some((view) => {
    const bucket = bucketOf(view.status);
    return bucket === "failed" || bucket === "cancelled";
  });
  return unproven ? 1 : 0;
}

// Reads events.jsonl and never writes it. Each poll replays the whole file
// and prints the steps past the ones already printed; the snapshot is taken
// before the events are read, so once it says every check is settled, the
// events read after it hold every step it saw.
async function followCommand(ctx: Context): Promise<number> {
  const id = ctx.state.currentId();
  if (id === null) {
    throw new AgentError(`no run yet for ${ctx.state.root}`, cmd(ctx, "run"));
  }
  const run = ctx.state.readRun(id);
  const typical = ctx.state.typicalDurations(run);
  const names = run.checks.map((check) => check.name);
  let printed = 0;
  for (;;) {
    const snapshot = ctx.state.snapshot(id);
    let steps;
    try {
      steps = replay(names, readEvents(eventsPath(snapshot.dir)));
    } catch (err) {
      if (!(err instanceof IllegalTransition)) throw err;
      throw new AgentError(`inconsistent events in ${eventsPath(snapshot.dir)}: ${err.message}`, cmd(ctx, "run"));
    }
    for (const step of steps.slice(printed)) {
      const views = presentChecks({ checks: step.checks, outcome: null }, true);
      const view = views.find((candidate) => candidate.name === step.event.check)!;
      // The estimate as it stood when the change happened, not as of now.
      const eta = estimate(views, run.checks, typical, Date.parse(step.event.at));
      const at = { ...snapshot, checks: views };
      out(ctx.json ? `${checkJson(at, view, eta)}\n` : changeText(at, view, eta));
    }
    printed = steps.length;
    if (snapshot.checks.every(isSettled)) {
      const eta = etaOf(snapshot, typical);
      // An orphan has no event of its own; its unknown status is derived.
      for (const view of snapshot.checks.filter((candidate) => candidate.orphan)) {
        out(ctx.json ? `${checkJson(snapshot, view, eta)}\n` : changeText(snapshot, view, eta));
      }
      const next = nextFor(ctx, snapshot);
      out(ctx.json ? `${JSON.stringify(summarize(snapshot, next, eta))}\n` : summaryText(snapshot, next, eta));
      return resultsCode(snapshot);
    }
    await sleep(POLL_MS);
  }
}

function initCommand(ctx: Context, names: string[], write: boolean, force: boolean): number {
  const { checks, leftOut } = proposeChecks(ctx.state.root, names);
  const durations = ctx.state.passDurations(checks);
  const proposed = checks.map((check) => {
    const ms = durations.get(check.name);
    const timeoutSec = ms === undefined ? null : suggestTimeoutSec(ms);
    return timeoutSec === null ? check : { ...check, timeoutSec };
  });
  const file = path.join(ctx.state.root, CONFIG_FILE);
  const exists = existsSync(file);
  const content = configText(proposed);
  if (write) {
    if (exists && !force) {
      throw new AgentError(`${file} already exists, and init does not replace it`, cmd(ctx, `init${argsOf(names)} --write --force`));
    }
    writeFileSync(file, content);
  }
  const next = write ? cmd(ctx, "run") : cmd(ctx, `init${argsOf(names)} --write${exists ? " --force" : ""}`);
  const widen = leftOut.length === 0 ? null : cmd(ctx, `init${argsOf([...checks.map((check) => check.name), ...leftOut])}`);
  if (ctx.json) {
    out(`${JSON.stringify({ type: "init", file, written: write, existed: exists, config: JSON.parse(content), left_out: leftOut, next })}\n`);
    return 0;
  }
  const lines = [write ? `wrote ${file}:` : `would write ${file}${exists ? " (it exists; --force replaces it)" : ""}:`, content.trimEnd()];
  if (widen !== null) lines.push(`left out: ${leftOut.join(", ")} (to add them: ${widen})`);
  lines.push(`next: ${next}`);
  out(`${lines.join("\n")}\n`);
  return 0;
}

function argsOf(names: readonly string[]): string {
  return names.map((name) => ` ${shellQuote(name)}`).join("");
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
  if (buckets.includes("failed") || buckets.includes("cancelled")) return cmd(ctx, "run --failed");
  return null;
}

function cmd(ctx: Context, rest: string): string {
  return `firstlight ${rest}${ctx.cwdFlag}`;
}

function out(textValue: string): void {
  writeSync(1, textValue);
}

const tooOld = nodeVersionError(process.version);
if (tooOld !== null) exitWithEnvelope(tooOld);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => exitWithEnvelope(err),
);
