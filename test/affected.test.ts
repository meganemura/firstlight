import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { cleanup, cli, makeRepo, parseLines } from "./helpers.ts";

const RUN_ID = "[0-9A-HJKMNP-TV-Z]{26}";

function markerDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-marker-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

test("after a full pass, a check with affected runs only on the files changed since that pass", async () => {
  const marks = markerDir();
  const repo = makeRepo({
    "firstlight.json": {
      checks: {
        test: { run: `echo full >> ${marks}/log`, affected: `echo {files} >> ${marks}/log`, fullOn: ["*.lock"] },
      },
    },
    "a.ts": "1\n",
    "b.ts": "1\n",
    "c d.ts": "1\n",
  });
  onTestFinished(() => cleanup(repo));

  assert.equal((await cli(repo, ["run"])).code, 0);
  const fullRun = parseLines((await cli(repo, ["results", "--json"])).stdout).at(-1)!.run as string;

  writeFileSync(path.join(repo.root, "a.ts"), "2\n");
  writeFileSync(path.join(repo.root, "c d.ts"), "2\n");
  const narrowed = await cli(repo, ["run"]);
  assert.equal(narrowed.code, 0, narrowed.stderr);
  const json = parseLines((await cli(repo, ["results", "--json"])).stdout)[0]!;
  assert.deepEqual(json.narrowed, { base: fullRun, files: ["a.ts", "c d.ts"], command: `echo a.ts 'c d.ts' >> ${marks}/log` });
  assert.deepEqual(lines(`${marks}/log`), ["full", "a.ts c d.ts"]);
  const text = await cli(repo, ["results"]);
  assert.match(text.stdout, new RegExp(`^test passed \\(narrowed to 2 files since run ${fullRun}, exit 0, `));

  const again = await cli(repo, ["run", "--json"]);
  assert.notEqual(parseLines(again.stdout)[0]!.cached_from, null, "the same narrowing on the same tree is reused");
  assert.equal(lines(`${marks}/log`).length, 2);

  writeFileSync(path.join(repo.root, "b.ts"), "2\n");
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.equal(lines(`${marks}/log`).at(-1), "a.ts b.ts c d.ts", "files count from the last full pass, not the narrowed one");

  assert.equal((await cli(repo, ["run", "--full"])).code, 0);
  assert.equal(lines(`${marks}/log`).at(-1), "full");

  unlinkSync(path.join(repo.root, "b.ts"));
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.equal(lines(`${marks}/log`).at(-1), "full", "a deleted file runs the full command");

  writeFileSync(path.join(repo.root, "deps.lock"), "x\n");
  assert.equal((await cli(repo, ["run"])).code, 0);
  assert.equal(lines(`${marks}/log`).at(-1), "full", "a fullOn file runs the full command");
});

test("a check with affected and no full pass yet runs the full command", async () => {
  const marks = markerDir();
  const repo = makeRepo({
    "firstlight.json": { checks: { test: { run: `echo full >> ${marks}/log; exit 1`, affected: `echo {files} >> ${marks}/log` } } },
    "a.ts": "1\n",
  });
  onTestFinished(() => cleanup(repo));
  assert.equal((await cli(repo, ["run"])).code, 1);
  writeFileSync(path.join(repo.root, "a.ts"), "2\n");
  assert.equal((await cli(repo, ["run"])).code, 1);
  assert.deepEqual(lines(`${marks}/log`), ["full", "full"]);
  const result = await cli(repo, ["results", "--json"]);
  assert.equal(parseLines(result.stdout)[0]!.narrowed, undefined);
  assert.match(parseLines(result.stdout).at(-1)!.run as string, new RegExp(`^${RUN_ID}$`));
});

test("affected must hold {files}, fullOn needs affected, and --full belongs to run", async () => {
  const bad = makeRepo({ "firstlight.json": { checks: { test: { run: "true", affected: "vitest related" } } } });
  onTestFinished(() => cleanup(bad));
  const refused = await cli(bad, ["run"]);
  assert.equal(refused.code, 1);
  assert.match(JSON.parse(refused.stderr).error, /check "test" has "affected" that is not a shell command holding \{files\}/);

  const orphan = makeRepo({ "firstlight.json": { checks: { test: { run: "true", fullOn: ["*.lock"] } } } });
  onTestFinished(() => cleanup(orphan));
  assert.match(JSON.parse((await cli(orphan, ["run"])).stderr).error, /has "fullOn" without "affected"/);

  const flag = await cli(orphan, ["results", "--full"]);
  assert.deepEqual(JSON.parse(flag.stderr), { error: "--full belongs to run", do: "run `firstlight run --full`" });
});
