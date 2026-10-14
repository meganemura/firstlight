import { defineStep, z } from "nukadoko";
import runChecks from "./run-checks.ts";

export default defineStep({
  description: "Asserts the summary's next command is `firstlight results --wait`.",
  pattern: "the next command it names is to wait for the results",
  args: z.object({ next: z.string() }),
  returns: z.object({}),
  from: { next: [runChecks, "next"] },
  mutates: false,
  rationale: "An agent follows the printed next command, so the scenario pins the exact text rather than a substring.",
  run({}, { next }) {
    if (next !== "firstlight results --wait") throw new Error(`expected "firstlight results --wait", got "${next}"`);
    return {};
  },
});
