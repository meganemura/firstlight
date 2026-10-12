# firstlight

firstlight is a parallel check runner for coding agents. An agent runs lint, typecheck, and tests through it.

firstlight starts every configured check at the same time and returns as soon as the first one fails, so the agent can start to fix it. The other checks keep running in the background, and the agent reads their results later. When the agent runs `firstlight run` again, firstlight first stops the checks that are still running from the previous run, then starts over.

## Agent flow

1. Start the checks:

   ```sh
   firstlight run
   ```

   It returns at the first failed or timed-out check, with the last 40 lines of that check's log, the status of every other check, and the next command. If every check passes, it prints one line and exits 0.

2. Fix the failure. Meanwhile, the other checks continue.

3. Read the rest:

   ```sh
   firstlight results --wait
   ```

4. Run again. This cancels anything left from step 1:

   ```sh
   firstlight run
   ```

`firstlight run test` runs only `test` and the checks it is `after`.

## Install

Requires Node.js 24 or newer. firstlight is not published yet. Node strips TypeScript types when it runs the source, so from a checkout:

```sh
node src/cli.ts --help
```

firstlight has no runtime dependencies, so running it from a checkout needs no install. A published package will need a build step first, because Node does not strip types from files under `node_modules`.

## Config

`firstlight.json` at the repository root:

```json
{
  "checks": {
    "build": { "run": "npm run build" },
    "types": { "run": "tsc --noEmit", "after": ["build"] },
    "test": { "run": "node --test", "after": ["build"], "timeoutSec": 600 }
  }
}
```

| Key | Meaning |
| --- | --- |
| `run` | A command string. firstlight runs it with `/bin/sh -c` in the repository root. stdout and stderr go to one log file. |
| `after` | Checks that must pass before this one starts. If one of them does not pass, this check is `skipped`. |
| `timeoutSec` | Seconds before firstlight stops the check and records `timed_out`. The default is 600. |

A check name must match `[A-Za-z0-9][A-Za-z0-9._-]*`, because it is also the log file name. firstlight rejects unknown keys, unknown `after` names, and cycles before it starts anything.

Without `firstlight.json`, each of the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict` that exists becomes a check that runs `npm run <name>`, with no `after`.

The repository root is `git rev-parse --show-toplevel` from the current directory, or the current directory when that fails. `--cwd DIR` starts from `DIR` instead.

## Commands

```text
firstlight run [check...] [--cwd DIR] [--json]
firstlight results [--wait] [--cwd DIR] [--json]
firstlight stop [--cwd DIR] [--json]
firstlight --help
```

- `run` stops the previous run if it is still going, starts the checks, and returns at the first `failed` or `timed_out` check, or when every check is done.
- `results` reports the latest run: status, exit code, elapsed time, and for `failed` and `timed_out` checks the log path and the last 40 log lines. `--wait` blocks until every check is done.
- `stop` cancels the checks that are still running. With nothing running, it does nothing and exits 0.

A check is `pending`, `running`, `passed`, `failed`, `timed_out`, `cancelled`, or `skipped`. A check is `unknown`, with `orphan: true`, when its supervisor process is gone before the check finished. firstlight does not invent an exit code for it. A check killed by a signal has the exit code 128 plus the signal number.

The default output is short plain text with no colors. `--json` prints JSON Lines: one object per check, then one summary:

```json
{"type":"check","name":"lint","status":"failed","exit_code":1,"elapsed_ms":205,"log":"/.../lint.log","tail":["src/a.ts:3:1 unused variable x"]}
{"type":"summary","run":"01K...","failed":["lint"],"running":["test"],"passed":["build"],"cancelled":[],"next":"firstlight results --wait"}
```

`failed` in the summary holds the checks that are `failed`, `timed_out`, `skipped`, or `unknown`. `running` holds `pending` and `running` checks. `next` is the command to run next, or `null`.

## Exit codes

| Command | 0 | 1 |
| --- | --- | --- |
| `run` | every check passed | any check did not pass |
| `results` | no check is `failed`, `timed_out`, `skipped`, `cancelled`, or `unknown` | at least one is |
| `stop` | the run stopped, or nothing was running | firstlight itself failed |

When firstlight itself fails (bad config, unknown command, no run yet), it exits 1 and prints one JSON object on stderr:

```json
{"error":"invalid firstlight.json: check \"b\" is after unknown check \"nope\"","do":"fix /repo/firstlight.json, then rerun the command"}
```

Do what `do` says.

## State

firstlight never writes into the repository it checks. State lives under:

```text
${XDG_STATE_HOME:-~/.local/state}/firstlight/<repo-key>/
  current                   the latest run id
  runs/<run-id>/run.json    the run: root, supervisor pid, start time, checks
  runs/<run-id>/events.jsonl  every status change, appended by the supervisor
  runs/<run-id>/<check>.log   stdout and stderr of one check
  runs/<run-id>/supervisor.log  stderr of the supervisor itself
```

`<repo-key>` is the first 16 hex characters of the SHA-256 of the repository root path. Run ids sort by start time. firstlight keeps the newest 20 runs.

Each run has one detached supervisor process. It starts the checks, waits on them, enforces timeouts, and writes `events.jsonl`. There is no long-lived daemon. Each check runs in its own process group, so a stop or a timeout reaches every process the check started.

## Non-goals for v0.1

- No parsing of diagnostics. firstlight shows the log tail as it is.
- No cache. Every run starts every selected check.
- No daemon, no queue, and no watch mode.

## Development

```sh
npm ci
npm test              # vitest, with Hegel property tests
npm run typecheck     # tsc --noEmit; Node runs the sources directly
npm run archstrict    # module boundaries and the layer order
npm run mutation      # Stryker, with the agent reporter
```

A failed test prints a depug evidence file and the command that reruns that one test.

firstlight checks itself. `firstlight.json` in this repository runs `typecheck`, `test`, `archstrict`, and a `mutation` run scoped to `src/checks.ts` and `src/config.ts`, all in parallel:

```sh
node src/cli.ts run
```

## License

MIT
