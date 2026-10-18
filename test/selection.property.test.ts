// Properties of the selector protocol: the name-status parser reads back
// what git prints; the gate leaves the changes to the selector only when
// git listed some and none is pinned by fullOn; a valid selector answer
// reads back as written, and every other shape or failed exit runs in full;
// and each selected id reaches the shell as exactly one word.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import {
  gateChanges,
  matchesPath,
  narrowedKeyCommand,
  narrowTo,
  parseNameStatus,
  parseSelectorOutput,
  readSelector,
  substituteTests,
  type Change,
  type SelectedTest,
  type SelectorExit,
} from "../src/selection.ts";

const segment = gs.text({ minSize: 1, maxSize: 6, alphabet: "abcxyz._-" });
const filePath = gs.arrays(segment, { minSize: 1, maxSize: 3 }).map((parts) => parts.join("/"));
const change = gs.tuples(gs.sampledFrom(["A", "M", "D", "T", "R100"]), filePath).map(([status, file]) => ({ status, path: file }));
const id = gs.text({ minSize: 1, maxSize: 8, alphabet: "ab $'\"*;&|\\`(){}#~\n:" });
const extra = gs.oneOf<unknown>(gs.integers({ minValue: -5, maxValue: 5 }), gs.text({ maxSize: 4 }), gs.booleans(), gs.just(null));
const selectedTest = gs.tuples(id, gs.arrays(gs.tuples(gs.sampledFrom(["file", "line", "name"]), extra), { maxSize: 3 })).map(
  ([testId, fields]) => ({ ...Object.fromEntries(fields), id: testId }) as SelectedTest,
);

function uniqueIds(tests: readonly SelectedTest[]): SelectedTest[] {
  return tests.filter((entry, index) => tests.findIndex((other) => other.id === entry.id) === index);
}

function exit(stdout: string, overrides: Partial<SelectorExit> = {}): SelectorExit {
  return { error: null, timedOut: false, code: 0, signal: null, stdout, stderr: "", ...overrides };
}

test("parseNameStatus reads back every change git prints", () => {
  hegel.test(
    (tc) => {
      const changes: Change[] = tc.draw(gs.arrays(change, { maxSize: 8 }));
      const output = changes.map((entry) => `${entry.status}\0${entry.path}\0`).join("");
      assert.deepEqual(parseNameStatus(output), changes);
    },
    { testCases: 200 },
  );
});

test("the gate hands the changes to the selector only when git listed some and none matches fullOn", () => {
  hegel.test(
    (tc) => {
      const listed = tc.draw(gs.booleans());
      const changes: Change[] = tc.draw(gs.arrays(change, { maxSize: 8 }));
      const fullOn: string[] = tc.draw(gs.arrays(gs.sampledFrom(["*.lock", "**/config.*", "a/*", "zz"]), { maxSize: 2 }));
      const gate = gateChanges(fullOn, listed ? changes : null);
      const pinned = changes.some((entry) => fullOn.some((glob) => matchesPath(glob, entry.path)));
      const asks = listed && changes.length > 0 && !pinned;
      assert.equal("changes" in gate, asks);
      if ("changes" in gate) assert.deepEqual(gate.changes, changes, "deletions go to the selector too");
    },
    { testCases: 300 },
  );
});

test("a valid selector answer reads back as written, with each id once where it was first named", () => {
  hegel.test(
    (tc) => {
      if (tc.draw(gs.booleans())) {
        const reason: string = tc.draw(gs.text({ minSize: 1, maxSize: 20 }));
        assert.deepEqual(parseSelectorOutput(`${JSON.stringify({ full: reason })}\n`), { full: reason });
        assert.deepEqual(readSelector(exit(JSON.stringify({ full: reason }))), { full: `the selector asked for it: ${reason}` });
        return;
      }
      const tests: SelectedTest[] = tc.draw(gs.arrays(selectedTest, { maxSize: 6 }));
      const answer = { tests: uniqueIds(tests) };
      assert.deepEqual(parseSelectorOutput(JSON.stringify({ tests })), answer);
      assert.deepEqual(readSelector(exit(JSON.stringify({ tests }))), answer);
    },
    { testCases: 300 },
  );
});

const badTest = gs.oneOf<unknown>(
  gs.just(null),
  gs.just("a"),
  gs.just(["a"]),
  gs.just({}),
  gs.just({ id: "" }),
  gs.just({ id: 3 }),
  gs.just({ name: "a" }),
);
const badAnswer = gs.oneOf<unknown>(
  gs.just(null),
  gs.just([]),
  gs.just("tests"),
  gs.integers(),
  gs.just({}),
  gs.just({ tests: [], full: "x" }),
  gs.just({ tests: [], other: 1 }),
  gs.just({ full: "" }),
  gs.just({ full: 1 }),
  gs.just({ tests: {} }),
  gs.just({ tests: "a" }),
  gs.arrays(badTest, { minSize: 1, maxSize: 3 }).map((bad) => ({ tests: [{ id: "ok" }, ...bad] })),
);

test("any other answer is rejected, and a rejected answer or a failed exit runs in full", () => {
  hegel.test(
    (tc) => {
      const answer: unknown = tc.draw(badAnswer);
      const stdout = JSON.stringify(answer);
      assert.ok("invalid" in parseSelectorOutput(stdout), stdout);
      assert.ok("full" in readSelector(exit(stdout)), stdout);

      const valid = JSON.stringify({ tests: [{ id: "a" }] });
      const code: number = tc.draw(gs.integers({ minValue: 1, maxValue: 255 }));
      assert.ok("full" in readSelector(exit(valid, { code })), "a non-zero exit");
      assert.ok("full" in readSelector(exit(valid, { timedOut: true, code: null, signal: "SIGKILL" })), "a timeout");
      assert.ok("full" in readSelector(exit(valid, { error: "spawn /bin/sh ENOENT", code: null })), "no shell");
    },
    { testCases: 200 },
  );
});

test("each selected id reaches the shell as exactly one word, in the selector's order", () => {
  hegel.test(
    (tc) => {
      const ids: string[] = tc.draw(gs.arrays(id, { minSize: 1, maxSize: 5 }));
      const command = substituteTests("printf '%s\\0' {tests}", ids);
      const words = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }).split("\0");
      words.pop();
      assert.deepEqual(words, ids);
    },
    { testCases: 100 },
  );
});

test("a narrowing names each changed file once, keeps the selector's tests, and runs nothing when it chose none", () => {
  hegel.test(
    (tc) => {
      const changes: Change[] = tc.draw(gs.arrays(change, { minSize: 1, maxSize: 8 }));
      const tests = uniqueIds(tc.draw(gs.arrays(selectedTest, { maxSize: 4 })));
      const narrowing = narrowTo("01K", changes, tests, "run {tests}");
      assert.deepEqual(narrowing.files, [...new Set(changes.map((entry) => entry.path))].sort());
      assert.deepEqual(narrowing.tests, tests);
      assert.equal(narrowing.base, "01K");
      assert.equal(narrowing.command, tests.length === 0 ? null : substituteTests("run {tests}", tests.map((entry) => entry.id)));
      const key = narrowedKeyCommand(narrowing, "run {tests}");
      assert.equal(key === narrowing.command, tests.length > 0);
      assert.notEqual(key, "run ");
    },
    { testCases: 200 },
  );
});

test("a path glob's * stays in one segment and ** crosses segments", () => {
  hegel.test(
    (tc) => {
      const parts: string[] = tc.draw(gs.arrays(segment, { minSize: 2, maxSize: 4 }));
      const file = parts.join("/");
      assert.ok(matchesPath("**", file));
      assert.equal(matchesPath("*", file), false);
      assert.ok(matchesPath(`${parts[0]}/**`, file));
      assert.ok(matchesPath(`**/${parts.at(-1)}`, file));
      assert.ok(matchesPath(file, file));
    },
    { testCases: 200 },
  );
});

test("each way to the full run names its reason", () => {
  assert.deepEqual(gateChanges([], null), { full: "git could not list the changed files" });
  assert.deepEqual(gateChanges([], []), { full: "no file changed" });
  assert.deepEqual(gateChanges(["*.lock"], [{ status: "M", path: "a" }, { status: "M", path: "npm.lock" }]), { full: "npm.lock matches fullOn" });
  const valid = JSON.stringify({ tests: [{ id: "a" }] });
  const stderr = `first\n\n  second  \nthird\nfourth\n`;
  assert.deepEqual(readSelector(exit(valid, { code: 2, stderr })), { full: "the selector exited 2 (stderr: first; second; third)" });
  assert.deepEqual(readSelector(exit(valid, { code: 1 })), { full: "the selector exited 1" });
  assert.deepEqual(readSelector(exit(valid, { code: null, signal: "SIGTERM" })), { full: "the selector was stopped by SIGTERM" });
  assert.deepEqual(readSelector(exit(valid, { code: null })), { full: "the selector was stopped by a signal" });
  assert.deepEqual(readSelector(exit(valid, { timedOut: true, code: null })), { full: "the selector did not answer within 60s" });
  assert.deepEqual(readSelector(exit(valid, { error: "spawn ENOENT", code: null })), { full: "the selector could not start (spawn ENOENT)" });
  assert.deepEqual(readSelector(exit("", { stderr: "x".repeat(250) })), { full: `the selector printed nothing (stderr: ${"x".repeat(200)}...)` });
  assert.deepEqual(readSelector(exit(" \n", { stderr: "x".repeat(200) })), { full: `the selector printed nothing (stderr: ${"x".repeat(200)})` });
});

test("each rejected answer says what was wrong with it", () => {
  const cases: [string, string][] = [
    ["log line\n{}", "output that is not one JSON object"],
    ["[]", "JSON that is not an object"],
    ["null", "JSON that is not an object"],
    ['{"tests":[],"stats":{}}', 'an object with the unknown key "stats"'],
    ['{"tests":[],"full":"x"}', 'an object with both "tests" and "full"'],
    ["{}", 'an object with neither "tests" nor "full"'],
    ['{"full":""}', '"full" that is not a non-empty string'],
    ['{"full":["x"]}', '"full" that is not a non-empty string'],
    ['{"tests":"a"}', '"tests" that is not an array'],
    ['{"tests":[{"id":""}]}', 'a test without a non-empty string "id"'],
    ['{"tests":[{"id":1}]}', 'a test without a non-empty string "id"'],
    ['{"tests":["a"]}', 'a test without a non-empty string "id"'],
  ];
  for (const [stdout, invalid] of cases) assert.deepEqual(parseSelectorOutput(stdout), { invalid }, stdout);
  assert.deepEqual(parseSelectorOutput('{"tests":[]}'), { tests: [] });
});

test("parseNameStatus refuses a field that is not git's", () => {
  assert.deepEqual(parseNameStatus("M\0a"), [{ status: "M", path: "a" }]);
  assert.equal(parseNameStatus("M\0"), null);
  for (const output of ["m\0a\0", "xM\0a\0", "M1x\0a\0", "M\0\0"]) assert.equal(parseNameStatus(output), null, output);
});

test("a path glob treats every other character as literal", () => {
  assert.equal(matchesPath("zz", "a"), false);
  assert.equal(matchesPath("a.b", "axb"), false);
  assert.equal(matchesPath("*.ts", "d/x.ts"), false);
  assert.equal(matchesPath("a*", "ab/c"), false);
  assert.ok(matchesPath("*.ts", "x.ts"));
  assert.ok(matchesPath("**", "a\nb"));
});
