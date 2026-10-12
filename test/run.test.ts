import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkStatuses, cleanup, cli, currentRun, makeRepo, parseLines } from "./helpers.ts";

test("run exits 0 with one summary line when every check passes", async (t) => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: { a: { run: "true" }, b: { run: "sleep 0.1" }, c: { run: "echo hi", after: ["a"] } },
    },
  });
  t.after(() => cleanup(repo));

  const result = await cli(repo, ["run"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^passed 3 checks in \d+\.\ds \(run [0-9A-Z]{26}\)\n$/);

  const json = await cli(repo, ["run", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const summary = parseLines(json.stdout).at(-1)!;
  assert.deepEqual(
    { ...summary, run: "<id>" },
    { type: "summary", run: "<id>", failed: [], running: [], passed: ["a", "b", "c"], cancelled: [], next: null },
  );
});

test("run returns at the first failure while a slow check keeps running", async (t) => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        quick: { run: "sleep 0.2; echo 'src/a.ts:1:1 boom'; exit 3" },
        slow: { run: "sleep 3; echo slow-done" },
      },
    },
  });
  t.after(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.ms < 2_500, `run took ${run.ms} ms, which is not before the slow check ends`);
  assert.match(run.stdout, /^quick failed \(exit 3, \d+\.\ds\)\n/);
  assert.match(run.stdout, /\n {4}src\/a\.ts:1:1 boom\n/);
  assert.match(run.stdout, /\nslow running/);
  assert.match(run.stdout, /\nnext: firstlight results --wait\n$/);

  const results = await cli(repo, ["results", "--wait", "--json"]);
  assert.equal(results.code, 1, results.stderr);
  assert.deepEqual(checkStatuses(results.stdout), { quick: "failed", slow: "passed" });
  const lines = parseLines(results.stdout);
  const quick = lines.find((line) => line.name === "quick")!;
  assert.equal(quick.exit_code, 3);
  assert.deepEqual(quick.tail, ["src/a.ts:1:1 boom"]);
  const slow = lines.find((line) => line.name === "slow")!;
  assert.equal(slow.exit_code, 0);
  assert.equal(readFileSync(slow.log as string, "utf8"), "slow-done\n");
  assert.equal(lines.at(-1)!.next, "firstlight run");
});

test("a check runs only after its dependency passes and is skipped when it fails", async (t) => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        build: { run: "sleep 0.3" },
        types: { run: "true", after: ["build"] },
        bad: { run: "exit 1" },
        blocked: { run: "true", after: ["bad"] },
      },
    },
  });
  t.after(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stdout, /^bad failed \(exit 1, /);

  const results = await cli(repo, ["results", "--wait", "--json"]);
  assert.equal(results.code, 1);
  assert.deepEqual(checkStatuses(results.stdout), {
    build: "passed",
    types: "passed",
    bad: "failed",
    blocked: "skipped",
  });

  const { events } = currentRun(repo);
  const index = (check: string, status: string) =>
    events.findIndex((event) => event.check === check && event.status === status);
  assert.ok(index("build", "passed") >= 0);
  assert.ok(index("types", "running") > index("build", "passed"), "types started before build passed");
  assert.equal(index("blocked", "running"), -1);
  assert.deepEqual(events.at(-1)!.type, "run");
  assert.deepEqual(events.at(-1)!.status, "done");
});

test("a check past its timeoutSec is timed_out", async (t) => {
  const repo = makeRepo({
    "firstlight.json": { checks: { slow: { run: "sleep 5", timeoutSec: 0.3 } } },
  });
  t.after(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.ms < 4_000, `run took ${run.ms} ms`);
  assert.match(run.stdout, /^slow timed_out \(exit 143, \d+\.\ds\)\n/);

  const results = await cli(repo, ["results", "--json"]);
  assert.equal(results.code, 1);
  const [slow] = parseLines(results.stdout);
  assert.equal(slow!.status, "timed_out");
  assert.equal(slow!.exit_code, 143);
});

test("run with check names runs those and their after dependencies only", async (t) => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        build: { run: "true" },
        test: { run: "true", after: ["build"] },
        lint: { run: "exit 1" },
      },
    },
  });
  t.after(() => cleanup(repo));

  const run = await cli(repo, ["run", "test", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(checkStatuses(run.stdout), { build: "passed", test: "passed" });
  assert.deepEqual(
    currentRun(repo).run.checks.map((check) => check.name),
    ["build", "test"],
  );
});
