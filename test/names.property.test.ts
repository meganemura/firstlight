// Properties of the npm-run-all glob and the log file names: the matcher
// agrees with a separate backtracking matcher, and the file names are safe,
// unique, and stable for names that are already safe.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { logBase, logFileNames, matchesPattern } from "../src/names.ts";

// A small alphabet makes matches and near misses common.
function drawWord(tc: hegel.TestCase, alphabet: string, maxLength: number): string {
  const length = tc.draw(gs.integers({ minValue: 0, maxValue: maxLength }));
  let word = "";
  for (let i = 0; i < length; i += 1) word += alphabet[tc.draw(gs.integers({ minValue: 0, maxValue: alphabet.length - 1 }))];
  return word;
}

function reference(pattern: string, name: string): boolean {
  if (pattern.length === 0) return name.length === 0;
  if (pattern[0] === "*") {
    let stars = 0;
    while (pattern[stars] === "*") stars += 1;
    const rest = pattern.slice(stars);
    for (let taken = 0; taken <= name.length; taken += 1) {
      if (stars === 1 && name.slice(0, taken).includes(":")) break;
      if (reference(rest, name.slice(taken))) return true;
    }
    return false;
  }
  return name[0] === pattern[0] && reference(pattern.slice(1), name.slice(1));
}

test("the glob matcher agrees with a backtracking reference matcher", () => {
  hegel.test(
    (tc) => {
      const pattern = drawWord(tc, "ab:*", 8);
      const name = drawWord(tc, "ab:", 8);
      assert.equal(matchesPattern(pattern, name), reference(pattern, name), `${pattern} vs ${name}`);
    },
    { testCases: 500 },
  );
});

test("a pattern without * matches only itself", () => {
  hegel.test(
    (tc) => {
      const pattern = drawWord(tc, "ab:.-", 6);
      const name = drawWord(tc, "ab:.-", 6);
      assert.equal(matchesPattern(pattern, pattern), true);
      assert.equal(matchesPattern(pattern, name), pattern === name);
    },
    { testCases: 300 },
  );
});

test("** matches a superset of what * matches", () => {
  hegel.test(
    (tc) => {
      const pattern = drawWord(tc, "ab:*", 8);
      const name = drawWord(tc, "ab:", 8);
      const wide = pattern.replace(/\*+/g, "**");
      if (matchesPattern(pattern, name)) assert.equal(matchesPattern(wide, name), true, `${wide} vs ${name}`);
    },
    { testCases: 500 },
  );
});

test("log file names are safe, unique without regard to case, and keep a safe name as it is", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
      const names = [...new Set(Array.from({ length: count }, () => drawWord(tc, "aA_:- ", 4)))];
      const files = logFileNames(names);
      assert.deepEqual([...files.keys()], names);
      const lower = [...files.values()].map((file) => file.toLowerCase());
      assert.equal(new Set(lower).size, lower.length);
      assert.ok(!lower.includes("supervisor.log"));
      for (const file of files.values()) assert.match(file, /^[A-Za-z0-9._-]+\.log$/);
      const safe = names.filter((name) => logBase(name) === name);
      const safeLower = safe.map((name) => name.toLowerCase());
      for (const name of safe) {
        if (safeLower.filter((other) => other === name.toLowerCase()).length === 1) {
          assert.equal(files.get(name), `${name}.log`);
        }
      }
    },
    { testCases: 300 },
  );
});
