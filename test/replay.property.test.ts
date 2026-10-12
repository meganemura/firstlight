// Property of the replay `follow` prints from: each step is the fold of the
// events up to and including that step's event, so a late reader sees the
// same history, in the same order, that the run went through.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { canAdvance, CHECK_STATUSES, foldEvents, replay, type CheckStatus, type RunEventLine } from "../src/checks.ts";

const AT = "2026-10-12T00:00:00.000Z";

function legalPath(tc: hegel.TestCase): CheckStatus[] {
  const path: CheckStatus[] = [];
  let status: CheckStatus = "pending";
  for (;;) {
    const options = CHECK_STATUSES.filter((to) => canAdvance(status, to));
    if (options.length === 0 || !tc.draw(gs.booleans())) return path;
    status = tc.draw(gs.sampledFrom(options));
    path.push(status);
  }
}

test("every replay step equals the fold of the events up to it", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
      const names = Array.from({ length: count }, (_, i) => `c${i}`);
      const queues = new Map(names.map((name) => [name, legalPath(tc)]));
      const events: RunEventLine[] = [];
      for (;;) {
        const waiting = names.filter((name) => queues.get(name)!.length > 0);
        if (waiting.length === 0) break;
        const name = tc.draw(gs.sampledFrom(waiting));
        events.push({ type: "check", check: name, status: queues.get(name)!.shift()!, at: AT });
      }
      const outcome = tc.draw(gs.sampledFrom([null, "done", "cancelled"] as const));
      if (outcome !== null) events.push({ type: "run", status: outcome, at: AT });

      const steps = replay(names, events);
      const checkEvents = events.filter((event) => event.type === "check");
      assert.equal(steps.length, checkEvents.length);
      steps.forEach((step, i) => {
        assert.equal(step.event, checkEvents[i]);
        const prefix = events.slice(0, events.indexOf(step.event) + 1);
        assert.deepEqual(step.checks, foldEvents(names, prefix).checks);
        assert.equal(step.checks.find((state) => state.name === step.event.check)!.status, step.event.status);
      });
    },
    { testCases: 300 },
  );
});
