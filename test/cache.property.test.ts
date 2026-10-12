// Properties of cache keys and reuse: a key is a function of the tree, the
// command, and the dependency keys, and changes when any one of them does;
// a key flows into every check that is after it; and only a pass is reused.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { cacheKey, cacheKeys, findReuse, type PastCacheRun } from "../src/cache.ts";
import { CHECK_STATUSES, initialState, type CheckSpec } from "../src/checks.ts";

test("identical inputs give identical keys, in any dependency order", () => {
  hegel.test(
    (tc) => {
      const tree = tc.draw(gs.text());
      const run = tc.draw(gs.text());
      const deps = tc.draw(gs.arrays(gs.text(), { maxSize: 4 }));
      assert.equal(cacheKey(tree, run, deps), cacheKey(tree, run, [...deps]));
      assert.equal(cacheKey(tree, run, deps), cacheKey(tree, run, [...deps].reverse()));
    },
    { testCases: 200 },
  );
});

test("a key changes when the tree, the command, or a dependency key changes", () => {
  hegel.test(
    (tc) => {
      const tree = tc.draw(gs.text());
      const run = tc.draw(gs.text());
      const deps = tc.draw(gs.arrays(gs.text(), { minSize: 1, maxSize: 4 }));
      const other = tc.draw(gs.text());
      const key = cacheKey(tree, run, deps);
      if (other !== tree) assert.notEqual(cacheKey(other, run, deps), key);
      if (other !== run) assert.notEqual(cacheKey(tree, other, deps), key);
      const index = tc.draw(gs.integers({ minValue: 0, maxValue: deps.length - 1 }));
      const changed = deps.map((dep, i) => (i === index ? other : dep));
      if (other !== deps[index]) assert.notEqual(cacheKey(tree, run, changed), key);
    },
    { testCases: 300 },
  );
});

test("changing one command changes the key of that check and of every check after it, and no other", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const names = Array.from({ length: count }, (_, i) => `c${i}`);
      const specs: CheckSpec[] = names.map((name, i) => ({
        name,
        run: `run ${name}`,
        after: names.slice(0, i).filter(() => tc.draw(gs.booleans())),
        timeoutSec: tc.draw(gs.integers({ minValue: 1, maxValue: 600 })),
      }));
      const target = tc.draw(gs.sampledFrom(names));
      const edited = specs.map((spec) => (spec.name === target ? { ...spec, run: `${spec.run} --changed` } : spec));

      const reaches = (name: string): boolean =>
        name === target || specs.find((spec) => spec.name === name)!.after.some(reaches);
      const before = cacheKeys(specs, "tree");
      const after = cacheKeys(edited, "tree");
      for (const name of names) {
        assert.equal(before.get(name) !== after.get(name), reaches(name), name);
      }
      assert.deepEqual(cacheKeys(specs.map((spec) => ({ ...spec, timeoutSec: 1 })), "tree"), before);
    },
    { testCases: 200 },
  );
});

test("only a passed result is reused, from the newest run that has one, and a reuse keeps its origin", () => {
  hegel.test(
    (tc) => {
      const runCount = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
      const past: PastCacheRun[] = Array.from({ length: runCount }, (_, i) => {
        const status = tc.draw(gs.sampledFrom(CHECK_STATUSES));
        const key = tc.draw(gs.sampledFrom(["k1", "k2"]));
        const cachedFrom = status === "passed" && tc.draw(gs.booleans()) ? `origin${i}` : null;
        return {
          id: `run${i}`,
          keys: { c: key },
          states: [{ ...initialState("c"), status, elapsed_ms: 100 + i, cached_from: cachedFrom }],
        };
      });
      const found = findReuse(new Map([["c", "k1"]]), past);
      const source = past.find((run) => run.keys.c === "k1" && run.states[0]!.status === "passed");
      if (source === undefined) {
        assert.equal(found.size, 0);
      } else {
        assert.deepEqual(found.get("c"), {
          run: source.states[0]!.cached_from ?? source.id,
          elapsed_ms: source.states[0]!.elapsed_ms,
        });
      }
    },
    { testCases: 300 },
  );
});
