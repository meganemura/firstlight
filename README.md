# firstlight

firstlight is a parallel check runner for coding agents. An agent runs lint, typecheck, and tests through it.

firstlight starts every check at the same time and returns as soon as the first one fails, so the agent can start to fix it. The other checks keep running in the background, and the agent reads their results later. When the agent runs `firstlight run` again, firstlight first stops the checks that are still running from the previous run, then starts over.

`firstlight run` reads like npm-run-all's `run-p`, the parallel runner:

```sh
firstlight run lint typecheck test
firstlight run "lint:*" test
```

A check is any shell command, so a project does not need Node or a `package.json`. Node is only needed to run firstlight itself. A Ruby project can pass its commands directly:

```sh
firstlight run "bundle exec rubocop" "bundle exec rspec"
```

or keep them in `firstlight.json`:

```json
{
  "checks": {
    "rubocop": { "run": "bundle exec rubocop" },
    "rspec": { "run": "bundle exec rspec", "timeoutSec": 900 }
  }
}
```

and run `firstlight run`, or `firstlight run rspec` for one of them.

## Agent flow

1. Start the checks:

   ```sh
   firstlight run lint typecheck test
   ```

   It returns at the first failed or timed-out check, with the last 40 lines of that check's log, the status of every other check, and the next command. If every check passes, it prints one line and exits 0.

2. Fix the failure. Meanwhile, the other checks continue.

3. Read the rest:

   ```sh
   firstlight results --wait
   ```

   Or watch each check finish as it happens, with `firstlight follow`.

4. Run again. This cancels anything left from step 1:

   ```sh
   firstlight run lint typecheck test
   ```

   Or run only what did not pass the last time:

   ```sh
   firstlight run --failed
   ```

## Arguments of `run`

`run` is the parallel `run-p` equivalent. Each argument is one of:

| Argument | Meaning |
| --- | --- |
| a word, like `test` | The check of that name in `firstlight.json`, together with the checks it is `after`. Without such a check, the `package.json` script of that name, run as `npm run test`. |
| a pattern, like `"lint:*"` | Every `package.json` script it matches, in `package.json` order. As in npm-run-all, `*` matches inside one `:`-separated segment and `**` matches across segments: `lint:*` matches `lint:js` and `lint:css` but not `lint:js:fix`, and `test:**` matches all three levels. Only `*` is special. Quote a pattern so the shell does not expand it. |
| an argument with whitespace, like `"bundle exec rspec"` | A shell command. Its check name is the command itself. |
| any argument after `--` | A shell command, one per argument, even a single word: `firstlight run lint -- make "bundle exec rspec"` runs the `lint` check or script, `make`, and `bundle exec rspec`. Put `--cwd` and `--json` before `--`. |

The checks run in argument order, and a configured check's `after` checks come just before it. An argument repeated, or a pattern that matches a name already given, runs once. Two different checks under one name are refused. A word that is neither a configured check nor a script, and a pattern that matches no script, stop firstlight with the error envelope, which lists the configured checks and the scripts.

With no arguments, `firstlight run` runs every check in `firstlight.json`, or, without that file, the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict` that exist.

firstlight has no sequential `run-s` mode and none of npm-run-all's other flags. To run a check only after another passes, give it `after` in `firstlight.json`.

## Install

Requires Node.js 24 or newer. Add it to a project as a development dependency:

```sh
npm i -D firstlight
npx firstlight --help
```

Or run it once without adding it:

```sh
npx firstlight run
```

The package holds JavaScript compiled from `src/` and has no runtime dependencies. From a checkout, Node strips the TypeScript types and runs the source directly, with no build:

```sh
node src/cli.ts --help
```

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

A check name in `firstlight.json` must match `[A-Za-z0-9][A-Za-z0-9._-]*`, so that an argument that names it cannot also read as a pattern or a command. firstlight rejects unknown keys, unknown `after` names, and cycles before it starts anything.

Without `firstlight.json`, each of the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict` that exists becomes a check that runs `npm run <name>`, with no `after`.

The repository root is `git rev-parse --show-toplevel` from the current directory, or the current directory when that fails. `--cwd DIR` starts from `DIR` instead.

## Commands

```text
firstlight run [name|pattern|"command"...] [-- command...] [--no-cache] [--cwd DIR] [--json]
firstlight run --failed [--no-cache] [--cwd DIR] [--json]
firstlight results [--wait] [--cwd DIR] [--json]
firstlight follow [--cwd DIR] [--json]
firstlight stop [--cwd DIR] [--json]
firstlight --help
```

- `run` stops the previous run if it is still going, starts the checks, and returns at the first `failed` or `timed_out` check, or when every check is done. A check that already passed on the same working tree is reused instead of run; see [Reused passes](#reused-passes). `--no-cache` runs every selected check.
- `run --failed` runs only the checks that did not pass in the latest run; see [Running what failed](#running-what-failed).
- `results` reports the latest run: status, exit code, elapsed time, and for `failed` and `timed_out` checks the log path and the last 40 log lines. `--wait` blocks until every check is done.
- `follow` prints the status changes of the latest run as they happen; see [Following a run](#following-a-run).
- `stop` cancels the checks that are still running. With nothing running, it does nothing and exits 0.

A `running` or `pending` check shows about how long it has left, and the `next: firstlight results --wait` line shows the time left for the whole run, so the agent knows when to pull the rest:

```text
lint failed (exit 1, 0.4s)
  log: /.../lint.log
    src/a.ts:3:1 unused variable x
test running (3.5s, about 8.0s left)
types pending (about 12s left)
run 01K...: 1 failed, 2 running
next: firstlight results --wait (about 12s left)
```

The estimate comes from the `elapsed_ms` of the newest `passed` result of a check with the same name and the same `run` command in an earlier kept run. This holds for script and command checks too: `lint:js` is the command `npm run lint:js` every time. A failed, timed-out, or cancelled result does not count, because it stopped early. A running check has that duration minus the time it has run. When it has already run longer, the line says `past its usual 9.0s` instead. A pending check has its own duration plus the longest time left of its `after` checks. The run has the longest time left of its unfinished checks. When a check, or one of its `after` checks, has no such history, firstlight shows no estimate for it, and none for the run. Times below 10 seconds keep one decimal; longer times are whole seconds.

## Running what failed

`firstlight run --failed` runs the checks of the latest run that did not pass: `failed`, `timed_out`, `skipped`, `cancelled`, and `unknown`. If the latest run is still going, it is stopped first, so a check that stop cancels runs again too. Each check resolves the way its name does in `firstlight run <name>`, against the current `firstlight.json`: a configured check comes with the checks it is `after`, and a reused pass still applies, so an `after` check that passed on the same working tree is not run again. A `package.json` script or a shell command that was given on the command line runs the same command again. A configured check that has since been removed from `firstlight.json` is left out.

When there is no run yet, or every check of the latest run passed, `run --failed` starts nothing, prints the error envelope with `"do":"firstlight run"`, and exits 1, because there is nothing it could prove. The same happens when every check that did not pass has been removed from `firstlight.json`. `--failed` takes no check names.

The latest run is the one `--failed` reads, so after `firstlight run --failed`, the next `--failed` narrows to what still fails among those checks. Run `firstlight run` to run every check again.

## Following a run

`firstlight follow` attaches to the latest run and prints one line for each status change of each check, starting from the first one, so a late caller sees the whole history. It then prints the summary lines that `results --wait` prints and exits with the code `results --wait` would give:

```text
lint running
test running
lint failed (exit 1, 0.4s)
  log: /.../lint.log
    src/a.ts:3:1 unused variable x
test passed (exit 0, 10.4s)
run 01K...: 1 failed, 1 passed
next: firstlight run
```

A `running` line shows the time left that firstlight estimated when the check started, when there is one. A failed or timed-out check has the same log tail that `run` prints. A reused pass says `cached from run 01K...`, and a check whose supervisor died appears as `unknown` at the end. With `--json`, each change is one check object, in the same shape as `results --json`, and the last line is the summary object.

Each line is written as it happens, with no buffering, so a tool that watches a command's output line by line, such as Claude Code's Monitor, sees each check finish. `follow` only reads the state; the supervisor stays the only writer of `events.jsonl`. With no run yet, it prints the error envelope with `"do":"firstlight run"`.

## Reused passes

When a check already passed in a kept run on the same working tree, with the same command, `firstlight run` does not run it again. It reports the earlier pass:

```text
test passed (cached from run 01K..., 10.4s originally)
```

If every selected check is reused, `run` starts no check and exits 0 at once: `passed 4 checks in 0.2s (4 cached, run 01K...)`. A check that is `after` a reused check starts right away. This saves the slow checks when an agent runs again after changing nothing, or after a failure in a different check.

firstlight compares a cache key. The key of a check is the SHA-256 of:

- the tree key: the git tree hash of the working tree, tracked and untracked files, without ignored files. firstlight computes it with `git add -A` and `git write-tree` against a temporary index of its own, so the real index, the staged changes, and the refs do not change. The blobs of changed files go into the object store as loose objects, which `git gc` removes later like any other unreferenced object;
- the check's `run` command;
- the keys of its `after` checks.

The name of a check and its `timeoutSec` are not part of the key. `firstlight.json` is part of the tree unless it is ignored, so an edit to it runs every check again.

Only a `passed` result is reused. A `failed`, `timed_out`, `cancelled`, `skipped`, or `unknown` check runs again. firstlight finds a pass in the kept runs, newest first, so a pruned run stops being a source. A pass that was itself reused names the run that really ran the check, with that run's time, so a chain of unchanged runs keeps one origin.

The limits:

- Environment variables are not part of the key. A check whose result depends on one gives the earlier result after that variable changes.
- Files outside the repository, ignored files (for example `node_modules/`), the installed tools, and the state of a network service are not part of the key.
- The tree is hashed once, when the run starts. An edit made while a check runs is not in the key of that run.
- A directory that is not the root of a git repository has no tree key, and nothing is reused there. A git failure has the same effect.

In these cases, run `firstlight run --no-cache`. It runs every selected check, and still records the keys, so a later run can reuse its passes.

## Statuses and output

A check is `pending`, `running`, `passed`, `failed`, `timed_out`, `cancelled`, or `skipped`. A check is `unknown`, with `orphan: true`, when its supervisor process is gone before the check finished. firstlight does not invent an exit code for it. A check killed by a signal has the exit code 128 plus the signal number.

The default output is short plain text with no colors. `--json` prints JSON Lines: one object per check, then one summary:

```json
{"type":"check","name":"lint","status":"failed","exit_code":1,"elapsed_ms":205,"log":"/.../lint.log","eta_ms":0,"overdue":false,"cached_from":null,"tail":["src/a.ts:3:1 unused variable x"]}
{"type":"check","name":"test","status":"running","exit_code":null,"elapsed_ms":null,"log":"/.../test.log","eta_ms":8012,"overdue":false,"cached_from":null}
{"type":"check","name":"build","status":"passed","exit_code":0,"elapsed_ms":10412,"log":"/.../build.log","eta_ms":0,"overdue":false,"cached_from":"01K..."}
{"type":"summary","run":"01K...","failed":["lint"],"running":["test"],"passed":["build"],"cancelled":[],"next":"firstlight results --wait","eta_ms":8012}
```

`failed` in the summary holds the checks that are `failed`, `timed_out`, `skipped`, or `unknown`. `running` holds `pending` and `running` checks. `next` is the command to run next, or `null`. `eta_ms` on a check is the estimated milliseconds it has left: `0` for a finished check, and `null` when there is no estimate. `overdue` is `true` when a running check has run longer than its usual duration; its `eta_ms` is then `0`. `cached_from` is the id of the run that ran a reused check, or `null`. That run may be pruned since. For a reused check, `exit_code` and `elapsed_ms` come from that run, and its log holds one line that names it. `eta_ms` in the summary is the estimate for the whole run, `0` when nothing is left to run, or `null`.

## Exit codes

| Command | 0 | 1 |
| --- | --- | --- |
| `run` | every check passed | any check did not pass |
| `results`, `follow` | no check is `failed`, `timed_out`, `skipped`, `cancelled`, or `unknown` | at least one is |
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
  runs/<run-id>/run.json    the run: root, supervisor pid, start time, checks,
                            cache keys, and the passes it reused
  runs/<run-id>/events.jsonl  every status change, appended by the supervisor
  runs/<run-id>/<check>.log   stdout and stderr of one check
  runs/<run-id>/supervisor.log  stderr of the supervisor itself
```

The log file name of a check is its name with each character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 100 characters: `lint:js` writes `lint_js.log`, and `bundle exec rspec` writes `bundle_exec_rspec.log`. The name in the output and in `--json` stays as written. When two checks of one run would share a file name, ignoring case, or a check would take `supervisor.log`, one of them gets `-2`, `-3`, and so on; a name that is already a safe file name keeps its own file. The `log` field in `--json` always gives the real path.

`<repo-key>` is the first 16 hex characters of the SHA-256 of the repository root path. Run ids sort by start time. firstlight keeps the newest 20 runs.

Each run has one detached supervisor process. It records the reused passes, starts the other checks, waits on them, enforces timeouts, and writes `events.jsonl`. There is no long-lived daemon. Each check runs in its own process group, so a stop or a timeout reaches every process the check started.

## Non-goals for v0.1

- No parsing of diagnostics. firstlight shows the log tail as it is.
- No cache beyond reused passes. Earlier runs feed the time-left estimate and the passes a run reuses, and nothing else.
- No daemon, no queue, and no watch mode.

## Development

```sh
npm ci
npm test              # vitest, with Hegel property tests
npm run typecheck     # tsc --noEmit; Node runs the sources directly
npm run archstrict    # module boundaries and the layer order
npm run mutation      # Stryker, with the agent reporter
npm run build         # tsc to dist/, the JavaScript the package ships
npm pack --dry-run    # the tarball's file list; prepack runs the build
```

`test/pack.test.ts` packs the package, installs the tarball into a temporary project, and runs the installed `firstlight` bin, so `npm test` covers the published form too. Releases follow [docs/releasing.md](docs/releasing.md).

A failed test prints a depug evidence file and the command that reruns that one test.

firstlight checks itself. `firstlight.json` in this repository runs `typecheck`, `test`, `archstrict`, and a `mutation` run scoped to `src/checks.ts` and `src/config.ts`, all in parallel:

```sh
node src/cli.ts run
```

## License

MIT
