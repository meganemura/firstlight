import { defineStep, z } from "nukadoko";
import { runFirstlight } from "./firstlight-cli.ts";
import createCheckedRepository from "./create-checked-repository.ts";
import { checkLines } from "./run-checks.ts";

export default defineStep({
  description: "Runs `firstlight results --wait --json`, which blocks until every check of the latest run is done.",
  pattern: "the agent waits for the results",
  args: z.object({ root: z.string(), stateHome: z.string() }),
  returns: z.object({
    checks: checkLines,
    next: z.string().describe("the summary's next command"),
  }),
  from: { root: [createCheckedRepository, "root"], stateHome: [createCheckedRepository, "stateHome"] },
  mutates: false,
  rationale: "results only reads the run's state, so the step is read-only even though it waits on the checks the earlier run started.",
  run({}, { root, stateHome }) {
    const { checks, next } = runFirstlight(["results", "--wait"], root, stateHome);
    return { checks, next };
  },
});
