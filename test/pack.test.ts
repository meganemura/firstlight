// Packs the package as npm would publish it, installs the tarball into a
// throwaway project, and runs the installed bins and resolves the recorder. This is the only test that
// reaches dist/: the others run src/ through Node's type stripping, which
// Node refuses for files under node_modules.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { checkStatuses, cleanup, makeRepo, parseLines } from "./helpers.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
// npm is a script next to node; the installed bin's `#!/usr/bin/env node`
// needs node on PATH too.
const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`;

function npm(args: string[], cwd: string): string {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
  });
}

test("the packed tarball installs a firstlight bin that runs a check, and the Node selector with its recorder", { timeout: 120_000 }, async () => {
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-pack-")));
  onTestFinished(() => rmSync(work, { recursive: true, force: true }));

  const packed = JSON.parse(npm(["pack", "--json", "--pack-destination", work], ROOT)) as {
    filename: string;
    files: { path: string }[];
  }[];
  const files = packed[0]!.files.map((file) => file.path);
  assert.ok(files.includes("dist/cli.js"), files.join("\n"));
  assert.ok(files.includes("dist/supervisor.js"), files.join("\n"));
  assert.ok(files.includes("dist/node/cli.js"), files.join("\n"));
  assert.ok(files.includes("dist/node/vitest-setup.js"), files.join("\n"));
  assert.deepEqual(
    files.filter((file) => !file.startsWith("dist/")).sort(),
    ["CHANGELOG.md", "LICENSE", "README.md", "package.json", "ruby/firstlight_minitest.rb", "ruby/firstlight_rspec.rb", "ruby/firstlight_tests.rb"],
  );
  assert.ok(files.includes("dist/recorders/node-test.js"), files.join("\n"));
  assert.deepEqual(
    files.filter((file) => file.startsWith("dist/") && !file.endsWith(".js")),
    [],
  );

  const project = path.join(work, "project");
  mkdirSync(project);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  npm(["install", "--offline", "--no-save", path.join(work, packed[0]!.filename)], project);

  const bin = path.join(project, "node_modules", ".bin", "firstlight");
  assert.match(readFileSync(bin, "utf8"), /^#!\/usr\/bin\/env node\n/);

  const help = spawnSync(bin, ["--help"], { encoding: "utf8", env: { ...process.env, PATH } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^firstlight: run lint, typecheck, and tests in parallel/);

  const repo = makeRepo({});
  onTestFinished(() => cleanup(repo));
  const env = { ...process.env, PATH, XDG_STATE_HOME: repo.xdg };
  const run = spawnSync(bin, ["run", "--json", "--", "true"], { cwd: repo.root, encoding: "utf8", env });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(checkStatuses(run.stdout), { true: "passed" });
  assert.deepEqual(parseLines(run.stdout).at(-1)!.passed, ["true"]);

  mkdirSync(path.join(repo.root, "test"));
  writeFileSync(path.join(repo.root, "test", "a.test.mjs"), 'import { test } from "node:test";\ntest("passes", () => {});\n');
  const tested = spawnSync(bin, ["run", "--json", "--", "node --test"], { cwd: repo.root, encoding: "utf8", env });
  assert.equal(tested.status, 0, tested.stderr);
  const check = parseLines(tested.stdout).find((line) => line.type === "check")!;
  assert.deepEqual((check.tests as Record<string, unknown>).passed, 1, tested.stdout);

  const selector = path.join(project, "node_modules", ".bin", "firstlight-node");
  assert.match(readFileSync(selector, "utf8"), /^#!\/usr\/bin\/env node\n/);
  const input = JSON.stringify({ version: 1, check: "test", tree: "t2", base: { run: "r1", tree: "t1", record: null }, changes: [] });
  const selected = spawnSync(selector, ["select"], { cwd: project, input, encoding: "utf8", env: { ...process.env, PATH } });
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stdout, `${JSON.stringify({ full: "no recording in the base run" })}\n`);

  const resolved = execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('firstlight/node/vitest-setup'))"], {
    cwd: project,
    encoding: "utf8",
  }).trim();
  assert.equal(resolved, `file://${path.join(project, "node_modules", "firstlight", "dist", "node", "vitest-setup.js")}`);
  assert.ok(existsSync(new URL(resolved)));
});
