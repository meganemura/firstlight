import { defineStep, z } from "nukadoko";
import { runFirstlight } from "./firstlight-cli.ts";
import createCheckedRepository from "./create-checked-repository.ts";

export const checkLines = z
  .array(z.object({ name: z.string(), status: z.string() }))
  .describe("one entry per check line firstlight printed: its name and status");

export default defineStep({
  description: "Runs `firstlight run --json` in the repository, which starts every configured check, and times how long it takes to return.",
  pattern: "the agent runs both checks with firstlight",
  args: z.object({ root: z.string(), stateHome: z.string() }),
  returns: z.object({
    exitCode: z.number().describe("firstlight's exit code: 1 when a check failed"),
    elapsedMs: z.number().describe("wall-clock time until firstlight returned"),
    checks: checkLines,
    next: z.string().describe("the summary's next command"),
  }),
  from: { root: [createCheckedRepository, "root"], stateHome: [createCheckedRepository, "stateHome"] },
  mutates: true,
  rationale: "The time to return is the point of the tool, so the step measures it around the real process instead of trusting the elapsed fields firstlight prints.",
  run({}, { root, stateHome }) {
    const started = Date.now();
    const output = runFirstlight(["run"], root, stateHome);
    return { ...output, elapsedMs: Date.now() - started };
  },
});
