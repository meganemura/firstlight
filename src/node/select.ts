// Which test files a set of changes reaches, by the map of the base run's
// recording: a changed test file selects itself, and a changed source file
// selects the tests that ran the code it changed. A change no recording can
// see asks for the full run. Reading git and the map is command.ts's. No I/O.

import { matchesPath, type Change, type SelectedTest, type SelectorAnswer } from "../selection.ts";
import type { CoverageMap, FunctionSpan } from "./map.ts";

// The base side of one `git diff -U0` hunk: `count` lines from line `start`
// (1-based) were replaced or deleted, or, when `count` is 0, lines were
// inserted after line `start`.
export interface Hunk {
  start: number;
  count: number;
}

// A changed file as the base run saw it: the text the recorded offsets
// index, and where that text changed.
export interface Edit {
  base: string;
  hunks: Hunk[];
}

export interface SelectOptions {
  always: readonly string[];
  ignore: readonly string[];
}

// The code a change touched: code outside every function body, which every
// loader runs, or the bodies of these functions, indexes into the file's
// function table.
export interface Touched {
  top: boolean;
  functions: Set<number>;
}

// What a change in a file some test loaded reaches: every test that loaded
// it, for the reason given, or the tests that ran one of these functions.
type Reach = { loaders: string } | { functions: ReadonlySet<number> };

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_NAME = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

export function selectTests(
  map: CoverageMap,
  changes: readonly Change[],
  edits: ReadonlyMap<string, Edit | undefined>,
  options: SelectOptions,
): SelectorAnswer {
  const gone = new Set(changes.filter((change) => change.status === "D").map((change) => change.path));
  const chosen = new Map<string, string>();
  const choose = (test: string, reason: string): void => {
    if (!gone.has(test) && !chosen.has(test)) chosen.set(test, reason);
  };
  for (const change of changes) {
    if (options.ignore.some((glob) => matchesPath(glob, change.path))) continue;
    if (map.tests[change.path] !== undefined || TEST_NAME.test(change.path)) choose(change.path, "changed");
    const functions = map.files[change.path];
    if (functions === undefined) {
      // A source file no test loaded reaches no test. Any other file may be
      // read at run time, which coverage cannot see.
      if (CODE_FILE.test(change.path)) continue;
      return { full: `${change.path} is not code and no recording covers it` };
    }
    const reach = reachOf(change, functions, edits.get(change.path));
    for (const [test, loaded] of Object.entries(map.tests)) {
      const ran = loaded[change.path];
      if (ran === undefined) continue;
      if ("loaders" in reach) {
        choose(test, `${change.path} ${reach.loaders}`);
        continue;
      }
      const hit = ran.find((index) => reach.functions.has(index));
      if (hit !== undefined) choose(test, `${change.path} changed in ${functions[hit]!.name || "an anonymous function"}`);
    }
  }
  for (const test of Object.keys(map.tests)) {
    if (options.always.some((glob) => matchesPath(glob, test))) choose(test, "--always");
  }
  const tests: SelectedTest[] = [...chosen.keys()].sort().map((id) => ({ id, reason: chosen.get(id)! }));
  return { tests };
}

// The changed files a selection needs the base text and the hunks of: the
// ones some test loaded and that still exist.
export function editsNeeded(map: CoverageMap, changes: readonly Change[], options: SelectOptions): string[] {
  return changes
    .filter((change) => change.status !== "D" && map.files[change.path] !== undefined)
    .filter((change) => !options.ignore.some((glob) => matchesPath(glob, change.path)))
    .map((change) => change.path);
}

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  for (const line of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (match === null) continue;
    hunks.push({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) });
  }
  return hunks;
}

// Each position belongs to the innermost function whose body holds it, or
// to the top level. A body starts on the line after the function's first
// line, because that line holds its name and signature, which its callers
// and the code that defines it depend on, not only the code that calls it.
export function touchedCode(functions: readonly FunctionSpan[], edit: Edit): Touched {
  const lines = lineStarts(edit.base);
  const lineStart = (line: number): number => lines[line - 1] ?? edit.base.length;
  const bodies = functions.map((fn) => ({ start: nextLineStart(lines, fn.start, edit.base.length), end: fn.end }));
  const boundaries = bodies.flatMap((body) => [body.start, body.end]);
  const touched: Touched = { top: false, functions: new Set() };
  for (const hunk of edit.hunks) {
    // An insertion lands where the line after `start` begins, and runs
    // where the code at that position runs.
    const start = lineStart(hunk.count === 0 ? hunk.start + 1 : hunk.start);
    const end = hunk.count === 0 ? start + 1 : lineStart(hunk.start + hunk.count);
    // Lines past the end of the base text: the diff and the text disagree,
    // so nothing says which code changed.
    if (end <= start) touched.top = true;
    // The owner changes only where a body starts or ends, so the owners of
    // the positions from `start` to `end` are those of `start` and of each
    // boundary between.
    for (const position of [start, ...boundaries]) {
      if (position < start || position >= end) continue;
      const owner = innermost(bodies, position);
      if (owner === null) touched.top = true;
      else touched.functions.add(owner);
    }
  }
  return touched;
}

function reachOf(change: Change, functions: readonly FunctionSpan[], edit: Edit | undefined): Reach {
  if (change.status === "D") return { loaders: "was deleted" };
  // Git could not show the base text or the diff, so where it changed is unknown.
  if (edit === undefined) return { loaders: "changed" };
  const touched = touchedCode(functions, edit);
  return touched.top ? { loaders: "changed outside any function" } : { functions: touched.functions };
}

// V8's functions nest, and the table is ordered by start and then by end,
// longest first, so of the bodies that hold a position, the last one in the
// table is inside all the others.
function innermost(bodies: readonly { start: number; end: number }[], position: number): number | null {
  let owner: number | null = null;
  bodies.forEach((body, index) => {
    if (body.start <= position && position < body.end) owner = index;
  });
  return owner;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

// A function that ends on its first line has an empty body: this start is
// at or after its end.
function nextLineStart(lines: readonly number[], offset: number, length: number): number {
  return lines.find((start) => start > offset) ?? length;
}
