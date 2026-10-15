import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { parseConfig, selectChecks, withParsers } from "../src/config.ts";
import { KEEP_RUNS, newRunId, RepoState } from "../src/store.ts";
import { checkStatuses, cleanup, cli, makeRepo, parseLines } from "./helpers.ts";

async function envelope(files: Record<string, unknown>, args: string[] = ["run"]) {
  const repo = makeRepo(files);
  const result = await cli(repo, args);
  await cleanup(repo);
  return { root: repo.root, result, body: JSON.parse(result.stderr) as unknown };
}

test("an unknown after name is rejected with the error envelope", async () => {
  const { root, result, body } = await envelope({
    "firstlight.json": { checks: { a: { run: "true" }, b: { run: "true", after: ["nope"] } } },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(body, {
    error: 'invalid firstlight.json: check "b" is after unknown check "nope"',
    do: `fix ${root}/firstlight.json, then rerun the command`,
  });
});

test("a cycle in after is rejected with the error envelope", async () => {
  const { root, result, body } = await envelope({
    "firstlight.json": {
      checks: { a: { run: "true", after: ["b"] }, b: { run: "true", after: ["a"] } },
    },
  });
  assert.equal(result.code, 1);
  assert.deepEqual(body, {
    error: 'invalid firstlight.json: "after" has a cycle: a -> b -> a',
    do: `fix ${root}/firstlight.json, then rerun the command`,
  });
});

test("a repository with no config is told to create firstlight.json", async () => {
  const { root, result, body } = await envelope({});
  assert.equal(result.code, 1);
  assert.deepEqual(body, {
    error: `no checks found in ${root}: there is no firstlight.json and package.json has no lint, typecheck, test, archstrict script`,
    do: `create ${root}/firstlight.json like {"checks": {"test": {"run": "npm test"}}}, then run \`firstlight run\``,
  });
});

test("results before any run, and an unknown command, print the envelope", async () => {
  const none = await envelope({ "firstlight.json": { checks: { a: { run: "true" } } } }, ["results"]);
  assert.equal(none.result.code, 1);
  assert.deepEqual(none.body, { error: `no run yet for ${none.root}`, do: "firstlight run" });

  const unknown = await envelope({ "firstlight.json": { checks: { a: { run: "true" } } } }, ["frobnicate"]);
  assert.equal(unknown.result.code, 1);
  assert.deepEqual(unknown.body, { error: "unknown command: frobnicate", do: "run `firstlight --help` for the usage" });
});

test("without firstlight.json the package.json scripts become checks", async () => {
  const repo = makeRepo({
    "package.json": {
      name: "fixture",
      private: true,
      scripts: { lint: "echo lint-ok", test: "echo test-ok", build: "exit 1" },
    },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(checkStatuses(run.stdout), { lint: "passed", test: "passed" });
  const lint = parseLines(run.stdout).find((line) => line.name === "lint")!;
  assert.match(readFileSync(lint.log as string, "utf8"), /\nlint-ok\n/);
});

test("without firstlight.json the check-like scripts it did not run are named, in text and in --json", async () => {
  const repo = makeRepo({
    "package.json": {
      scripts: { test: "true", "check:architecture": "exit 1", build: "exit 1", "test:mutation": "exit 1", check: "exit 1" },
    },
  });
  onTestFinished(() => cleanup(repo));

  const run = await cli(repo, ["run"]);
  assert.equal(run.code, 0, run.stderr);
  assert.match(
    run.stdout,
    /^passed 1 check in [\d.]+s \(run \w+\)\nnot run: check:architecture, test:mutation, check \(without firstlight\.json, only lint, typecheck, test, archstrict run; name a script, like firstlight run check:architecture, or write firstlight\.json with firstlight init\)\n$/,
  );

  const json = await cli(repo, ["run", "--json"]);
  assert.deepEqual(parseLines(json.stdout).at(-1)!.not_run, ["check:architecture", "test:mutation", "check"]);

  const named = await cli(repo, ["run", "test", "--json"]);
  assert.equal(parseLines(named.stdout).at(-1)!.not_run, undefined);
});

test("with only check-like scripts outside the fallback, the envelope names them", async () => {
  const { root, result, body } = await envelope({ "package.json": { scripts: { "check:sql": "true", "lint:js": "true", build: "true" } } });
  assert.equal(result.code, 1);
  assert.deepEqual(body, {
    error: `no checks found in ${root}: there is no firstlight.json and package.json has no lint, typecheck, test, archstrict script (scripts that look like checks: check:sql, lint:js)`,
    do: `run \`firstlight run check:sql lint:js\`, or write ${root}/firstlight.json with \`firstlight init check:sql lint:js --write\``,
  });
});

test("--help prints plain text and exits 0", async () => {
  const repo = makeRepo({});
  onTestFinished(() => cleanup(repo));
  const help = await cli(repo, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^firstlight: run lint, typecheck, and tests in parallel/);
});

test("check selection pulls in transitive after dependencies in config order", () => {
  const checks = parseConfig(
    JSON.stringify({
      checks: {
        build: { run: "b" },
        gen: { run: "g", after: ["build"] },
        test: { run: "t", after: ["gen"], timeoutSec: 30 },
        lint: { run: "l" },
      },
    }),
    "firstlight.json",
  );
  assert.deepEqual(
    selectChecks(checks, ["test"]),
    [
      { name: "build", run: "b", after: [], timeoutSec: 600 },
      { name: "gen", run: "g", after: ["build"], timeoutSec: 600 },
      { name: "test", run: "t", after: ["gen"], timeoutSec: 30 },
    ],
  );
});

test("an unknown parser is rejected with the error envelope", async () => {
  const { root, result, body } = await envelope({
    "firstlight.json": { checks: { a: { run: "true", parser: "jest" } } },
  });
  assert.equal(result.code, 1);
  assert.deepEqual(body, {
    error: 'invalid firstlight.json: check "a" has "parser" "jest"; allowed values are tsc, vitest, node-test, archstrict, none, or a list of tsc, vitest, node-test, archstrict',
    do: `fix ${root}/firstlight.json, then rerun the command`,
  });
});

test("an empty parser list is rejected", async () => {
  const { result, body } = await envelope({
    "firstlight.json": { checks: { a: { run: "true", parser: [] } } },
  });
  assert.equal(result.code, 1);
  assert.match((body as { error: string }).error, /has "parser" \[\]; allowed values are/);
});

test("a parser in firstlight.json wins over inference, and none turns inference off", () => {
  const checks = parseConfig(
    JSON.stringify({
      checks: {
        named: { run: "make types", parser: "tsc" },
        listed: { run: "make check", parser: ["tsc", "vitest"] },
        off: { run: "tsc --noEmit", parser: "none" },
        inferred: { run: "npm run unit" },
        plain: { run: "make" },
      },
    }),
    "firstlight.json",
  );
  const repo = makeRepo({ "package.json": { scripts: { unit: "node --test" } } });
  onTestFinished(() => cleanup(repo));
  assert.deepEqual(
    withParsers(repo.root, checks).map((check) => [check.name, check.parser]),
    [
      ["named", "tsc"],
      ["listed", ["tsc", "vitest"]],
      ["off", null],
      ["inferred", "node-test"],
      ["plain", null],
    ],
  );
});

test("pruning keeps the newest 20 run directories", () => {
  const xdg = path.join(tmpdir(), `firstlight-prune-${process.pid}`);
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = xdg;
  try {
    const state = new RepoState("/nonexistent/repo");
    const ids = Array.from({ length: 25 }, (_, i) => newRunId(1_700_000_000_000 + i));
    for (const id of ids) mkdirSync(state.runDir(id), { recursive: true });
    state.prune();
    assert.equal(KEEP_RUNS, 20);
    assert.deepEqual(state.runIds(), ids.slice(5).reverse());
  } finally {
    process.env.XDG_STATE_HOME = saved;
    rmSync(xdg, { recursive: true, force: true });
  }
});
