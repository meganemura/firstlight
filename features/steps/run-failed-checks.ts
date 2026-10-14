import { defineStep, z } from "nukadoko";
import { runFirstlight } from "./firstlight-cli.ts";
import createCheckedRepository from "./create-checked-repository.ts";
import { checkLines } from "./run-checks.ts";

export default defineStep({
  description: "Runs `firstlight run --failed --json`, which starts only the checks that did not pass in the latest run.",
  pattern: "the agent runs only the checks that did not pass",
  args: z.object({ root: z.string(), stateHome: z.string() }),
  returns: z.object({ checks: checkLines }),
  from: { root: [createCheckedRepository, "root"], stateHome: [createCheckedRepository, "stateHome"] },
  mutates: true,
  rationale: "The command is the one the previous results printed; the step runs it as an agent would, in the same repository and state directory.",
  run({}, { root, stateHome }) {
    return { checks: runFirstlight(["run", "--failed"], root, stateHome).checks };
  },
});
