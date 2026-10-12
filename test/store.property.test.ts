// Property of run ids: sorting them as strings sorts them by creation
// time, which is what `runIds`, pruning, and `current` rely on.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { newRunId } from "../src/store.ts";

// Ten Crockford characters hold 50 bits of milliseconds.
const MAX_TIME = 2 ** 50 - 1;

test("run ids sort by creation time", () => {
  hegel.test(
    (tc) => {
      const times = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: MAX_TIME }), { minSize: 2, maxSize: 10, unique: true }),
      );
      const ids = times.map((time) => ({ time, id: newRunId(time) }));
      for (const { id } of ids) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      const byId = [...ids].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((entry) => entry.time);
      assert.deepEqual(byId, [...times].sort((a, b) => a - b));
    },
    { testCases: 200 },
  );
});
