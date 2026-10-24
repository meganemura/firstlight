// The vitest setup file firstlight's recorders live in. It does two things,
// each only while firstlight sets its variable, so it can stay in the
// config. With FIRSTLIGHT_TESTS set, it appends one line per finished test
// to that file, in the shape src/tests.ts reads. With FIRSTLIGHT_RECORD
// set, during a full run, it records which code one test file runs, in its
// own worker and in every Node process the test starts, as raw V8 coverage
// in the layout layout.ts names; firstlight-node select reads it. It
// imports no other file of the repository: V8 under-reports the functions
// of a module that loaded before the coverage started.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { afterAll, beforeEach, expect, type RunnerTestCase } from "vitest";
import { RAW_DIR, RECORD_ENV, TESTS_ENV, TEST_MARKER } from "./layout.ts";

// Named apart from the files NODE_V8_COVERAGE writes, coverage-<pid>-*.json.
const WORKER_COVERAGE = "coverage-worker.json";

const record = process.env[RECORD_ENV];
const tests = process.env[TESTS_ENV];
const test = expect.getState().testPath;

if (tests) {
  beforeEach(({ task, onTestFinished }) => {
    const started = performance.now();
    onTestFinished(() => {
      appendFileSync(tests, `${JSON.stringify(testLine(task, performance.now() - started))}\n`);
    });
  });
}

// An empty FIRSTLIGHT_RECORD names no directory, so it records nothing too.
if (record && test !== undefined) {
  // Hashed, because a test file's path can be longer than a file name may be.
  const dir = path.join(record, RAW_DIR, createHash("sha256").update(test).digest("hex"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, TEST_MARKER), JSON.stringify({ file: test, worker: `${process.pid}/${threadId}` }));
  // Each process the test starts inherits this and writes its own coverage
  // here when it exits.
  process.env.NODE_V8_COVERAGE = dir;
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  // Binary coverage: the map needs only whether each function ran. Two
  // recordings of this repository's suite, one with call counts and one
  // without, listed the same functions.
  await session.post("Profiler.startPreciseCoverage");
  afterAll(async () => {
    const { result } = await session.post("Profiler.takePreciseCoverage");
    writeFileSync(path.join(dir, WORKER_COVERAGE), JSON.stringify({ result }));
  });
}

// When the test finishes, its result holds every error, retries included.
// The rerun names the test the way depug's does: vitest's -t matches the
// suite and test names joined by a space.
function testLine(task: RunnerTestCase, elapsed: number): Record<string, unknown> {
  const names: string[] = [];
  for (let suite = task.suite; suite !== undefined && suite.name !== ""; suite = suite.suite) names.unshift(suite.name);
  names.push(task.name);
  const file = task.file.filepath;
  const failed = task.result?.state === "fail";
  const error = task.result?.errors?.[0];
  const pattern = `^${names.join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  return {
    file,
    line: task.location?.line ?? null,
    name: names.join(" > "),
    status: failed ? "failed" : "passed",
    duration_ms: Math.round(elapsed * 10) / 10,
    message: failed ? (error?.message ?? "").split("\n").find((part) => part.trim().length > 0) ?? null : null,
    rerun: `npx vitest run ${JSON.stringify(path.relative(process.cwd(), file))} -t ${JSON.stringify(pattern)}`,
    cwd: process.cwd(),
  };
}
