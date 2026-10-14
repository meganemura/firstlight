import { defineStep, z } from "nukadoko";
import createCheckedRepository from "./create-checked-repository.ts";
import { checkLines } from "./run-checks.ts";
import waitForResults from "./wait-for-results.ts";

export default defineStep({
  description: "Asserts the slow check passed and the next command is to run what failed.",
  pattern: "the slow check has passed",
  args: z.object({ checks: checkLines, next: z.string(), slow: z.string() }),
  returns: z.object({}),
  from: { checks: [waitForResults, "checks"], next: [waitForResults, "next"], slow: [createCheckedRepository, "slow"] },
  mutates: false,
  rationale: "The next command after a finished run with a failure is the agent's way into the last When, so it is checked here too.",
  run({}, { checks, next, slow }) {
    const status = checks.find((check) => check.name === slow)?.status;
    if (status !== "passed") throw new Error(`expected ${slow} passed, got ${status}`);
    if (next !== "firstlight run --failed") throw new Error(`expected "firstlight run --failed", got "${next}"`);
    return {};
  },
});
