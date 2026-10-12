import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { checkStatuses, cleanup, cli, makeRepo, parseLines } from "./helpers.ts";

test("run takes package.json scripts and globs like run-p, and returns at the first failure", async () => {
  const repo = makeRepo({
    "package.json": { scripts: { "lint:a": "echo lint-a-broke; exit 2", "lint:b": "true", test: "sleep 2" } },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run", "lint:*", "test", "--json"]);
  assert.equal(run.code, 1, run.stderr);
  const lines = parseLines(run.stdout);
  assert.deepEqual(
    lines.filter((line) => line.type === "check").map((line) => line.name),
    ["lint:a", "lint:b", "test"],
  );
  const lintA = lines.find((line) => line.name === "lint:a")!;
  assert.equal(lintA.status, "failed");
  assert.equal(path.basename(lintA.log as string), "lint_a.log");
  assert.ok((lintA.tail as string[]).includes("lint-a-broke"), String(lintA.tail));
  assert.equal(lines.find((line) => line.name === "test")!.status, "running");
  assert.equal(lines.at(-1)!.next, "firstlight results --wait");

  const results = await cli(repo, ["results", "--wait", "--json"]);
  assert.equal(results.code, 1, results.stderr);
  assert.deepEqual(checkStatuses(results.stdout), { "lint:a": "failed", "lint:b": "passed", test: "passed" });
});

test("a check in firstlight.json wins over a package.json script of the same name", async () => {
  const repo = makeRepo({
    "package.json": { scripts: { test: "echo from-script" } },
    "firstlight.json": { checks: { test: { run: "echo from-config" } } },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run", "test", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  const check = parseLines(run.stdout).find((line) => line.name === "test")!;
  assert.equal(readFileSync(check.log as string, "utf8"), "from-config\n");
});

test("an unknown name and a glob that matches nothing give the error envelope", async () => {
  const repo = makeRepo({ "package.json": { scripts: { "lint:a": "true", test: "true" } } });
  onTestFinished(() => cleanup(repo));

  const unknown = await cli(repo, ["run", "nope"]);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, "");
  const body = JSON.parse(unknown.stderr) as { error: string; do: string };
  assert.equal(body.error, "unknown check or script: nope (configured checks: (none); package.json scripts: lint:a, test)");
  assert.match(body.do, /firstlight run "make test"/);

  const empty = await cli(repo, ["run", "fmt:*"]);
  assert.equal(empty.code, 1);
  assert.deepEqual(JSON.parse(empty.stderr), {
    error: 'no package.json script matches "fmt:*"; the scripts are: lint:a, test',
    do: "pick a pattern that matches one of: lint:a, test",
  });
});

test("shell commands run as checks in a repository with no package.json", async () => {
  const repo = makeRepo({});
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run", "sleep 0.2; echo spec-broke; exit 4", "sleep 3"]);
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.ms < 2_500, `run took ${run.ms} ms, which is not before the slow command ends`);
  assert.match(run.stdout, /^sleep 0\.2; echo spec-broke; exit 4 failed \(exit 4, \d+\.\ds\)\n/);
  assert.match(run.stdout, /\n {2}log: .*\/sleep_0\.2__echo_spec-broke__exit_4\.log\n {4}spec-broke\n/);
  assert.match(run.stdout, /\nsleep 3 running/);

  const word = await cli(repo, ["run", "rspec"]);
  assert.equal(word.code, 1);
  const body = JSON.parse(word.stderr) as { error: string; do: string };
  assert.equal(body.error, "unknown check or script: rspec (configured checks: (none); no package.json)");
  assert.match(body.do, /firstlight run -- rspec/);
});

test("a command and a script run side by side, and -- makes a single word a command", async () => {
  const repo = makeRepo({ "package.json": { scripts: { ok: "echo script-ok", true: "exit 9" } } });
  onTestFinished(() => cleanup(repo));

  const mixed = await cli(repo, ["run", "ok", "echo cmd-ok", "--json"]);
  assert.equal(mixed.code, 0, mixed.stderr);
  const lines = parseLines(mixed.stdout);
  assert.deepEqual(lines.at(-1)!.passed, ["ok", "echo cmd-ok"]);
  const command = lines.find((line) => line.name === "echo cmd-ok")!;
  assert.equal(readFileSync(command.log as string, "utf8"), "cmd-ok\n");

  const separated = await cli(repo, ["run", "ok", "--json", "--", "true", "echo after"]);
  assert.equal(separated.code, 0, separated.stderr);
  assert.deepEqual(parseLines(separated.stdout).at(-1)!.passed, ["ok", "true", "echo after"]);

  const script = await cli(repo, ["run", "true"]);
  assert.equal(script.code, 1, script.stderr);
  assert.match(script.stdout, /^true failed \(exit 9,/);
});

test("a script check gets a time-left estimate from its last pass under the same name and command", async () => {
  const repo = makeRepo({ "package.json": { scripts: { "q:fail": "sleep 0.2; exit 1", "slow:x": "sleep 1.5" } } });
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run", "q:fail", "slow:*"]);
  assert.equal(first.code, 1, first.stderr);
  assert.doesNotMatch(first.stdout, /left/);
  assert.equal((await cli(repo, ["results", "--wait"])).code, 1);

  const second = await cli(repo, ["run", "q:fail", "slow:*"]);
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stdout, /\nslow:x running \(\d+\.\ds, about \d+\.\ds left\)\n/);
});
