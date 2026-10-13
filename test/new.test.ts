import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, currentRun, makeRepo, parseLines } from "./helpers.ts";

const NODE_MODULES = path.resolve(import.meta.dirname, "..", "node_modules");
// Three tsc runs, which take a while when the machine is busy.
const TSC_TIMEOUT_MS = 60_000;

test("results --new reports only the tsc errors the previous run did not have, even after the code moved", async () => {
  const repo = makeRepo({
    "package.json": { name: "app", version: "1.0.0", private: true, scripts: { typecheck: "tsc --noEmit -p ." } },
    "tsconfig.json": { compilerOptions: { strict: true, noEmit: true }, files: ["a.ts"] },
    "a.ts": "export const x: string = 1;\n",
    ".gitignore": "node_modules\n",
  });
  symlinkSync(NODE_MODULES, path.join(repo.root, "node_modules"));
  onTestFinished(() => cleanup(repo));

  await cli(repo, ["run", "typecheck"]);
  const firstId = currentRun(repo).id;
  const first = await cli(repo, ["results", "--new"]);
  assert.equal(first.code, 1, first.stderr);
  assert.match(
    first.stdout,
    /^typecheck failed \(exit 2, \d+\.\ds\)\n {2}a\.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'\.\n {2}log: /,
  );
  assert.match(
    first.stdout,
    new RegExp(`\\nno earlier run to compare with, so every failure counts as new\\nrun ${firstId}: 1 new failure\\nnext: firstlight run --failed\\n$`),
  );

  writeFileSync(path.join(repo.root, "a.ts"), "\n\nexport const x: string = 1;\nexport const y: number = missing;\n");
  await cli(repo, ["run", "typecheck"]);
  const secondId = currentRun(repo).id;
  const second = await cli(repo, ["results", "--new"]);
  assert.equal(second.code, 1, second.stderr);
  assert.match(
    second.stdout,
    new RegExp(
      `^typecheck failed \\(exit 2, \\d+\\.\\ds\\)\\n {2}a\\.ts:4:26 TS2304 Cannot find name 'missing'\\.\\n {2}\\(1 diagnostic already in run ${firstId}\\)\\n {2}log: `,
    ),
  );
  assert.doesNotMatch(second.stdout, /^ {2}a\.ts:\d+:\d+ TS2322/m);
  assert.match(
    second.stdout,
    new RegExp(`\\nnot new: 1 failure already in the previous run\\nrun ${secondId}: 1 new failure\\nnext: firstlight run --failed\\n$`),
  );

  const json = await cli(repo, ["results", "--new", "--json"]);
  assert.equal(json.code, 1, json.stderr);
  const lines = parseLines(json.stdout);
  assert.deepEqual(
    lines.map((line) => line.type),
    ["check", "diagnostic", "summary"],
  );
  assert.equal(lines[0]!.new, true);
  assert.equal(lines[0]!.baseline, firstId);
  assert.equal(lines[0]!.old_diagnostics, 1);
  assert.deepEqual(lines[1], {
    type: "diagnostic",
    check: "typecheck",
    file: "a.ts",
    line: 4,
    col: 26,
    rule: "TS2304",
    message: "Cannot find name 'missing'.",
  });
  assert.deepEqual(lines[2], {
    type: "summary",
    run: secondId,
    failed: ["typecheck"],
    running: [],
    passed: [],
    cancelled: [],
    next: "firstlight run --failed",
    eta_ms: 0,
    new: ["typecheck"],
    new_failures: 1,
    old_failures: 1,
    no_baseline: [],
  });

  writeFileSync(path.join(repo.root, "a.ts"), "export const x: string = 1;\n");
  await cli(repo, ["run", "typecheck"]);
  const third = await cli(repo, ["results", "--new"]);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(third.stdout, `not new: 1 failure already in the previous run\nrun ${currentRun(repo).id}: no new failures\n`);

  const all = await cli(repo, ["results"]);
  assert.equal(all.code, 1, all.stderr);
  assert.match(all.stdout, /TS2322/);
}, TSC_TIMEOUT_MS);

test("results --new compares each check without diagnostics with the newest earlier run that settled it", async () => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        a: { run: "test ! -f broken-a" },
        b: { run: "test ! -f broken-b" },
        slow: { run: "sleep 2; test ! -f broken-slow" },
      },
    },
  });
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run"]);
  assert.equal(first.code, 0, first.stderr);

  writeFileSync(path.join(repo.root, "broken-a"), "");
  await cli(repo, ["run"]);
  const waited = await cli(repo, ["results", "--new", "--wait"]);
  assert.equal(waited.code, 1, waited.stderr);
  assert.match(waited.stdout, /^a failed \(exit 1, \d+\.\ds\)\n {2}log: /);
  assert.match(waited.stdout, new RegExp(`\\nnot new: 2 passed\\nrun ${currentRun(repo).id}: 1 new failure\\nnext: firstlight run --failed\\n$`));

  writeFileSync(path.join(repo.root, "broken-b"), "");
  await cli(repo, ["run", "--failed"]);
  const narrowed = await cli(repo, ["results", "--new", "--json"]);
  assert.equal(narrowed.code, 0, narrowed.stderr);
  const lines = parseLines(narrowed.stdout);
  assert.deepEqual(
    lines.map((line) => [line.type, line.name ?? null, line.new]),
    [
      ["check", "a", false],
      ["summary", null, []],
    ],
  );
  assert.equal(lines[1]!.old_failures, 1);
  assert.equal(lines[1]!.next, null);

  await cli(repo, ["run"]);
  const early = await cli(repo, ["results", "--new"]);
  assert.equal(early.code, 1, early.stderr);
  assert.match(early.stdout, /^b failed \(exit 1, \d+\.\ds\)\n {2}log: /);
  assert.match(early.stdout, /\nslow running \(/);
  assert.match(early.stdout, /: 1 new failure, 1 running\nnext: firstlight results --new --wait/);
  assert.doesNotMatch(early.stdout, /^a /m);

  const done = await cli(repo, ["results", "--new", "--wait"]);
  assert.equal(done.code, 1, done.stderr);
  assert.match(done.stdout, new RegExp(`\\nnot new: 1 failure already in the previous run, 1 passed\\nrun ${currentRun(repo).id}: 1 new failure\\n`));
});

test("--new belongs to results", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { a: { run: "true" } } } });
  onTestFinished(() => cleanup(repo));

  const result = await cli(repo, ["run", "--new"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: "--new belongs to results", do: "run `firstlight results --new`" });
});
