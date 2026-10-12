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
- `src/supervisor.ts`: the detached per-run supervisor. It is `src/cli.ts` started again with the hidden `__supervise <run dir>` subcommand. It is the only writer of `events.jsonl`.
- `src/checks.ts`: the check status state machine, the event types, and the fold from events to the status of each check, including the `unknown`/`orphan` rule. No I/O.
- `src/config.ts`: `firstlight.json` and the `package.json` fallback, validation, the `after` graph, and check selection.
- `src/store.ts`: state under `$XDG_STATE_HOME/firstlight/<repo-key>/`: run ids, `run.json`, `events.jsonl`, `current`, logs, and pruning.
- `src/processes.ts`: pid liveness and process-group signals.
- `src/report.ts`: plain text and JSON Lines output.
- `src/errors.ts`: the `{"error","do"}` envelope.
- `test/*.test.ts`: `node:test` tests. They run the real CLI as a child process against temporary git repositories, each with its own `XDG_STATE_HOME`. `test/helpers.ts` holds the fixtures.

## Rules

- Use Node built-ins only. Ask the owner before you add a dependency, including a development dependency.
- `src/` runs directly through Node's type stripping: use erasable TypeScript syntax only (no enum, no namespace, no parameter properties), and write `.ts` extensions in relative imports.
- There is no `bin` entry yet. Node does not strip types from files under `node_modules`, so publishing needs a build step first.
- Write all committed text in English. Do not reference private tools or internal working documents.
- Comments say why: keep a comment only for a reason the code cannot show. Each module starts with a short comment on its responsibility and boundary. A test gets no comments that narrate its steps; the assertion documents the step.
- Do not use em-dash characters in prose.
- Never kill processes by pattern (no `pkill`, no `killall`). Signal only pids that firstlight or the test started.
- Never publish, push a release tag, or change the repository's visibility. Those are the owner's to run.

## Commands

- `npm test` runs the test suite (`node --test "test/*.test.ts"`).
- `node src/cli.ts run --cwd <repo>` runs firstlight from this checkout against a repository.
