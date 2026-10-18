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

   It returns at the first failed or timed-out check, with the last 40 lines of that check's log, the status of every other check, and the next command. When firstlight can read that tool's output, the check's [diagnostics](#diagnostics) come first and the log tail is 10 lines. If every check passes, it prints one line and exits 0.

   While other checks are still running, the next command is `firstlight results --wait`.

2. Fix the failure. Meanwhile, the other checks continue.

3. Read the rest:

   ```sh
   firstlight results --wait
   ```

   Or watch each check finish as it happens, with `firstlight follow`.

4. Run only what did not pass. Once every check is done and one failed, this is the next command that `results` and `follow` print. It cancels anything left from step 1:

   ```sh
   firstlight run --failed
   ```

   Or run every check again:

   ```sh
   firstlight run lint typecheck test
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

Requires Node.js 24 or newer. On an older Node, every command stops before it does anything and prints `{"error":"firstlight needs Node 24 or newer (found v20.19.0)","do":"install Node 24 or newer, then rerun the same command"}` with exit code 1. Add it to a project as a development dependency:

```sh
npm i -D firstlight
npx firstlight --help
```

Or run it once without adding it:

```sh
npx firstlight run
```

Without `firstlight.json`, `firstlight run` runs the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict`. To choose the checks, let `firstlight init` propose a `firstlight.json`, read it, then write it:

```sh
npx firstlight init typecheck test check:architecture
npx firstlight init typecheck test check:architecture --write
```

See [Starting a config](#starting-a-config).

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
| `parser` | How to read the check's log when it fails: `tsc`, `vitest`, `node-test`, or `archstrict`, or a list of them, like `["tsc", "vitest"]`, read in order. Without it, firstlight infers the parser from `run`. `none` turns diagnostics off for this check. See [Diagnostics](#diagnostics). |
| `select` | A selector: a command that reads the changes since the check's last full pass on stdin and prints the tests they reach. It needs `runSelected`. See [Selecting tests](#selecting-tests), and [Selecting vitest tests](#selecting-vitest-tests) for the selector the package ships. |
| `runSelected` | The command that runs the selected tests, with `{tests}` where their ids go, like `vitest run {tests}`. It needs `select`. |
| `fullOn` | Path globs whose change runs the full `run` command without asking the selector, like `["package-lock.json", "vitest.config.ts"]`. `*` stays inside one directory and `**` crosses directories. It needs `select`. |

A check name in `firstlight.json` must match `[A-Za-z0-9][A-Za-z0-9._:-]*`, so that an argument that names it cannot also read as a pattern or a command. firstlight rejects unknown keys, unknown `after` names, cycles, and an unknown `parser` before it starts anything.

Without `firstlight.json`, each of the `package.json` scripts `lint`, `typecheck`, `test`, and `archstrict` that exists becomes a check that runs `npm run <name>`, with no `after`.

Other scripts whose name starts with one of those words or with `check` (`check:architecture`, `test:mutation`, `check`) are not run, because such a script can chain the others or take hours. `firstlight run` names them instead, after its result:

```text
passed 2 checks in 79.5s (run 01K...)
not run: check:architecture, test:mutation (without firstlight.json, only lint, typecheck, test, archstrict run; name a script, like firstlight run check:architecture, or write firstlight.json with firstlight init)
```

With `--json`, the summary gains `"not_run": ["check:architecture", "test:mutation"]`. When none of the four scripts exists, the error envelope names those scripts and suggests running them.

### Starting a config

`firstlight init` proposes a `firstlight.json` from the `package.json` scripts and prints it. It writes nothing until `--write` is given, and `--write` does not replace an existing `firstlight.json` without `--force`.

```text
$ firstlight init typecheck test check:architecture
would write /repo/firstlight.json:
{
  "checks": {
    "typecheck": {
      "run": "npm run typecheck",
      "parser": "tsc"
    },
    "test": {
      "run": "npm run test",
      "parser": "vitest"
    },
    "check:architecture": {
      "run": "npm run check:architecture"
    }
  }
}
left out: test:mutation (to add them: firstlight init typecheck test check:architecture test:mutation)
next: firstlight init typecheck test check:architecture --write
```

- With no names, the proposal holds the scripts `lint`, `typecheck`, `test`, and `archstrict` that exist. Names and patterns (`"check:*"`, as in `run`) pick any scripts instead. A shell command is not a script, so add it to `firstlight.json` by hand.
- Each check is named after its script and runs `npm run <script>`, the same command `firstlight run <script>` runs, so the runs before `init` still count for reused passes and time estimates.
- `parser` is written when firstlight can infer it from the script (see [Diagnostics](#diagnostics)). A script that chains commands with `&&`, like `tsc --noEmit && vitest run`, gets the list of its commands' parsers.
- `timeoutSec` is written when a kept run passed the same check in more than a third of the default 600 seconds: three times that duration, rounded up to whole minutes.
- `left out:` names the scripts that look like checks (they start with `lint`, `typecheck`, `test`, `check`, or `archstrict`) and that the proposal does not hold, with the command that adds them.
- `--json` prints one object: `{"type":"init","file","written","existed","config","left_out","next"}`.

The repository root is `git rev-parse --show-toplevel` from the current directory, or the current directory when that fails. `--cwd DIR` starts from `DIR` instead.

## Commands

```text
firstlight run [name|pattern|"command"...] [-- command...] [--no-cache] [--cwd DIR] [--json]
firstlight run --failed [--no-cache] [--cwd DIR] [--json]
firstlight results [--wait] [--new] [--cwd DIR] [--json]
firstlight follow [--cwd DIR] [--json]
firstlight stop [--cwd DIR] [--json]
firstlight init [script|pattern...] [--write [--force]] [--cwd DIR] [--json]
firstlight --help
```

- `run` stops the previous run if it is still going, starts the checks, and returns at the first `failed` or `timed_out` check, or when every check is done. A check that already passed on the same working tree, or failed there twice, is reused instead of run; see [Reused results](#reused-results). `--no-cache` runs every selected check.
- `run --failed` runs only the checks that did not pass in the latest run; see [Running what failed](#running-what-failed).
- `results` reports the latest run: status, exit code, elapsed time, and for `failed` and `timed_out` checks the diagnostics, the log path, and the last 40 log lines (10 when there are diagnostics). `--wait` blocks until every check is done. `--new` reports only the failures the previous run did not have; see [Only new failures](#only-new-failures).
- `follow` prints the status changes of the latest run as they happen; see [Following a run](#following-a-run).
- `stop` cancels the checks that are still running. With nothing running, it does nothing and exits 0.
- `init` proposes a `firstlight.json` from the `package.json` scripts, and writes it with `--write`; see [Starting a config](#starting-a-config).

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
next: firstlight run --failed
```

A `running` line shows the time left that firstlight estimated when the check started, when there is one. A failed or timed-out check has the same [diagnostics](#diagnostics) and log tail that `run` prints. A reused pass says `cached from run 01K...`, and a check whose supervisor died appears as `unknown` at the end. With `--json`, each change is one check object, in the same shape as `results --json`, followed by the diagnostic lines of a failed check, and the last line is the summary object.

Each line is written as it happens, with no buffering, so a tool that watches a command's output line by line, such as Claude Code's Monitor, sees each check finish. `follow` only reads the state; the supervisor stays the only writer of `events.jsonl`. With no run yet, it prints the error envelope with `"do":"firstlight run"`.

## Only new failures

`firstlight results --new` reports only the failures that were not there before, so a project that already has failures can still gate a change on not adding one:

```text
typecheck failed (exit 2, 1.4s)
  src/a.ts:4:26 TS2304 Cannot find name 'missing'.
  (1 diagnostic already in run 01K...)
  log: /.../typecheck.log
    ...
not new: 1 failure already in the previous run, 2 passed
run 01K...: 1 new failure
next: firstlight run --failed
```

The previous run is chosen per check: it is the newest kept run before the latest one in which a check with the same name and the same `run` command `passed`, `failed`, or `timed_out`. A run in which that check was `cancelled`, `skipped`, or never finished is passed over, because it proved nothing either way. This is per check, not one run for all, because `run --failed` and `run <name>` leave runs that hold only some of the checks.

A failure is new when:

- for a check with [diagnostics](#diagnostics): no diagnostic of the same check in the previous run has the same file, rule, and message. The line and column do not count, so code that only moved is not new. The cost is that a second copy of a known error, in the same file with the same rule and message, is not new either.
- for a failed or timed-out check without diagnostics: the check did not fail or time out in the previous run.
- for a check with no previous run at all: always. The output says so in one line: `no earlier run to compare with, so every failure counts as new`, or `no earlier result for lint, so its failures count as new` when only some checks have none.

The output lists each check with a new failure, with only its new diagnostics, and each check that proved nothing yet (`pending`, `running`, `cancelled`, or `unknown`). Passed checks, skipped checks, and failures that were already there are counts on the `not new:` line. A skipped check is judged through the `after` check whose failure skipped it.

`--new` works with `--wait`, and the gate use waits for every check: `firstlight results --new --wait`. It exits 1 when there is a new failure, or when a check is still `pending` or `running`, was `cancelled`, or is `unknown`, because those checks prove nothing. Otherwise it exits 0, also when the run has failures that were already there.

With `--json`, every check object of `results --json` comes, with two more fields: `new` (`true` when the check has a new failure) and `baseline` (the id of the run it was compared with, or `null`). A failed check also has `old_diagnostics`, the number of its diagnostics that were already there. Only the new diagnostics follow a check, and `more_diagnostics` counts the new ones past 20. The summary has four more fields: `new` (the checks with a new failure), `new_failures` and `old_failures` (counts, where a failure is one diagnostic, or one failed check without diagnostics), and `no_baseline` (the checks with no previous run).

```json
{"type":"check","name":"typecheck","status":"failed","exit_code":2,"elapsed_ms":1412,"log":"/.../typecheck.log","eta_ms":0,"overdue":false,"cached_from":null,"new":true,"baseline":"01K...","old_diagnostics":1,"tail":["..."]}
{"type":"diagnostic","check":"typecheck","file":"src/a.ts","line":4,"col":26,"rule":"TS2304","message":"Cannot find name 'missing'."}
{"type":"summary","run":"01K...","failed":["typecheck"],"running":[],"passed":[],"cancelled":[],"next":"firstlight run --failed","eta_ms":0,"new":["typecheck"],"new_failures":1,"old_failures":1,"no_baseline":[]}
```

## Diagnostics

When a check fails or times out, firstlight reads its log with the check's parser, if it has one, and prints the problems the tool reported in one shape, before the log tail:

```text
typecheck failed (exit 2, 1.4s)
  src/a.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'.
  src/a.ts:2:26 TS2304 Cannot find name 'missing'.
  log: /.../typecheck.log
    > app@1.0.0 typecheck
    > tsc --noEmit
    ...
```

Each line is `file:line:col rule message`. A part the tool does not report is left out. With diagnostics, the log tail is 10 lines instead of 40, because the diagnostics carry the substance. A check shows at most 20 diagnostics, then `(N more diagnostics in the log)`. Without a parser, or when the parser finds nothing, the output is the log tail as before.

| Parser | Reads | `rule` |
| --- | --- | --- |
| `tsc` | `path(line,col): error TSxxxx: message`, and the `--pretty` form `path:line:col - error TSxxxx: message` | the `TSxxxx` code |
| `vitest` | the default reporter: each `FAIL` block, its error, and the first stack frame inside the repository | the test's full name, `suite > test`; none for a file that failed to load |
| `node-test` | `node --test` with the spec reporter (its `failing tests` section) or the TAP reporter; the first stack frame inside the repository | the test's full name, `suite > test` |
| `archstrict` | the text of `archstrict check`: `[rule] path:line:col` and the evidence line | the rule id |

The message is the first line of the error. A line that ends in `:` takes the next line too, so `Expected values to be strictly equal: 7 !== 6` stays whole. Paths inside the repository are relative to its root. Colors and CRLF line endings make no difference.

A check's `parser` in `firstlight.json` chooses the parser. Without one, firstlight infers it from the `run` command when the command is simple commands joined by `&&`: `tsc`, `vitest`, `node --test`, or `archstrict`, also through `npx`, `pnpm exec`, a `node_modules/.bin/` path, or a leading `NAME=value`. For `npm run <script>` and `npm test`, it reads the script's own command in `package.json`, one level deep. An `&&` list, like `tsc --noEmit && vitest run`, gets the parser of each command that has one, in order, and its diagnostics are what each parser finds; a parser skips the lines of other tools. A command with `||`, `;`, or a pipe gets no parser, because which tool's output the log ends with is not fixed. firstlight decides the parser when the run starts, so `results` reads the log the same way later. A parser reads text, so a command that prints JSON, such as `archstrict check --json`, gives no diagnostics.

In `--json`, the diagnostics follow their check's object, one line each:

```json
{"type":"check","name":"typecheck","status":"failed","exit_code":2,"elapsed_ms":1412,"log":"/.../typecheck.log","eta_ms":0,"overdue":false,"cached_from":null,"tail":["> app@1.0.0 typecheck","> tsc --noEmit","..."]}
{"type":"diagnostic","check":"typecheck","file":"src/a.ts","line":1,"col":14,"rule":"TS2322","message":"Type 'number' is not assignable to type 'string'."}
{"type":"diagnostic","check":"typecheck","file":"src/a.ts","line":2,"col":26,"rule":"TS2304","message":"Cannot find name 'missing'."}
```

`line`, `col`, and `rule` are `null` when the tool has none. When a check has more than 20 diagnostics, its object has `more_diagnostics`, the number left out.

### depug evidence and rerun

When the vitest run uses [depug](https://www.npmjs.com/package/@meganemura/depug)'s reporter, depug prints an evidence file and a rerun command for each failed test. firstlight attaches both to that test's diagnostic, as two lines under it:

```text
test failed (exit 1, 3.2s)
  test/names.test.ts:6:10 quotes a word with a space AssertionError: Expected values to be strictly equal: "'a b'" !== 'a b'
    evidence: /.../tmp/depug/run-20261012-101024-1110/001-quotes-a-word-with-a-space.json
    rerun: npx depug rerun -- npx vitest run "test/names.test.ts" -t "^quotes a word with a space$"
  log: /.../test.log
```

In `--json`, the diagnostic line gets `evidence` (the absolute path) and `rerun` (the command) as two more fields. A diagnostic without them has neither field.

firstlight matches by the test file and the full test name in depug's rerun command, against the file and the name in vitest's `FAIL` header. vitest joins the names with ` > ` and depug with a space, so two tests can look the same (`a > b c` and `a b > c`). When two failed tests, or two depug failures, have the same file and name, or when depug printed nothing for a test, firstlight attaches nothing to it. A log without depug lines gives the same diagnostics as before. This applies everywhere diagnostics show: `run`, `results`, `results --new`, and `follow`.

## Reused results

When a check already passed in a kept run on the same working tree, with the same command, `firstlight run` does not run it again. It reports the earlier pass:

```text
test passed (cached from run 01K..., 10.4s originally)
```

If every selected check is reused, `run` starts no check and exits 0 at once: `passed 4 checks in 0.2s (4 cached, run 01K...)`. A check that is `after` a reused check starts right away. This saves the slow checks when an agent runs again after changing nothing, or after a failure in a different check.

A failure is reused too, once it has repeated: when two runs that really ran the check on the same key both failed, and no run on that key passed, the next run reports the failure with the log of the run that had it, and does not run the check:

```text
test failed (cached from run 01K..., 10.4s originally)
...the last lines of that run's log...
firstlight: not run; failed in run 01K... on the same working tree with the same command. Change something, or run it again with --no-cache if the failure came from outside the tree or may be flaky
```

The first run again after a failure still runs the check, because a failure can come from outside the tree, like a service that was down or a flaky test, and that run is how an agent finds out. A third run of the same failure on the same tree only repeats what the agent already knows. Coding agents do this often: in a 2026 study of 1,200 agent sessions, running unchanged tests again was one of three wasteful habits found in most tasks ([arXiv:2609.30725](https://arxiv.org/abs/2609.30725)). A failure counts only when the command itself exited non-zero; a check that could not start, timed out, or was cancelled is never reused. A check that passed once on a key never gets a reused failure on that key.

firstlight compares a cache key. The key of a check is the SHA-256 of:

- the tree key: the git tree hash of the working tree, tracked and untracked files, without ignored files. firstlight computes it with `git add -A` and `git write-tree` against a temporary index of its own, so the real index, the staged changes, and the refs do not change. The blobs of changed files go into the object store as loose objects, which `git gc` removes later like any other unreferenced object;
- the check's `run` command;
- the keys of its `after` checks.

The name of a check and its `timeoutSec` are not part of the key. `firstlight.json` is part of the tree unless it is ignored, so an edit to it runs every check again.

A `timed_out`, `cancelled`, `skipped`, or `unknown` check runs again. firstlight finds a result in the kept runs, newest first, so a pruned run stops being a source. A result that was itself reused names the run that really ran the check, with that run's time, so a chain of unchanged runs keeps one origin.

The limits:

- Environment variables are not part of the key. A check whose result depends on one gives the earlier result after that variable changes.
- Files outside the repository, ignored files (for example `node_modules/`), the installed tools, and the state of a network service are not part of the key.
- The tree is hashed once, when the run starts. An edit made while a check runs is not in the key of that run.
- A directory that is not the root of a git repository has no tree key, and nothing is reused there. A git failure has the same effect.

In these cases, run `firstlight run --no-cache`. It runs every selected check, and still records the keys, so a later run can reuse its passes.

## Selecting tests

A check with a selector runs only the tests that the changes reach, once it has passed in full:

```json
{
  "checks": {
    "test": {
      "run": "vitest run",
      "select": "my-selector",
      "runSelected": "vitest run {tests}",
      "fullOn": ["package-lock.json", "vitest.config.ts"]
    }
  }
}
```

firstlight knows no language. It decides when to narrow a check, gives the selector the changes, and runs the tests that the selector returns. A selector is any command that reads one JSON object on stdin and prints one JSON object on stdout. A selector for one language records during the full run which tests reach which files, and selects from that record later. For vitest, the package ships one: see [Selecting vitest tests](#selecting-vitest-tests).

**Recording.** When a check with `select` runs its full `run` command, firstlight creates a directory for it in the run's state and sets `FIRSTLIGHT_RECORD` to that directory's absolute path for the check's process. A recorder in the test run can write its map there. firstlight removes the directory when it prunes the run. A narrowed run does not set `FIRSTLIGHT_RECORD`.

**Selecting.** In a later run, firstlight finds the newest kept run where the check ran its full `run` command and passed. It lists the files that changed between that run's tree and the current tree (`git diff --name-status --no-renames`, tracked and untracked files, with deletions). Then it runs `select` with `/bin/sh -c` in the repository root, without `FIRSTLIGHT_RECORD`, and writes this object to its stdin:

```json
{
  "version": 1,
  "check": "test",
  "tree": "<the current tree key>",
  "base": { "run": "01K...", "tree": "<the tree key of that run>", "record": "/.../runs/01K.../record/test" },
  "changes": [
    { "status": "M", "path": "src/a.ts" },
    { "status": "D", "path": "src/old.ts" }
  ]
}
```

`base.record` is `null` when the full run left no record directory. A rename is a deletion and an addition.

The selector prints one of these on stdout and exits 0:

```json
{"tests": [{"id": "src/a.test.ts"}, {"id": "src/b.test.ts", "reason": "imports src/a.ts"}]}
{"full": "the record is older than the test files"}
```

Each test needs `id`, a non-empty string. Other fields stay in the run record. An id that is named twice runs once. firstlight puts the ids, each quoted for the shell and separated by spaces, in place of `{tests}` in `runSelected`, in the selector's order, and runs that command:

```text
test passed (selected 2 tests for 3 changed files since run 01K..., 3.1s)
```

When the selector selects no test, the check passes without a process. Its log holds one line that says so:

```text
test passed (selected 0 tests for 3 changed files since run 01K...)
```

**Full runs.** firstlight runs the full `run` command when:

- the check has not passed its full command in a kept run;
- no file changed since that run;
- git could not list the changes;
- a changed file matches `fullOn` (firstlight then does not run the selector);
- the selector printed `{"full": "<reason>"}`;
- the selector exited with a code other than 0, did not answer within 60 seconds, or printed anything other than one of the two objects above;
- `run --full` was given. `run --no-cache` still selects; it only stops reuse.

When a check with a selector had a full pass to count from and still ran in full, its status line says why. The reason for a failed selector includes the first lines of its stderr:

```text
test passed (full run: the selector exited 1 (stderr: cannot read the record), 10.2s)
```

A narrowed run never becomes the base of a later narrowing, so the changes always count from a full pass. Every full run that passes is a new base with a new record, including one that the selector asked for or one after a failed selector. The selected command is part of the cache key, so the same selection on the same tree is reused like any other result. The selector still runs first, because only its answer names that command.

In `--json`, the check line gets `narrowed` when the selector selected the tests: `{"base": "<run id>", "files": [...], "tests": [{"id": "...", ...}], "command": "..."}`, where `command` is `null` when it selected none. It gets `full_run` when the check ran in full after all: `{"base": "<run id>", "reason": "..."}`. `run.json` records both fields under the same names, keyed by check.

The limit is the selector's record. A test that reads a file at run time, or starts the code as a child process, reaches that code only when the recorder sees it. Put the files that every test depends on in `fullOn`, and run `firstlight run --full` before a merge.

## Selecting vitest tests

The package ships a selector for Node projects that test with vitest. Its recorder is a vitest setup file: during a full run, it records which functions each test file ran, in the test's own worker and in every Node process the test started. `firstlight-node select` reads that record and selects a test file only when a change touched code that the test file ran. Running the code is what counts, not importing it: a test that starts the CLI as a child process reaches the CLI's code, and a test that imports a module but never calls a function does not reach that function.

Two settings go in the vitest config:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["firstlight/node/vitest-setup"],
    experimental: { viteModuleRunner: false },
  },
});
```

and the selector goes in the check:

```json
{
  "checks": {
    "test": {
      "run": "vitest run",
      "select": "firstlight-node select --ignore '*.md' --ignore '**/*.md'",
      "runSelected": "vitest run --passWithNoTests {tests}",
      "fullOn": ["package-lock.json", "vitest.config.ts"]
    }
  }
}
```

`--passWithNoTests` keeps a narrowed run green when the selected files hold no test that vitest's `include` matches, such as a new `*.test.ts` file outside it.

**Requirements.**

- vitest with `test.experimental.viteModuleRunner: false` (tested with vitest 4.1.11). Node then loads each module itself, and V8's coverage names the file of each function. Through vite's module runner, V8 names no file. The recorded positions are positions in the source, because Node runs JavaScript as written and TypeScript with its types replaced by spaces. Code that needs a transform before Node can run it (an `enum`, JSX, decorators) cannot be recorded this way.
- One test file per worker: `isolate: true`, the default. Tested with the default `forks` pool. When two test files ran in one worker, the selector asks for the full run and says so.
- The recorder first in `setupFiles`, so that the other setup files run while it records.
- A process that a test starts keeps `NODE_V8_COVERAGE` in its environment. A process started with an environment that leaves it out is not recorded.

**Recording.** The setup file does nothing unless `FIRSTLIGHT_RECORD` is set, so it can stay in the config. When it is set, which firstlight does only for the full run of a check with a selector, the setup file starts V8's precise coverage in the worker and sets `NODE_V8_COVERAGE` for the processes that the test starts. Each test file gets a directory under `$FIRSTLIGHT_RECORD/raw/` with its path, the worker's coverage, and one coverage file for each Node process that exited without a signal. The setup file reads nothing.

The first selection from a recording turns the raw coverage into `map.json` in the same directory and removes the raw files. The map holds, for each source file in the repository and outside `node_modules`, the functions that any test compiled, and for each test file, the source files it loaded and the functions it ran.

**Selection.** For each changed file that no `--ignore` glob matches:

- A changed test file selects itself: a test file in the recording, or a new file named `*.test.*` or `*.spec.*` with a JavaScript or TypeScript extension. A deleted test file is never selected.
- A changed source file that a test loaded is diffed between the base tree and the current tree (`git diff -U0`), and each changed line goes to the innermost function whose body holds it. A test file is selected when it ran one of those functions. A function's body starts on the line after its first line, so a change to a function's name or signature counts as a change to the code around the function. A change outside every function body (an import, a top-level statement, a function that no test compiled) selects every test file that loaded the source file. A deleted source file selects every test file that loaded it.
- A source file with a JavaScript or TypeScript extension (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`) that no test loaded selects nothing.
- Any other file asks for the full run, because a test can read it at run time and coverage does not see a read: `{"full": "test/fixtures/a.json is not code and no recording covers it"}`.

`--always <glob>` selects every recorded test file that matches. Use it for a test of built output: the recording names `dist/cli.js`, not the `src/cli.ts` it was built from. `--ignore <glob>` leaves out every changed file that matches. The globs work like `fullOn`: `*` stays inside one directory and `**` crosses directories, so `**/*.md` does not match `README.md` at the root, and `*.md` does.

Each selected test's id is its path relative to the repository root, and its `reason` names the change, such as `"src/math.ts changed in triple"`, `"src/math.ts changed outside any function"`, `"changed"`, or `"--always"`.

**Full runs.** Beside firstlight's own reasons, the selector asks for the full run when the base run left no recording (the setup file is not in the vitest config, or vitest ran without firstlight), when two test files ran in one worker, when another version of `firstlight-node` wrote the map, and when a changed file is not code.

**Limits.** The vitest config, `globalSetup` files, and any other code that runs outside a test file's worker are not recorded: put them in `fullOn`. A new source file that a test loads by listing a directory, not by an import, selects nothing until a file that loads it changes. A process killed by a signal writes no coverage. A test whose inputs change from run to run, such as a property test, can run a function in one run and not in the next, and the selection follows the run that was recorded: two recordings of this repository's suite differed in 1 to 6 of about 3,580 pairs of a test file and a function it ran, all in one property test file. `--always '**/*.property.test.ts'` runs such tests on every change. Run `firstlight run --full` before a merge.

## CPU contention

firstlight starts every check at once and has no concurrency limit. Test runners such as vitest and `node --test` already spread one check over every core, so checks that run together share the CPU: each one takes longer than it does alone, and the whole run takes at least the checks' total CPU time divided by the number of cores. Measured on a 4-CPU machine, with Node 24.21.0, three runs each, times in seconds:

| Repository | Checks | Each alone (sum) | Together | Slowest check alone, together |
| --- | --- | --- | --- | --- |
| firstlight | typecheck, test, archstrict | 35.1 | 34.7 | test 30.9, 34.2 |
| finderscope | typecheck, test, archstrict | 62.8 | 59.4 | test 58.4, 58.9 |
| polylinedb | typecheck, test, check:architecture | 197.8 | 178.9 | test 132.0, 178.4 |

In polylinedb, test used about 2.9 cores and check:architecture about 3.8 while each ran alone, so together they need about 160 seconds of the 4 cores at best; 179 is close to that, and 20 seconds less than one after the other. A limit on how many checks run at once would not make the run shorter, because the total CPU time is the same; it would only move time from one check to another. The failure that arrives first still arrives first: typecheck finished in 3 to 6 seconds in every run, against about 2 alone. (finderscope's test had the same two failures on that machine in every run, alone and together.)

To see one heavy check's result sooner at the cost of a longer run, start another heavy check after it with `after`. In polylinedb, putting check:architecture after test would let test report at about 132 seconds instead of 178, and the run would end at about 196 instead of 179.

## Statuses and output

A check is `pending`, `running`, `passed`, `failed`, `timed_out`, `cancelled`, or `skipped`. A check is `unknown`, with `orphan: true`, when its supervisor process is gone before the check finished. firstlight does not invent an exit code for it. A check killed by a signal has the exit code 128 plus the signal number.

The default output is short plain text with no colors. `--json` prints JSON Lines: one object per check, then one summary:

```json
{"type":"check","name":"lint","status":"failed","exit_code":1,"elapsed_ms":205,"log":"/.../lint.log","eta_ms":0,"overdue":false,"cached_from":null,"tail":["src/a.ts:3:1 unused variable x"]}
{"type":"check","name":"test","status":"running","exit_code":null,"elapsed_ms":null,"log":"/.../test.log","eta_ms":8012,"overdue":false,"cached_from":null}
{"type":"check","name":"build","status":"passed","exit_code":0,"elapsed_ms":10412,"log":"/.../build.log","eta_ms":0,"overdue":false,"cached_from":"01K..."}
{"type":"summary","run":"01K...","failed":["lint"],"running":["test"],"passed":["build"],"cancelled":[],"next":"firstlight results --wait","eta_ms":8012}
```

`failed` in the summary holds the checks that are `failed`, `timed_out`, `skipped`, or `unknown`. `running` holds `pending` and `running` checks. `next` is the command to run next, or `null`: `firstlight results --wait` while a check is still running, and `firstlight run --failed` once every check is done and one did not pass. `eta_ms` on a check is the estimated milliseconds it has left: `0` for a finished check, and `null` when there is no estimate. `overdue` is `true` when a running check has run longer than its usual duration; its `eta_ms` is then `0`. `cached_from` is the id of the run that ran a reused check, or `null`. That run may be pruned since. For a reused check, `exit_code` and `elapsed_ms` come from that run, and its log holds one line that names it. `eta_ms` in the summary is the estimate for the whole run, `0` when nothing is left to run, or `null`.

## Exit codes

| Command | 0 | 1 |
| --- | --- | --- |
| `run` | every check passed | any check did not pass |
| `results`, `follow` | no check is `failed`, `timed_out`, `skipped`, `cancelled`, or `unknown` | at least one is |
| `results --new` | no failure is new, and no check is `pending`, `running`, `cancelled`, or `unknown` | a failure is new, or a check proved nothing yet |
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
  runs/<run-id>/record/<check>/  what the check's recorder wrote during a
                            full run (only for a check with "select")
```

The log file name of a check is its name with each character outside `[A-Za-z0-9._-]` replaced by `_`, cut to 100 characters: `lint:js` writes `lint_js.log`, and `bundle exec rspec` writes `bundle_exec_rspec.log`. The name in the output and in `--json` stays as written. When two checks of one run would share a file name, ignoring case, or a check would take `supervisor.log`, one of them gets `-2`, `-3`, and so on; a name that is already a safe file name keeps its own file. The `log` field in `--json` always gives the real path.

`<repo-key>` is the first 16 hex characters of the SHA-256 of the repository root path. Run ids sort by start time. firstlight keeps the newest 20 runs.

Each run has one detached supervisor process. It records the reused passes, starts the other checks, waits on them, enforces timeouts, and writes `events.jsonl`. There is no long-lived daemon. Each check runs in its own process group, so a stop or a timeout reaches every process the check started.

## Non-goals for v0.1

- Diagnostics come only from the four parsers above. Any other tool shows its log tail as it is.
- No cache beyond reused passes. Earlier runs feed the time-left estimate, the passes a run reuses, and the comparison of `results --new`, and nothing else.
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
