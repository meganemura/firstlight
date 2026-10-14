import { defineStep, z } from "nukadoko";
import createCheckedRepository from "./create-checked-repository.ts";
import { checkLines } from "./run-checks.ts";
import runFailedChecks from "./run-failed-checks.ts";

export default defineStep({
  description: "Asserts the rerun printed exactly one check line, for the fast check, which failed again.",
  pattern: "only the fast check runs again",
  args: z.object({ checks: checkLines, fast: z.string() }),
  returns: z.object({}),
  from: { checks: [runFailedChecks, "checks"], fast: [createCheckedRepository, "fast"] },
  mutates: false,
  rationale: "A slow check that passed and ran again would cost the agent its full time once more, which is what --failed exists to avoid.",
  run({}, { checks, fast }) {
    const names = checks.map((check) => check.name);
    if (names.length !== 1 || names[0] !== fast) throw new Error(`expected only ${fast}, got [${names.join(", ")}]`);
    if (checks[0]!.status !== "failed") throw new Error(`expected ${fast} to fail again, got ${checks[0]!.status}`);
    return {};
  },
});
