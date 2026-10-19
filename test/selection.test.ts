import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, currentRun, makeRepo, parseLines, runFiles, type Repo } from "./helpers.ts";

// The selector is a shell script, so these tests show that the protocol
// needs nothing but stdin, stdout, and an exit code. It saves its stdin and
// prints whatever the test put in the marker directory.
const SELECTOR = `cat > "$1/stdin.json"
echo "\${FIRSTLIGHT_RECORD:-unset}" > "$1/selector-env"
cat "$1/stdout"
cat "$1/stderr" >&2
exit "$(cat "$1/code")"
`;

function markerDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-marker-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function answer(marks: string, stdout: unknown, code = 0, stderr = ""): void {
  writeFileSync(path.join(marks, "stdout"), typeof stdout === "string" ? stdout : JSON.stringify(stdout));
  writeFileSync(path.join(marks, "stderr"), stderr);
  writeFileSync(path.join(marks, "code"), `${code}\n`);
}

function selectorRepo(marks: string, files: Record<string, unknown> = {}): Repo {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        test: {
          run: `echo full >> ${marks}/log; echo "$FIRSTLIGHT_RECORD" >> ${marks}/record-env; echo map > "$FIRSTLIGHT_RECORD/map"`,
          select: `sh select.sh ${marks}`,
          runSelected: `printf '%s\\n' {tests} >> ${marks}/selected`,
          fullOn: ["*.lock"],
        },
      },
    },
    "select.sh": SELECTOR,
    "a.ts": "1\n",
    "b.ts": "1\n",
    ...files,
  });
  onTestFinished(() => cleanup(repo));
  return repo;
}

async function latest(repo: Repo): Promise<{ check: Record<string, unknown>; run: string }> {
  const output = parseLines((await cli(repo, ["results", "--json"])).stdout);
  return { check: output[0]!, run: output.at(-1)!.run as string };
}

test("a full run records, and a later run gives the selector the changes and runs the tests it picks", async () => {
  const marks = markerDir();
  const repo = selectorRepo(marks);

  const full = await cli(repo, ["run"], { FIRSTLIGHT_RECORD: "/nowhere" });
  assert.equal(full.code, 0, full.stdout);
  const base = currentRun(repo);
  const record = path.join(base.dir, "record", "test");
  assert.deepEqual(lines(`${marks}/record-env`), [record]);
  assert.equal(readFileSync(path.join(record, "map"), "utf8"), "map\n");
  assert.equal(existsSync(`${marks}/stdin.json`), false, "no full pass yet, so no selector call");

  writeFileSync(path.join(repo.root, "a.ts"), "2\n");
  unlinkSync(path.join(repo.root, "b.ts"));
  answer(marks, { tests: [{ id: "a test", file: "a.test.ts" }, { id: "b" }, { id: "a test" }] });
  const narrowed = await cli(repo, ["run"], { FIRSTLIGHT_RECORD: "/nowhere" });
  assert.equal(narrowed.code, 0, narrowed.stdout);
  const run = currentRun(repo);
  assert.deepEqual(JSON.parse(readFileSync(`${marks}/stdin.json`, "utf8")), {
    version: 1,
    check: "test",
    tree: (run.run as unknown as { tree: string }).tree,
    base: { run: base.id, tree: (base.run as unknown as { tree: string }).tree, record },
    changes: [
      { status: "M", path: "a.ts" },
      { status: "D", path: "b.ts" },
    ],
  });
  assert.deepEqual(lines(`${marks}/selector-env`), ["unset"]);
  assert.deepEqual(lines(`${marks}/selected`), ["a test", "b"]);
  assert.deepEqual(lines(`${marks}/log`), ["full"]);
  assert.equal(existsSync(path.join(run.dir, "record")), false, "a narrowed run records nothing");

  const { check } = await latest(repo);
  assert.deepEqual(check.narrowed, {
    base: base.id,
    files: ["a.ts", "b.ts"],
    tests: [{ id: "a test", file: "a.test.ts" }, { id: "b" }],
    command: `printf '%s\\n' 'a test' b >> ${marks}/selected`,
  });
  assert.equal(check.full_run, undefined);
  const text = await cli(repo, ["results"]);
  assert.match(text.stdout, new RegExp(`^test passed \\(selected 2 tests for 2 changed files since run ${base.id}, exit 0, `));

  const again = await cli(repo, ["run", "--json"]);
  assert.notEqual(parseLines(again.stdout)[0]!.cached_from, null, "the same selection on the same tree is reused");
  assert.equal(lines(`${marks}/selected`).length, 2);

  writeFileSync(path.join(repo.root, "c.ts"), "1\n");
  answer(marks, { tests: [{ id: "c" }] });
  assert.equal((await cli(repo, ["run"])).code, 0);
  const third = JSON.parse(readFileSync(`${marks}/stdin.json`, "utf8")) as { base: { run: string }; changes: unknown[] };
  assert.equal(third.base.run, base.id, "changes count from the last full pass, not a narrowed one");
  assert.equal(third.changes.length, 3);
});

test("a selector that picks no test passes the check without running anything", async () => {
  const marks = markerDir();
  const repo = selectorRepo(marks);
  assert.equal((await cli(repo, ["run"])).code, 0);
  const base = currentRun(repo).id;

  writeFileSync(path.join(repo.root, "a.ts"), "2\n");
  answer(marks, { tests: [] });
  const none = await cli(repo, ["run", "--json"]);
  assert.equal(none.code, 0, none.stdout);
  const check = parseLines(none.stdout)[0]!;
  assert.equal(check.status, "passed");
  assert.equal(check.exit_code, null);
  assert.deepEqual(check.narrowed, { base, files: ["a.ts"], tests: [], command: null });
  assert.deepEqual(lines(`${marks}/log`), ["full"]);
  assert.equal(existsSync(`${marks}/selected`), false);
  assert.deepEqual(lines(check.log as string), [`firstlight: not run; the selector chose no test for 1 changed file since run ${base}`]);
  const event = currentRun(repo).events.find((line) => line.check === "test")!;
  assert.equal(event.no_tests, true);
  assert.equal(event.status, "passed");

  const text = await cli(repo, ["results"]);
  assert.match(text.stdout, new RegExp(`^test passed \\(selected 0 tests for 1 changed file since run ${base}\\)\n`));
});

test("a selector that fails or asks for it, a fullOn match, and --full each run the full command", async () => {
  const marks = markerDir();
  const repo = selectorRepo(marks);
  assert.equal((await cli(repo, ["run"])).code, 0);
  let base = currentRun(repo).id;
  const fullRun = async (): Promise<unknown> => (await latest(repo)).check.full_run;

  writeFileSync(path.join(repo.root, "a.ts"), "2\n");
  answer(marks, { tests: [{ id: "a" }] }, 1, "boom\nat line 3\n");
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.match((await cli(repo, ["results"])).stdout, /^test passed \(full run: the selector exited 1 \(stderr: boom; at line 3\), exit 0, /);
  assert.deepEqual(await fullRun(), { base, reason: "the selector exited 1 (stderr: boom; at line 3)" });
  base = currentRun(repo).id;

  writeFileSync(path.join(repo.root, "a.ts"), "3\n");
  answer(marks, "Resolving dependencies...\n{}");
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.deepEqual(await fullRun(), { base, reason: "the selector printed output that is not one JSON object" });
  base = currentRun(repo).id;

  writeFileSync(path.join(repo.root, "a.ts"), "4\n");
  answer(marks, { full: "the map is older than the test files" });
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.deepEqual(await fullRun(), { base, reason: "the selector asked for it: the map is older than the test files" });
  base = currentRun(repo).id;
  assert.equal(lines(`${marks}/record-env`).at(-1), path.join(currentRun(repo).dir, "record", "test"), "a full run records again");
  assert.deepEqual(lines(`${marks}/log`), ["full", "full", "full", "full"]);
  assert.equal(existsSync(`${marks}/selected`), false);

  writeFileSync(path.join(repo.root, "deps.lock"), "x\n");
  unlinkSync(`${marks}/stdin.json`);
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.deepEqual(await fullRun(), { base, reason: "deps.lock matches fullOn" });
  base = currentRun(repo).id;
  assert.equal(existsSync(`${marks}/stdin.json`), false, "a fullOn match asks no selector");

  writeFileSync(path.join(repo.root, "a.ts"), "5\n");
  assert.equal((await cli(repo, ["run", "--full"])).code, 0);
  assert.equal(existsSync(`${marks}/stdin.json`), false, "--full asks no selector");
  assert.equal(await fullRun(), undefined);
  assert.equal(lines(`${marks}/log`).length, 6);
  assert.match((await cli(repo, ["results"])).stdout, /^test passed \(exit 0, /);
});

test("select needs runSelected with {tests}, fullOn needs select, and affected is unknown", async () => {
  const refusal = async (check: Record<string, unknown>): Promise<string> => {
    const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "true", ...check } } } });
    onTestFinished(() => cleanup(repo));
    const refused = await cli(repo, ["run"]);
    assert.equal(refused.code, 1);
    return (JSON.parse(refused.stderr) as { error: string }).error;
  };
  assert.equal(await refusal({ select: "pick" }), `invalid firstlight.json: check "test" has "select" without "runSelected"`);
  assert.equal(await refusal({ runSelected: "vitest run {tests}" }), `invalid firstlight.json: check "test" has "runSelected" without "select"`);
  assert.equal(
    await refusal({ select: "pick", runSelected: "vitest run" }),
    `invalid firstlight.json: check "test" has "runSelected" that is not a shell command holding {tests}, like "vitest run {tests}"`,
  );
  assert.equal(await refusal({ select: " ", runSelected: "x {tests}" }), `invalid firstlight.json: check "test" needs "select" to be a non-empty shell command string`);
  assert.equal(await refusal({ fullOn: ["*.lock"] }), `invalid firstlight.json: check "test" has "fullOn" without "select"`);
  assert.equal(
    await refusal({ select: "pick", runSelected: "x {tests}", fullOn: "*.lock" }),
    `invalid firstlight.json: check "test" has "fullOn" that is not an array of path globs`,
  );
  assert.equal(
    await refusal({ affected: "vitest related {files}" }),
    `invalid firstlight.json: check "test" has unknown key "affected"; allowed keys are run, after, timeoutSec, parser, select, runSelected, fullOn, paths`,
  );

  const flag = makeRepo({ "firstlight.json": { checks: { test: { run: "true" } } } });
  onTestFinished(() => cleanup(flag));
  assert.deepEqual(JSON.parse((await cli(flag, ["results", "--full"])).stderr), { error: "--full belongs to run", do: "run `firstlight run --full`" });
});
