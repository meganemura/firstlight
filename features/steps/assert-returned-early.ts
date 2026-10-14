import { defineStep, z } from "nukadoko";
import createCheckedRepository from "./create-checked-repository.ts";
import runChecks, { checkLines } from "./run-checks.ts";

export default defineStep({
  description: "Asserts firstlight exited 1 with the fast check failed and the slow check running, before the slow check could have finished.",
  pattern: "firstlight returns with the fast check's failure while the slow check is still running",
  args: z.object({
    exitCode: z.number(),
    elapsedMs: z.number(),
    checks: checkLines,
    fast: z.string(),
    slow: z.string(),
    slowSeconds: z.number(),
  }),
  returns: z.object({}),
  from: {
    exitCode: [runChecks, "exitCode"],
    elapsedMs: [runChecks, "elapsedMs"],
    checks: [runChecks, "checks"],
    fast: [createCheckedRepository, "fast"],
    slow: [createCheckedRepository, "slow"],
    slowSeconds: [createCheckedRepository, "slowSeconds"],
  },
  mutates: false,
  rationale: "The printed status alone could be stale; the elapsed time shows the return really came before the slow check's own run time.",
  run({}, { exitCode, elapsedMs, checks, fast, slow, slowSeconds }) {
    const status = new Map(checks.map((check) => [check.name, check.status]));
    if (status.get(fast) !== "failed") throw new Error(`expected ${fast} failed, got ${status.get(fast)}`);
    if (status.get(slow) !== "running") throw new Error(`expected ${slow} running, got ${status.get(slow)}`);
    if (exitCode !== 1) throw new Error(`expected exit 1, got ${exitCode}`);
    if (elapsedMs >= slowSeconds * 1000) throw new Error(`firstlight took ${elapsedMs} ms, not less than the slow check's ${slowSeconds} s`);
    return {};
  },
});
