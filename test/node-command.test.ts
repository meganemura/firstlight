// The firstlight-node command in process: it refuses arguments and stdin
// it does not know, asks for the full run when the base run left no usable
// recording, writes the map once, from the raw coverage, on the first
// selection, and reads each changed file's base text and hunks from git, so
// every reason a selection gives comes from a real repository.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { HELP, main } from "../src/node/command.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

function scratch(prefix: string, files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

function input(record: string | null, changes: unknown[] = [{ status: "M", path: "src/a.ts" }], trees = { tree: "t2", base: "t1" }): string {
  return JSON.stringify({ version: 1, check: "test", tree: trees.tree, base: { run: "r1", tree: trees.base, record }, changes });
}

function answer(args: string[], stdin: string, root = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  return main(args, async () => stdin, root);
}

function printed(value: unknown): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

test("--help prints the usage, and arguments the command does not know are refused with exit 2", async () => {
  for (const words of ["Usage:", "firstlight-node select [--always <glob>]... [--ignore <glob>]...", "firstlight/node/vitest-setup", "viteModuleRunner: false", "isolate: true"]) {
    assert.ok(HELP.includes(words), words);
  }
  assert.deepEqual(await answer(["--help"], ""), { code: 0, stdout: HELP, stderr: "" });
  assert.deepEqual(await answer(["-h"], ""), { code: 0, stdout: HELP, stderr: "" });
  for (const [args, message] of [
    [[], "name a command"],
    [["check"], 'unknown command "check"'],
    [["--help", "select"], 'unknown command "--help"'],
    [["select", "--only", "x"], 'unknown option "--only"'],
    [["select", "--ignore", "x", "--always"], "--always needs a glob"],
    [["select", "--ignore"], "--ignore needs a glob"],
  ] as const) {
    assert.deepEqual(await answer([...args], input(null)), { code: 2, stdout: "", stderr: `firstlight-node: ${message}\n\n${HELP}` });
  }
});

test("stdin that is not selector input is refused with exit 2", async () => {
  const lacksTrees = "stdin lacks tree, base.tree, or base.record";
  const lacksChanges = "stdin lacks a changes list of {status, path}";
  const good = { version: 1, tree: "t", base: { tree: "b", record: null }, changes: [{ status: "M", path: "a" }] };
  const refusals: [string, string][] = [
    ["nope", "stdin is not one JSON object"],
    ["null", "stdin is not selector input of protocol version 1"],
    ["[1]", "stdin is not selector input of protocol version 1"],
    [JSON.stringify({ ...good, version: 2 }), "stdin is not selector input of protocol version 1"],
    [JSON.stringify({ ...good, tree: 1 }), lacksTrees],
    [JSON.stringify({ ...good, base: null }), lacksTrees],
    [JSON.stringify({ ...good, base: { tree: 1, record: null } }), lacksTrees],
    [JSON.stringify({ ...good, base: { tree: "b" } }), lacksTrees],
    [JSON.stringify({ ...good, base: { tree: "b", record: 1 } }), lacksTrees],
    [JSON.stringify({ ...good, changes: {} }), lacksChanges],
    [JSON.stringify({ ...good, changes: [{ status: "M", path: "a" }, null] }), lacksChanges],
    [JSON.stringify({ ...good, changes: [{ status: "M", path: "a" }, { status: "M" }] }), lacksChanges],
    [JSON.stringify({ ...good, changes: [{ status: 1, path: "a" }] }), lacksChanges],
  ];
  for (const [stdin, message] of refusals) {
    assert.deepEqual(await answer(["select"], stdin), { code: 2, stdout: "", stderr: `firstlight-node: ${message}\n` }, stdin);
  }
});

test("a base run without a usable recording asks for the full run", async () => {
  assert.deepEqual(await answer(["select"], input(null)), printed({ full: "no recording in the base run" }));
  assert.deepEqual(await answer(["select"], input(scratch("firstlight-node-record-"))), printed({ full: "no recording in the base run" }));
  assert.deepEqual(
    await answer(["select"], input(scratch("firstlight-node-record-", { "raw/x/coverage-1.json": "{}", "raw/y/test.json": "{}" }))),
    printed({ full: "no recording in the base run" }),
  );
  assert.deepEqual(
    await answer(["select"], input(scratch("firstlight-node-record-", { "map.json": JSON.stringify({ version: 0, files: {}, tests: {} }) }))),
    printed({ full: "the base run's map was written by another version of firstlight-node" }),
  );
});

test("the first selection writes the map and removes the raw coverage, and later ones read the map", async () => {
  const dir = scratch("firstlight-node-record-", {
    "raw/a/test.json": JSON.stringify({ file: path.join(ROOT, "test/a.test.ts"), worker: "1/0" }),
    "raw/a/coverage-worker.json": JSON.stringify({
      result: [
        { url: `file://${ROOT}/test/a.test.ts`, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] }] },
        { url: "node:internal/x", functions: [] },
      ],
    }),
  });
  const changes = [{ status: "M", path: "test/a.test.ts" }];
  const expected = printed({ tests: [{ id: "test/a.test.ts", reason: "changed" }] });
  assert.deepEqual(await answer(["select"], input(dir, changes)), expected);
  assert.deepEqual(readdirSync(dir), ["map.json"]);
  assert.deepEqual(await answer(["select"], input(dir, changes)), expected);
  assert.ok(!existsSync(path.join(dir, "raw")));
});

test("a recording of two test files in one worker asks for the full run each time, and keeps the raw coverage", async () => {
  const marker = (test: string) => JSON.stringify({ file: path.join(ROOT, test), worker: "1/0" });
  const dir = scratch("firstlight-node-record-", {
    "raw/a/test.json": marker("test/a.test.ts"),
    "raw/b/test.json": marker("test/b.test.ts"),
  });
  const shared = printed({ full: "test/a.test.ts and test/b.test.ts ran in one worker; the recorder needs isolate: true" });
  assert.deepEqual(await answer(["select"], input(dir)), shared);
  assert.deepEqual(await answer(["select"], input(dir)), shared);
  assert.deepEqual(readdirSync(dir), ["raw"]);
});

// A source file longer than 256 bytes, with a named function, a function
// stored in a constant, an anonymous one, and top-level code.
const MATH = `// Arithmetic for the tests of firstlight-node. This comment only makes
// the file longer than the smallest buffers a child process could be
// given, so a selection reads it through git the way it reads real code.
export function double(n: number): number {
  return n * 2;
}
export const triple = (n: number): number => {
  return n * 3;
};
export const squares = [1, 2].map((n) => {
  return n * n;
});
export const unit = 1;
`;

function span(text: string, from: string, to: string, name: string, count: number) {
  const startOffset = text.indexOf(from);
  return { functionName: name, ranges: [{ startOffset, endOffset: text.indexOf(to, startOffset) + to.length, count }] };
}

// The recording a full run of five test files would leave: a ran double,
// b ran triple, c ran the anonymous function, d only loaded the files, and
// e loaded nothing of them.
function recordMath(root: string): string {
  const math = (counts: [number, number, number]) => ({
    url: `file://${root}/src/math.ts?vitest=1`,
    functions: [
      { functionName: "", ranges: [{ startOffset: 0, endOffset: MATH.length, count: 1 }] },
      span(MATH, "export function double", "\n}", "double", counts[0]),
      span(MATH, "(n: number): number =>", "\n}", "triple", counts[1]),
      span(MATH, "(n) =>", "\n}", "", counts[2]),
    ],
  });
  const gone = { url: `file://${root}/src/gone.ts`, functions: [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 5, count: 1 }] }] };
  const runs: Record<string, object[]> = {
    a: [math([1, 0, 0])],
    b: [math([0, 1, 0])],
    c: [math([0, 0, 1]), gone],
    d: [math([0, 0, 0]), gone],
    e: [],
  };
  const files: Record<string, string> = {};
  for (const [name, scripts] of Object.entries(runs)) {
    files[`raw/${name}/test.json`] = JSON.stringify({ file: `${root}/test/${name}.test.ts`, worker: `${name}/0` });
    files[`raw/${name}/coverage-1.json`] = JSON.stringify({ result: scripts });
  }
  return scratch("firstlight-node-record-", files);
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
}

function repository(): { root: string; base: string } {
  const root = scratch("firstlight-node-repo-", {
    "src/math.ts": MATH,
    "src/gone.ts": "1;\n",
    "notes.md": "notes\n",
    ...Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`test/${name}.test.ts`, `// ${name}\n`])),
  });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, base: git(root, "rev-parse", "HEAD^{tree}") };
}

function tree(root: string, files: Record<string, string | null>): string {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) rmSync(path.join(root, file));
    else writeFileSync(path.join(root, file), text);
  }
  git(root, "add", "-A");
  return git(root, "write-tree");
}

test("a selection reads each changed file's base text and hunks from git, and says why it chose each test", async () => {
  const { root, base } = repository();
  const record = recordMath(root);
  const current = tree(root, {
    "src/math.ts": MATH.replace("n * 3", "3 * n").replace("n * n", "n ** 2"),
    "src/gone.ts": null,
    "test/a.test.ts": "// a, changed\n",
    "test/new.test.ts": "// new\n",
    "src/unused.ts": "export {};\n",
    "notes.md": "more notes\n",
  });
  const changes = [
    { status: "M", path: "src/math.ts" },
    { status: "D", path: "src/gone.ts" },
    { status: "M", path: "test/a.test.ts" },
    { status: "A", path: "test/new.test.ts" },
    { status: "A", path: "src/unused.ts" },
    { status: "M", path: "notes.md" },
  ];
  const expected = printed({
    tests: [
      { id: "test/a.test.ts", reason: "changed" },
      { id: "test/b.test.ts", reason: "src/math.ts changed in triple" },
      { id: "test/c.test.ts", reason: "src/math.ts changed in an anonymous function" },
      { id: "test/d.test.ts", reason: "src/gone.ts was deleted" },
      { id: "test/e.test.ts", reason: "--always" },
      { id: "test/new.test.ts", reason: "changed" },
    ],
  });
  const args = ["select", "--ignore", "*.md", "--always", "test/e.*"];
  assert.deepEqual(await answer(args, input(record, changes, { tree: current, base }), root), expected);

  const inherited = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, "no-such-git-dir");
  try {
    assert.deepEqual(await answer(args, input(record, changes, { tree: current, base }), root), expected);
  } finally {
    if (inherited === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = inherited;
  }
});

test("a change outside every function selects every test that loaded the file, and a file git cannot show counts as changed throughout", async () => {
  const { root, base } = repository();
  const record = recordMath(root);
  const current = tree(root, { "src/math.ts": MATH.replace("unit = 1", "unit = 2") });
  const changes = [{ status: "M", path: "src/math.ts" }];
  const everyLoader = (reason: string) => printed({ tests: ["a", "b", "c", "d"].map((name) => ({ id: `test/${name}.test.ts`, reason })) });
  assert.deepEqual(await answer(["select"], input(record, changes, { tree: current, base }), root), everyLoader("src/math.ts changed outside any function"));
  assert.deepEqual(
    await answer(["select"], input(record, changes, { tree: current, base: "0000000000000000000000000000000000000000" }), root),
    everyLoader("src/math.ts changed"),
  );
});
