# AGENTS.md

Context for agents that work in this repository.

## What this is

firstlight is a parallel check runner for coding agents.
`firstlight run` starts every configured check (lint, typecheck, tests) at once, returns at the first failure, and keeps the other checks running in the background.
`firstlight results` reads them later, and `firstlight stop` cancels them.
A second `firstlight run` stops the previous run first.
The user-facing description is in `README.md`.

## Layout

- `src/cli.ts`: the entry point. It parses arguments, runs the commands, picks exit codes and next commands, and starts the supervisor.
- `src/supervisor.ts`: the detached per-run supervisor. It is `src/cli.ts` started again with the hidden `__supervise <run dir>` subcommand. It is the only writer of `events.jsonl`, so it also records the passes the CLI chose to reuse, before it starts any check.
- `src/checks.ts`: the check status state machine, the event types, and the fold from events to the status of each check, including the `unknown`/`orphan` rule, and the one step outside the transition table: a reused `passed` straight from `pending`, legal only with `cached_from`. No I/O.
- `src/eta.ts`: the time-left estimate, from the newest pass of the same check in an earlier run. No I/O.
- `src/cache.ts`: the cache key of each check (the tree key, its `run` command, and the keys of its `after` checks) and the lookup of a reusable pass in earlier runs. No I/O.
- `src/tree.ts`: the tree key, the git tree hash of the working tree with untracked files and without ignored ones, computed through a temporary index so the user's index and refs do not change.
- `src/config.ts`: `firstlight.json` and the `package.json` fallback, validation, the `after` graph, check selection, and what each argument of `run` stands for (a configured check, a script or script pattern, or a shell command).
- `src/names.ts`: the npm-run-all pattern match over script names, the log file name of each check, and shell quoting. No I/O.
- `src/store.ts`: state under `$XDG_STATE_HOME/firstlight/<repo-key>/`: run ids, `run.json`, `events.jsonl`, `current`, logs, pruning, and the usual durations and reusable passes read from the kept runs.
- `src/processes.ts`: pid liveness and process-group signals.
- `src/report.ts`: plain text and JSON Lines output.
- `src/errors.ts`: the `{"error","do"}` envelope.
- `test/*.test.ts`: vitest tests. Most run the real CLI as a child process against temporary git repositories, each with its own `XDG_STATE_HOME`. `test/helpers.ts` holds the fixtures. `test/*.property.test.ts` are Hegel property tests of the pure parts: the state machine, `after` validation, run ids, the time-left estimate, cache keys and reuse, the script pattern match, and log file names.
- `archstrict.config.ts`: the module boundaries and the layer order, `cache.ts`, `checks.ts`, `eta.ts`, and `names.ts` at the bottom, then `config.ts`, `errors.ts`, `processes.ts`, `store.ts`, and `tree.ts`, then `report.ts` and `supervisor.ts`, then `cli.ts`. Every module is strict, and `archstrict.todo.json` is empty.
- `stryker.config.json`: mutation testing with the `agent` reporter, which writes `reports/mutation/agent.jsonl`.
- `firstlight.json`: firstlight checks itself with `typecheck`, `test`, `archstrict`, and a `mutation` run scoped to `src/checks.ts` and `src/config.ts`.

## Rules

- Runtime code uses Node built-ins only (no runtime dependencies). Development uses the owner's toolchain: vitest, Hegel (`@hegeldev/hegel`), archstrict, Stryker with stryker-agent-reporter, and depug (`@meganemura/depug`). Ask the owner before you add any other dependency. Pin exact versions, at least 7 days past release, with no later security fix superseding them.
- Write tests with Hegel wherever a property exists: invariants, round trips, ordering. Example tests cover exact CLI output and JSON shape.
- `src/` runs directly through Node's type stripping: use erasable TypeScript syntax only (no enum, no namespace, no parameter properties), and write `.ts` extensions in relative imports.
- There is no `bin` entry yet. Node does not strip types from files under `node_modules`, so publishing needs a build step first.
- Write all committed text in English. Do not reference private tools or internal working documents.
- Comments say why: keep a comment only for a reason the code cannot show. Each module starts with a short comment on its responsibility and boundary. A test gets no comments that narrate its steps; the assertion documents the step.
- Do not use em-dash characters in prose.
- Never kill processes by pattern (no `pkill`, no `killall`). Signal only pids that firstlight or the test started.
- Never publish, push a release tag, or change the repository's visibility. Those are the owner's to run.

## Commands

- `npm test` runs the vitest suite. A failed test prints a `depug evidence:` file and a `depug rerun:` command; run that command, or put a depug verb in front of it, instead of guessing a runtime value from the source.
- `npm run typecheck` runs `tsc --noEmit` over `src/`, `test/`, and the root `*.ts` files. tsc only checks; Node runs the sources directly.
- `npm run archstrict` runs `archstrict check`.
- `npm run mutation` runs Stryker over `src/` except `cli.ts` and `supervisor.ts`. `npm run mutation -- --mutate src/checks.ts` narrows it to one file.
- `node src/cli.ts run` runs firstlight on this repository with `firstlight.json`. `node src/cli.ts run --cwd <repo>` runs it against another repository.

## archstrict

In projects with an `archstrict.config.ts` (module-boundary/architecture linting), run `npx archstrict rules <path>` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run `npx archstrict check` after editing to confirm.

The full rule reference (every rule's evidence/because/do shape, the config schema, the pre-edit query) is at `node_modules/archstrict/skills/archstrict/SKILL.md` when installed via npm - read it before configuring `archstrict.config.ts`, or when a violation's `do:` text alone isn't enough.

If there is no `archstrict.config.ts`, skip archstrict entirely - it may not be installed here.
