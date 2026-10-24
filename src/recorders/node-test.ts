// The node:test recorder. firstlight preloads it into every Node process a
// check starts, through NODE_OPTIONS, so it must cost nothing where it does
// not apply: it acts only in the process `node --test` starts for one test
// file, which has NODE_TEST_CONTEXT set, and only while FIRSTLIGHT_TESTS
// names a file. There it appends one line per finished test, in the shape
// src/tests.ts reads. It imports no file of firstlight, because a published
// package resolves this file alone, by path.

import { appendFileSync } from "node:fs";
import path from "node:path";

const out = process.env.FIRSTLIGHT_TESTS;
const started = new WeakMap<object, number>();
// The same file preloaded twice, as a nested firstlight run would do,
// records each test once.
const installed = Symbol.for("firstlight.node-test-recorder");
const scope = globalThis as Record<symbol, unknown>;

if (out && process.env.NODE_TEST_CONTEXT && scope[installed] === undefined) {
  scope[installed] = true;
  // Loaded here, so a process that runs no test never loads the runner.
  const { afterEach, beforeEach } = await import("node:test");
  beforeEach((t) => {
    started.set(t, performance.now());
  });
  afterEach((t) => {
    const begun = started.get(t);
    const file = t.filePath ?? null;
    if (file === null || !("error" in t)) return;
    const relative = path.relative(process.cwd(), file);
    // node:test wraps what the test threw in an ERR_TEST_FAILURE, whose
    // own stack points into the runner.
    const thrown = t.error instanceof Error && t.error.cause !== undefined ? t.error.cause : t.error;
    const line = {
      file,
      line: failedLine(thrown, file),
      name: t.fullName,
      status: t.passed ? "passed" : "failed",
      duration_ms: begun === undefined ? null : Math.round((performance.now() - begun) * 10) / 10,
      message: thrown === undefined || thrown === null ? null : firstLine(thrown),
      // --test-name-pattern matches a test's own name, not its suites'.
      rerun: `node --test --test-name-pattern=${JSON.stringify(`^${escapeRegExp(t.name)}$`)} ${JSON.stringify(relative)}`,
      cwd: process.cwd(),
    };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
  });
}

// The first line of the message, joined with the next ones while it ends
// in ":", because assert's "Expected values to be strictly equal:" says
// nothing until the "2 !== 3" that follows it.
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.split("\n").map((part) => part.trim()).filter((part) => part.length > 0);
  let message = lines[0] ?? "";
  for (let i = 1; i < lines.length && message.endsWith(":"); i += 1) message += ` ${lines[i]}`;
  return message;
}

// node:test gives no test its line, so a failed one gets the line in its
// own file where the error was thrown, and a passed one none.
function failedLine(error: unknown, file: string): number | null {
  if (!(error instanceof Error) || typeof error.stack !== "string") return null;
  const url = `file://${file}`;
  for (const frame of error.stack.split("\n")) {
    const found = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?$/.exec(frame.trim());
    if (found !== null && (found[1] === file || found[1] === url)) return Number(found[2]);
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
