import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, makeRepo, parseLines, type Repo } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const NODE_MODULES = path.join(ROOT, "node_modules");
const SETUP = path.join(ROOT, "src", "node", "vitest-setup.ts");

function available(command: string): boolean {
  return spawnSync("/bin/sh", ["-c", command], { stdio: "ignore" }).status === 0;
}

const HAS_MINITEST = available(`ruby -e 'require "minitest"'`);
const HAS_RSPEC = available("rspec --version");

function write(repo: Repo, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(repo.root, file)), { recursive: true });
  writeFileSync(path.join(repo.root, file), content);
}

async function failedRun(repo: Repo): Promise<Record<string, unknown>[]> {
  await cli(repo, ["run"]);
  const results = await cli(repo, ["results", "--wait", "--json"]);
  assert.equal(results.code, 1, results.stderr);
  return parseLines(results.stdout);
}

// Without FIRSTLIGHT_TESTS, so that when firstlight runs this suite, the
// failing tests these reruns run do not count as this suite's.
function rerun(repo: Repo, command: string): string {
  const env = { ...process.env };
  delete env.FIRSTLIGHT_TESTS;
  const out = spawnSync("/bin/sh", ["-c", `${command} 2>&1`], { cwd: repo.root, encoding: "utf8", env });
  // vitest colors its summary on CI even when it writes to a pipe.
  return out.stdout.replace(/\u001b\[[0-9;]*m/g, "");
}

const NODE_TEST = `import { describe, test } from "node:test";
import assert from "node:assert/strict";
describe("math", () => {
  test("adds", () => assert.equal(1 + 1, 2));
  test("subtracts", () => {
    assert.equal(3 - 1, 1);
  });
});
test("stands alone", () => {});
`;

test("node:test results come back per test, and a failed test gets its line and a rerun that runs only that test", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "node --test" } } } });
  onTestFinished(() => cleanup(repo));
  write(repo, "test/math.test.mjs", NODE_TEST);

  const lines = await failedRun(repo);
  const check = lines.find((line) => line.type === "check")!;
  assert.deepEqual(check.tests, { passed: 2, failed: 1, skipped: 0, file: (check.tests as { file: string }).file });
  assert.match((check.tests as { file: string }).file, /\/test\.tests\.jsonl$/);
  const diagnostics = lines.filter((line) => line.type === "diagnostic");
  assert.deepEqual(diagnostics, [
    {
      type: "diagnostic",
      check: "test",
      file: "test/math.test.mjs",
      line: 6,
      col: null,
      rule: "math > subtracts",
      message: "Expected values to be strictly equal: 2 !== 1",
      rerun: 'node --test --test-name-pattern="^subtracts$" "test/math.test.mjs"',
    },
  ]);
  assert.match(rerun(repo, diagnostics[0]!.rerun as string), /\nℹ tests 1\n[\s\S]*ℹ fail 1\n/);

  const text = await cli(repo, ["results"]);
  assert.match(
    text.stdout,
    /^test failed \(exit 1, 3 tests, 1 failed, \d+\.\ds\)\n {2}test\/math\.test\.mjs:6 math > subtracts Expected values to be strictly equal: 2 !== 1\n {4}rerun: node --test --test-name-pattern="\^subtracts\$" "test\/math\.test\.mjs"\n {2}tests: \S+\/test\.tests\.jsonl\n {2}log: /,
  );
});

test("each recorded test keeps its duration in the tests file, passed ones too", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "node --test" } } } });
  onTestFinished(() => cleanup(repo));
  write(repo, "test/math.test.mjs", NODE_TEST);

  const lines = await failedRun(repo);
  const file = (lines.find((line) => line.type === "check")!.tests as { file: string }).file;
  const recorded = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(recorded.map((line) => [line.name, line.status]).sort(), [
    ["math > adds", "passed"],
    ["math > subtracts", "failed"],
    ["stands alone", "passed"],
  ]);
  for (const line of recorded) assert.equal(typeof line.duration_ms, "number");
});

test("a test process below the root gets files relative to the root and a rerun that changes into its directory", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "cd web && node --test" } } } });
  onTestFinished(() => cleanup(repo));
  write(repo, "web/test/math.test.mjs", NODE_TEST);

  const lines = await failedRun(repo);
  const diagnostic = lines.find((line) => line.type === "diagnostic")!;
  assert.equal(diagnostic.file, "web/test/math.test.mjs");
  assert.equal(diagnostic.rerun, 'cd web && node --test --test-name-pattern="^subtracts$" "test/math.test.mjs"');
  assert.match(rerun(repo, diagnostic.rerun as string), /\nℹ tests 1\n/);
});

test("the recorders join the check's own NODE_OPTIONS, RUBYOPT, and SPEC_OPTS, and a check without tests has no results", async () => {
  const repo = makeRepo({
    "firstlight.json": { checks: { env: { run: 'printf "%s\\n%s\\n%s\\n" "$NODE_OPTIONS" "$RUBYOPT" "$SPEC_OPTS"; exit 3' } } },
  });
  onTestFinished(() => cleanup(repo));

  await cli(repo, ["run"], { NODE_OPTIONS: "--max-old-space-size=200", RUBYOPT: "-W0", SPEC_OPTS: "--order defined" });
  const results = await cli(repo, ["results", "--wait", "--json"]);
  const check = parseLines(results.stdout).find((line) => line.type === "check")!;
  assert.equal(check.tests, undefined);
  const log = readFileSync(check.log as string, "utf8").split("\n");
  assert.equal(log[0], `--max-old-space-size=200 --import=${JSON.stringify(path.join(ROOT, "src", "recorders", "node-test.ts"))}`);
  assert.equal(log[1], `-W0 -r${path.join(ROOT, "ruby", "firstlight_minitest.rb")}`);
  assert.equal(log[2], `--order defined --require ${path.join(ROOT, "ruby", "firstlight_rspec.rb")}`);
});

test("a repeated failure reused from an earlier run keeps its failed tests", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "node --test" } } } });
  onTestFinished(() => cleanup(repo));
  write(repo, "test/math.test.mjs", NODE_TEST);
  execSync("git add -A", { cwd: repo.root });

  await failedRun(repo);
  await failedRun(repo);
  const lines = await failedRun(repo);
  const check = lines.find((line) => line.type === "check")!;
  assert.notEqual(check.cached_from, null);
  assert.deepEqual(
    lines.filter((line) => line.type === "diagnostic").map((line) => line.rule),
    ["math > subtracts"],
  );
});

test("vitest results come from the setup file, and replace the parser's diagnostic of the same test", async () => {
  const repo = makeRepo({
    "package.json": { name: "suite", version: "1.0.0", private: true, type: "module", scripts: { test: "vitest run" } },
    "vitest.config.ts": `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { setupFiles: [${JSON.stringify(SETUP)}], includeTaskLocation: true } });\n`,
    ".gitignore": "node_modules\n",
  });
  symlinkSync(NODE_MODULES, path.join(repo.root, "node_modules"));
  onTestFinished(() => cleanup(repo));
  write(
    repo,
    "test/math.test.ts",
    `import { describe, expect, test } from "vitest";\ndescribe("math", () => {\n  test("adds", () => expect(1 + 1).toBe(2));\n  test("subtracts", () => expect(3 - 1).toBe(1));\n});\n`,
  );

  const lines = await failedRun(repo);
  const check = lines.find((line) => line.type === "check")!;
  assert.deepEqual(check.tests, { passed: 1, failed: 1, skipped: 0, file: (check.tests as { file: string }).file });
  assert.deepEqual(
    lines.filter((line) => line.type === "diagnostic"),
    [
      {
        type: "diagnostic",
        check: "test",
        file: "test/math.test.ts",
        line: 4,
        col: null,
        rule: "math > subtracts",
        message: "expected 2 to be 1 // Object.is equality",
        rerun: 'npx vitest run "test/math.test.ts" -t "^math subtracts$"',
      },
    ],
  );
  assert.match(rerun(repo, lines.find((line) => line.type === "diagnostic")!.rerun as string), /Tests {2}1 failed \| 1 skipped \(2\)/);
});

test.skipIf(!HAS_MINITEST)("minitest results come from RUBYOPT, with a rerun by test name", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "ruby -Itest test/math_test.rb" } } } });
  onTestFinished(() => cleanup(repo));
  write(
    repo,
    "test/math_test.rb",
    `require "minitest/autorun"\nclass MathTest < Minitest::Test\n  def test_adds = assert_equal(2, 1 + 1)\n  def test_subtracts = assert_equal(1, 3 - 1)\nend\n`,
  );

  const lines = await failedRun(repo);
  const check = lines.find((line) => line.type === "check")!;
  assert.equal((check.tests as { passed: number }).passed, 1);
  const diagnostic = lines.find((line) => line.type === "diagnostic")!;
  assert.deepEqual(
    { file: diagnostic.file, line: diagnostic.line, rule: diagnostic.rule, message: diagnostic.message },
    { file: "test/math_test.rb", line: 4, rule: "MathTest#test_subtracts", message: "Expected: 1 Actual: 2" },
  );
  assert.equal(diagnostic.rerun, "ruby -Ilib -Itest test/math_test.rb --name 'MathTest#test_subtracts'");
  assert.match(rerun(repo, diagnostic.rerun as string), /\n1 runs, 1 assertions, 1 failures/);
});

test.skipIf(!HAS_RSPEC)("RSpec results come from SPEC_OPTS, with a rerun by example id", async () => {
  const repo = makeRepo({ "firstlight.json": { checks: { test: { run: "rspec" } } }, ".rspec": "--format documentation\n" });
  onTestFinished(() => cleanup(repo));
  write(
    repo,
    "spec/math_spec.rb",
    `RSpec.describe "math" do\n  [1, 2].each { |n| it("is one") { expect(n).to eq(1) } }\nend\n`,
  );

  const lines = await failedRun(repo);
  const diagnostic = lines.find((line) => line.type === "diagnostic")!;
  assert.deepEqual(
    { file: diagnostic.file, line: diagnostic.line, rule: diagnostic.rule, rerun: diagnostic.rerun },
    { file: "spec/math_spec.rb", line: 2, rule: "math is one", rerun: "rspec './spec/math_spec.rb[1:2]'" },
  );
  assert.match(readFileSync(lines.find((line) => line.type === "check")!.log as string, "utf8"), /\nmath\n {2}is one\n/);
  assert.match(rerun(repo, diagnostic.rerun as string), /\n1 example, 1 failure\n/);
});
