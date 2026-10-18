// The on-disk state of runs under XDG_STATE_HOME, never inside the checked
// repository: repository identity, run ids, run.json, events.jsonl, the
// `current` pointer, check logs, and pruning, and the earlier runs read back
// for the time-left estimate, for reused passes, and for the baselines of
// `results --new`. The CLI writes run.json and `current`; only the
// supervisor appends to events.jsonl.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CHECK_STATUSES,
  foldEvents,
  IllegalTransition,
  presentChecks,
  type CheckSpec,
  type CheckState,
  type CheckView,
  type RunEventLine,
  type RunOutcome,
} from "./checks.ts";
import { findBaselines, type Baseline } from "./baseline.ts";
import { findReuse, type Reuse } from "./cache.ts";
import { AgentError, messageOf } from "./errors.ts";
import { typicalDurations, type PastRun } from "./eta.ts";
import { logFileNames } from "./names.ts";
import { isPidAlive } from "./processes.ts";
import type { FullRun, Narrowing } from "./selection.ts";

export const KEEP_RUNS = 20;
const RUN_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface RunRecord {
  id: string;
  root: string;
  supervisor_pid: number | null;
  started_at: string;
  checks: CheckSpec[];
  // Absent in a run written before the cache existed, and empty when the
  // root had no tree key: such a run is never a cache source.
  cache_keys?: Record<string, string>;
  // The results the CLI chose to reuse; the supervisor records them as
  // events, so it stays the only writer of events.jsonl.
  reused?: Record<string, Reuse>;
  // The tree key the run was keyed on; a later run diffs against it to
  // narrow a check. Absent in a run written before narrowing existed.
  tree?: string;
  // The checks whose selector chose the tests to run, and the checks with a
  // selector that ran in full although they had a full pass to count from.
  narrowed?: Record<string, Narrowing>;
  full_run?: Record<string, FullRun>;
}

// What a check's selector reads about the full pass it counts from.
export interface NarrowBase {
  run: string;
  tree: string;
  // The directory the check's recorder wrote into, or null when it wrote
  // nothing.
  record: string | null;
}

interface PastRunFiles {
  record: RunRecord;
  states: CheckState[];
}

export interface RunSnapshot {
  run: RunRecord;
  dir: string;
  outcome: RunOutcome | null;
  supervisorAlive: boolean;
  checks: CheckView[];
}

export function resolveRoot(cwd: string): string {
  let dir: string;
  try {
    dir = realpathSync(cwd);
    if (!statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new AgentError(`not a directory: ${cwd}`, "pass an existing directory to --cwd");
  }
  try {
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    if (top.length > 0) return top;
  } catch {
    // Not a git repository, or no git: the directory itself is the root.
  }
  return dir;
}

export function stateBase(): string {
  const fromEnv = process.env.XDG_STATE_HOME?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), ".local", "state");
  return path.resolve(base, "firstlight");
}

export function repoKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

export class RepoState {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = path.join(stateBase(), repoKey(root));
  }

  runDir(id: string): string {
    return path.join(this.dir, "runs", id);
  }

  currentId(): string | null {
    let text: string;
    try {
      text = readFileSync(path.join(this.dir, "current"), "utf8").trim();
    } catch (err) {
      if (isEnoent(err)) return null;
      throw new AgentError(`could not read the current run: ${messageOf(err)}`, `check permissions on ${this.dir}`);
    }
    return RUN_ID_RE.test(text) ? text : null;
  }

  setCurrent(id: string): void {
    atomicWrite(path.join(this.dir, "current"), `${id}\n`);
  }

  createRun(
    checks: CheckSpec[],
    cacheKeys: ReadonlyMap<string, string>,
    reused: ReadonlyMap<string, Reuse>,
    tree: string | null = null,
    narrowed: ReadonlyMap<string, Narrowing> = new Map(),
    fullRun: ReadonlyMap<string, FullRun> = new Map(),
  ): RunRecord {
    const id = newRunId();
    mkdirSync(this.runDir(id), { recursive: true });
    const run: RunRecord = {
      id,
      root: this.root,
      supervisor_pid: null,
      started_at: new Date().toISOString(),
      checks,
      cache_keys: Object.fromEntries(cacheKeys),
      reused: Object.fromEntries(reused),
    };
    if (tree !== null) run.tree = tree;
    if (narrowed.size > 0) run.narrowed = Object.fromEntries(narrowed);
    if (fullRun.size > 0) run.full_run = Object.fromEntries(fullRun);
    this.writeRun(run);
    return run;
  }

  writeRun(run: RunRecord): void {
    atomicWrite(path.join(this.runDir(run.id), "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  }

  readRun(id: string): RunRecord {
    const file = path.join(this.runDir(id), "run.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new AgentError(`could not read ${file}: ${messageOf(err)}`, "start a new run with `firstlight run`");
    }
    if (!isRunRecord(raw)) {
      throw new AgentError(`unreadable run record: ${file}`, "start a new run with `firstlight run`");
    }
    return raw;
  }

  snapshot(id: string): RunSnapshot {
    const run = this.readRun(id);
    const dir = this.runDir(id);
    const names = run.checks.map((check) => check.name);
    let folded = this.fold(dir, names);
    let supervisorAlive = true;
    if (folded.outcome === null) {
      supervisorAlive = isPidAlive(run.supervisor_pid);
      // The supervisor writes its final event and then exits; read again so
      // that ordering is never mistaken for an orphan.
      if (!supervisorAlive) folded = this.fold(dir, names);
    }
    return { run, dir, outcome: folded.outcome, supervisorAlive, checks: presentChecks(folded, supervisorAlive) };
  }

  private fold(dir: string, names: string[]) {
    try {
      return foldEvents(names, readEvents(path.join(dir, "events.jsonl")));
    } catch (err) {
      if (err instanceof IllegalTransition) {
        throw new AgentError(
          `inconsistent events in ${path.join(dir, "events.jsonl")}: ${err.message}`,
          "start a new run with `firstlight run`",
        );
      }
      throw err;
    }
  }

  // A narrowed run's time is the time of the tests it chose, not of the
  // full command, so it is left out.
  typicalDurations(run: RunRecord): Map<string, number> {
    const past: PastRun[] = this.pastRuns()
      .filter((files) => files.record.id < run.id)
      .map((files) => ({
        checks: files.record.checks,
        states: files.states.filter((state) => files.record.narrowed?.[state.name] === undefined),
      }));
    return typicalDurations(run.checks, past);
  }

  // The newest pass of each check in any kept run, for checks that no run
  // holds yet, as `firstlight init` proposes them.
  passDurations(specs: CheckSpec[]): Map<string, number> {
    const past: PastRun[] = this.pastRuns().map((files) => ({ checks: files.record.checks, states: files.states }));
    return typicalDurations(specs, past);
  }

  // The run each check of `run` is compared with, keyed by check name, with
  // that run's record, whose parser and log the comparison reads.
  baselines(run: RunRecord): Map<string, Baseline & { record: RunRecord }> {
    const past = this.pastRuns().filter((files) => files.record.id < run.id);
    const records = new Map(past.map((files) => [files.record.id, files.record]));
    const found = findBaselines(
      run.checks,
      past.map((files) => ({ id: files.record.id, checks: files.record.checks, states: files.states })),
    );
    return new Map([...found].map(([name, baseline]) => [name, { ...baseline, record: records.get(baseline.run)! }]));
  }

  // Called before the new run exists, so every kept run is earlier.
  reusable(cacheKeys: ReadonlyMap<string, string>): Map<string, Reuse> {
    const past = this.pastRuns().map((files) => ({
      id: files.record.id,
      keys: files.record.cache_keys ?? {},
      states: files.states,
    }));
    const found = findReuse(cacheKeys, past);
    for (const [name, reuse] of found) {
      if (reuse.status !== "failed") continue;
      const origin = past.find((run) => run.id === reuse.run);
      if (origin === undefined) {
        found.delete(name);
        continue;
      }
      // The origin ran the check under its own name there, which may differ.
      const originName = origin.states.find((state) => origin.keys[state.name] === cacheKeys.get(name))?.name ?? name;
      const record = this.readRun(origin.id);
      const log = logPaths(this.runDir(origin.id), record.checks).get(originName);
      if (log === undefined) found.delete(name);
      else found.set(name, { ...reuse, log });
    }
    return found;
  }

  // The newest kept run that ran this check's full command on its own tree
  // and passed: a narrowed pass only proves the tests it chose, so counting
  // from it would let changes slip between two narrowings, and a reused
  // pass ran nothing, so its recorder wrote nothing. The run it reused is
  // older and on the same tree, and the search reaches it.
  narrowBase(check: CheckSpec): NarrowBase | null {
    for (const files of this.pastRuns()) {
      const { record, states } = files;
      if (record.tree === undefined || record.narrowed?.[check.name] !== undefined) continue;
      const spec = record.checks.find((candidate) => candidate.name === check.name);
      if (spec?.run !== check.run) continue;
      const state = states.find((candidate) => candidate.name === check.name);
      if (state?.status !== "passed" || state.cached_from !== null) continue;
      const dir = recordPaths(this.runDir(record.id), record.checks).get(check.name)!;
      return { run: record.id, tree: record.tree, record: existsSync(dir) ? dir : null };
    }
    return null;
  }

  // Newest first. Only the kept runs are read, so the history costs no file
  // of its own. An earlier run that no longer reads cleanly is history with
  // nothing to say, not a reason to fail the current command.
  private pastRuns(): PastRunFiles[] {
    const past: PastRunFiles[] = [];
    for (const id of this.runIds()) {
      try {
        const record = this.readRun(id);
        const names = record.checks.map((check) => check.name);
        const folded = foldEvents(names, readEvents(eventsPath(this.runDir(id))));
        past.push({ record, states: folded.checks });
      } catch {
        continue;
      }
    }
    return past;
  }

  // Newest first. Run ids sort by creation time.
  runIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(path.join(this.dir, "runs"));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return names.filter((name) => RUN_ID_RE.test(name)).sort().reverse();
  }

  prune(keep: number = KEEP_RUNS): void {
    for (const id of this.runIds().slice(keep)) {
      rmSync(this.runDir(id), { recursive: true, force: true });
    }
  }
}

// Derived from the run's own check list on every read, so run.json needs no
// field for it and a run written before script and command checks existed
// keeps `<name>.log`.
export function logPaths(runDir: string, checks: readonly CheckSpec[]): Map<string, string> {
  const files = logFileNames(checks.map((check) => check.name));
  return new Map([...files].map(([name, file]) => [name, path.join(runDir, file)]));
}

// The directory a check's recorder writes into during a full run, named
// like its log so that two checks never share one. Pruning a run removes
// it with the run.
export function recordPaths(runDir: string, checks: readonly CheckSpec[]): Map<string, string> {
  const files = logFileNames(checks.map((check) => check.name));
  return new Map([...files].map(([name, file]) => [name, path.join(runDir, "record", file.slice(0, -".log".length))]));
}

export function eventsPath(runDir: string): string {
  return path.join(runDir, "events.jsonl");
}

// One appendFileSync per event is one write(2) with O_APPEND, so a reader
// never sees two events interleaved.
export function appendEvent(runDir: string, event: RunEventLine): void {
  appendFileSync(eventsPath(runDir), `${JSON.stringify(event)}\n`);
}

export function readEvents(file: string): RunEventLine[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const lines = text.split("\n");
  // A line without its newline may still be in the middle of being written.
  lines.pop();
  const events: RunEventLine[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new AgentError(`unreadable line in ${file}: ${line}`, "start a new run with `firstlight run`");
    }
    if (!isEvent(raw)) {
      throw new AgentError(`unexpected event in ${file}: ${line}`, "start a new run with `firstlight run`");
    }
    events.push(raw);
  }
  return events;
}

const TAIL_BYTES = 256 * 1024;

export function tailLines(file: string, count: number): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  try {
    const size = statSync(file).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    // The first line is partial when the read started mid-file.
    if (length < size) lines.shift();
    return lines.slice(-count);
  } finally {
    closeSync(fd);
  }
}

// Enough for any log a parser reads in practice. A longer log keeps its
// end, where test runners print their failures.
const PARSE_BYTES = 8 * 1024 * 1024;

export function readLogEnd(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (err) {
    if (isEnoent(err)) return "";
    throw err;
  }
  try {
    const size = statSync(file).size;
    const length = Math.min(size, PARSE_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function newRunId(now = Date.now()): string {
  let time = now;
  let timeChars = "";
  for (let i = 0; i < 10; i += 1) {
    timeChars = CROCKFORD[time % 32] + timeChars;
    time = Math.floor(time / 32);
  }
  let randomChars = "";
  for (const byte of randomBytes(16)) randomChars += CROCKFORD[byte % 32];
  return timeChars + randomChars;
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.root !== "string" || typeof value.started_at !== "string") return false;
  if (!(value.supervisor_pid === null || Number.isInteger(value.supervisor_pid))) return false;
  if (!Array.isArray(value.checks)) return false;
  if (value.cache_keys !== undefined && !isStringRecord(value.cache_keys)) return false;
  if (value.reused !== undefined && !isReuseRecord(value.reused)) return false;
  if (value.tree !== undefined && typeof value.tree !== "string") return false;
  if (value.narrowed !== undefined && !isNarrowedRecord(value.narrowed)) return false;
  if (value.full_run !== undefined && !isFullRunRecord(value.full_run)) return false;
  return value.checks.every(
    (check) =>
      isRecord(check) &&
      typeof check.name === "string" &&
      typeof check.run === "string" &&
      Array.isArray(check.after) &&
      typeof check.timeoutSec === "number" &&
      (check.parser === undefined ||
        check.parser === null ||
        typeof check.parser === "string" ||
        (Array.isArray(check.parser) && check.parser.every((name) => typeof name === "string"))) &&
      (check.selector === undefined || isSelector(check.selector)),
  );
}

function isEvent(value: unknown): value is RunEventLine {
  if (!isRecord(value) || typeof value.at !== "string") return false;
  if (value.type === "run") return value.status === "done" || value.status === "cancelled";
  return (
    value.type === "check" &&
    typeof value.check === "string" &&
    CHECK_STATUSES.includes(value.status as never) &&
    (value.cached_from === undefined || typeof value.cached_from === "string") &&
    (value.no_tests === undefined || value.no_tests === true)
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isReuseRecord(value: unknown): value is Record<string, Reuse> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.run === "string" &&
        typeof entry.elapsed_ms === "number" &&
        (entry.status === undefined || entry.status === "passed" || entry.status === "failed") &&
        (entry.exit_code === undefined || Number.isInteger(entry.exit_code)) &&
        (entry.log === undefined || typeof entry.log === "string"),
    )
  );
}

function isNarrowedRecord(value: unknown): value is Record<string, Narrowing> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.base === "string" &&
        (entry.command === null || typeof entry.command === "string") &&
        isStringArray(entry.files) &&
        Array.isArray(entry.tests) &&
        entry.tests.every((test) => isRecord(test) && typeof test.id === "string"),
    )
  );
}

function isFullRunRecord(value: unknown): value is Record<string, FullRun> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isRecord(entry) && typeof entry.base === "string" && typeof entry.reason === "string")
  );
}

function isSelector(value: unknown): boolean {
  return isRecord(value) && typeof value.select === "string" && typeof value.runSelected === "string" && isStringArray(value.fullOn);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
