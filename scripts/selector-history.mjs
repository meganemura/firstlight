// Replays this repository's history through the Node selector. For each
// commit that changes code, it records the full suite at the commit's
// parent, in a worktree, and asks the selector what the commit's changes
// reach, with the options of the test check in firstlight.json, after
// firstlight's own fullOn gate. It prints the share of test files each
// commit would run. With --time <n>, it also times, at the <n> newest
// commits the selector narrowed, the full suite, the full suite with the
// recorder on, and the selected tests, in turn, --repeat times, and prints
// the medians and the one-minute load average seen before each run: the
// numbers mean little on a machine something else keeps busy. Every vitest
// run uses WORKERS workers.
//
//   node scripts/selector-history.mjs [--limit <n>] [--time <n>] [--repeat <n>]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/node/command.ts";
import { gateChanges, parseNameStatus } from "../src/selection.ts";
import { testCheck } from "./test-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const SETUP = path.join(ROOT, "src", "node", "vitest-setup.ts");
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Two workers leave the machine room for the processes the CLI tests start,
// and every run, full or selected, gets the same number, so the times compare.
const WORKERS = 2;

const flags = Object.fromEntries(
  process.argv.slice(2).flatMap((word, i, all) => (word.startsWith("--") ? [[word.slice(2), Number(all[i + 1])]] : [])),
);
const limit = flags.limit ?? Infinity;
const timed = flags.time ?? 0;
const repeat = flags.repeat ?? 1;

const { args: selectArgs, fullOn } = testCheck(ROOT);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const work = mkdtempSync(path.join(tmpdir(), "firstlight-history-"));
const tree = path.join(work, "tree");
// vitest resolves "vitest/config" from the config file, so the configs live
// in this checkout's gitignored tmp/ and point their root at the worktree.
mkdirSync(path.join(ROOT, "tmp"), { recursive: true });
const configs = {
  record: path.join(ROOT, "tmp", "history-record.config.ts"),
  plain: path.join(ROOT, "tmp", "history-plain.config.ts"),
};
const config = (setupFiles) => `import { defineConfig } from "vitest/config";
export default defineConfig({
  root: ${JSON.stringify(tree)},
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ${JSON.stringify(setupFiles)},
    experimental: { viteModuleRunner: false },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
`;
writeFileSync(configs.record, config([SETUP]));
writeFileSync(configs.plain, config([]));

const commits = git(ROOT, "rev-list", "--reverse", "HEAD")
  .trim()
  .split("\n")
  .flatMap((commit) => {
    const parent = git(ROOT, "rev-list", "--parents", "-n", "1", commit).trim().split(" ")[1];
    if (parent === undefined || git(ROOT, "ls-tree", "--name-only", parent, "test/").trim() === "") return [];
    const changes = parseNameStatus(git(ROOT, "diff", "--name-status", "-z", "--no-renames", parent, commit));
    return changes.some((change) => CODE.test(change.path)) ? [{ commit, parent, changes }] : [];
  })
  .slice(-limit);

function checkout(rev) {
  git(tree, "checkout", "--quiet", "--detach", "--force", rev);
  git(tree, "clean", "-fdxq", "-e", "node_modules");
}

function vitest(configFile, extra, env = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [VITEST, "run", "--config", configFile, `--maxWorkers=${WORKERS}`, ...extra], {
    cwd: tree,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: result.status === 0, ms: performance.now() - started, output: `${result.stdout}${result.stderr}` };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const rows = [];
git(ROOT, "worktree", "add", "--quiet", "--detach", tree, commits[0]?.parent ?? "HEAD");
symlinkSync(path.join(ROOT, "node_modules"), path.join(tree, "node_modules"));
try {
  for (const { commit, parent, changes } of commits) {
    const subject = git(ROOT, "log", "-1", "--format=%s", commit).trim();
    const total = git(ROOT, "ls-tree", "-r", "--name-only", commit, "test/").split("\n").filter((file) => /\.test\.ts$/.test(file)).length;
    const row = { commit: commit.slice(0, 7), subject, changed: changes.length, total };
    rows.push(row);
    const gate = gateChanges(fullOn, changes);
    if ("full" in gate) {
      row.full = gate.full;
      continue;
    }
    checkout(parent);
    const record = path.join(work, `record-${parent.slice(0, 7)}`);
    mkdirSync(record);
    const recorded = vitest(configs.record, [], { FIRSTLIGHT_RECORD: record });
    if (!recorded.ok) {
      row.unmeasured = "the recorded full run at the parent failed";
      row.log = recorded.output.split("\n").filter((line) => /FAIL|Error/.test(line)).slice(0, 5);
      rmSync(record, { recursive: true, force: true });
      continue;
    }
    const input = {
      version: 1,
      check: "test",
      tree: git(ROOT, "rev-parse", `${commit}^{tree}`).trim(),
      base: { run: "history", tree: git(ROOT, "rev-parse", `${parent}^{tree}`).trim(), record },
      changes: gate.changes,
    };
    const outcome = await main(selectArgs, async () => JSON.stringify(input), tree);
    rmSync(record, { recursive: true, force: true });
    const answer = JSON.parse(outcome.stdout);
    if ("full" in answer) row.full = answer.full;
    else row.selected = answer.tests.map((entry) => entry.id);
  }

  for (const row of rows.filter((entry) => entry.selected !== undefined).slice(-timed)) {
    if (timed === 0) break;
    checkout(row.commit);
    const full = [];
    const recorded = [];
    const selected = [];
    const loads = [];
    const timedRun = (configFile, extra, env) => {
      loads.push(loadavg()[0]);
      return vitest(configFile, extra, env);
    };
    for (let i = 0; i < repeat; i++) {
      const fullRun = timedRun(configs.plain, []);
      const record = mkdtempSync(path.join(work, "overhead-"));
      const recordedRun = timedRun(configs.record, [], { FIRSTLIGHT_RECORD: record });
      rmSync(record, { recursive: true, force: true });
      // firstlight passes a check with no selected test without a process.
      const selectedRun = row.selected.length === 0 ? { ok: true, ms: 0 } : timedRun(configs.plain, ["--passWithNoTests", ...row.selected]);
      full.push(fullRun.ms);
      recorded.push(recordedRun.ms);
      selected.push(selectedRun.ms);
      row.passed = (row.passed ?? true) && fullRun.ok && recordedRun.ok && selectedRun.ok;
    }
    row.fullMs = median(full);
    row.recordedMs = median(recorded);
    row.selectedMs = median(selected);
    row.load = [Math.min(...loads), Math.max(...loads)];
  }
} finally {
  git(ROOT, "worktree", "remove", "--force", tree);
  rmSync(work, { recursive: true, force: true });
  rmSync(configs.record, { force: true });
  rmSync(configs.plain, { force: true });
}

console.log("commit   changed  selected/total  full  recorded  selected  load      subject");
for (const row of rows) {
  const share = row.selected !== undefined ? `${row.selected.length}/${row.total}` : row.full !== undefined ? `full: ${row.full}` : `not measured: ${row.unmeasured}`;
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const times =
    row.fullMs === undefined
      ? ""
      : `${seconds(row.fullMs)}  ${seconds(row.recordedMs)}  ${seconds(row.selectedMs)}  ${row.load.map((load) => load.toFixed(1)).join("-")}${row.passed ? "" : " (a run failed)"}`;
  console.log(`${row.commit}  ${String(row.changed).padStart(7)}  ${share.padEnd(14)}  ${times.padEnd(34)}  ${row.subject}`);
  for (const line of row.log ?? []) console.log(`         ${line}`);
}
const narrowed = rows.filter((row) => row.selected !== undefined);
const full = rows.filter((row) => row.full !== undefined);
const shares = narrowed.map((row) => row.selected.length / row.total);
console.log(
  `\n${rows.length} code-changing commits; ${narrowed.length} narrowed, ${full.length} full, ${rows.length - narrowed.length - full.length} not measured; ` +
    `selected share among narrowed: median ${(100 * (median(shares) ?? 0)).toFixed(0)}%, mean ${(100 * (shares.reduce((a, b) => a + b, 0) / Math.max(shares.length, 1))).toFixed(0)}%`,
);
console.log(JSON.stringify(rows.map(({ log, ...row }) => row)));
