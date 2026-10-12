# AGENTS.md

Context for agents that work in this repository.

## What this is

firstlight is a parallel check runner for coding agents.
`firstlight run` starts every configured check (lint, typecheck, tests) at once, returns at the first failure, and keeps the other checks running in the background.
`firstlight results` reads them later, `firstlight follow` prints each status change as it happens, and `firstlight stop` cancels them.
A second `firstlight run` stops the previous run first.
The user-facing description is in `README.md`.

## Layout

- `src/cli.ts`: the entry point. It parses arguments, runs the commands, picks exit codes and next commands, and starts the supervisor. `follow` lives here too: it polls the state and only reads `events.jsonl`.
- `src/supervisor.ts`: the detached per-run supervisor. It is `src/cli.ts` started again with the hidden `__supervise <run dir>` subcommand. It is the only writer of `events.jsonl`, so it also records the passes the CLI chose to reuse, before it starts any check.
- `src/checks.ts`: the check status state machine, the event types, and the fold from events to the status of each check, including the `unknown`/`orphan` rule, and the one step outside the transition table: a reused `passed` straight from `pending`, legal only with `cached_from`. `replay` gives the run after each event, which `follow` prints. No I/O.
- `src/baseline.ts`: `results --new`: the earlier run each check is compared with (the newest kept run that passed, failed, or timed out the same check with the same command), and which failures are new, by diagnostic identity (file, rule, and message, without the position) or, without diagnostics, by the check's earlier status. No I/O.
- `src/eta.ts`: the time-left estimate, from the newest pass of the same check in an earlier run. No I/O.
- `src/cache.ts`: the cache key of each check (the tree key, its `run` command, and the keys of its `after` checks) and the lookup of a reusable pass in earlier runs. No I/O.
- `src/tree.ts`: the tree key, the git tree hash of the working tree with untracked files and without ignored ones, computed through a temporary index so the user's index and refs do not change.
- `src/config.ts`: `firstlight.json` and the `package.json` fallback, validation, the `after` graph, check selection, what each argument of `run` stands for (a configured check, a script or script pattern, or a shell command), which checks `run --failed` runs again, and the parser each check of a run gets.
- `src/diagnostics.ts`: the diagnostics parsers for the logs of `tsc`, vitest, `node --test`, and `archstrict check`, and the inference of a check's parser from its command and the `package.json` script it runs. No I/O.
- `src/names.ts`: the npm-run-all pattern match over script names, the log file name of each check, and shell quoting. No I/O.
- `src/store.ts`: state under `$XDG_STATE_HOME/firstlight/<repo-key>/`: run ids, `run.json`, `events.jsonl`, `current`, logs, pruning, and the usual durations, reusable passes, and `results --new` baselines read from the kept runs.
- `src/processes.ts`: pid liveness and process-group signals.
- `src/report.ts`: plain text and JSON Lines output, including a failed check's diagnostics before its log tail, and the output of `results --new`.
- `src/errors.ts`: the `{"error","do"}` envelope.
- `test/*.test.ts`: vitest tests. Most run the real CLI as a child process against temporary git repositories, each with its own `XDG_STATE_HOME`. `test/helpers.ts` holds the fixtures. `test/*.property.test.ts` are Hegel property tests of the pure parts: the state machine and its replay, `after` validation, the `run --failed` selection, the `results --new` comparison and baselines, run ids, the time-left estimate, cache keys and reuse, the script pattern match, log file names, and the diagnostics parsers and parser inference. `test/fixtures/diagnostics/` holds real output of `tsc`, vitest, `node --test`, and `archstrict check` on broken projects, with the project path replaced by `/repo`.
- `archstrict.config.ts`: the module boundaries and the layer order, `baseline.ts`, `cache.ts`, `checks.ts`, `diagnostics.ts`, `eta.ts`, and `names.ts` at the bottom, then `config.ts`, `errors.ts`, `processes.ts`, `store.ts`, and `tree.ts`, then `report.ts` and `supervisor.ts`, then `cli.ts`. Every module is strict, and `archstrict.todo.json` is empty.
- `test/pack.test.ts`: packs the package with `npm pack`, installs the tarball into a temporary project, and runs the installed `firstlight` bin. It is the only test that reaches `dist/`.
- `tsconfig.build.json`: the build. It compiles `src/` to `dist/` (gitignored) and rewrites `.ts` relative imports to `.js`. The supervisor is `dist/cli.js` started again, so the published package spawns plain JavaScript.
- `.github/workflows/publish.yml` and `docs/releasing.md`: the npm release through a trusted publisher on a `v*` tag, and the one-time bootstrap that is still to do.
- `stryker.config.json`: mutation testing with the `agent` reporter, which writes `reports/mutation/agent.jsonl`.
- `firstlight.json`: firstlight checks itself with `typecheck`, `test`, `archstrict`, and a `mutation` run scoped to `src/checks.ts` and `src/config.ts`.

## Rules

- Runtime code uses Node built-ins only (no runtime dependencies). Development uses the owner's toolchain: vitest, Hegel (`@hegeldev/hegel`), archstrict, Stryker with stryker-agent-reporter, and depug (`@meganemura/depug`). Ask the owner before you add any other dependency. Pin exact versions, at least 7 days past release, with no later security fix superseding them.
- Write tests with Hegel wherever a property exists: invariants, round trips, ordering. Example tests cover exact CLI output and JSON shape.
- `src/` runs directly through Node's type stripping: use erasable TypeScript syntax only (no enum, no namespace, no parameter properties), and write `.ts` extensions in relative imports.
- Node does not strip types from files under `node_modules`, so the package ships `dist/`, compiled by `npm run build`. Do not point `bin` or a test of the installed package at `src/`.
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
- `npm run build` compiles `src/` to `dist/` with `tsconfig.build.json`, after it removes the old `dist/`. Only the pack test needs it, and `npm pack` runs it through `prepack`.
- `npm pack --dry-run` prints the tarball's file list: `dist/`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.
- `node src/cli.ts run` runs firstlight on this repository with `firstlight.json`. `node src/cli.ts run --cwd <repo>` runs it against another repository.

## archstrict

In projects with an `archstrict.config.ts` (module-boundary/architecture linting), run `npx archstrict rules <path>` BEFORE creating a file or adding an import - it reports the module, tags, and constraints that would govern that path, even before it exists. Run `npx archstrict check` after editing to confirm.

The full rule reference (every rule's evidence/because/do shape, the config schema, the pre-edit query) is at `node_modules/archstrict/skills/archstrict/SKILL.md` when installed via npm - read it before configuring `archstrict.config.ts`, or when a violation's `do:` text alone isn't enough.

If there is no `archstrict.config.ts`, skip archstrict entirely - it may not be installed here.
