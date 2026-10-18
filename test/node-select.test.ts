// The Node selector end to end: firstlight runs a real vitest suite in
// full, the setup file records it, and later runs select by the code each
// test ran, a test that reaches the code only through a child process
// included. A selector that fails says why in one line.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, makeRepo, parseLines, type Repo } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SELECTOR = path.join(ROOT, "src", "node", "cli.ts");
const SETUP = path.join(ROOT, "src", "node", "vitest-setup.ts");

const MATH = `export function double(n: number): number {
  return n * 2;
}

export function triple(n: number): number {
  return n * 3;
}
`;

function write(repo: Repo, file: string, text: string): void {
  writeFileSync(path.join(repo.root, file), text);
}

function project(): Repo {
  const repo = makeRepo({
    ".gitignore": "node_modules\n",
    "package.json": { type: "module", private: true },
    "firstlight.json": {
      checks: {
        test: {
          run: `node ${VITEST} run`,
          select: `node ${SELECTOR} select --ignore '*.md'`,
          runSelected: `node ${VITEST} run --passWithNoTests {tests}`,
        },
      },
    },
    "vitest.config.ts": `import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/*.test.ts"], setupFiles: [${JSON.stringify(SETUP)}], experimental: { viteModuleRunner: false } },
});
`,
    "data.txt": "4\n",
    "notes.md": "notes\n",
  });
  onTestFinished(() => cleanup(repo));
  symlinkSync(path.join(ROOT, "node_modules"), path.join(repo.root, "node_modules"));
  mkdirSync(path.join(repo.root, "src"));
  mkdirSync(path.join(repo.root, "test"));
  write(repo, "src/math.ts", MATH);
  write(repo, "src/tool.ts", `import { double } from "./math.ts";\nprocess.stdout.write(String(double(Number(process.argv[2]))));\n`);
  write(repo, "test/double.test.ts", `import { expect, test } from "vitest";\nimport { double } from "../src/math.ts";\ntest("doubles", () => expect(double(2)).toBe(4));\n`);
  write(repo, "test/triple.test.ts", `import { expect, test } from "vitest";\nimport { triple } from "../src/math.ts";\ntest("triples", () => expect(triple(2)).toBe(6));\n`);
  write(
    repo,
    "test/tool.test.ts",
    `import { execFileSync } from "node:child_process";\nimport { expect, test } from "vitest";\ntest("runs the tool", () => expect(execFileSync(process.execPath, ["src/tool.ts", "4"], { encoding: "utf8" })).toBe("8"));\n`,
  );
  return repo;
}

async function testCheck(repo: Repo): Promise<Record<string, unknown>> {
  const run = await cli(repo, ["run", "--json"]);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  return parseLines(run.stdout).find((line) => line.type === "check")!;
}

function selectedIds(check: Record<string, unknown>): string[] {
  return ((check.narrowed as { tests: { id: string }[] }).tests).map((entry) => entry.id);
}

test("a vitest run recorded in full narrows later runs to the tests that ran the changed code", { timeout: 120_000 }, async () => {
  const repo = project();

  const full = await testCheck(repo);
  assert.equal(full.status, "passed");
  assert.equal(full.narrowed, undefined);

  write(repo, "src/math.ts", MATH.replace("n * 3", "3 * n"));
  const inTriple = await testCheck(repo);
  assert.deepEqual(selectedIds(inTriple), ["test/triple.test.ts"]);
  assert.deepEqual((inTriple.narrowed as { tests: unknown[] }).tests, [{ id: "test/triple.test.ts", reason: "src/math.ts changed in triple" }]);

  write(repo, "src/math.ts", MATH.replace("n * 2", "2 * n"));
  assert.deepEqual(selectedIds(await testCheck(repo)), ["test/double.test.ts", "test/tool.test.ts"]);

  write(repo, "src/math.ts", `${MATH}export const unit = 1;\n`);
  assert.deepEqual(selectedIds(await testCheck(repo)), ["test/double.test.ts", "test/tool.test.ts", "test/triple.test.ts"]);

  write(repo, "src/math.ts", MATH);
  write(repo, "notes.md", "more notes\n");
  const ignored = await testCheck(repo);
  assert.deepEqual(ignored.narrowed, { base: (ignored.narrowed as { base: string }).base, files: ["notes.md"], tests: [], command: null });

  write(repo, "data.txt", "5\n");
  const data = await testCheck(repo);
  assert.equal(data.narrowed, undefined);
  assert.match((data.full_run as { reason: string }).reason, /^the selector asked for it: data\.txt is not code and no recording covers it$/);
});

test("the firstlight-node bin passes on the command's refusal and exit code, and exits 1 with one line on stderr when the selection fails", () => {
  const refused = spawnSync(process.execPath, [SELECTOR, "select"], { cwd: ROOT, input: "nope", encoding: "utf8" });
  assert.deepEqual({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr }, { status: 2, stdout: "", stderr: "firstlight-node: stdin is not one JSON object\n" });

  const record = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-node-record-")));
  onTestFinished(() => rmSync(record, { recursive: true, force: true }));
  mkdirSync(path.join(record, "raw", "a", "not-a-file"), { recursive: true });
  writeFileSync(path.join(record, "raw", "a", "test.json"), JSON.stringify({ file: path.join(ROOT, "test", "a.test.ts"), worker: "1/0" }));
  const input = { version: 1, check: "test", tree: "t2", base: { run: "r1", tree: "t1", record }, changes: [{ status: "M", path: "src/a.ts" }] };
  const run = spawnSync(process.execPath, [SELECTOR, "select"], { cwd: ROOT, input: JSON.stringify(input), encoding: "utf8" });
  assert.deepEqual({ status: run.status, stdout: run.stdout }, { status: 1, stdout: "" });
  assert.match(run.stderr, /^firstlight-node: EISDIR: [^\n]+\n$/);
});
