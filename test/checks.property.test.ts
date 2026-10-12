// Properties of the check state machine: a fold over any legal event
// sequence ends where each check's last event put it, an event the
// transition table does not allow is rejected wherever it appears, and a
// reused pass is legal only as the first and only step of a check.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import {
  canAdvance,
  canApply,
  CHECK_STATUSES,
  foldEvents,
  IllegalTransition,
  type CheckEvent,
  type CheckStatus,
  type RunEventLine,
} from "../src/checks.ts";

const AT = "2026-10-12T00:00:00.000Z";

function event(check: string, status: CheckStatus): CheckEvent {
  return { type: "check", check, status, at: AT };
}

function nextStatuses(from: CheckStatus): CheckStatus[] {
  return CHECK_STATUSES.filter((to) => canAdvance(from, to));
}

function legalPath(tc: hegel.TestCase): CheckStatus[] {
  const path: CheckStatus[] = [];
  let status: CheckStatus = "pending";
  for (;;) {
    const options = nextStatuses(status);
    if (options.length === 0 || !tc.draw(gs.booleans())) return path;
    status = tc.draw(gs.sampledFrom(options));
    path.push(status);
  }
}

// Every status is reachable from pending, so a shortest path always exists.
function pathTo(target: CheckStatus): CheckStatus[] {
  const queue: CheckStatus[][] = [[]];
  for (;;) {
    const path = queue.shift()!;
    const last = path.at(-1) ?? "pending";
    if (last === target) return path;
    for (const next of nextStatuses(last)) queue.push([...path, next]);
  }
}

test("folding any legal event sequence ends in the status of each check's last event", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
      const names = Array.from({ length: count }, (_, i) => `c${i}`);
      const queues = new Map(names.map((name) => [name, legalPath(tc)]));
      const expected = new Map(names.map((name) => [name, queues.get(name)!.at(-1) ?? "pending"]));

      const events: RunEventLine[] = [];
      for (;;) {
        const waiting = names.filter((name) => queues.get(name)!.length > 0);
        if (waiting.length === 0) break;
        const name = tc.draw(gs.sampledFrom(waiting));
        events.push(event(name, queues.get(name)!.shift()!));
      }
      const outcome = tc.draw(gs.sampledFrom([null, "done", "cancelled"] as const));
      if (outcome !== null) events.push({ type: "run", status: outcome, at: AT });

      const folded = foldEvents(names, events);
      assert.deepEqual(
        folded.checks.map((state) => [state.name, state.status]),
        names.map((name) => [name, expected.get(name)]),
      );
      assert.equal(folded.outcome, outcome);
    },
    { testCases: 300 },
  );
});

test("any transition the table does not allow is rejected", () => {
  hegel.test(
    (tc) => {
      const from = tc.draw(gs.sampledFrom(CHECK_STATUSES));
      const to = tc.draw(gs.sampledFrom(CHECK_STATUSES));
      tc.assume(!canAdvance(from, to));
      const events = [...pathTo(from), to].map((status) => event("c", status));
      assert.throws(() => foldEvents(["c"], events), IllegalTransition);
    },
    { testCases: 200 },
  );
});

test("an event for a check the run does not have is rejected", () => {
  hegel.test(
    (tc) => {
      const status = tc.draw(gs.sampledFrom(CHECK_STATUSES));
      assert.throws(() => foldEvents(["a"], [event("b", status)]), IllegalTransition);
    },
    { testCases: 50 },
  );
});

test("a reused result is legal only as passed straight from pending", () => {
  hegel.test(
    (tc) => {
      const from = tc.draw(gs.sampledFrom(CHECK_STATUSES));
      const to = tc.draw(gs.sampledFrom(CHECK_STATUSES));
      const reused: CheckEvent = { ...event("c", to), cached_from: "01K0000000000000000000000" };
      const events = [...pathTo(from).map((status) => event("c", status)), reused];
      if (from === "pending" && to === "passed") {
        const [state] = foldEvents(["c"], events).checks;
        assert.equal(state!.status, "passed");
        assert.equal(state!.cached_from, reused.cached_from);
        assert.equal(state!.started_at, null);
      } else {
        assert.equal(canApply(from, reused), false);
        assert.throws(() => foldEvents(["c"], events), IllegalTransition);
      }
    },
    { testCases: 200 },
  );
});
