import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { checkStatuses, cleanup, cli, currentRun, makeRepo, parseLines, type Repo } from "./helpers.ts";

const RUN_ID = "[0-9A-HJKMNP-TV-Z]{26}";

function markerDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-marker-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function count(file: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function repoWith(checks: Record<string, unknown>): Repo {
  const repo = makeRepo({ "firstlight.json": { checks }, "src.txt": "one\n" });
  onTestFinished(() => cleanup(repo));
  return repo;
}

test("a pass on an unchanged tree is reused without running, and an edit runs it again", async () => {
  const marks = markerDir();
  const repo = repoWith({ test: { run: `sleep 0.3; echo ran >> ${marks}/test` } });

  const first = await cli(repo, ["run"]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`^passed 1 check in \\d+\\.\\ds \\(run ${RUN_ID}\\)\\n$`));
  assert.equal(count(`${marks}/test`), 1);
  const firstId = currentRun(repo).id;

  const second = await cli(repo, ["run"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, new RegExp(`^passed 1 check in \\d+\\.\\ds \\(1 cached, run ${RUN_ID}\\)\\n$`));
  assert.equal(count(`${marks}/test`), 1);
  const secondRun = currentRun(repo);
  assert.notEqual(secondRun.id, firstId);
  assert.deepEqual(
    secondRun.events.filter((event) => event.type === "check").map((event) => [event.status, event.cached_from]),
    [["passed", firstId]],
  );

  const results = await cli(repo, ["results"]);
  assert.equal(results.code, 0, results.stderr);
  assert.match(results.stdout, new RegExp(`^test passed \\(cached from run ${firstId}, \\d+\\.\\ds originally\\)\\n`));
  assert.match(results.stdout, new RegExp(`\\nrun ${RUN_ID}: 1 passed \\(1 cached\\)\\n$`));

  const json = await cli(repo, ["results", "--json"]);
  const [check] = parseLines(json.stdout);
  assert.equal(check!.cached_from, firstId);
  assert.equal(check!.exit_code, 0);
  assert.ok(typeof check!.elapsed_ms === "number" && check!.elapsed_ms >= 300, `elapsed_ms ${check!.elapsed_ms}`);
  assert.match(readFileSync(check!.log as string, "utf8"), new RegExp(`passed in run ${firstId}`));

  const third = await cli(repo, ["run", "--json"]);
  assert.equal(parseLines(third.stdout)[0]!.cached_from, firstId, "a reuse of a reuse names the run that ran it");
  assert.equal(count(`${marks}/test`), 1);

  writeFileSync(path.join(repo.root, "src.txt"), "two\n");
  const edited = await cli(repo, ["run", "--json"]);
  assert.equal(edited.code, 0, edited.stderr);
  assert.equal(parseLines(edited.stdout)[0]!.cached_from, null);
  assert.equal(count(`${marks}/test`), 2);
});

test("a failing check runs again once, and --no-cache runs a passing one anyway", async () => {
  const marks = markerDir();
  const repo = repoWith({
    good: { run: `echo ran >> ${marks}/good` },
    bad: { run: `echo ran >> ${marks}/bad; exit 1` },
  });

  assert.equal((await cli(repo, ["run"])).code, 1);
  await cli(repo, ["results", "--wait"]);
  const second = await cli(repo, ["run"]);
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stdout, /^bad failed \(exit 1, /);
  assert.match(second.stdout, new RegExp(`\\ngood passed \\(cached from run ${RUN_ID}, \\d+\\.\\ds originally\\)\\n`));
  assert.match(second.stdout, /: 1 failed, 1 passed \(1 cached\)\n/);
  assert.equal(count(`${marks}/bad`), 2);
  assert.equal(count(`${marks}/good`), 1);

  const forced = await cli(repo, ["run", "--no-cache", "good"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(forced.stdout, /cached/);
  assert.equal(count(`${marks}/good`), 2);

  const forcedId = currentRun(repo).id;
  const after = await cli(repo, ["run", "--json", "good"]);
  assert.equal(parseLines(after.stdout)[0]!.cached_from, forcedId, "a --no-cache run still records keys a later run reuses");
  assert.equal(count(`${marks}/good`), 2);
});

test("a failure that repeated on an unchanged tree is reused with its log until the tree changes or --no-cache", async () => {
  const marks = markerDir();
  const repo = repoWith({ bad: { run: `echo ran >> ${marks}/bad; echo "expected 2, got 3"; exit 3` } });

  assert.equal((await cli(repo, ["run"])).code, 1);
  assert.equal((await cli(repo, ["run"])).code, 1);
  assert.equal(count(`${marks}/bad`), 2);
  const origin = currentRun(repo).id;

  const third = await cli(repo, ["run"]);
  assert.equal(third.code, 1, third.stderr);
  assert.equal(count(`${marks}/bad`), 2);
  assert.match(third.stdout, new RegExp(`^bad failed \\(cached from run ${origin}, \\d+\\.\\ds originally\\)\\n`));
  assert.match(third.stdout, /expected 2, got 3\n/);
  assert.match(third.stdout, new RegExp(`not run; failed in run ${origin} on the same working tree`));
  assert.match(third.stdout, /: 1 failed \(1 cached\)\n/);

  const json = await cli(repo, ["results", "--json"]);
  const [check] = parseLines(json.stdout);
  assert.deepEqual([check!.status, check!.exit_code, check!.cached_from], ["failed", 3, origin]);

  const failed = await cli(repo, ["run", "--failed", "--json"]);
  assert.equal(parseLines(failed.stdout)[0]!.cached_from, origin, "a reuse of a reused failure names the run that ran it");
  assert.equal(count(`${marks}/bad`), 2);

  assert.equal((await cli(repo, ["run", "--no-cache"])).code, 1);
  assert.equal(count(`${marks}/bad`), 3);

  writeFileSync(path.join(repo.root, "src.txt"), "two\n");
  assert.equal((await cli(repo, ["run"])).code, 1);
  assert.equal(count(`${marks}/bad`), 4);
});

test("a check that passed once on a tree is never reported as a reused failure there", async () => {
  const marks = markerDir();
  const repo = repoWith({ flaky: { run: `echo ran >> ${marks}/flaky; test -f ${marks}/pass` } });

  writeFileSync(`${marks}/pass`, "");
  assert.equal((await cli(repo, ["run"])).code, 0);
  rmSync(`${marks}/pass`);
  assert.equal((await cli(repo, ["run", "--no-cache"])).code, 1);
  assert.equal((await cli(repo, ["run", "--no-cache"])).code, 1);
  const again = await cli(repo, ["run", "--json"]);
  assert.equal(again.code, 0, again.stderr);
  assert.notEqual(parseLines(again.stdout)[0]!.cached_from, null);
  assert.equal(count(`${marks}/flaky`), 3);
});

test("a check is reused only while its command and the keys of its after checks are unchanged", async () => {
  const marks = markerDir();
  const build = `echo ran >> ${marks}/build`;
  const testRun = `echo ran >> ${marks}/test`;
  const repo = repoWith({ build: { run: build }, test: { run: testRun, after: ["build"] } });
  writeFileSync(path.join(repo.root, ".gitignore"), "firstlight.json\n");
  const configure = (buildRun: string, test: string) =>
    writeFileSync(
      path.join(repo.root, "firstlight.json"),
      JSON.stringify({ checks: { build: { run: buildRun }, test: { run: test, after: ["build"] } } }),
    );
  const cachedOf = async (): Promise<Record<string, unknown>> => {
    const result = await cli(repo, ["run", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    return Object.fromEntries(
      parseLines(result.stdout)
        .filter((line) => line.type === "check")
        .map((line) => [line.name, line.cached_from !== null]),
    );
  };

  assert.deepEqual(await cachedOf(), { build: false, test: false });
  assert.deepEqual(await cachedOf(), { build: true, test: true });
  configure(build, `${testRun}; true`);
  assert.deepEqual(await cachedOf(), { build: true, test: false });
  configure(`${build}; true`, `${testRun}; true`);
  assert.deepEqual(await cachedOf(), { build: false, test: false });
  assert.deepEqual([count(`${marks}/build`), count(`${marks}/test`)], [2, 3]);
});

test("a check after a reused check runs as soon as the reuse is recorded", async () => {
  const marks = markerDir();
  const repo = repoWith({
    build: { run: `sleep 0.5; echo ran >> ${marks}/build` },
    flaky: { run: `echo ran >> ${marks}/flaky; test -f ${marks}/pass`, after: ["build"] },
  });
  assert.equal((await cli(repo, ["run"])).code, 1);
  await cli(repo, ["results", "--wait"]);
  writeFileSync(`${marks}/pass`, "");

  const second = await cli(repo, ["run", "--json"]);
  assert.equal(second.code, 0, second.stderr);
  const lines = parseLines(second.stdout);
  assert.notEqual(lines.find((line) => line.name === "build")!.cached_from, null);
  assert.equal(lines.find((line) => line.name === "flaky")!.cached_from, null);
  assert.equal(count(`${marks}/build`), 1);
  assert.equal(count(`${marks}/flaky`), 2);
  assert.ok(second.ms < 2_000, `run took ${second.ms} ms`);
  const events = currentRun(repo).events;
  assert.deepEqual(events[0], { ...events[0], check: "build", status: "passed" });
});

test("--no-cache belongs to run", async () => {
  const repo = repoWith({ a: { run: "true" } });
  const result = await cli(repo, ["results", "--no-cache"]);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: "--no-cache belongs to run", do: "run `firstlight run --no-cache`" });
});
