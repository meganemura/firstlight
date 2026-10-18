// Properties of the Node selector's pure parts. The code a change touches
// is what a position-by-position reading of the base text says. A change
// outside every function selects every test that loaded the file, and a
// change inside one function's own body exactly the tests that ran it. An
// ignored change changes nothing, a deleted file is never selected, a
// changed test file and an --always test always are, more changes never
// drop a test, and a file no recording covers asks for the full run unless
// its name says it is code. The map says exactly what the raw coverage
// said, in any order, as the same bytes, and reads back as written. The
// parsers keep exactly what they can use.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { matchesPath, type Change, type SelectorAnswer } from "../src/selection.ts";
import { buildMap, parseCoverage, parseMap, parseTestFile, type CoverageMap, type FileCoverage, type FunctionSpan, type RawRecord } from "../src/node/map.ts";
import { editsNeeded, parseHunks, selectTests, touchedCode, type Edit, type Hunk, type SelectOptions, type Touched } from "../src/node/select.ts";

const ROOT = "/repo";
const FILE = "src/f.ts";
const NO_OPTIONS: SelectOptions = { always: [], ignore: [] };

// A source text and its functions, as V8 reports them: spans of offsets
// that nest or lie apart, ordered by start and then by end, longest first.
interface Source {
  base: string;
  functions: FunctionSpan[];
}

const source = gs.composite((tc): Source => {
  const texts: string[] = tc.draw(gs.arrays(gs.text({ minSize: 0, maxSize: 5, alphabet: "ab ;{}" }), { minSize: 1, maxSize: 12 }));
  const joined = texts.join("\n") + (tc.draw(gs.booleans()) ? "\n" : "");
  const base = joined === "" ? "\n" : joined;
  const accepted: FunctionSpan[] = [];
  for (let i = tc.draw(gs.integers({ minValue: 0, maxValue: 7 })); i > 0; i--) {
    const start = tc.draw(gs.integers({ minValue: 0, maxValue: base.length - 1 }));
    const end = tc.draw(gs.integers({ minValue: start + 1, maxValue: base.length }));
    const fits = accepted.every(
      (other) =>
        end <= other.start ||
        other.end <= start ||
        (((other.start <= start && end <= other.end) || (start <= other.start && other.end <= end)) && !(other.start === start && other.end === end)),
    );
    if (fits) accepted.push({ start, end, name: tc.draw(gs.booleans()) ? `fn${accepted.length}` : "" });
  }
  return { base, functions: accepted.sort((a, b) => a.start - b.start || b.end - a.end) };
});

// The model the selector's offsets are checked against, one position at a
// time: a position is in a function's body when it lies on a later line
// than the function's start and before its end, and belongs to the
// smallest such function.
function lineOf(base: string, position: number): number {
  return base.slice(0, position).split("\n").length - 1;
}

function ownerOf(src: Source, position: number): number | null {
  let owner: number | null = null;
  src.functions.forEach((fn, index) => {
    const inBody = lineOf(src.base, position) > lineOf(src.base, fn.start) && position < fn.end;
    if (inBody && (owner === null || fn.end - fn.start < src.functions[owner]!.end - src.functions[owner]!.start)) owner = index;
  });
  return owner;
}

// The base positions a hunk names: every character of the replaced lines,
// or, for an insertion after line `start`, the first character of the next
// line, or the end of the text when there is none.
function positionsOf(base: string, hunk: Hunk): number[] {
  const all = Array.from({ length: base.length }, (_, position) => position);
  if (hunk.count === 0) return [all.find((position) => lineOf(base, position) === hunk.start) ?? base.length];
  return all.filter((position) => lineOf(base, position) >= hunk.start - 1 && lineOf(base, position) < hunk.start - 1 + hunk.count);
}

function modelTouched(src: Source, hunks: readonly Hunk[]): Touched {
  const touched: Touched = { top: false, functions: new Set() };
  for (const hunk of hunks) {
    const positions = positionsOf(src.base, hunk);
    if (positions.length === 0) touched.top = true;
    for (const position of positions) {
      const owner = ownerOf(src, position);
      if (owner === null) touched.top = true;
      else touched.functions.add(owner);
    }
  }
  return touched;
}

function lineCount(base: string): number {
  return base.split("\n").length - (base.endsWith("\n") ? 1 : 0);
}

function linesWhere(src: Source, keep: (owners: (number | null)[]) => boolean): number[] {
  return Array.from({ length: lineCount(src.base) }, (_, i) => i + 1).filter((line) =>
    keep(positionsOf(src.base, { start: line, count: 1 }).map((position) => ownerOf(src, position))),
  );
}

// The source with one more function after it, whose body holds a whole
// line, so every source has a line that one function owns.
function withTail(src: Source): Source {
  const head = src.base.endsWith("\n") ? src.base : `${src.base}\n`;
  const base = `${head}f {\n  body;\n}\n`;
  return { base, functions: [...src.functions, { start: head.length, end: base.length - 1, name: "tail" }] };
}

const hunksOf = (src: Source) =>
  gs.arrays(
    gs.tuples(gs.integers({ minValue: 0, maxValue: lineCount(src.base) + 2 }), gs.integers({ minValue: 0, maxValue: 4 })).map(
      ([start, count]): Hunk => ({ start: count === 0 ? start : Math.max(start, 1), count }),
    ),
    { maxSize: 4 },
  );

test("the code a change touches is what each of its base positions belongs to", () => {
  hegel.test(
    (tc) => {
      const src = tc.draw(source);
      const hunks = tc.draw(hunksOf(src));
      assert.deepEqual(touchedCode(src.functions, { base: src.base, hunks }), modelTouched(src, hunks));
    },
    { testCases: 500 },
  );
});

// Which of the functions each test ran, for tests that loaded the file.
const runs = (functions: number) =>
  gs.arrays(gs.optional(gs.arrays(gs.booleans(), { minSize: functions, maxSize: functions })), { minSize: 1, maxSize: 4 });

function mapOf(src: Source, ran: (boolean[] | null)[]): CoverageMap {
  const tests: CoverageMap["tests"] = {};
  ran.forEach((flags, index) => {
    tests[`test/t${index}.test.ts`] = flags === null ? {} : { [FILE]: flags.flatMap((flag, fn) => (flag ? [fn] : [])) };
  });
  return { version: 1, files: { [FILE]: src.functions }, tests };
}

function selected(map: CoverageMap, changes: Change[], edits: Map<string, Edit>): string[] | string {
  const answer = selectTests(map, changes, edits, NO_OPTIONS);
  return "full" in answer ? answer.full : answer.tests.map((entry) => entry.id);
}

function testsWhere(ran: (boolean[] | null)[], keep: (flags: boolean[]) => boolean): string[] {
  return ran.flatMap((flags, index) => (flags !== null && keep(flags) ? [`test/t${index}.test.ts`] : []));
}

test("a change on a line outside every function body selects every test that loaded the file, and only those", () => {
  hegel.test(
    (tc) => {
      const src = tc.draw(source);
      const ran = tc.draw(runs(src.functions.length));
      const outside = linesWhere(src, (owners) => owners.every((owner) => owner === null));
      tc.assume(outside.length > 0);
      const line = tc.draw(gs.sampledFrom(outside));
      const hunk: Hunk = tc.draw(gs.booleans()) ? { start: line, count: 1 } : { start: line - 1, count: 0 };
      const edits = new Map([[FILE, { base: src.base, hunks: [hunk] }]]);
      assert.deepEqual(selected(mapOf(src, ran), [{ status: "M", path: FILE }], edits), testsWhere(ran, () => true));
    },
    { testCases: 300 },
  );
});

test("a change inside one function's own body selects exactly the tests that ran that function", () => {
  hegel.test(
    (tc) => {
      const src = withTail(tc.draw(source));
      const owned = linesWhere(src, (owners) => owners.every((owner) => owner !== null && owner === owners[0]));
      const line = tc.draw(gs.sampledFrom(owned));
      const target = ownerOf(src, positionsOf(src.base, { start: line, count: 1 })[0]!)!;
      const hunk: Hunk = tc.draw(gs.booleans()) ? { start: line, count: 1 } : { start: line - 1, count: 0 };
      const ran = tc.draw(runs(src.functions.length));
      const edits = new Map([[FILE, { base: src.base, hunks: [hunk] }]]);
      assert.deepEqual(
        selected(mapOf(src, ran), [{ status: "M", path: FILE }], edits),
        testsWhere(ran, (flags) => flags[target]!),
      );
    },
    { testCases: 300 },
  );
});

// A repository's worth of changes: a loaded source file with functions,
// one with none, a source file no test loaded, files that are not code,
// recorded test files (one whose name is not a test name), new test files,
// and a code file whose name only looks like one, in any order, with any
// status, against any options.
const RECORDED = ["test/t0.test.ts", "test/t1.spec.mjs", "checks/t2.ts", "test/t3.test.tsx"];
const NOT_CODE = ["data.json", "README.md", "docs/x.md"];
const PATHS = [FILE, "src/g.ts", "src/h.cts", ...NOT_CODE, "test/new.test.ts", "test/new.spec.jsx", "lib/x.tests.ts", ...RECORDED];
const TEST_NAMES = ["test/new.test.ts", "test/new.spec.jsx", "test/t0.test.ts", "test/t1.spec.mjs", "test/t3.test.tsx"];

interface World {
  map: CoverageMap;
  changes: Change[];
  edits: Map<string, Edit>;
  options: SelectOptions;
}

const world = gs.composite((tc): World => {
  const src = tc.draw(source);
  const tests: CoverageMap["tests"] = {};
  for (const name of RECORDED.filter(() => tc.draw(gs.booleans()))) {
    const loaded: Record<string, number[]> = {};
    if (tc.draw(gs.booleans())) loaded[FILE] = src.functions.flatMap((_, index) => (tc.draw(gs.booleans()) ? [index] : []));
    if (tc.draw(gs.booleans())) loaded["src/g.ts"] = [];
    tests[name] = loaded;
  }
  const map: CoverageMap = { version: 1, files: { [FILE]: src.functions, "src/g.ts": [] }, tests };
  const pool = PATHS.filter(() => tc.draw(gs.booleans()));
  const changes: Change[] = [];
  while (pool.length > 0) {
    const [path] = pool.splice(tc.draw(gs.integers({ minValue: 0, maxValue: pool.length - 1 })), 1);
    changes.push({ status: tc.draw(gs.sampledFrom(["M", "A", "D"])), path: path! });
  }
  const edits = new Map<string, Edit>();
  if (tc.draw(gs.booleans())) edits.set(FILE, { base: src.base, hunks: tc.draw(hunksOf(src)) });
  const options = {
    always: ["checks/**", "test/t0.test.ts"].filter(() => tc.draw(gs.booleans())),
    ignore: ["*.md", "**/*.md", "test/t1.spec.mjs", "src/g.*"].filter(() => tc.draw(gs.booleans())),
  };
  return { map, changes, edits, options };
});

const ignoredBy = (options: SelectOptions) => (change: Change) => options.ignore.some((glob) => matchesPath(glob, change.path));

test("an ignored change changes nothing but that a deleted file stays unselected, and a file no recording covers asks for the full run only when it is not code", () => {
  hegel.test(
    (tc) => {
      const { map, changes, edits, options } = tc.draw(world);
      const answer = selectTests(map, changes, edits, options);
      const ignored = ignoredBy(options);
      const without = selectTests(map, changes.filter((change) => !ignored(change)), edits, options);
      const deleted = new Set(changes.filter((change) => ignored(change) && change.status === "D").map((change) => change.path));
      assert.deepEqual(answer, "full" in without ? without : { tests: without.tests.filter((entry) => !deleted.has(entry.id)) });
      const uncovered = changes.find((change) => !ignored(change) && NOT_CODE.includes(change.path));
      assert.deepEqual("full" in answer ? answer.full : null, uncovered === undefined ? null : `${uncovered.path} is not code and no recording covers it`);
    },
    { testCases: 300 },
  );
});

test("a deleted file is never selected, a changed test file and an --always test always are, and the ids are sorted", () => {
  hegel.test(
    (tc) => {
      const drawn = tc.draw(world);
      const { map, edits, options } = drawn;
      const changes = drawn.changes.filter((change) => !NOT_CODE.includes(change.path));
      const answer = selectTests(map, changes, edits, options);
      assert.ok(!("full" in answer));
      const ids = answer.tests.map((entry) => entry.id);
      assert.deepEqual(ids, [...new Set(ids)].sort());
      const gone = new Set(changes.filter((change) => change.status === "D").map((change) => change.path));
      for (const id of ids) assert.ok(!gone.has(id), `${id} was deleted`);
      const ignored = ignoredBy(options);
      const due = [
        ...changes.filter((change) => !ignored(change) && (map.tests[change.path] !== undefined || TEST_NAMES.includes(change.path))),
        ...Object.keys(map.tests).flatMap((id) => (options.always.some((glob) => matchesPath(glob, id)) ? [{ status: "M", path: id }] : [])),
      ].filter((change) => !gone.has(change.path));
      for (const change of due) assert.ok(ids.includes(change.path), `${change.path} is selected`);
      for (const id of ids) assert.ok(map.tests[id] !== undefined || changes.some((change) => change.path === id), `${id} is recorded or changed`);
    },
    { testCases: 300 },
  );
});

test("the files a selection reads from git are the changed files some test loaded that still exist and are not ignored", () => {
  hegel.test(
    (tc) => {
      const { map, changes, options } = tc.draw(world);
      const ignored = ignoredBy(options);
      assert.deepEqual(
        editsNeeded(map, changes, options),
        changes.filter((change) => change.status !== "D" && (change.path === FILE || change.path === "src/g.ts") && !ignored(change)).map((change) => change.path),
      );
    },
    { testCases: 200 },
  );
});

test("more changes never drop a test that still exists, and once a change runs everything, more changes still do", () => {
  hegel.test(
    (tc) => {
      const { map, changes: larger, edits, options } = tc.draw(world);
      const smaller = larger.filter(() => tc.draw(gs.booleans()));
      const small = selectTests(map, smaller, edits, options);
      const large = selectTests(map, larger, edits, options);
      if ("full" in large) return;
      assert.ok(!("full" in small), "a change that runs everything does so among more changes too");
      const gone = new Set(larger.filter((change) => change.status === "D").map((change) => change.path));
      const kept = new Set(large.tests.map((entry) => entry.id));
      for (const entry of small.tests) {
        if (!gone.has(entry.id)) assert.ok(kept.has(entry.id), `${entry.id} is still selected`);
      }
    },
    { testCases: 300 },
  );
});

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const OTHER_EXTENSIONS = [".json", ".md", ".tsv", ".ts.orig", ".mtsx", ".xts", ".css", ""];

test("a changed file no test loaded selects itself when its name is a test file's, nothing when it is code, and the full run otherwise", () => {
  hegel.test(
    (tc) => {
      const stem = tc.draw(gs.sampledFrom(["x", "x.test", "x.spec", "x.tests", "spec", "x.spec.ts", "x.test.js"]));
      const extension = tc.draw(gs.sampledFrom([...CODE_EXTENSIONS, ...OTHER_EXTENSIONS]));
      const file = `${tc.draw(gs.sampledFrom(["", "src/", "test/a.b/"]))}${stem}${extension}`;
      const status = tc.draw(gs.sampledFrom(["M", "A", "D"]));
      const answer = selectTests({ version: 1, files: {}, tests: {} }, [{ status, path: file }], new Map(), NO_OPTIONS);
      const code = CODE_EXTENSIONS.some((ending) => file.endsWith(ending));
      const named = CODE_EXTENSIONS.some((ending) => file.endsWith(`.test${ending}`) || file.endsWith(`.spec${ending}`)) && status !== "D";
      const expected: SelectorAnswer = !code ? { full: `${file} is not code and no recording covers it` } : { tests: named ? [{ id: file, reason: "changed" }] : [] };
      assert.deepEqual(answer, expected);
    },
    { testCases: 300 },
  );
});

// Raw coverage as the recorder leaves it, after parseCoverage: per test,
// the repository files each process loaded (one file can come from the
// worker and from a child process too), each with its top-level function
// first. Spans share starts, and one has no name.
const SPANS = [
  [10, 40],
  [10, 30],
  [12, 20],
  [50, 90],
  [60, 70],
  [60, 65],
] as const;
const nameOf = (start: number, end: number) => (start === 60 && end === 65 ? "" : `f${start}_${end}`);

const fileCoverage = gs.composite(
  (tc): FileCoverage => ({
    file: tc.draw(gs.sampledFrom(["src/a.ts", "src/b.ts", "test/t0.test.ts"])),
    functions: [
      { functionName: "", ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
      ...SPANS.filter(() => tc.draw(gs.booleans())).map(([start, end]) => ({
        functionName: nameOf(start, end),
        ranges: [
          { startOffset: start, endOffset: end, count: tc.draw(gs.integers({ minValue: 0, maxValue: 2 })) },
          { startOffset: start + 1, endOffset: start + 2, count: 0 },
        ],
      })),
    ],
  }),
);

const TESTS = ["/repo/test/t0.test.ts", "/repo/test/t1.test.ts", "/repo/test/t2.test.ts", "/elsewhere/t3.test.ts", "/repo/node_modules/p/t4.test.ts"];

const rawRecords = gs.composite((tc): RawRecord[] => {
  const tests = TESTS.filter(() => tc.draw(gs.booleans()));
  return tests.map((test, i) => ({ test, worker: `${100 + i}/0`, scripts: tc.draw(gs.arrays(fileCoverage, { maxSize: 4 })) }));
});

// What the map should say, from the definition: the files of the tests in
// the repository, each file's spans once, by start and then longest first,
// and the spans each test ran, by their place in that order.
function modelMap(records: readonly RawRecord[]): CoverageMap {
  const kept = records.filter((record) => record.test.startsWith("/repo/test/"));
  const files: CoverageMap["files"] = {};
  for (const file of [...new Set(kept.flatMap((record) => record.scripts.map((script) => script.file)))].sort()) {
    const keys = new Set(kept.flatMap((record) => record.scripts.filter((script) => script.file === file).flatMap((script) => script.functions.slice(1).map((fn) => `${fn.ranges[0]!.startOffset}:${fn.ranges[0]!.endOffset}`))));
    files[file] = SPANS.filter(([start, end]) => keys.has(`${start}:${end}`)).map(([start, end]) => ({ start, end, name: nameOf(start, end) }));
  }
  const tests: CoverageMap["tests"] = {};
  for (const record of [...kept].sort((a, b) => (a.test < b.test ? -1 : 1))) {
    const loaded: Record<string, number[]> = {};
    for (const file of [...new Set(record.scripts.map((script) => script.file))].sort()) {
      const ran = record.scripts.filter((script) => script.file === file).flatMap((script) => script.functions.slice(1).filter((fn) => fn.ranges[0]!.count > 0));
      loaded[file] = files[file]!.flatMap((span, index) => (ran.some((fn) => fn.ranges[0]!.startOffset === span.start && fn.ranges[0]!.endOffset === span.end) ? [index] : []));
    }
    tests[record.test.slice("/repo/".length)] = loaded;
  }
  return { version: 1, files, tests };
}

test("the map says exactly which repository functions each test ran, as the same bytes whatever order the coverage came in", () => {
  hegel.test(
    (tc) => {
      const records = tc.draw(rawRecords);
      const map = buildMap(records, ROOT);
      const reversed = buildMap(
        records.toReversed().map((record) => ({ ...record, scripts: record.scripts.toReversed() })),
        ROOT,
      );
      assert.equal(JSON.stringify(map), JSON.stringify(modelMap(records)));
      assert.equal(JSON.stringify(reversed), JSON.stringify(map));
      assert.deepEqual(parseMap(JSON.stringify(map)), map);
    },
    { testCases: 300 },
  );
});

// A test file by its repository path, or by its absolute path when it is
// not a repository file.
const named = (test: string) => (test.startsWith("/repo/test/") ? test.slice("/repo/".length) : test);

test("two test files recorded in one worker make the map ask for the full run, naming both", () => {
  hegel.test(
    (tc) => {
      const records = tc.draw(rawRecords).map((record) => ({ ...record, worker: tc.draw(gs.sampledFrom(["1/0", "2/0", "2/1"])) }));
      const seen = new Map<string, string>();
      let shared: string | null = null;
      for (const record of records) {
        const first = seen.get(record.worker);
        if (first !== undefined && shared === null) shared = `${named(first)} and ${named(record.test)}`;
        seen.set(record.worker, first ?? record.test);
      }
      const map = buildMap(records, ROOT);
      assert.deepEqual("full" in map ? map.full : null, shared === null ? null : `${shared} ran in one worker; the recorder needs isolate: true`);
    },
    { testCases: 300 },
  );
});

// Coverage URLs and the repository file each one is, if any.
const URLS: [string, string | null][] = [
  ["file:///repo/src/a.ts", "src/a.ts"],
  ["file:///repo/src/b.ts?vitest=1", "src/b.ts"],
  ["file:///repo/src/c.ts#h?x", "src/c.ts"],
  ["file:///repo/src/a%20b.ts", "src/a b.ts"],
  ["file:///repo/..d/e.ts", "..d/e.ts"],
  ["file:///repo/node_modules/x/i.js", null],
  ["file:///repo/src/node_modules/y.js", null],
  ["file:///elsewhere/c.ts", null],
  ["file:///repository/e.ts", null],
  ["file:///repo", null],
  ["file:///", null],
  ["node:internal/x", null],
  ["data:text/javascript,1", null],
  ["", null],
];
const FUNCTIONS = [{ functionName: "", ranges: [{ startOffset: 0, endOffset: 3, count: 1 }] }];

test("parseCoverage keeps exactly the scripts of repository files, by their repository path", () => {
  hegel.test(
    (tc) => {
      const entries = tc.draw(
        gs.arrays(
          gs.oneOf(
            gs.sampledFrom(URLS).map(([url, file]) => ({ entry: { url, functions: FUNCTIONS } as unknown, file })),
            gs.sampledFrom([null, 3, "s", [], { url: 5, functions: [] }, { url: "file:///repo/a.ts" }, { url: "file:///repo/a.ts", functions: "x" }]).map((entry) => ({ entry: entry as unknown, file: null as string | null })),
          ),
          { maxSize: 6 },
        ),
      );
      const expected = entries.flatMap(({ file }) => (file === null ? [] : [{ file, functions: FUNCTIONS }]));
      assert.deepEqual(parseCoverage(JSON.stringify({ result: entries.map(({ entry }) => entry), timestamp: 1 }), ROOT), expected);
    },
    { testCases: 300 },
  );
  for (const text of ["", "{", "null", "[]", "3", '{"result":3}', '{"result":{"url":"file:///repo/a.ts"}}']) assert.deepEqual(parseCoverage(text, ROOT), []);
});

test("the recorder's marker and the map read back as written, and any other shape reads as nothing", () => {
  hegel.test(
    (tc) => {
      const marker = { file: tc.draw(gs.text({ maxSize: 20 })), worker: tc.draw(gs.text({ maxSize: 10 })) };
      assert.deepEqual(parseTestFile(JSON.stringify(marker)), { test: marker.file, worker: marker.worker });
    },
    { testCases: 100 },
  );
  for (const text of ["", "{", "null", "[]", '"x"', '{"file":"a"}', '{"worker":"1/0"}', '{"file":1,"worker":"1/0"}', '{"file":"a","worker":2}']) {
    assert.equal(parseTestFile(text), null, text);
  }
  const map: CoverageMap = { version: 1, files: { "src/a.ts": [{ start: 0, end: 3, name: "a" }] }, tests: { "test/a.test.ts": { "src/a.ts": [0] } } };
  assert.deepEqual(parseMap(JSON.stringify(map)), map);
  for (const text of ["", "{", "null", "[]", "1", '{"version":2,"files":{},"tests":{}}', '{"files":{},"tests":{}}']) assert.equal(parseMap(text), null, text);
});

test("parseHunks reads back the base side of every hunk header git prints", () => {
  hegel.test(
    (tc) => {
      const hunks: Hunk[] = tc.draw(
        gs.arrays(
          gs.tuples(gs.integers({ minValue: 0, maxValue: 5000 }), gs.integers({ minValue: 0, maxValue: 300 })).map(([start, count]) => ({ start, count })),
          { maxSize: 5 },
        ),
      );
      const lines = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts"];
      for (const hunk of hunks) {
        const side = hunk.count === 1 && tc.draw(gs.booleans()) ? `${hunk.start}` : `${hunk.start},${hunk.count}`;
        const added = tc.draw(gs.integers({ minValue: 0, maxValue: 300 }));
        const other = `${tc.draw(gs.integers({ minValue: 0, maxValue: 5000 }))}${added === 1 && tc.draw(gs.booleans()) ? "" : `,${added}`}`;
        lines.push(`@@ -${side} +${other} @@ ctx`, "-@@ -1 +1 @@", "+@@ -2 +2 @@");
      }
      assert.deepEqual(parseHunks(lines.join("\n")), hunks);
    },
    { testCases: 200 },
  );
});
