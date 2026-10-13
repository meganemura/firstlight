import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { checkStatuses, cleanup, cli, makeRepo } from "./helpers.ts";

const SCRIPTS = { lint: "true", typecheck: "tsc --noEmit", test: "vitest run", "check:arch": "true", "test:slow": "true", build: "exit 1" };

test("init prints the proposal, writes nothing, and names the check-like scripts it left out", async () => {
  const repo = makeRepo({ "package.json": { scripts: SCRIPTS } });
  onTestFinished(() => cleanup(repo));

  const result = await cli(repo, ["init"]);
  assert.equal(result.code, 0, result.stderr);
  const file = path.join(repo.root, "firstlight.json");
  assert.equal(
    result.stdout,
    [
      `would write ${file}:`,
      "{",
      '  "checks": {',
      '    "lint": {',
      '      "run": "npm run lint"',
      "    },",
      '    "typecheck": {',
      '      "run": "npm run typecheck",',
      '      "parser": "tsc"',
      "    },",
      '    "test": {',
      '      "run": "npm run test",',
      '      "parser": "vitest"',
      "    }",
      "  }",
      "}",
      "left out: check:arch, test:slow (to add them: firstlight init lint typecheck test check:arch test:slow)",
      "next: firstlight init --write",
      "",
    ].join("\n"),
  );
  assert.equal(existsSync(file), false);
});

test("init --write writes the picked scripts, run uses them, and a second --write needs --force", async () => {
  const repo = makeRepo({ "package.json": { scripts: SCRIPTS } });
  onTestFinished(() => cleanup(repo));
  const file = path.join(repo.root, "firstlight.json");

  const written = await cli(repo, ["init", "lint", "check:*", "--write", "--json"]);
  assert.equal(written.code, 0, written.stderr);
  assert.deepEqual(JSON.parse(written.stdout), {
    type: "init",
    file,
    written: true,
    existed: false,
    config: { checks: { lint: { run: "npm run lint" }, "check:arch": { run: "npm run check:arch" } } },
    left_out: ["test:slow"],
    next: "firstlight run",
  });
  const run = await cli(repo, ["run", "--json"]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(checkStatuses(run.stdout), { lint: "passed", "check:arch": "passed" });

  const again = await cli(repo, ["init", "--write"]);
  assert.equal(again.code, 1);
  assert.deepEqual(JSON.parse(again.stderr), {
    error: `${file} already exists, and init does not replace it`,
    do: "firstlight init --write --force",
  });
  const dryRun = await cli(repo, ["init"]);
  assert.match(dryRun.stdout, new RegExp(`^would write ${file} \\(it exists; --force replaces it\\):\n`));
  assert.match(dryRun.stdout, /\nnext: firstlight init --write --force\n$/);

  const forced = await cli(repo, ["init", "--write", "--force"]);
  assert.equal(forced.code, 0, forced.stderr);
  assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, "utf8")) as { checks: object }).checks), ["lint", "typecheck", "test"]);
});

test("init refuses what it cannot propose with the error envelope", async () => {
  const repo = makeRepo({ "package.json": { scripts: { build: "true", "check:sql": "true" } } });
  onTestFinished(() => cleanup(repo));
  const envelope = async (args: string[]) => {
    const result = await cli(repo, args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    return JSON.parse(result.stderr) as unknown;
  };

  assert.deepEqual(await envelope(["init"]), {
    error: "package.json has no lint, typecheck, test, archstrict script, so firstlight init has nothing to propose",
    do: "name the scripts to check, like `firstlight init check:sql`",
  });
  assert.deepEqual(await envelope(["init", "nope"]), {
    error: 'no package.json script is named "nope"; the scripts are: build, check:sql',
    do: "pick from: build, check:sql",
  });
  assert.deepEqual(await envelope(["init", "make test"]), {
    error: 'firstlight init picks package.json scripts, and "make test" is a shell command',
    do: 'add it to firstlight.json by hand, like {"checks": {"name": {"run": "make test"}}}',
  });
  assert.deepEqual(await envelope(["init", "--force"]), {
    error: "--force only lets init --write replace a firstlight.json",
    do: "run `firstlight init --write --force`",
  });
  assert.deepEqual(await envelope(["run", "--write"]), { error: "--write belongs to init", do: "run `firstlight init --write`" });

  const none = makeRepo({});
  onTestFinished(() => cleanup(none));
  const missing = await cli(none, ["init"]);
  assert.deepEqual(JSON.parse(missing.stderr), {
    error: `there is no package.json in ${none.root}, and firstlight init proposes checks from its scripts`,
    do: `write ${none.root}/firstlight.json by hand, like {"checks": {"test": {"run": "make test"}}}`,
  });
});
