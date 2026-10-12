import assert from "node:assert/strict";
import { onTestFinished, test } from "vitest";
import {
  checkPid,
  cleanup,
  cli,
  currentRun,
  isAlive,
  isGroupAlive,
  makeRepo,
  parseLines,
  runFiles,
  waitFor,
} from "./helpers.ts";

const LONG_RUN = {
  "firstlight.json": { checks: { fail: { run: "exit 1" }, long: { run: "sleep 30" } } },
};

test("a second run cancels the checks of the first", async () => {
  const repo = makeRepo(LONG_RUN);
  onTestFinished(() => cleanup(repo));

  const first = await cli(repo, ["run"]);
  assert.equal(first.code, 1, first.stderr);
  const firstId = currentRun(repo).id;
  const longPid = await waitFor("the long check to start", () => checkPid(runFiles(repo, firstId), "long"));
  assert.equal(isGroupAlive(longPid), true);

  const second = await cli(repo, ["run"]);
  assert.equal(second.code, 1, second.stderr);
  assert.notEqual(currentRun(repo).id, firstId);

  assert.equal(isAlive(longPid), false);
  await waitFor("the long check's process group to be gone", () => !isGroupAlive(longPid), 2_000);
  const { events } = runFiles(repo, firstId);
  const long = events.filter((event) => event.check === "long").map((event) => event.status);
  assert.deepEqual(long, ["running", "cancelled"]);
  assert.deepEqual({ ...events.at(-1)!, at: "<at>" }, { type: "run", status: "cancelled", at: "<at>" });
});

test("stop cancels running checks, and stop with nothing running exits 0", async () => {
  const repo = makeRepo(LONG_RUN);
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  const id = currentRun(repo).id;
  const longPid = await waitFor("the long check to start", () => checkPid(runFiles(repo, id), "long"));

  const stop = await cli(repo, ["stop"]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.match(stop.stdout, new RegExp(`^stopped run ${id}\\n`));
  assert.match(stop.stdout, /\nlong cancelled \(/);
  await waitFor("the long check's process group to be gone", () => !isGroupAlive(longPid), 2_000);

  const results = await cli(repo, ["results", "--json"]);
  const lines = parseLines(results.stdout);
  assert.deepEqual(
    lines.filter((line) => line.type === "check").map((line) => [line.name, line.status]),
    [
      ["fail", "failed"],
      ["long", "cancelled"],
    ],
  );
  assert.equal(results.code, 1);

  const again = await cli(repo, ["stop"]);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout, "nothing running\n");

  const fresh = makeRepo(LONG_RUN);
  onTestFinished(() => cleanup(fresh));
  const never = await cli(fresh, ["stop"]);
  assert.equal(never.code, 0, never.stderr);
  assert.equal(never.stdout, "nothing running\n");
});

test("a check whose supervisor died is unknown with orphan: true", async () => {
  const repo = makeRepo(LONG_RUN);
  let longPid: number | null = null;
  onTestFinished(() => cleanup(repo, [longPid]));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  const files = currentRun(repo);
  longPid = await waitFor("the long check to start", () => checkPid(runFiles(repo, files.id), "long"));

  process.kill(files.run.supervisor_pid, "SIGKILL");
  await waitFor("the supervisor to die", () => !isAlive(files.run.supervisor_pid));

  const results = await cli(repo, ["results", "--json"]);
  assert.equal(results.code, 1, results.stderr);
  const lines = parseLines(results.stdout);
  const long = lines.find((line) => line.name === "long")!;
  assert.equal(long.status, "unknown");
  assert.equal(long.orphan, true);
  assert.equal(long.exit_code, null);
  const fail = lines.find((line) => line.name === "fail")!;
  assert.equal(fail.status, "failed");
  assert.equal(fail.orphan, undefined);

  const text = await cli(repo, ["results"]);
  assert.match(text.stdout, /\nlong unknown \(orphan: the supervisor is gone, so the result is unknown\)\n/);
  assert.equal(isGroupAlive(longPid), true);
});

test("results exits 1 when a check was cancelled before it passed", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { long: { run: "sleep 30" } } } });
  onTestFinished(() => cleanup(repo));

  const pending = cli(repo, ["run"]);
  const longPid = await waitFor("the long check to start", () => {
    try {
      return checkPid(currentRun(repo), "long");
    } catch {
      return null;
    }
  });

  const stop = await cli(repo, ["stop"]);
  assert.equal(stop.code, 0, stop.stderr);
  await pending;
  await waitFor("the long check's process group to be gone", () => !isGroupAlive(longPid), 2_000);

  const results = await cli(repo, ["results"]);
  assert.match(results.stdout, /^long cancelled \(/);
  assert.equal(results.code, 1);
});
