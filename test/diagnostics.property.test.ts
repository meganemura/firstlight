// Properties of the log parsers and of parser inference: no input makes a
// parser throw or yield a malformed diagnostic, line endings and npm's script
// header do not change a result, depug's lines only add evidence and rerun to
// the one vitest diagnostic they name, and an npm script reads as its own
// command.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { inferParser, parseDiagnostics, PARSERS, type Diagnostic } from "../src/diagnostics.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "diagnostics");
const FIXTURE_LINES = readdirSync(FIXTURES).flatMap((file) => readFileSync(path.join(FIXTURES, file), "utf8").split("\n"));

// Real lines, cut real lines, and noise, so the near misses that matter
// show up next to arbitrary text.
function drawLog(tc: hegel.TestCase): string[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }));
    if (kind === 2) {
      lines.push(tc.draw(gs.text({ maxSize: 30 })).replace(/[\r\n]/g, ""));
      continue;
    }
    const line = tc.draw(gs.sampledFrom(FIXTURE_LINES));
    lines.push(kind === 0 ? line : line.slice(0, tc.draw(gs.integers({ minValue: 0, maxValue: line.length }))));
  }
  return lines;
}

test("no log makes a parser throw, and every diagnostic is well formed", () => {
  hegel.test(
    (tc) => {
      const parser = tc.draw(gs.sampledFrom(PARSERS));
      const log = tc.draw(gs.booleans()) ? drawLog(tc).join("\n") : tc.draw(gs.text({ maxSize: 200 }));
      for (const diagnostic of parseDiagnostics(parser, log, "/repo")) {
        assert.equal(typeof diagnostic.file, "string");
        assert.ok(diagnostic.file.length > 0);
        for (const position of [diagnostic.line, diagnostic.col]) {
          assert.ok(position === null || (Number.isSafeInteger(position) && position > 0), String(position));
        }
        assert.ok(diagnostic.rule === null || typeof diagnostic.rule === "string");
        assert.doesNotMatch(diagnostic.message, /[\r\n]/);
        assert.ok(diagnostic.message.length <= 300);
      }
    },
    { testCases: 400 },
  );
});

test("CRLF and LF line endings give the same diagnostics", () => {
  hegel.test(
    (tc) => {
      const parser = tc.draw(gs.sampledFrom(PARSERS));
      const lines = drawLog(tc);
      assert.deepEqual(parseDiagnostics(parser, lines.join("\r\n"), "/repo"), parseDiagnostics(parser, lines.join("\n"), "/repo"));
    },
    { testCases: 300 },
  );
});

test("npm's script header before a log changes nothing", () => {
  hegel.test(
    (tc) => {
      const parser = tc.draw(gs.sampledFrom(PARSERS));
      const log = drawLog(tc).join("\n");
      const header = "\n> pkg@1.0.0 check\n> some command --flag\n\n";
      assert.deepEqual(parseDiagnostics(parser, header + log, "/repo"), parseDiagnostics(parser, log, "/repo"));
    },
    { testCases: 300 },
  );
});

function withoutDepug({ evidence: _evidence, rerun: _rerun, ...rest }: Diagnostic): Diagnostic {
  return rest;
}

const DEPUG_LINE = /^depug (?:evidence|rerun): /;

test("a log without depug lines gives no evidence or rerun, and a match always has both", () => {
  hegel.test(
    (tc) => {
      const parser = tc.draw(gs.sampledFrom(PARSERS));
      const lines = drawLog(tc);
      const plain = lines.filter((line) => !DEPUG_LINE.test(line));
      for (const diagnostic of parseDiagnostics(parser, plain.join("\n"), "/repo")) {
        assert.deepEqual(Object.keys(diagnostic), ["file", "line", "col", "rule", "message"]);
      }
      for (const diagnostic of parseDiagnostics(parser, lines.join("\n"), "/repo")) {
        assert.equal(diagnostic.evidence === undefined, diagnostic.rerun === undefined);
        if (diagnostic.evidence === undefined) continue;
        assert.equal(parser, "vitest");
        assert.ok(diagnostic.evidence.startsWith("/"), diagnostic.evidence);
        assert.ok(lines.includes(`depug rerun: ${diagnostic.rerun}`), String(diagnostic.rerun));
      }
    },
    { testCases: 400 },
  );
});

const TEST_FILES = ["test/a.test.ts", "test/b.test.ts"];
const NAME_PARTS = ["a", "b", "a b", "b c", "x (y)", "q.*", "cost $1", "a > b"];

interface DrawnFailure {
  file: string;
  parts: string[];
}

function rerunCommand(failure: DrawnFailure): string {
  const pattern = `^${failure.parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(" ")}$`;
  return `npx depug rerun -- npx vitest run ${JSON.stringify(failure.file)} -t ${JSON.stringify(pattern)}`;
}

function depugKey(failure: DrawnFailure): string {
  return JSON.stringify([failure.file, failure.parts.join(" ")]);
}

// The header joins the names with " > ", so a name that holds " > " reads
// back as two.
function headerKey(failure: DrawnFailure): string {
  return JSON.stringify([failure.file, failure.parts.join(" > ").split(" > ").join(" ")]);
}

test("depug lines attach to the one vitest failure they name and change nothing else", () => {
  hegel.test(
    (tc) => {
      const drawFailure = (): DrawnFailure => ({
        file: tc.draw(gs.sampledFrom(TEST_FILES)),
        parts: Array.from({ length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) }, () => tc.draw(gs.sampledFrom(NAME_PARTS))),
      });
      const failures = Array.from({ length: tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) }, drawFailure);
      const reported: DrawnFailure[] = [];
      for (const failure of failures) {
        if (tc.draw(gs.booleans())) reported.push(failure);
        if (tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0) reported.push(failure);
      }
      if (tc.draw(gs.booleans())) reported.push(drawFailure());
      const depugLines = reported.flatMap((failure, i) => [
        "",
        `depug evidence: /repo/tmp/depug/run/${i}.json (the failing call is in these frames)`,
        `depug rerun: ${rerunCommand(failure)}`,
      ]);
      const blocks = failures.flatMap((failure, i) => [
        ` FAIL  ${failure.file} > ${failure.parts.join(" > ")}`,
        `Error: failure ${i}`,
        "",
        ` ❯ ${failure.file}:${i + 1}:3`,
        `⎯⎯⎯⎯⎯⎯[${i + 1}/${failures.length}]⎯`,
        "",
      ]);
      const plainLog = [" RUN  v4.1.11 /repo", ...blocks].join("\n");
      const depugLog = [" RUN  v4.1.11 /repo", ...depugLines, ...blocks].join("\n");
      const plain = parseDiagnostics("vitest", plainLog, "/repo");
      const attached = parseDiagnostics("vitest", depugLog, "/repo");
      assert.deepEqual(attached.map(withoutDepug), plain);
      attached.forEach((diagnostic, i) => {
        const key = headerKey(failures[i]!);
        const sameName = failures.filter((failure) => headerKey(failure) === key).length;
        const named = reported.flatMap((failure, j) => (depugKey(failure) === key ? [j] : []));
        if (sameName === 1 && named.length === 1) {
          assert.equal(diagnostic.evidence, `/repo/tmp/depug/run/${named[0]}.json`);
          assert.equal(diagnostic.rerun, rerunCommand(reported[named[0]!]!));
        } else {
          assert.equal(diagnostic.evidence, undefined);
          assert.equal(diagnostic.rerun, undefined);
        }
      });
    },
    { testCases: 300 },
  );
});

const COMMANDS = ["tsc --noEmit", "vitest run", "archstrict check", "node --test", "node app.js", "make", "bundle exec rspec"];

test("npm run reads as the script's own command, and an env prefix changes nothing", () => {
  hegel.test(
    (tc) => {
      const command = tc.draw(gs.sampledFrom(COMMANDS));
      const name = tc.draw(gs.sampledFrom(["test", "check", "lint:types"]));
      const direct = inferParser(command, () => null);
      const verb = name === "test" && tc.draw(gs.booleans()) ? "npm test" : `npm run ${name}`;
      assert.equal(inferParser(verb, (script) => (script === name ? command : null)), direct);
      assert.equal(inferParser(`FORCE_COLOR=0 ${command}`, () => null), direct);
    },
    { testCases: 200 },
  );
});

test("a compound command has no parser", () => {
  hegel.test(
    (tc) => {
      const first = tc.draw(gs.sampledFrom(COMMANDS));
      const second = tc.draw(gs.sampledFrom(COMMANDS));
      const joiner = tc.draw(gs.sampledFrom([" && ", " || ", "; ", " | "]));
      assert.equal(inferParser(`${first}${joiner}${second}`, () => null), null);
    },
    { testCases: 100 },
  );
});
