// Properties of the estimate over any acyclic after graph and any mix of
// statuses: no check has a negative time left, a pending check never ends
// before any of its dependencies, and the run ends with its slowest check.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { isSettled, type CheckSpec, type CheckStatus, type CheckView } from "../src/checks.ts";
import { estimate } from "../src/eta.ts";

const NOW = Date.parse("2026-10-12T00:10:00.000Z");
const STATUSES: (CheckStatus | "unknown")[] = ["pending", "running", "passed", "failed", "cancelled", "skipped", "unknown"];

test("time left is never negative, a pending check ends after its dependencies, and the run ends with its slowest check", () => {
  hegel.test(
    (tc) => {
      const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
      const names = Array.from({ length: count }, (_, i) => `c${i}`);
      const specs: CheckSpec[] = names.map((name, i) => ({
        name,
        run: name,
        after: names.slice(0, i).filter(() => tc.draw(gs.booleans())),
        timeoutSec: 600,
      }));
      const views: CheckView[] = names.map((name) => {
        const status = tc.draw(gs.sampledFrom(STATUSES));
        const ran = tc.draw(gs.integers({ minValue: 0, maxValue: 60_000 }));
        return {
          name,
          status,
          exit_code: null,
          elapsed_ms: null,
          started_at: status === "running" ? new Date(NOW - ran).toISOString() : null,
          pid: null,
          orphan: status === "unknown",
        };
      });
      const typical = new Map<string, number>();
      for (const name of names) {
        if (tc.draw(gs.booleans())) typical.set(name, tc.draw(gs.integers({ minValue: 0, maxValue: 60_000 })));
      }

      const eta = estimate(views, specs, typical, NOW);
      for (const spec of specs) {
        const own = eta.checks.get(spec.name)!;
        if (own.eta_ms !== null) assert.ok(own.eta_ms >= 0, `${spec.name} has ${own.eta_ms} ms left`);
        if (own.overdue) assert.equal(own.eta_ms, 0);
        const status = views.find((view) => view.name === spec.name)!.status;
        if (status !== "pending" || own.eta_ms === null) continue;
        for (const dep of spec.after) {
          const depEta = eta.checks.get(dep)!.eta_ms;
          assert.notEqual(depEta, null);
          assert.ok(own.eta_ms >= depEta!, `${spec.name} ends before its dependency ${dep}`);
        }
      }
      const open = views.filter((view) => !isSettled(view)).map((view) => eta.checks.get(view.name)!.eta_ms);
      const expected = open.includes(null) ? null : Math.max(0, ...(open as number[]));
      assert.equal(eta.eta_ms, expected);
    },
    { testCases: 300 },
  );
});
