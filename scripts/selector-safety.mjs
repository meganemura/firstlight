// Measures whether the Node selector would have run a test that catches a
// real bug. Each mutant Stryker killed is a bug some test caught; the
// script hands the selector a change at exactly that mutant's lines and
// counts the mutants for which it selects none of the tests that killed
// it. A mutant in a file that the test check's fullOn names gets the full
// run, as firstlight would give it. The map comes from a recording of the
// full suite at the same tree as the mutated sources.
//
//   FIRSTLIGHT_RECORD=<dir> npx vitest run
//   npx stryker run --reporters clear-text,json
//   node scripts/selector-safety.mjs <dir> reports/mutation/mutation.json

import { readFileSync } from "node:fs";
import path from "node:path";
import { loadMap } from "../src/node/command.ts";
import { selectTests } from "../src/node/select.ts";
import { gateChanges } from "../src/selection.ts";
import { testCheck } from "./test-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const [record, reportFile] = process.argv.slice(2);
if (record === undefined || reportFile === undefined) {
  process.stderr.write("usage: node scripts/selector-safety.mjs <record dir> <mutation.json>\n");
  process.exit(2);
}
const { options, fullOn } = testCheck(ROOT);

const map = loadMap(path.resolve(record), ROOT);
if ("full" in map) {
  process.stderr.write(`no map: ${map.full}\n`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const testFileOf = new Map();
for (const [file, { tests }] of Object.entries(report.testFiles ?? {})) {
  for (const entry of tests) testFileOf.set(entry.id, path.relative(ROOT, path.resolve(ROOT, file)));
}

const totals = { killed: 0, missed: 0, full: 0, selected: 0, killers: 0 };
const perFile = new Map();
const missed = [];
for (const [file, { source, mutants }] of Object.entries(report.files)) {
  const row = perFile.get(file) ?? { killed: 0, missed: 0, full: 0, selected: 0 };
  perFile.set(file, row);
  for (const mutant of mutants) {
    if (mutant.status !== "Killed" || (mutant.killedBy ?? []).length === 0) continue;
    const killers = new Set(mutant.killedBy.map((id) => testFileOf.get(id) ?? `unknown test ${id}`));
    const { start, end } = mutant.location;
    const edit = { base: source, hunks: [{ start: start.line, count: end.line - start.line + 1 }] };
    const changes = [{ status: "M", path: file }];
    const gate = gateChanges(fullOn, changes);
    const answer = "full" in gate ? gate : selectTests(map, changes, new Map([[file, edit]]), options);
    const selected = "full" in answer ? null : new Set(answer.tests.map((entry) => entry.id));
    totals.killed++;
    row.killed++;
    totals.killers += killers.size;
    if (selected === null) {
      totals.full++;
      row.full++;
      continue;
    }
    totals.selected += selected.size;
    row.selected += selected.size;
    if ([...killers].some((test) => selected.has(test))) continue;
    totals.missed++;
    row.missed++;
    missed.push({ file, line: start.line, mutator: mutant.mutatorName, replacement: mutant.replacement, killers: [...killers], selected: [...selected] });
  }
}

const tests = Object.keys(map.tests).length;
console.log(`recorded test files: ${tests}`);
console.log(`killed mutants: ${totals.killed}, missed (no killer selected): ${totals.missed}, answered with a full run: ${totals.full}`);
console.log(
  `test files selected per narrowed mutant: ${(totals.selected / Math.max(totals.killed - totals.full, 1)).toFixed(2)} of ${tests}; killers per mutant: ${(totals.killers / Math.max(totals.killed, 1)).toFixed(2)}`,
);
console.log("\nfile                      killed  missed    full  selected per narrowed mutant");
for (const [file, row] of [...perFile].sort()) {
  if (row.killed === 0) continue;
  const narrowed = row.killed - row.full;
  const share = narrowed === 0 ? "-" : (row.selected / narrowed).toFixed(2);
  console.log(`${file.padEnd(26)}${String(row.killed).padStart(6)}  ${String(row.missed).padStart(6)}  ${String(row.full).padStart(6)}  ${share.padStart(8)}`);
}
for (const entry of missed) console.log(`\nmissed: ${JSON.stringify(entry)}`);
