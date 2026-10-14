import { defineStep, z } from "nukadoko";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SLOW_SECONDS = 3;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd });
}

export default defineStep({
  description:
    "Creates a scratch git repository whose firstlight.json has a check `fast` that fails at once and a check `slow` that passes after a few seconds.",
  pattern: "a git repository with a fast failing check and a slow passing check",
  args: z.object({}),
  returns: z.object({
    root: z.string().describe("the scratch repository's root"),
    stateHome: z.string().describe("the XDG_STATE_HOME firstlight keeps its runs under, separate from the user's own"),
    fast: z.string().describe("the name of the check that fails at once"),
    slow: z.string().describe("the name of the check that passes after slowSeconds"),
    slowSeconds: z.number().describe("how long the slow check runs"),
  }),
  mutates: true,
  rationale:
    "firstlight keys its state by repository and reuses a pass on the same tree, so each scenario gets a fresh repository and a fresh state directory. Three seconds is long enough that `run` returning while `slow` still runs is not a race on a slow CI runner.",
  run({ scratch }) {
    const root = scratch.dir("firstlight-scenario-repo");
    const stateHome = scratch.dir("firstlight-scenario-state");
    writeFileSync(
      join(root, "firstlight.json"),
      JSON.stringify({
        checks: {
          fast: { run: "echo broken; exit 1" },
          slow: { run: `sleep ${SLOW_SECONDS}; echo fine` },
        },
      }),
    );
    git(root, "init", "--quiet");
    git(root, "-c", "user.email=scenario@example.invalid", "-c", "user.name=scenario", "add", "firstlight.json");
    git(root, "-c", "user.email=scenario@example.invalid", "-c", "user.name=scenario", "commit", "--quiet", "-m", "Add checks");
    return { root, stateHome, fast: "fast", slow: "slow", slowSeconds: SLOW_SECONDS };
  },
});
