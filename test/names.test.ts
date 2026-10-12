import assert from "node:assert/strict";
import { test } from "vitest";
import { expandPattern, logFileNames, matchesPattern, shellQuote } from "../src/names.ts";

const SCRIPTS = ["lint", "lint:js", "lint:css", "lint:js:fix", "test", "test:unit", "test:e2e:browser", "typecheck"];

test("patterns expand in package.json order, with * inside one segment and ** across segments", () => {
  assert.deepEqual(expandPattern("lint:*", SCRIPTS), ["lint:js", "lint:css"]);
  assert.deepEqual(expandPattern("lint:**", SCRIPTS), ["lint:js", "lint:css", "lint:js:fix"]);
  assert.deepEqual(expandPattern("test:**", SCRIPTS), ["test:unit", "test:e2e:browser"]);
  assert.deepEqual(expandPattern("test:*", SCRIPTS), ["test:unit"]);
  assert.deepEqual(expandPattern("*", SCRIPTS), ["lint", "test", "typecheck"]);
  assert.deepEqual(expandPattern("**", SCRIPTS), SCRIPTS);
  assert.deepEqual(expandPattern("t*", SCRIPTS), ["test", "typecheck"]);
  assert.deepEqual(expandPattern("*:js", SCRIPTS), ["lint:js"]);
  assert.deepEqual(expandPattern("**:fix", SCRIPTS), ["lint:js:fix"]);
  assert.deepEqual(expandPattern("build:*", SCRIPTS), []);
});

test("characters other than * are literal in a pattern", () => {
  assert.equal(matchesPattern("a.b*", "a.bc"), true);
  assert.equal(matchesPattern("a.b*", "axbc"), false);
  assert.equal(matchesPattern("(x)+?*", "(x)+?y"), true);
});

test("log file names keep safe names and disambiguate names that map to one file", () => {
  assert.deepEqual(
    [...logFileNames(["lint", "a:b", "a_b", "bundle exec rspec", "supervisor", "Test", "test"])],
    [
      ["lint", "lint.log"],
      ["a:b", "a_b-2.log"],
      ["a_b", "a_b.log"],
      ["bundle exec rspec", "bundle_exec_rspec.log"],
      ["supervisor", "supervisor-2.log"],
      ["Test", "Test.log"],
      ["test", "test-2.log"],
    ],
  );
  assert.equal(logFileNames(["x".repeat(300)]).get("x".repeat(300)), `${"x".repeat(100)}.log`);
  assert.equal(logFileNames([""]).get(""), "_.log");
});

test("shell quoting leaves plain words alone and quotes the rest", () => {
  assert.equal(shellQuote("lint:js"), "lint:js");
  assert.equal(shellQuote("it's here"), "'it'\\''s here'");
});
