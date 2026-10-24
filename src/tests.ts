// The test results protocol: the file a check's test recorders append one
// line per finished test to, what a line holds, and how firstlight reads
// the lines back into counts and into a diagnostic for each failed test.
// firstlight knows no test runner; a recorder does, and it is anything that
// appends these lines to the file $FIRSTLIGHT_TESTS names. The recorders,
// and setting the variable, are the supervisor's; reading the file is the
// store's. No I/O.

import path from "node:path";
import { shellQuote } from "./names.ts";
import type { Diagnostic } from "./diagnostics.ts";

export const TESTS_ENV = "FIRSTLIGHT_TESTS";
export const TEST_STATUSES = ["passed", "failed", "skipped"] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];
const MESSAGE_MAX = 300;

// One finished test. `file` is relative to the repository root when it is
// inside it, and `rerun` runs from the root.
export interface TestResult {
  file: string;
  line: number | null;
  name: string;
  status: TestStatus;
  duration_ms: number | null;
  message: string | null;
  rerun: string | null;
}

export type TestCounts = Record<TestStatus, number>;

// What a recorder writes: the fields of TestResult, with `file` absolute or
// relative to `cwd`, the directory the test process ran in, where its
// `rerun` runs too. A line that does not have this shape is skipped, and so
// is a last line without its newline, which may still be in the middle of
// being written.
export function parseTestLines(text: string, root: string): TestResult[] {
  const lines = text.split("\n");
  lines.pop();
  const out: TestResult[] = [];
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const result = toResult(raw, root);
    if (result !== null) out.push(result);
  }
  return out;
}

export function countTests(results: readonly TestResult[]): TestCounts {
  const counts: TestCounts = { passed: 0, failed: 0, skipped: 0 };
  for (const result of results) counts[result.status] += 1;
  return counts;
}

// A failed test in the shape of every other problem a check reports, so
// `results --new` tells a new failure from a known one the same way. The
// test's name is its rule, as the vitest and node:test parsers name it.
export function testDiagnostics(results: readonly TestResult[]): Diagnostic[] {
  return results
    .filter((result) => result.status === "failed")
    .map((result) => ({
      file: result.file,
      line: result.line,
      col: null,
      rule: result.name,
      message: result.message ?? "",
      ...(result.rerun === null ? {} : { rerun: result.rerun }),
    }));
}

function toResult(raw: unknown, root: string): TestResult | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { file, name, status, cwd } = record;
  if (typeof file !== "string" || file.length === 0 || typeof name !== "string" || name.length === 0) return null;
  if (!(TEST_STATUSES as readonly unknown[]).includes(status)) return null;
  const dir = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : root;
  const rerun = typeof record.rerun === "string" && record.rerun.length > 0 ? fromRoot(record.rerun, dir, root) : null;
  return {
    file: relativeTo(root, path.resolve(dir, file)),
    line: positive(record.line),
    name,
    status: status as TestStatus,
    duration_ms: typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms) && record.duration_ms >= 0 ? record.duration_ms : null,
    message: typeof record.message === "string" && record.message.trim().length > 0 ? clip(record.message) : null,
    rerun,
  };
}

// A test process can run below the root, as `cd web && npm test` does; its
// rerun command only works from there.
function fromRoot(command: string, dir: string, root: string): string {
  return path.relative(root, dir) === "" ? command : `cd ${shellQuote(relativeTo(root, dir))} && ${command}`;
}

// Relative to the root when below it, absolute otherwise.
function relativeTo(root: string, file: string): string {
  const relative = path.relative(root, file);
  const outside = relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
  return outside ? file : relative;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= MESSAGE_MAX ? flat : `${flat.slice(0, MESSAGE_MAX - 3)}...`;
}
