import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { resolveRun } from "../src/config.ts";
import { AgentError } from "../src/errors.ts";

function dir(files: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "firstlight-resolve-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), JSON.stringify(content));
  return root;
}

function envelope(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AgentError) return err;
    throw err;
  }
  throw new Error("no error was thrown");
}

const PKG = { scripts: { "lint:a": "x", "lint:b": "x", "lint:b:fix": "x", test: "x", build: "x" } };

test("words become package.json scripts and patterns expand in package.json order", () => {
  const root = dir({ "package.json": PKG });
  assert.deepEqual(
    resolveRun(root, ["test", "lint:*"], []).map((check) => [check.name, check.run]),
    [
      ["test", "npm run test"],
      ["lint:a", "npm run lint:a"],
      ["lint:b", "npm run lint:b"],
    ],
  );
  assert.deepEqual(
    resolveRun(root, ["lint:**", "lint:a"], []).map((check) => check.name),
    ["lint:a", "lint:b", "lint:b:fix"],
  );
});

test("a configured check wins over a script of the same name and brings its after checks", () => {
  const root = dir({
    "package.json": PKG,
    "firstlight.json": { checks: { build: { run: "make build" }, test: { run: "make test", after: ["build"], timeoutSec: 30 } } },
  });
  assert.deepEqual(resolveRun(root, ["lint:a", "test"], []), [
    { name: "lint:a", run: "npm run lint:a", after: [], timeoutSec: 600 },
    { name: "build", run: "make build", after: [], timeoutSec: 600 },
    { name: "test", run: "make test", after: ["build"], timeoutSec: 30 },
  ]);
  assert.deepEqual(
    resolveRun(root, ["*"], []).map((check) => [check.name, check.run]),
    [
      ["test", "make test"],
      ["build", "make build"],
    ],
  );
});

test("an argument with whitespace and every argument after -- is a shell command named by itself", () => {
  const root = dir({});
  assert.deepEqual(resolveRun(root, ["bundle exec rubocop"], ["make", "bundle exec rspec"]), [
    { name: "bundle exec rubocop", run: "bundle exec rubocop", after: [], timeoutSec: 600 },
    { name: "make", run: "make", after: [], timeoutSec: 600 },
    { name: "bundle exec rspec", run: "bundle exec rspec", after: [], timeoutSec: 600 },
  ]);
});

test("an unknown name lists the configured checks and the scripts, and suggests a command", () => {
  const withPkg = envelope(() =>
    resolveRun(dir({ "package.json": PKG, "firstlight.json": { checks: { a: { run: "true" } } } }), ["nope"], []),
  );
  assert.equal(
    withPkg.message,
    "unknown check or script: nope (configured checks: a; package.json scripts: lint:a, lint:b, lint:b:fix, test, build)",
  );
  assert.match(withPkg.next, /firstlight run -- nope/);

  const bare = envelope(() => resolveRun(dir({}), ["rspec"], []));
  assert.equal(bare.message, "unknown check or script: rspec (configured checks: (none); no package.json)");
  assert.match(bare.next, /quoting it, like `firstlight run "make test"`/);
});

test("a pattern that matches nothing names the available scripts", () => {
  const empty = envelope(() => resolveRun(dir({ "package.json": PKG }), ["fmt:*"], []));
  assert.equal(empty.message, 'no package.json script matches "fmt:*"; the scripts are: lint:a, lint:b, lint:b:fix, test, build');
  assert.equal(empty.next, "pick a pattern that matches one of: lint:a, lint:b, lint:b:fix, test, build");

  const none = envelope(() => resolveRun(dir({}), ["lint:*"], []));
  assert.equal(none.message, 'no package.json script matches "lint:*"; there is no package.json');
});

test("two different checks under one name are refused, and repeats are run once", () => {
  const root = dir({ "package.json": PKG });
  assert.deepEqual(resolveRun(root, ["test", "test"], []).map((check) => check.name), ["test"]);
  const clash = envelope(() => resolveRun(root, ["test"], ["test"]));
  assert.match(clash.message, /two checks are named "test"/);
  assert.equal(envelope(() => resolveRun(root, [], [" "])).message, "an empty command was given to `firstlight run`");
});
