import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { CLI, cleanup, cli, currentRun, makeRepo, parseLines, waitFor, type Repo } from "./helpers.ts";

interface Following {
  stdout: () => string;
  exited: () => boolean;
  done: Promise<number | null>;
}

function follow(repo: Repo, args: string[] = []): Following {
  const child = spawn(process.execPath, [CLI, "follow", ...args], {
    cwd: repo.root,
    env: { ...process.env, XDG_STATE_HOME: repo.xdg },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let exited = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      exited = true;
      resolve(code);
    });
  });
  return { stdout: () => stdout, exited: () => exited, done };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LATE = {
  "firstlight.json": {
    checks: {
      quick: { run: "exit 1" },
      late_pass: { run: "sleep 1; echo ok" },
      late_fail: { run: "sleep 2; echo 'src/a.ts:1:1 late boom'; exit 2" },
    },
  },
};

test("follow prints each status change as it happens, then the summary, and exits like results --wait", async () => {
  const repo = makeRepo(LATE);
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  const following = follow(repo);

  await waitFor("follow to print the late pass", () => /\nlate_pass passed \(exit 0, \d+\.\ds\)\n/.test(following.stdout()), 5_000);
  assert.equal(following.exited(), false);
  assert.doesNotMatch(following.stdout(), /late_fail failed/);

  const code = await following.done;
  assert.equal(code, 1);
  const id = currentRun(repo).id;
  const { dir } = currentRun(repo);
  const lines = following.stdout().split("\n");
  const changes = lines.filter((line) => /^\w+ /.test(line) && !line.startsWith("run ") && !line.startsWith("next:"));
  assert.deepEqual(
    changes.map((line) => line.replace(/ \(.*$/, "")).filter((line) => !line.endsWith(" running")),
    ["quick failed", "late_pass passed", "late_fail failed"],
  );
  assert.deepEqual(changes.filter((line) => line.endsWith(" running")).sort(), ["late_fail running", "late_pass running", "quick running"]);
  assert.match(
    following.stdout(),
    new RegExp(
      "\\nlate_fail failed \\(exit 2, \\d+\\.\\ds\\)\\n" +
        `  log: ${escapeRegExp(path.join(dir, "late_fail.log"))}\\n` +
        "    src/a\\.ts:1:1 late boom\\n" +
        `run ${id}: 2 failed, 1 passed\\nnext: firstlight run --failed\\n$`,
    ),
  );

  const results = await cli(repo, ["results", "--wait"]);
  assert.equal(results.code, code);
  assert.ok(results.stdout.endsWith(`run ${id}: 2 failed, 1 passed\nnext: firstlight run --failed\n`));
});

test("follow on a finished run replays the whole history, writes no event, and exits 0 when every check passed", async () => {
  const repo = makeRepo({
    "firstlight.json": { checks: { build: { run: "true" }, test: { run: "sleep 0.2", after: ["build"] } } },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 0, run.stderr);
  const { id, dir } = currentRun(repo);
  const events = path.join(dir, "events.jsonl");
  const before = { text: readFileSync(events, "utf8"), mtime: statSync(events).mtimeMs };

  const text = await cli(repo, ["follow"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(
    text.stdout,
    new RegExp(
      "^build running\\nbuild passed \\(exit 0, \\d+\\.\\ds\\)\\ntest running\\ntest passed \\(exit 0, \\d+\\.\\ds\\)\\n" +
        `run ${id}: 2 passed\\n$`,
    ),
  );

  const json = await cli(repo, ["follow", "--json"]);
  assert.equal(json.code, 0, json.stderr);
  const lines = parseLines(json.stdout);
  assert.deepEqual(
    lines.filter((line) => line.type === "check").map((line) => [line.name, line.status]),
    [
      ["build", "running"],
      ["build", "passed"],
      ["test", "running"],
      ["test", "passed"],
    ],
  );
  assert.deepEqual(Object.keys(lines[1]!), ["type", "name", "status", "exit_code", "elapsed_ms", "log", "eta_ms", "overdue", "cached_from"]);
  const results = await cli(repo, ["results", "--wait", "--json"]);
  assert.deepEqual(lines.at(-1), parseLines(results.stdout).at(-1));

  assert.deepEqual({ text: readFileSync(events, "utf8"), mtime: statSync(events).mtimeMs }, before);
});

test("follow --json streams a late failure with its log tail, and follow with no run prints the envelope", async () => {
  const repo = makeRepo(LATE);
  onTestFinished(() => cleanup(repo));

  const none = await cli(repo, ["follow"]);
  assert.equal(none.code, 1);
  assert.equal(none.stdout, "");
  assert.deepEqual(JSON.parse(none.stderr), { error: `no run yet for ${repo.root}`, do: "firstlight run" });

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 1, run.stderr);
  const following = follow(repo, ["--json"]);
  await waitFor("the late pass line", () => following.stdout().includes('"name":"late_pass","status":"passed"'), 5_000);
  assert.equal(following.exited(), false);

  assert.equal(await following.done, 1);
  const lines = parseLines(following.stdout());
  const lateFail = lines.find((line) => line.name === "late_fail" && line.status === "failed")!;
  assert.equal(lateFail.exit_code, 2);
  assert.deepEqual(lateFail.tail, ["src/a.ts:1:1 late boom"]);
  assert.deepEqual(lines.at(-1), {
    type: "summary",
    run: currentRun(repo).id,
    failed: ["quick", "late_fail"],
    running: [],
    passed: ["late_pass"],
    cancelled: [],
    next: "firstlight run --failed",
    eta_ms: 0,
  });

  const named = await cli(repo, ["follow", "quick"]);
  assert.equal(named.code, 1);
  assert.deepEqual(JSON.parse(named.stderr), { error: "follow takes no check names", do: "run `firstlight follow` without arguments" });
});
