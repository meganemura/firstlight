import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { onTestFinished, test } from "vitest";
import { NODE_FLOOR, nodeVersionError } from "../src/errors.ts";
import { CLI, cleanup, makeRepo } from "./helpers.ts";

test("a Node below the floor is refused with its version, and the floor and above are not", () => {
  hegel.test((tc) => {
    const major = tc.draw(gs.integers({ minValue: 0, maxValue: 99 }));
    const version = `v${major}.${tc.draw(gs.integers({ minValue: 0, maxValue: 30 }))}.${tc.draw(gs.integers({ minValue: 0, maxValue: 9 }))}`;
    const err = nodeVersionError(version);
    if (major >= NODE_FLOOR) {
      assert.equal(err, null);
    } else {
      assert.equal(err?.message, `firstlight needs Node ${NODE_FLOOR} or newer (found ${version})`);
    }
  });
});

test("the CLI refuses an old Node before it reads arguments or starts a run", () => {
  const repo = makeRepo({ "package.json": { scripts: { test: "true" } } });
  onTestFinished(() => cleanup(repo));
  const pretendOld = "data:text/javascript,Object.defineProperty(process,'version',{value:'v20.19.0'})";

  const result = spawnSync(process.execPath, ["--import", pretendOld, CLI, "run"], {
    cwd: repo.root,
    env: { ...process.env, XDG_STATE_HOME: repo.xdg },
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(JSON.parse(result.stderr), {
    error: "firstlight needs Node 24 or newer (found v20.19.0)",
    do: "install Node 24 or newer, then rerun the same command",
  });
  const state = path.join(repo.xdg, "firstlight");
  assert.ok(!existsSync(state) || readdirSync(state).length === 0);
});
