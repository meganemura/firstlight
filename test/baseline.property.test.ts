// Properties of `results --new`: a run compared with itself has nothing
// new, the new diagnostics are a subset of the latest ones, the order of
// checks and diagnostics and the positions of diagnostics change nothing,
// a known failure only ever removes new ones, and a check with no baseline
// has only new failures. The baseline of a check is the newest earlier run
// that settled the same check.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import {
  compareFailures,
  countFailures,
  diagnosticKey,
  findBaselines,
  type LatestOutcome,
  type Outcome,
  type PastBaselineRun,
} from "../src/baseline.ts";
import { CHECK_STATUSES, initialState, type CheckSpec } from "../src/checks.ts";
import type { Diagnostic } from "../src/diagnostics.ts";

// Small alphabets, so two draws often share an identity.
function drawDiagnostic(tc: hegel.TestCase): Diagnostic {
  const position = () => (tc.draw(gs.booleans()) ? null : tc.draw(gs.integers({ minValue: 1, maxValue: 50 })));
  return {
    file: tc.draw(gs.sampledFrom(["a.ts", "b.ts"])),
    line: position(),
    col: position(),
    rule: tc.draw(gs.sampledFrom([null, "TS2304", "TS2322"])),
    message: tc.draw(gs.sampledFrom(["Cannot find name 'x'.", "Type mismatch."])),
  };
}

function drawDiagnostics(tc: hegel.TestCase): Diagnostic[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
  return Array.from({ length: count }, () => drawDiagnostic(tc));
}

function drawLatest(tc: hegel.TestCase): LatestOutcome[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
  return Array.from({ length: count }, (_, i) => {
    const failed = tc.draw(gs.booleans());
    return { name: `c${i}`, failed, diagnostics: failed ? drawDiagnostics(tc) : [] };
  });
}

function drawBaselines(tc: hegel.TestCase, latest: readonly LatestOutcome[]): Map<string, Outcome> {
  const baselines = new Map<string, Outcome>();
  for (const check of latest) {
    if (!tc.draw(gs.booleans())) continue;
    const failed = tc.draw(gs.booleans());
    baselines.set(check.name, { failed, diagnostics: failed ? drawDiagnostics(tc) : [] });
  }
  return baselines;
}

function shuffle<T>(tc: hegel.TestCase, items: readonly T[]): T[] {
  const keyed = items.map((item) => ({ item, key: tc.draw(gs.integers({ minValue: 0, maxValue: 1000 })) }));
  return keyed.sort((a, b) => a.key - b.key).map(({ item }) => item);
}

function newKeys(latest: readonly LatestOutcome[], baselines: ReadonlyMap<string, Outcome>): Map<string, string[]> {
  return new Map(
    compareFailures(latest, baselines).map((check) => [check.name, check.newDiagnostics.map(diagnosticKey).sort()]),
  );
}

test("a run compared with itself has no new failure, and every failure counts as known", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const comparisons = compareFailures(latest, new Map(latest.map((check) => [check.name, check])));
      assert.ok(comparisons.every((check) => !check.isNew && check.newDiagnostics.length === 0));
      const failures = latest.filter((check) => check.failed).reduce((sum, check) => sum + Math.max(1, check.diagnostics.length), 0);
      assert.deepEqual(countFailures(comparisons), { new: 0, old: failures });
    },
    { testCases: 300 },
  );
});

test("the new diagnostics are a subset of the latest ones, and new plus known is all of them", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const baselines = drawBaselines(tc, latest);
      const comparisons = compareFailures(latest, baselines);
      assert.deepEqual(
        comparisons.map((check) => check.name),
        latest.filter((check) => check.failed).map((check) => check.name),
      );
      for (const comparison of comparisons) {
        const check = latest.find((candidate) => candidate.name === comparison.name)!;
        for (const diagnostic of comparison.newDiagnostics) assert.ok(check.diagnostics.includes(diagnostic));
        assert.equal(comparison.newDiagnostics.length + comparison.oldDiagnostics, check.diagnostics.length);
        if (check.diagnostics.length > 0) assert.equal(comparison.isNew, comparison.newDiagnostics.length > 0);
      }
      const total = latest.filter((check) => check.failed).reduce((sum, check) => sum + Math.max(1, check.diagnostics.length), 0);
      const counts = countFailures(comparisons);
      assert.equal(counts.new + counts.old, total);
    },
    { testCases: 300 },
  );
});

test("the order of checks and diagnostics does not change what is new", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const baselines = drawBaselines(tc, latest);
      const shuffledLatest = shuffle(tc, latest).map((check) => ({ ...check, diagnostics: shuffle(tc, check.diagnostics) }));
      const shuffledBaselines = new Map(
        shuffle(tc, [...baselines]).map(([name, outcome]) => [name, { ...outcome, diagnostics: shuffle(tc, outcome.diagnostics) }]),
      );
      assert.deepEqual(newKeys(shuffledLatest, shuffledBaselines), newKeys(latest, baselines));
    },
    { testCases: 300 },
  );
});

test("a diagnostic that only moved to another line or column is not new", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const moved = new Map<string, Outcome>(
        latest.map((check) => [
          check.name,
          {
            failed: check.failed,
            diagnostics: check.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              line: tc.draw(gs.integers({ minValue: 1, maxValue: 99 })),
              col: null,
            })),
          },
        ]),
      );
      assert.equal(countFailures(compareFailures(latest, moved)).new, 0);
    },
    { testCases: 300 },
  );
});

test("a known failure added to a baseline never makes a diagnostic new", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const baselines = drawBaselines(tc, latest);
      const widened = new Map(
        [...baselines].map(([name, outcome]) => [
          name,
          outcome.failed ? { failed: true, diagnostics: [...outcome.diagnostics, ...drawDiagnostics(tc)] } : outcome,
        ]),
      );
      const before = newKeys(latest, baselines);
      for (const [name, keys] of newKeys(latest, widened)) {
        for (const key of keys) assert.ok(before.get(name)!.includes(key));
      }
    },
    { testCases: 300 },
  );
});

test("without a baseline, every failure is new", () => {
  hegel.test(
    (tc) => {
      const latest = drawLatest(tc);
      const comparisons = compareFailures(latest, new Map());
      assert.ok(comparisons.every((check) => check.isNew && check.oldDiagnostics === 0));
      for (const comparison of comparisons) {
        assert.deepEqual(comparison.newDiagnostics, latest.find((check) => check.name === comparison.name)!.diagnostics);
      }
      assert.equal(countFailures(comparisons).old, 0);
    },
    { testCases: 300 },
  );
});

test("a check's baseline is the newest earlier run that passed, failed, or timed out the same command", () => {
  hegel.test(
    (tc) => {
      const specs: CheckSpec[] = ["a", "b", "c"].map((name) => ({ name, run: `run ${name}`, after: [], timeoutSec: 600 }));
      const count = tc.draw(gs.integers({ minValue: 0, maxValue: 6 }));
      const past: PastBaselineRun[] = Array.from({ length: count }, (_, i) => {
        const checks = specs
          .filter(() => tc.draw(gs.booleans()))
          .map((spec) => (tc.draw(gs.booleans()) ? spec : { ...spec, run: "changed" }));
        const states = checks.map((check) => ({ ...initialState(check.name), status: tc.draw(gs.sampledFrom(CHECK_STATUSES)) }));
        return { id: `r${count - i}`, checks, states };
      });
      const settles = (run: PastBaselineRun, spec: CheckSpec) =>
        run.checks.some((check) => check.name === spec.name && check.run === spec.run) &&
        ["passed", "failed", "timed_out"].includes(run.states.find((state) => state.name === spec.name)!.status);

      const baselines = findBaselines(specs, past);
      for (const spec of specs) {
        const index = past.findIndex((run) => settles(run, spec));
        const baseline = baselines.get(spec.name);
        if (index === -1) {
          assert.equal(baseline, undefined);
        } else {
          assert.equal(baseline?.run, past[index]!.id);
          assert.equal(baseline?.status, past[index]!.states.find((state) => state.name === spec.name)!.status);
        }
      }
    },
    { testCases: 300 },
  );
});
