import assert from "node:assert/strict";
import { test } from "vitest";
import type { CheckSpec, CheckState, CheckStatus, CheckView } from "../src/checks.ts";
import { estimate, formatSeconds, typicalDurations } from "../src/eta.ts";

const NOW = Date.parse("2026-10-12T00:01:00.000Z");

function spec(name: string, after: string[] = [], run = `run ${name}`): CheckSpec {
  return { name, run, after, timeoutSec: 600 };
}

function view(name: string, status: CheckStatus | "unknown", startedMsAgo: number | null = null): CheckView {
  return {
    name,
    status,
    exit_code: null,
    elapsed_ms: null,
    started_at: startedMsAgo === null ? null : new Date(NOW - startedMsAgo).toISOString(),
    pid: null,
    orphan: status === "unknown",
    cached_from: null,
  };
}

function state(name: string, status: CheckStatus, elapsed_ms: number | null): CheckState {
  return { name, status, pid: null, exit_code: null, started_at: null, elapsed_ms, cached_from: null };
}

test("a running check has its usual duration minus the time it has run", () => {
  const eta = estimate([view("test", "running", 3_500)], [spec("test")], new Map([["test", 11_500]]), NOW);
  assert.deepEqual(eta.checks.get("test"), { eta_ms: 8_000, overdue: false });
  assert.equal(eta.eta_ms, 8_000);
});

test("a running check past its usual duration has 0 left and is overdue", () => {
  const eta = estimate([view("test", "running", 12_000)], [spec("test")], new Map([["test", 9_000]]), NOW);
  assert.deepEqual(eta.checks.get("test"), { eta_ms: 0, overdue: true });
  assert.equal(eta.eta_ms, 0);
});

test("a pending check waits for the slowest of its dependencies, then runs its usual duration", () => {
  const eta = estimate(
    [view("build", "running", 1_000), view("lint", "passed"), view("types", "pending")],
    [spec("build"), spec("lint"), spec("types", ["build", "lint"])],
    new Map([
      ["build", 5_000],
      ["types", 2_000],
    ]),
    NOW,
  );
  assert.deepEqual(eta.checks.get("build"), { eta_ms: 4_000, overdue: false });
  assert.deepEqual(eta.checks.get("lint"), { eta_ms: 0, overdue: false });
  assert.deepEqual(eta.checks.get("types"), { eta_ms: 6_000, overdue: false });
  assert.equal(eta.eta_ms, 6_000);
});

test("a pending check whose dependency has no history is unknown, and so is the run", () => {
  const eta = estimate(
    [view("build", "running", 1_000), view("types", "pending"), view("lint", "running", 1_000)],
    [spec("build"), spec("types", ["build"]), spec("lint")],
    new Map([
      ["types", 2_000],
      ["lint", 3_000],
    ]),
    NOW,
  );
  assert.deepEqual(eta.checks.get("build"), { eta_ms: null, overdue: false });
  assert.deepEqual(eta.checks.get("types"), { eta_ms: null, overdue: false });
  assert.deepEqual(eta.checks.get("lint"), { eta_ms: 2_000, overdue: false });
  assert.equal(eta.eta_ms, null);
});

test("settled checks have 0 left, and a run with only settled checks has 0 left", () => {
  const eta = estimate(
    [view("a", "passed"), view("b", "failed"), view("c", "unknown")],
    [spec("a"), spec("b"), spec("c")],
    new Map(),
    NOW,
  );
  assert.deepEqual([...eta.checks.values()].map((check) => check.eta_ms), [0, 0, 0]);
  assert.equal(eta.eta_ms, 0);
});

test("the usual duration is the newest pass of the same name and the same command", () => {
  const typical = typicalDurations(
    [spec("test"), spec("lint"), spec("types")],
    [
      { checks: [spec("test"), spec("lint", [], "eslint --fix")], states: [state("test", "failed", 100), state("lint", "passed", 50)] },
      { checks: [spec("test"), spec("types")], states: [state("test", "passed", 4_000), state("types", "cancelled", 10)] },
      { checks: [spec("test"), spec("lint")], states: [state("test", "passed", 9_000), state("lint", "passed", 700)] },
    ],
  );
  assert.deepEqual([...typical.entries()], [
    ["test", 4_000],
    ["lint", 700],
  ]);
});

test("seconds keep one decimal below 10 s and are whole from 10 s", () => {
  assert.deepEqual([400, 8_000, 9_940, 10_000, 12_400, 12_600].map(formatSeconds), ["0.4s", "8.0s", "9.9s", "10s", "12s", "13s"]);
});
