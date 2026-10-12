// Properties of `run --failed`'s selection: it takes every check of the
// latest run that did not pass and nothing that did, a configured check
// comes with every check it is after, a script or command check comes back
// as it ran, and a configured check that left firstlight.json is reported
// as dropped instead of being run.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import type { CheckSpec, ReportedStatus } from "../src/checks.ts";
import { commandCheck, scriptCheck, selectFailed, type PreviousCheck } from "../src/config.ts";

const STATUSES: ReportedStatus[] = ["pending", "running", "passed", "failed", "timed_out", "cancelled", "skipped", "unknown"];

function drawConfig(tc: hegel.TestCase): CheckSpec[] {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const checks: CheckSpec[] = [];
  for (let i = 0; i < count; i += 1) {
    const after = checks.filter(() => tc.draw(gs.booleans())).map((check) => check.name);
    checks.push({ name: `c${i}`, run: `run c${i}`, after, timeoutSec: 600 });
  }
  return checks;
}

function closure(configured: CheckSpec[], name: string, into: Set<string>): Set<string> {
  if (into.has(name)) return into;
  into.add(name);
  for (const dep of configured.find((check) => check.name === name)!.after) closure(configured, dep, into);
  return into;
}

test("the selection is exactly the unproven checks, with the after checks of the configured ones", () => {
  hegel.test(
    (tc) => {
      const configured = drawConfig(tc);
      const candidates: CheckSpec[] = [
        ...configured.filter(() => tc.draw(gs.booleans())),
        scriptCheck("lint:js"),
        commandCheck("bundle exec rspec"),
        { name: "gone", run: "make gone", after: [], timeoutSec: 600 },
        { name: "removed", run: "make removed", after: ["gone"], timeoutSec: 600 },
      ];
      const previous: PreviousCheck[] = candidates
        .filter(() => tc.draw(gs.booleans()))
        .map((spec) => ({ spec, status: tc.draw(gs.sampledFrom(STATUSES)) }));

      const { checks, dropped } = selectFailed(configured, previous);
      const names = checks.map((check) => check.name);
      assert.equal(new Set(names).size, names.length);

      const unproven = previous.filter((entry) => entry.status !== "passed");
      const expected = new Set<string>();
      for (const { spec } of unproven) {
        if (configured.some((check) => check.name === spec.name)) closure(configured, spec.name, expected);
        else if (spec.name === "lint:js" || spec.name === "bundle exec rspec") expected.add(spec.name);
      }
      assert.deepEqual(new Set(names), expected);
      assert.deepEqual(
        dropped,
        unproven.map((entry) => entry.spec.name).filter((name) => name === "gone" || name === "removed"),
      );
      for (const check of checks) {
        const source = configured.find((spec) => spec.name === check.name) ?? candidates.find((spec) => spec.name === check.name);
        assert.deepEqual(check, source);
      }
    },
    { testCases: 300 },
  );
});
