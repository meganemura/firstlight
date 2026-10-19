// A check with "paths" runs again only when a file changed since its newest
// full pass matches one of them, through the real CLI in a git repository.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, currentRun, makeRepo, parseLines, type Repo } from "./helpers.ts";

function pathsRepo(): Repo {
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        lint: { run: "echo lint >> .runs", paths: ["src/**", "package.json"] },
        docs: { run: "echo docs >> .runs", paths: ["**/*.md", "*.md"] },
        always: { run: "echo always >> .runs" },
      },
    },
    ".gitignore": ".runs\n",
    "README.md": "1\n",
  });
  mkdirSync(path.join(repo.root, "src"));
  writeFileSync(path.join(repo.root, "src", "a.ts"), "1\n");
  onTestFinished(() => cleanup(repo));
  return repo;
}

function runs(repo: Repo): string[] {
  const file = path.join(repo.root, ".runs");
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).sort();
  rmSync(file);
  return lines;
}

test("a check runs again only when a changed file matches its paths", async () => {
  const repo = pathsRepo();
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.deepEqual(runs(repo), ["always", "docs", "lint"], "nothing passed in full yet, so every check runs");
  const base = currentRun(repo).id;

  writeFileSync(path.join(repo.root, "README.md"), "2\n");
  const text = await cli(repo, ["run"]);
  assert.equal(text.code, 0, text.stdout);
  assert.deepEqual(runs(repo), ["always", "docs"]);
  const shown = await cli(repo, ["results"]);
  assert.match(shown.stdout, new RegExp(`^lint passed \\(not run: no file of 1 changed file since run ${base} matches its paths\\)$`, "m"));

  writeFileSync(path.join(repo.root, "src", "a.ts"), "2\n");
  const json = await cli(repo, ["run", "--json"]);
  assert.equal(json.code, 0, json.stdout);
  assert.deepEqual(runs(repo), ["always", "lint"]);
  const lines = parseLines(json.stdout);
  assert.equal(lines.find((line) => line.name === "lint")!.narrowed, undefined);
  assert.deepEqual(
    (lines.find((line) => line.name === "docs")!.narrowed as { files: string[] }).files,
    ["src/a.ts"],
    "docs counts from its own newest full pass, the run before",
  );
});

test("a skipped check records why, passes without an exit code, and --full runs it", async () => {
  const repo = pathsRepo();
  assert.equal((await cli(repo, ["run"])).code, 0);
  runs(repo);
  const base = currentRun(repo).id;

  rmSync(path.join(repo.root, "README.md"));
  const skipped = await cli(repo, ["run", "--json"]);
  assert.equal(skipped.code, 0, skipped.stdout);
  assert.deepEqual(runs(repo), ["always", "docs"], "a deleted file counts as a change to its path");
  const lint = parseLines(skipped.stdout).find((line) => line.name === "lint")!;
  assert.equal(lint.status, "passed");
  assert.equal(lint.exit_code, null);
  assert.deepEqual(lint.narrowed, { base, files: ["README.md"], tests: [], command: null, paths: ["src/**", "package.json"] });
  assert.equal(readFileSync(lint.log as string, "utf8"), `firstlight: not run; no file of 1 changed file since run ${base} matches its paths\n`);
  const event = currentRun(repo).events.find((line) => line.check === "lint")!;
  assert.equal(event.no_tests, true);

  writeFileSync(path.join(repo.root, "README.md"), "3\n");
  assert.equal((await cli(repo, ["run", "--full"])).code, 0);
  assert.deepEqual(runs(repo), ["always", "docs", "lint"]);
});

test("paths must be a non-empty list of globs", async () => {
  const refusal = async (paths: unknown): Promise<string> => {
    const repo = makeRepo({ "firstlight.json": { checks: { lint: { run: "true", paths } } } });
    onTestFinished(() => cleanup(repo));
    const refused = await cli(repo, ["run"]);
    assert.equal(refused.code, 1);
    return (JSON.parse(refused.stderr) as { error: string }).error;
  };
  const message = `invalid firstlight.json: check "lint" has "paths" that is not a non-empty array of path globs, like ["src/**", "package.json"]`;
  assert.equal(await refusal([]), message);
  assert.equal(await refusal("src/**"), message);
  assert.equal(await refusal(["src/**", ""]), message);
});
