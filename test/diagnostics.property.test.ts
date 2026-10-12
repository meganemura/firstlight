// Properties of the log parsers and of parser inference: no input makes a
// parser throw or yield a malformed diagnostic, line endings and npm's script
// header do not change a result, and an npm script reads as its own command.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { inferParser, parseDiagnostics, PARSERS } from "../src/diagnostics.ts";

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
