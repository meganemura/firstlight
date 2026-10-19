// Measures the Node selector where Stryker cannot: on code that the tests
// reach only through child processes, such as src/cli.ts and
// src/supervisor.ts. A child process never sees the mutant Stryker switches
// on, so Stryker's report lists those mutants as uncovered or surviving.
// The script applies a seeded sample of a report's mutants one at a time,
// runs the test files the selector picks for a change at the mutant's
// lines, and, when those pass, the whole suite. A mutant that the whole
// suite kills and the selected files do not is a miss. A mutant in a file
// that the test check's fullOn names gets the full run. The map comes from
// a recording of the full suite at the same tree as the report's sources.
//
// The mutants go into a git worktree of HEAD in a temporary directory, never
// into this checkout: a script stopped by a signal or by a restart of the
// machine cannot write the original back, and one such stop once left a
// mutant in src/supervisor.ts.
//
// A mutant of the supervisor can leave detached processes behind, and one
// that never records a check's end starts the check again without end: one
// such mutant once filled the machine with thousands of processes. So each
// vitest run gets a TMPDIR of its own, which every process it starts
// inherits and every test repository lives under. While the run lasts, more
// than RUNAWAY such processes stop it, as a failed run. After it, every
// process that names that directory in its environment, working directory,
// or command line gets SIGKILL: those are the processes the run started.
// That search reads /proc, so the script runs on Linux.
//
// No test runs the mutated files in its own worker, so Stryker reports
// every mutant as not covered and runs no test for it; --ignoreStatic keeps
// it from running the whole suite for the recorder's top-level mutants.
//
//   FIRSTLIGHT_RECORD=<dir> npx vitest run
//   npx stryker run --mutate src/cli.ts,src/supervisor.ts,src/node/cli.ts,src/node/vitest-setup.ts --ignoreStatic --reporters json
//   node scripts/selector-children.mjs <dir> reports/mutation/mutation.json [--sample <n>] [--seed <n>]

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, symlinkSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMap } from "../src/node/command.ts";
import { selectTests } from "../src/node/select.ts";
import { gateChanges } from "../src/selection.ts";
import { testCheck } from "./test-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
// The whole suite, at WORKERS workers, peaked at 19 processes. A hundred
// Node processes already hold several gigabytes.
const RUNAWAY = 100;
// Each mutant runs the whole suite, and two workers leave the machine room
// for the processes the CLI tests start.
const WORKERS = 2;
const RUN_TIMEOUT_MS = 300_000;
const [record, reportFile, ...flags] = process.argv.slice(2);
if (record === undefined || reportFile === undefined) {
  process.stderr.write("usage: node scripts/selector-children.mjs <record dir> <mutation.json> [--sample <n>] [--seed <n>]\n");
  process.exit(2);
}
const { options, fullOn } = testCheck(ROOT);
let sample = 20;
let seed = 1;
for (let i = 0; i < flags.length; i += 2) {
  if (flags[i] === "--sample") sample = Number(flags[i + 1]);
  else if (flags[i] === "--seed") seed = Number(flags[i + 1]);
}

const map = loadMap(path.resolve(record), ROOT);
if ("full" in map) {
  process.stderr.write(`no map: ${map.full}\n`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportFile, "utf8"));
const out = mkdtempSync(path.join(tmpdir(), "firstlight-children-"));
const tree = path.join(out, "tree");
execFileSync("git", ["worktree", "add", "--quiet", "--detach", tree, "HEAD"], { cwd: ROOT });
symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"));
function cleanUp() {
  execFileSync("git", ["worktree", "remove", "--force", tree], { cwd: ROOT });
  rmSync(out, { recursive: true, force: true });
}
for (const [file, { source }] of Object.entries(report.files)) {
  if (readFileSync(path.join(tree, file), "utf8") !== source) {
    process.stderr.write(`${file} at HEAD differs from the source the report mutated\n`);
    cleanUp();
    process.exit(1);
  }
}

// mulberry32, so one seed always draws the same mutants.
function random(state) {
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pool = Object.entries(report.files).flatMap(([file, { source, mutants }]) => mutants.map((mutant) => ({ file, source, mutant })));
const next = random(seed);
for (let i = 0; i < Math.min(sample, pool.length); i++) {
  const j = i + Math.floor(next() * (pool.length - i));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const chosen = pool.slice(0, sample);

const env = { ...process.env };
delete env.FIRSTLIGHT_RECORD;

function startedUnder(dir) {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    .filter((pid) => {
      const read = (what) => {
        try {
          return what === "cwd" ? readlinkSync(`/proc/${pid}/cwd`) : readFileSync(`/proc/${pid}/${what}`, "latin1");
        } catch {
          // The process ended, or is not this user's.
          return "";
        }
      };
      return read("environ").split("\0").includes(`TMPDIR=${dir}`) || read("cwd").startsWith(dir) || read("cmdline").includes(dir);
    })
    .map(Number);
}

function sweep(dir) {
  for (let round = 0; round < 10; round++) {
    const pids = startedUnder(dir);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // It ended on its own.
      }
    }
  }
}

async function vitest(files) {
  const result = path.join(out, "result.json");
  rmSync(result, { force: true });
  const tmp = mkdtempSync(path.join(out, "tmp-"));
  const child = spawn(process.execPath, [VITEST, "run", `--maxWorkers=${WORKERS}`, "--passWithNoTests", "--reporter=json", `--outputFile=${result}`, ...files], {
    cwd: tree,
    env: { ...env, TMPDIR: tmp },
    stdio: "ignore",
  });
  let stopped = null;
  const stop = (why) => {
    stopped ??= why;
    child.kill("SIGKILL");
  };
  const watch = setInterval(() => {
    if (startedUnder(tmp).length > RUNAWAY) stop(`more than ${RUNAWAY} processes`);
  }, 2000);
  const timer = setTimeout(() => stop(`no end within ${RUN_TIMEOUT_MS / 1000}s`), RUN_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearInterval(watch);
  clearTimeout(timer);
  sweep(tmp);
  rmSync(tmp, { recursive: true, force: true });
  let failed = [];
  try {
    failed = JSON.parse(readFileSync(result, "utf8"))
      .testResults.filter((entry) => entry.status !== "passed")
      .map((entry) => path.relative(tree, entry.name));
  } catch {
    // A run that was stopped or crashed wrote no result; its exit says it failed.
  }
  return { ok: code === 0 && stopped === null, failed, stopped };
}

function offset(source, { line, column }) {
  let start = 0;
  for (let i = 1; i < line; i++) start = source.indexOf("\n", start) + 1;
  return start + column - 1;
}

const total = Object.keys(map.tests).length;
const counts = { caught: 0, missed: 0, "caught by no test": 0, flaky: 0, full: 0 };
let selectedSum = 0;
let narrowed = 0;
try {
  for (const { file, source, mutant } of chosen) {
    const { start, end } = mutant.location;
    const edit = { base: source, hunks: [{ start: start.line, count: end.line - start.line + 1 }] };
    const changes = [{ status: "M", path: file }];
    const gate = gateChanges(fullOn, changes);
    const answer = "full" in gate ? gate : selectTests(map, changes, new Map([[file, edit]]), options);
    const where = `${file}:${start.line}:${start.column} ${mutant.mutatorName} ${JSON.stringify(mutant.replacement).slice(0, 60)}`;
    if ("full" in answer) {
      counts.full++;
      console.log(`full     ${where}: ${answer.full}`);
      continue;
    }
    const selected = answer.tests.map((entry) => entry.id);
    selectedSum += selected.length;
    narrowed++;
    writeFileSync(path.join(tree, file), source.slice(0, offset(source, start)) + mutant.replacement + source.slice(offset(source, end)));
    let outcome;
    let detail = "";
    try {
      const picked = selected.length === 0 ? { ok: true, failed: [] } : await vitest(selected);
      if (!picked.ok) {
        outcome = "caught";
        detail = `by ${picked.failed.join(", ") || `a run stopped for ${picked.stopped ?? "a crash"}`}`;
      } else {
        const whole = await vitest([]);
        const others = whole.failed.filter((test) => !selected.includes(test));
        outcome = whole.ok ? "caught by no test" : others.length > 0 || whole.failed.length === 0 ? "missed" : "flaky";
        detail = whole.ok ? "" : `the whole suite failed ${whole.failed.join(", ") || "without a result"}`;
      }
    } finally {
      writeFileSync(path.join(tree, file), source);
    }
    counts[outcome]++;
    console.log(`${outcome.padEnd(8)} ${where}: ${selected.length}/${total} selected ${detail}`);
  }
} finally {
  cleanUp();
}
console.log(`\n${chosen.length} mutants of ${pool.length}, seed ${seed}: ${Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(", ")}`);
console.log(`test files selected per narrowed mutant: ${(selectedSum / Math.max(narrowed, 1)).toFixed(2)} of ${total}`);
