// The recorder, a vitest setup file. In a run firstlight starts with
// FIRSTLIGHT_RECORD set, it records which code one test file runs, in its
// own worker and in every Node process the test starts, as raw V8 coverage
// in the layout map.ts reads. It only writes; firstlight-node select reads.
// Without FIRSTLIGHT_RECORD it does nothing, so it can stay in the config.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { afterAll, expect } from "vitest";
import { RECORD_ENV } from "../selection.ts";
import { RAW_DIR, TEST_MARKER } from "./map.ts";

// Named apart from the files NODE_V8_COVERAGE writes, coverage-<pid>-*.json.
const WORKER_COVERAGE = "coverage-worker.json";

const record = process.env[RECORD_ENV];
const test = expect.getState().testPath;

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
