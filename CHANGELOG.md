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
