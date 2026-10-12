# Changelog

## Unreleased

The first version of firstlight.

- `firstlight run` starts every check from `firstlight.json` in parallel and returns at the first check that fails or times out. It prints that check's exit code, the last 40 lines of its log, the status of the other checks, and the next command. The other checks keep running. When every check passes, it prints one line and exits 0.
- `firstlight run <check>...` runs only the named checks and the checks they are `after`.
- A second `firstlight run` stops the checks still running from the previous run before it starts.
- `firstlight results` reports the latest run, and `--wait` blocks until every check is done. It exits 1 when any check failed, timed out, was skipped or cancelled, or is unknown. `firstlight stop` cancels the running checks, and does nothing when none are running.
- A check can wait for other checks with `after`. If one of them does not pass, the check is `skipped`. A check that runs longer than `timeoutSec` (600 by default) is stopped and recorded as `timed_out`.
- Without `firstlight.json`, the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict` become checks.
- A detached supervisor per run starts the checks, each in its own process group, and records every status change in `events.jsonl` under `$XDG_STATE_HOME/firstlight/`. Nothing is written into the checked repository. The newest 20 runs are kept.
- If the supervisor dies before a check finishes, that check is reported as `unknown` with `orphan: true`, and no exit code is invented.
- `--json` prints JSON Lines: one object per check and one summary. A failure of firstlight itself prints `{"error","do"}` on stderr and exits 1.

Development:

- Runtime code still uses Node built-ins only. Development now uses TypeScript for `npm run typecheck`, vitest for `npm test`, Hegel property tests for the state machine, `after` validation, and run ids, archstrict for module boundaries and the layer order (`npm run archstrict`), Stryker with stryker-agent-reporter for mutation testing (`npm run mutation`), and depug, which prints an evidence file and a rerun command for each failed test. Every version is pinned exactly.
- The tests moved from `node:test` to vitest and assert the same behavior.
- `firstlight.json` makes firstlight check itself: `typecheck`, `test`, `archstrict`, and a scoped `mutation` run, in parallel.
- CI runs `npm ci`, `npm test`, `npm run typecheck`, and `npm run archstrict` on Node 24, with the actions pinned to commits.
