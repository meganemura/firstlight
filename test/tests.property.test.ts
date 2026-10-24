// Properties of the test results protocol: every well-formed line a
// recorder writes reads back with its file relative to the root, and its
// rerun runs from the root; a malformed line, or a last line still being
// written, drops out without taking its neighbours along; the counts add up
// to the results; and each failed test, and only a failed one, becomes a
// diagnostic named after the test.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { countTests, parseTestLines, testDiagnostics, TEST_STATUSES } from "../src/tests.ts";

const ROOT = "/repo";
const segment = gs.text({ minSize: 1, maxSize: 5, alphabet: "abxy._-" }).filter((part) => part !== "." && part !== "..");
const relative = gs.arrays(segment, { minSize: 1, maxSize: 3 }).map((parts) => parts.join("/"));
const where = gs.oneOf(gs.just(""), relative);
const record = gs
  .tuples(
    where,
    relative,
    gs.text({ minSize: 1, maxSize: 8 }),
    gs.sampledFrom(TEST_STATUSES),
    gs.oneOf(gs.just(null), gs.integers({ minValue: 1, maxValue: 500 })),
    gs.oneOf(gs.just(null), gs.text({ minSize: 1, maxSize: 6, alphabet: "ab -" })),
    gs.booleans(),
  )
  .map(([dir, file, name, status, line, rerun, absolute]) => {
    const cwd = dir === "" ? ROOT : `${ROOT}/${dir}`;
    return { file: absolute ? `${cwd}/${file}` : file, cwd, name, status, line, rerun, message: null, duration_ms: 1.5, under: dir, rel: file };
  });

test("every well-formed line reads back, with its file relative to the root and its rerun run from there", () => {
  hegel.test(
    (tc) => {
      const records = tc.draw(gs.arrays(record, { maxSize: 6 }));
      const text = records.map(({ under, rel, ...line }) => `${JSON.stringify(line)}\n`).join("");
      const results = parseTestLines(text, ROOT);
      assert.equal(results.length, records.length);
      results.forEach((result, index) => {
        const written = records[index]!;
        assert.equal(result.file, written.under === "" ? written.rel : `${written.under}/${written.rel}`);
        assert.equal(result.name, written.name);
        assert.equal(result.status, written.status);
        assert.equal(result.line, written.line);
        const rerun = written.rerun === null || written.rerun.length === 0 ? null : written.under === "" ? written.rerun : `cd ${written.under} && ${written.rerun}`;
        assert.equal(result.rerun, rerun);
      });
    },
    { testCases: 300 },
  );
});

test("a malformed line or an unfinished last line drops out alone", () => {
  hegel.test(
    (tc) => {
      const records = tc.draw(gs.arrays(record, { minSize: 1, maxSize: 5 }));
      const junk = tc.draw(gs.sampledFrom(["not json", "[]", "null", '{"file":"a"}', '{"file":"a","name":"n","status":"broken"}', ""]));
      const at = tc.draw(gs.integers({ minValue: 0, maxValue: records.length }));
      const lines = records.map(({ under, rel, ...line }) => JSON.stringify(line));
      lines.splice(at, 0, junk);
      const unfinished = tc.draw(gs.booleans());
      const text = `${lines.join("\n")}\n${unfinished ? JSON.stringify(records[0]!).slice(0, -1) : ""}`;
      assert.deepEqual(
        parseTestLines(text, ROOT).map((result) => result.name),
        records.map((entry) => entry.name),
      );
    },
    { testCases: 200 },
  );
});

test("the counts add up, and exactly the failed tests become diagnostics, named after the test", () => {
  hegel.test(
    (tc) => {
      const records = tc.draw(gs.arrays(record, { maxSize: 8 }));
      const results = parseTestLines(records.map(({ under, rel, ...line }) => `${JSON.stringify(line)}\n`).join(""), ROOT);
      const counts = countTests(results);
      assert.equal(counts.passed + counts.failed + counts.skipped, results.length);
      const failed = results.filter((result) => result.status === "failed");
      assert.equal(counts.failed, failed.length);
      const diagnostics = testDiagnostics(results);
      assert.deepEqual(
        diagnostics.map((diagnostic) => [diagnostic.file, diagnostic.line, diagnostic.rule, diagnostic.rerun ?? null]),
        failed.map((result) => [result.file, result.line, result.name, result.rerun]),
      );
    },
    { testCases: 300 },
  );
});
