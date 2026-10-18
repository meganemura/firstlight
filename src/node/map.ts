// The map a recording becomes: every function any test compiled in each
// source file of the repository, and for each test file the source files it
// loaded and the functions it ran. It is built from the raw V8 coverage the
// recorder wrote, in the recorder's own layout, and read back by the
// selector. Reading the files is command.ts's. No I/O.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { field, parseJson } from "./json.ts";

export const MAP_VERSION = 1;
// The recorder's layout under $FIRSTLIGHT_RECORD: one directory per test
// file under RAW_DIR, holding TEST_MARKER and any number of coverage files,
// the worker's own and one for each process the test started.
export const RAW_DIR = "raw";
export const TEST_MARKER = "test.json";
export const MAP_FILE = "map.json";

// Offsets into the source text Node compiled. Node strips TypeScript types
// by blanking them, so these are offsets into the file as written.
export interface FunctionSpan {
  start: number;
  end: number;
  name: string;
}

export interface CoverageMap {
  version: typeof MAP_VERSION;
  // Repository-relative source file -> every function any test compiled in
  // it, ordered by start, one entry per span. A key means some test loaded
  // the file. The top-level function is left out: every loader runs it.
  files: Record<string, FunctionSpan[]>;
  // Repository-relative test file -> each source file it loaded -> the
  // indexes into `files` of the functions it ran, ascending.
  tests: Record<string, Record<string, number[]>>;
}

// What the recorder wrote for one test file. `worker` names the process and
// thread it ran in, so two test files that shared one are caught.
export interface RawRecord {
  test: string;
  worker: string;
  scripts: FileCoverage[];
}

// The part of one V8 ScriptCoverage the map reads, for a repository file.
export interface FileCoverage {
  file: string;
  functions: { functionName: string; ranges: { startOffset: number; endOffset: number; count: number }[] }[];
}

export function buildMap(records: readonly RawRecord[], root: string): CoverageMap | { full: string } {
  const workers = new Map<string, string>();
  for (const record of records) {
    const other = workers.get(record.worker);
    // A worker that runs a second test file keeps the modules the first one
    // loaded, so the second one's coverage misses them.
    if (other !== undefined) {
      return { full: `${repoPath(root, other) ?? other} and ${repoPath(root, record.test) ?? record.test} ran in one worker; the recorder needs isolate: true` };
    }
    workers.set(record.worker, record.test);
  }
  const known = new Map<string, Map<string, FunctionSpan>>();
  const ran = new Map<string, Map<string, Set<string>>>();
  for (const record of records) {
    const test = repoPath(root, record.test);
    if (test === null) continue;
    const loaded = ran.get(test) ?? new Map<string, Set<string>>();
    ran.set(test, loaded);
    for (const { file, functions } of record.scripts) {
      const spans = known.get(file) ?? new Map<string, FunctionSpan>();
      known.set(file, spans);
      const executed = loaded.get(file) ?? new Set<string>();
      loaded.set(file, executed);
      // V8 lists the script's top-level function first, and a function's
      // first range is the whole function, with its call count.
      for (const fn of functions.slice(1)) {
        const range = fn.ranges[0]!;
        const key = spanKey(range.startOffset, range.endOffset);
        spans.set(key, { start: range.startOffset, end: range.endOffset, name: fn.functionName });
        if (range.count > 0) executed.add(key);
      }
    }
  }
  // Sorted, so one recording always writes the same map.
  const files: CoverageMap["files"] = {};
  const indexes = new Map<string, Map<string, number>>();
  for (const file of [...known.keys()].sort()) {
    const spans = [...known.get(file)!.values()].sort((a, b) => a.start - b.start || b.end - a.end);
    files[file] = spans;
    indexes.set(file, new Map(spans.map((span, index) => [spanKey(span.start, span.end), index])));
  }
  const tests: CoverageMap["tests"] = {};
  for (const test of [...ran.keys()].sort()) {
    const loaded = ran.get(test)!;
    tests[test] = Object.fromEntries(
      [...loaded.keys()].sort().map((file) => [file, [...loaded.get(file)!].map((key) => indexes.get(file)!.get(key)!).sort((a, b) => a - b)]),
    );
  }
  return { version: MAP_VERSION, files, tests };
}

// The repository files of one coverage file, as Node writes it for
// NODE_V8_COVERAGE and as the recorder writes its worker's. Node's own
// scripts and the dependencies' are most of every file, and a recording
// holds hundreds of files, so they go here, before a record keeps them. A
// process killed mid-write leaves a file that does not parse; it then
// counts as no coverage.
export function parseCoverage(text: string, root: string): FileCoverage[] {
  const result = field(parseJson(text), "result");
  if (!Array.isArray(result)) return [];
  return result.flatMap((script: unknown) => {
    const url = field(script, "url");
    const functions = field(script, "functions");
    if (typeof url !== "string" || !Array.isArray(functions)) return [];
    const file = sourcePath(root, url);
    return file === null ? [] : [{ file, functions }];
  });
}

// The recorder's TEST_MARKER.
export function parseTestFile(text: string): { test: string; worker: string } | null {
  const raw = parseJson(text);
  const test = field(raw, "file");
  const worker = field(raw, "worker");
  return typeof test === "string" && typeof worker === "string" ? { test, worker } : null;
}

// A map this version wrote, or null for anything else, which then counts as
// no recording. The map is this command's own file, written whole by a
// rename, so its version says what it holds.
export function parseMap(text: string): CoverageMap | null {
  const raw = parseJson(text);
  return field(raw, "version") === MAP_VERSION ? (raw as CoverageMap) : null;
}

// fileURLToPath drops the query vitest or a loader adds, such as a test
// file's "?vitest=" or a mocked module's "?mock=". It refuses the node: URLs
// of Node's own scripts, which are most of every coverage file.
function sourcePath(root: string, url: string): string | null {
  return url.startsWith("file:") ? repoPath(root, fileURLToPath(url)) : null;
}

// Dependencies change only with the lockfile, which a check's fullOn names,
// so their code stays out of the map. firstlight signals process groups,
// so it runs on POSIX systems, where a relative path never names a drive.
function repoPath(root: string, file: string): string | null {
  const segments = path.relative(root, file).split(path.sep);
  if (segments[0] === "" || segments[0] === ".." || segments.includes("node_modules")) return null;
  return segments.join("/");
}

function spanKey(start: number, end: number): string {
  return `${start}:${end}`;
}
