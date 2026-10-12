import assert from "node:assert/strict";
import { readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, makeRepo, parseLines } from "./helpers.ts";

const NODE_MODULES = path.resolve(import.meta.dirname, "..", "node_modules");

test("a failed tsc check prints its diagnostics before a shorter log tail, in run and in results", async () => {
  const repo = makeRepo({
    "package.json": { name: "broken", version: "1.0.0", private: true, scripts: { typecheck: "tsc --noEmit -p ." } },
    "tsconfig.json": { compilerOptions: { strict: true, noEmit: true }, files: ["a.ts"] },
    "a.ts": "export const x: string = 1;\nexport const y: number = missing;\n",
    ".gitignore": "node_modules\n",
  });
  symlinkSync(NODE_MODULES, path.join(repo.root, "node_modules"));
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run", "typecheck"]);
  assert.equal(run.code, 1, run.stderr);
  assert.match(
    run.stdout,
    /^typecheck failed \(exit 2, \d+\.\ds\)\n {2}a\.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'\.\n {2}a\.ts:2:26 TS2304 Cannot find name 'missing'\.\n {2}log: \S+\/typecheck\.log\n/,
  );
  assert.match(run.stdout, /\n {4}> tsc --noEmit -p \.\n/);

  const results = await cli(repo, ["results", "--json"]);
  assert.equal(results.code, 1, results.stderr);
  const lines = parseLines(results.stdout);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["check", "diagnostic", "diagnostic", "summary"],
  );
  assert.ok((lines[0]!.tail as string[]).length <= 10);
  assert.equal(lines[0]!.more_diagnostics, undefined);
  assert.deepEqual(lines[1], {
    type: "diagnostic",
    check: "typecheck",
    file: "a.ts",
    line: 1,
    col: 14,
    rule: "TS2322",
    message: "Type 'number' is not assignable to type 'string'.",
  });
});

test("follow prints the diagnostics of a failed check in its failure line, in text and in --json", async () => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: { types: { run: "echo 'src/a.ts(3,7): error TS2304: Cannot find name x.'; exit 2", parser: "tsc" } },
    },
  });
  onTestFinished(() => cleanup(repo));
  await cli(repo, ["run"]);

  const follow = await cli(repo, ["follow"]);
  assert.equal(follow.code, 1, follow.stderr);
  assert.match(follow.stdout, /\ntypes failed \(exit 2, \d+\.\ds\)\n {2}src\/a\.ts:3:7 TS2304 Cannot find name x\.\n {2}log: /);

  const json = await cli(repo, ["follow", "--json"]);
  const lines = parseLines(json.stdout);
  const failed = lines.findIndex((line) => line.type === "check" && line.status === "failed");
  assert.deepEqual(lines[failed + 1], {
    type: "diagnostic",
    check: "types",
    file: "src/a.ts",
    line: 3,
    col: 7,
    rule: "TS2304",
    message: "Cannot find name x.",
  });
  assert.equal(lines.at(-1)!.type, "summary");
});

test("a failed check with more than 20 diagnostics prints 20 and counts the rest", async () => {
  const errors = Array.from({ length: 23 }, (_, i) => `echo 'src/a.ts(${i + 1},1): error TS2304: Cannot find name x.'`).join("; ");
  const repo = makeRepo({
    "firstlight.json": { checks: { types: { run: `${errors}; exit 2`, parser: "tsc" } } },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  assert.equal(run.stdout.split("\n").filter((line) => / {2}src\/a\.ts:\d+:1 TS2304 /.test(line)).length, 20);
  assert.match(run.stdout, /\n {2}src\/a\.ts:20:1 TS2304 Cannot find name x\.\n {2}\(3 more diagnostics in the log\)\n {2}log: /);

  const json = await cli(repo, ["results", "--json"]);
  const lines = parseLines(json.stdout);
  assert.equal(lines[0]!.more_diagnostics, 3);
  assert.equal(lines.filter((line) => line.type === "diagnostic").length, 20);
});

test("a failed vitest check shows depug's evidence and rerun under the diagnostic in run, results, results --new, and follow", async () => {
  const log = readFileSync(path.join(import.meta.dirname, "fixtures", "diagnostics", "vitest-depug.txt"), "utf8");
  const repo = makeRepo({
    "vitest.log": log,
    "firstlight.json": { checks: { test: { run: "cat vitest.log; exit 1", parser: "vitest" } } },
  });
  onTestFinished(() => cleanup(repo));
  const evidence = "/repo/tmp/depug/run-20261012-101024-1110/001-quotes-a-word-with-a-space.json";
  const rerun = 'npx depug rerun -- npx vitest run "test/zz-broken.test.ts" -t "^quotes a word with a space$"';
  const block = [
    "  test/zz-broken.test.ts:6:10 quotes a word with a space AssertionError: Expected values to be strictly equal: \"'a b'\" !== 'a b'",
    `    evidence: ${evidence}`,
    `    rerun: ${rerun}`,
    "  log: ",
  ].join("\n");

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.stdout.includes(`\n${block}`), run.stdout);

  for (const args of [["results"], ["results", "--new"], ["follow"]]) {
    const output = await cli(repo, args);
    assert.equal(output.code, 1, output.stderr);
    assert.ok(output.stdout.includes(`\n${block}`), `${args.join(" ")}:\n${output.stdout}`);
  }

  for (const args of [["results", "--json"], ["results", "--new", "--json"], ["follow", "--json"]]) {
    const lines = parseLines((await cli(repo, args)).stdout);
    assert.deepEqual(lines.filter((line) => line.type === "diagnostic"), [
      {
        type: "diagnostic",
        check: "test",
        file: "test/zz-broken.test.ts",
        line: 6,
        col: 10,
        rule: "quotes a word with a space",
        message: "AssertionError: Expected values to be strictly equal: \"'a b'\" !== 'a b'",
        evidence,
        rerun,
      },
    ], args.join(" "));
  }
});
