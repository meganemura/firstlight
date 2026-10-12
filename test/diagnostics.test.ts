import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { formatDiagnostic, inferParser, parseDiagnostics, type ParserName } from "../src/diagnostics.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "diagnostics");

function parseFixture(parser: ParserName, file: string) {
  return parseDiagnostics(parser, readFileSync(path.join(FIXTURES, file), "utf8"), "/repo");
}

const TSC = [
  { file: "src/math.ts", line: 5, col: 14, rule: "TS2322", message: "Type 'number' is not assignable to type 'string'." },
  { file: "src/math.ts", line: 7, col: 14, rule: "TS2304", message: "Cannot find name 'c'." },
  { file: "src/math.ts", line: 10, col: 38, rule: "TS2322", message: "Type 'number' is not assignable to type 'string'." },
  {
    file: "src/math.ts",
    line: 11,
    col: 14,
    rule: "TS2322",
    message: "Type '(a: { x: number; }) => void' is not assignable to type '(a: { x: string; }) => void'.",
  },
];

test("tsc diagnostics come from the plain form behind npm's script lines", () => {
  assert.deepEqual(parseFixture("tsc", "tsc.txt"), TSC);
});

test("tsc diagnostics come from the --pretty form with its colors", () => {
  assert.deepEqual(parseFixture("tsc", "tsc-pretty.txt"), TSC);
});

test("vitest diagnostics name the test and the first frame in the project", () => {
  assert.deepEqual(parseFixture("vitest", "vitest.txt"), [
    {
      file: "test/broken.test.ts",
      line: 2,
      col: 1,
      rule: null,
      message: "Error: Cannot find module '../src/missing.ts' imported from /repo/test/broken.test.ts",
    },
    { file: "test/calc.test.ts", line: 6, col: 23, rule: "mul > multiplies two numbers", message: "AssertionError: expected 7 to be 6 // Object.is equality" },
    {
      file: "test/calc.test.ts",
      line: 10,
      col: 43,
      rule: "mul > nested > deep equal",
      message: "AssertionError: expected { a: 2, b: [ 1, 2 ] } to deeply equal { a: 1, b: [ 1, 2 ] }",
    },
    { file: "src/calc.ts", line: 6, col: 26, rule: "parse throws on empty input", message: "Error: empty input" },
    { file: "test/other.test.ts", line: 5, col: 10, rule: "node assert inside vitest", message: "AssertionError: Expected values to be strictly equal: 2 !== 3" },
  ]);
});

test("vitest diagnostics skip the lines another reporter prints", () => {
  assert.deepEqual(parseFixture("vitest", "vitest-depug.txt"), [
    {
      file: "test/zz-broken.test.ts",
      line: 6,
      col: 10,
      rule: "quotes a word with a space",
      message: "AssertionError: Expected values to be strictly equal: \"'a b'\" !== 'a b'",
    },
  ]);
});

test("node:test diagnostics come from the spec reporter, with the full test name", () => {
  assert.deepEqual(parseFixture("node-test", "node-test.txt"), [
    {
      file: "ntest/calc.test.ts",
      line: 7,
      col: 12,
      rule: "mul > multiplies two numbers",
      message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 7 !== 6",
    },
    {
      file: "ntest/calc.test.ts",
      line: 11,
      col: 14,
      rule: "mul > nested > deep equal",
      message: "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected",
    },
    { file: "src/calc.ts", line: 6, col: 26, rule: "parse throws on empty input", message: "Error: empty input" },
    { file: "ntest/other.test.ts", line: 4, col: 24, rule: "rejects", message: "TypeError: bad type" },
  ]);
});

test("node:test diagnostics come from the TAP reporter, without the suites that only hold a failure", () => {
  assert.deepEqual(parseFixture("node-test", "node-test-tap.txt"), [
    { file: "ntest/calc.test.ts", line: 7, col: 12, rule: "mul > multiplies two numbers", message: "AssertionError: Expected values to be strictly equal: 7 !== 6" },
    {
      file: "ntest/calc.test.ts",
      line: 11,
      col: 14,
      rule: "mul > nested > deep equal",
      message: "AssertionError: Expected values to be strictly deep-equal: + actual - expected",
    },
    { file: "src/calc.ts", line: 6, col: 26, rule: "parse throws on empty input", message: "empty input" },
    { file: "ntest/other.test.ts", line: 4, col: 24, rule: "rejects", message: "TypeError: bad type" },
  ]);
});

test("archstrict diagnostics carry the rule id and the evidence, with the path made relative", () => {
  assert.deepEqual(parseFixture("archstrict", "archstrict.txt"), [
    {
      file: "src/b/index.ts",
      line: 1,
      col: 24,
      rule: "public-surface-bypass",
      message: "'../a/internal.ts' resolved to a file inside module 'a' other than its index.ts, index.tsx, index.mts, index.cts",
    },
    { file: "src/extra.ts", line: 1, col: 1, rule: "uncovered-module", message: "'/repo/src/extra.ts' is in scope but matches no declared module" },
  ]);
});

test("a parser finds nothing in another tool's log", () => {
  assert.deepEqual(parseFixture("tsc", "vitest.txt"), []);
  assert.deepEqual(parseFixture("vitest", "tsc.txt"), []);
  assert.deepEqual(parseFixture("node-test", "archstrict.txt"), []);
  assert.deepEqual(parseFixture("archstrict", "node-test.txt"), []);
});

test("a diagnostic prints as file:line:col rule message, dropping what is null", () => {
  assert.equal(formatDiagnostic({ file: "a.ts", line: 3, col: 7, rule: "TS2322", message: "bad" }), "a.ts:3:7 TS2322 bad");
  assert.equal(formatDiagnostic({ file: "a.ts", line: 3, col: null, rule: null, message: "bad" }), "a.ts:3 bad");
  assert.equal(formatDiagnostic({ file: "a.ts", line: null, col: null, rule: "x > y", message: "bad" }), "a.ts x > y bad");
});

test("the parser is inferred from the command, and from an npm script one level deep", () => {
  const scripts: Record<string, string> = {
    typecheck: "tsc --noEmit",
    test: "vitest run",
    "lint:arch": "archstrict check",
    unit: "node --test test/",
    again: "npm run typecheck",
    both: "tsc && vitest run",
  };
  const scriptOf = (name: string) => scripts[name] ?? null;
  const cases: [string, ParserName | null][] = [
    ["tsc --noEmit", "tsc"],
    ["npx tsc -p .", "tsc"],
    ["./node_modules/.bin/vitest run", "vitest"],
    ["CI=1 vitest run", "vitest"],
    ["pnpm exec archstrict check", "archstrict"],
    ["node --test", "node-test"],
    ["node --import ./setup.js --test test/", "node-test"],
    ["node script.js --test", null],
    ["npm run typecheck", "tsc"],
    ["npm run -s 'lint:arch'", "archstrict"],
    ["npm test", "vitest"],
    ["npm run unit -- --watch", "node-test"],
    ["npm run again", null],
    ["npm run both", null],
    ["npm run missing", null],
    ["tsc && vitest run", null],
    ["vitest run | tee out.log", null],
    ["bundle exec rspec", null],
    ["make", null],
  ];
  for (const [command, parser] of cases) assert.equal(inferParser(command, scriptOf), parser, command);
});
