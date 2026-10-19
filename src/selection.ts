// The selector protocol: when firstlight asks a check's selector which
// tests the changes reach, what it gives the selector, how it reads the
// answer, and the command it then runs. firstlight knows no language; a
// selector does, and it is any command that reads one JSON object on stdin
// and prints one on stdout. Reading git, running the selector, and the
// kept runs are the CLI's and the store's. No I/O.

import { shellQuote } from "./names.ts";

export const TESTS_PLACEHOLDER = "{tests}";
export const PROTOCOL_VERSION = 1;
// The directory a check's recorder may write into, set only while the check
// runs its full command.
export const RECORD_ENV = "FIRSTLIGHT_RECORD";
// A selector reads the map it recorded during a full run and the change
// list, which takes seconds even for an interpreter with a slow start
// (bundle exec, npx). One that takes longer is stuck, or saves less than
// the full run would cost.
export const SELECTOR_TIMEOUT_MS = 60_000;
const STDERR_LINES = 3;
const STDERR_LINE_CHARS = 200;

export interface Change {
  status: string;
  path: string;
}

// What the selector reads on stdin. `base.record` is the directory the
// check's own recorder wrote into during that full pass, or null when it
// wrote nothing there.
export interface SelectorInput {
  version: typeof PROTOCOL_VERSION;
  check: string;
  tree: string;
  base: { run: string; tree: string; record: string | null };
  changes: Change[];
}

// A selector may add fields of its own to a test, such as the file it
// lives in; firstlight keeps them in the run record and reads only `id`.
export type SelectedTest = Record<string, unknown> & { id: string };

export type SelectorAnswer = { tests: SelectedTest[] } | { full: string };

export interface SelectorExit {
  // The error that kept the shell from starting, if one did.
  error: string | null;
  timedOut: boolean;
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

// A check that ran only the selected tests. `command` is null when the
// selector chose none, or when no changed file matched the check's `paths`,
// and then nothing ran. `paths` is set only in that second case.
export interface Narrowing {
  base: string;
  files: string[];
  tests: SelectedTest[];
  command: string | null;
  paths?: string[];
}

// A check with a selector that had a full pass to count from and still ran
// in full, and why.
export interface FullRun {
  base: string;
  reason: string;
}

// `git diff --name-status -z --no-renames` prints a status field and a path
// field per change, each ended by NUL. A rename comes out as a deletion and
// an addition.
export function parseNameStatus(output: string): Change[] | null {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return null;
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const file = fields[i + 1]!;
    if (!/^[A-Z][0-9]*$/.test(status) || file.length === 0) return null;
    changes.push({ status, path: file });
  }
  return changes;
}

// Decided before the selector runs, so a change that reaches every test (a
// lockfile, the test runner's config) costs no selector call. A deletion is
// the selector's to judge: only it knows which tests read the deleted file.
export function gateChanges(fullOn: readonly string[], changes: readonly Change[] | null): { changes: Change[] } | { full: string } {
  if (changes === null) return { full: "git could not list the changed files" };
  if (changes.length === 0) return { full: "no file changed" };
  const pinned = changes.find((change) => fullOn.some((pattern) => matchesPath(pattern, change.path)));
  if (pinned !== undefined) return { full: `${pinned.path} matches fullOn` };
  return { changes: [...changes] };
}

// A check with `paths` reads only the files they match, so when git listed
// changes since its newest full pass and none of them matches, that pass
// still holds and the check runs nothing. A deleted file counts as a
// change to its path. No listing, or an empty one, runs the check: the
// first means git could not tell, and the second is the cache's to judge.
export function skipByPaths(base: string, paths: readonly string[], changes: readonly Change[] | null): Narrowing | null {
  if (changes === null || changes.length === 0) return null;
  if (changes.some((change) => paths.some((pattern) => matchesPath(pattern, change.path)))) return null;
  return { base, files: changedFiles(changes), tests: [], command: null, paths: [...paths] };
}

// Every way the selector can fail ends in the full run, never in a guess,
// and the reason names the failure with the start of the selector's stderr.
export function readSelector(exit: SelectorExit): SelectorAnswer {
  const failed = (problem: string): SelectorAnswer => ({ full: `${problem}${stderrNote(exit.stderr)}` });
  if (exit.error !== null) return failed(`the selector could not start (${exit.error})`);
  if (exit.timedOut) return failed(`the selector did not answer within ${SELECTOR_TIMEOUT_MS / 1000}s`);
  if (exit.code === null) return failed(`the selector was stopped by ${exit.signal ?? "a signal"}`);
  if (exit.code !== 0) return failed(`the selector exited ${exit.code}`);
  const answer = parseSelectorOutput(exit.stdout);
  if ("invalid" in answer) return failed(`the selector printed ${answer.invalid}`);
  if ("full" in answer) return { full: `the selector asked for it: ${answer.full}` };
  return answer;
}

// The one JSON object a selector prints, with exactly one of `tests` and
// `full`. A test id named twice runs once, where it was first named.
export function parseSelectorOutput(stdout: string): SelectorAnswer | { invalid: string } {
  if (stdout.trim().length === 0) return { invalid: "nothing" };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { invalid: "output that is not one JSON object" };
  }
  if (!isRecord(raw)) return { invalid: "JSON that is not an object" };
  const unknown = Object.keys(raw).find((key) => key !== "tests" && key !== "full");
  if (unknown !== undefined) return { invalid: `an object with the unknown key ${JSON.stringify(unknown)}` };
  if ("tests" in raw && "full" in raw) return { invalid: `an object with both "tests" and "full"` };
  if ("full" in raw) {
    return typeof raw.full === "string" && raw.full.length > 0 ? { full: raw.full } : { invalid: `"full" that is not a non-empty string` };
  }
  if (!("tests" in raw)) return { invalid: `an object with neither "tests" nor "full"` };
  if (!Array.isArray(raw.tests)) return { invalid: `"tests" that is not an array` };
  const tests: SelectedTest[] = [];
  const seen = new Set<string>();
  for (const test of raw.tests) {
    if (!isRecord(test) || typeof test.id !== "string" || test.id.length === 0) {
      return { invalid: `a test without a non-empty string "id"` };
    }
    if (seen.has(test.id)) continue;
    seen.add(test.id);
    tests.push(test as SelectedTest);
  }
  return { tests };
}

export function narrowTo(base: string, changes: readonly Change[], tests: readonly SelectedTest[], runSelected: string): Narrowing {
  return {
    base,
    files: changedFiles(changes),
    tests: [...tests],
    command: tests.length === 0 ? null : substituteTests(runSelected, tests.map((test) => test.id)),
  };
}

// The command a narrowed result stands for in its cache key. Choosing no
// test, or no change matching `paths`, proves something too, but never what
// the full run proves, so each gets a key no shell command shares.
// `command` is the check's runSelected, or its run for a `paths` skip.
export function narrowedKeyCommand(narrowing: Narrowing, command: string): string {
  if (narrowing.paths !== undefined) return JSON.stringify(["no change matches paths", narrowing.paths, command]);
  return narrowing.command ?? JSON.stringify(["no test selected", command]);
}

function changedFiles(changes: readonly Change[]): string[] {
  return [...new Set(changes.map((change) => change.path))].sort();
}

// A replacer function, because a replacement string reads "$'" and "$&"
// as patterns, and a quoted id like '$' holds one.
export function substituteTests(runSelected: string, ids: readonly string[]): string {
  const words = ids.map(shellQuote).join(" ");
  return runSelected.replaceAll(TESTS_PLACEHOLDER, () => words);
}

// A path glob: "*" stays inside one "/" segment, "**" crosses them, and
// any other character is literal, the same rules as the script patterns
// with "/" in place of ":".
export function matchesPath(pattern: string, file: string): boolean {
  let source = "";
  for (const part of pattern.split(/(\*+)/)) {
    if (part.length === 0) continue;
    if (part.startsWith("*")) source += part.length === 1 ? "[^/]*" : ".*";
    else source += part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su").test(file);
}

// One line, so the reason fits a status line.
function stderrNote(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, STDERR_LINES)
    .map((line) => (line.length > STDERR_LINE_CHARS ? `${line.slice(0, STDERR_LINE_CHARS)}...` : line));
  return lines.length === 0 ? "" : ` (stderr: ${lines.join("; ")})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
