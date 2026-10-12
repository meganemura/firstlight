import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { checkPid, checkStatuses, cleanup, cli, currentRun, makeRepo, parseLines, runFiles, waitFor } from "./helpers.ts";

test("run --failed with no run yet prints the envelope and exits 1", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { a: { run: "true" } } } });
  onTestFinished(() => cleanup(repo));

  const result = await cli(repo, ["run", "--failed"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: `no run yet for ${repo.root}, so no check has failed`,
    do: "firstlight run",
  });
});

test("run --failed reruns the checks that did not pass, with their after checks from the cache", async () => {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        build: { run: "true" },
        lint: { run: "true" },
        test: { run: "test -f fixed", after: ["build"] },
      },
    },
  });
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run"]);
  assert.equal(first.code, 1, first.stderr);
  const firstId = currentRun(repo).id;

  const again = await cli(repo, ["run", "--failed", "--json"]);
  assert.equal(again.code, 1, again.stderr);
  assert.deepEqual(checkStatuses(again.stdout), { build: "passed", test: "failed" });
  const build = parseLines(again.stdout).find((line) => line.name === "build")!;
  assert.equal(build.cached_from, firstId);
  assert.deepEqual(
    currentRun(repo).run.checks.map((check) => check.name),
    ["build", "test"],
  );

  writeFileSync(path.join(repo.root, "fixed"), "");
  const fixed = await cli(repo, ["run", "--failed"]);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.match(fixed.stdout, /^passed 2 checks in \d+\.\ds \(run [0-9A-Z]{26}\)\n$/);

  const nothing = await cli(repo, ["run", "--failed"]);
  assert.equal(nothing.code, 1);
  assert.equal(nothing.stdout, "");
  assert.deepEqual(JSON.parse(nothing.stderr), {
    error: `run ${currentRun(repo).id} has no check that did not pass`,
    do: "firstlight run",
  });
});

test("run --failed reruns a shell command as it ran, and counts a check the stop cancelled", async () => {
  const repo = makeRepo({});
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run", "--", "true", "exit 3", "sleep 30"]);
  assert.equal(first.code, 1, first.stderr);
  const firstId = currentRun(repo).id;
  await waitFor("the sleep to start", () => checkPid(runFiles(repo, firstId), "sleep 30"));

  const again = await cli(repo, ["run", "--failed", "--json"]);
  assert.equal(again.code, 1, again.stderr);
  assert.deepEqual(
    runFiles(repo, firstId).events.filter((event) => event.check === "sleep 30").map((event) => event.status),
    ["running", "cancelled"],
  );
  assert.deepEqual(
    currentRun(repo).run.checks.map((check) => check.name),
    ["exit 3", "sleep 30"],
  );
  const statuses = checkStatuses(again.stdout);
  assert.equal(statuses["exit 3"], "failed");
});

test("run --failed leaves out a check removed from firstlight.json, and refuses names", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { a: { run: "exit 1" }, b: { run: "true" } } } });
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run"]);
  assert.equal(first.code, 1, first.stderr);
  const firstId = currentRun(repo).id;

  const named = await cli(repo, ["run", "--failed", "a"]);
  assert.equal(named.code, 1);
  assert.deepEqual(JSON.parse(named.stderr), {
    error: "--failed picks the checks itself, so it takes no check names",
    do: "run `firstlight run --failed` without names, or name the checks without --failed",
  });

  const elsewhere = await cli(repo, ["results", "--failed"]);
  assert.equal(elsewhere.code, 1);
  assert.deepEqual(JSON.parse(elsewhere.stderr), { error: "--failed belongs to run", do: "run `firstlight run --failed`" });

  writeFileSync(path.join(repo.root, "firstlight.json"), JSON.stringify({ checks: { b: { run: "true" } } }));
  const dropped = await cli(repo, ["run", "--failed"]);
  assert.equal(dropped.code, 1);
  assert.deepEqual(JSON.parse(dropped.stderr), {
    error: `the checks that did not pass in run ${firstId} are no longer in firstlight.json: a`,
    do: "firstlight run",
  });
  assert.equal(currentRun(repo).id, firstId);
});
