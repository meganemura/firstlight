// Properties of narrowing: the name-status parser reads back what git
// prints, a plan narrows only when every changed path still exists, none is
// pinned by fullOn, and there are few enough; and the narrowed command
// names each changed file once.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { matchesPath, MAX_NARROWED_FILES, parseNameStatus, planNarrowing, type Change } from "../src/affected.ts";

const segment = gs.text({ minSize: 1, maxSize: 6, alphabet: "abcxyz._-" });
const filePath = gs.arrays(segment, { minSize: 1, maxSize: 3 }).map((parts) => parts.join("/"));
const change = gs.tuples(gs.sampledFrom(["A", "M", "D", "T", "R100"]), filePath).map(([status, file]) => ({ status, path: file }));

test("parseNameStatus reads back every change git prints", () => {
  hegel.test(
    (tc) => {
      const changes: Change[] = tc.draw(gs.arrays(change, { maxSize: 8 }));
      const output = changes.map((entry) => `${entry.status}\0${entry.path}\0`).join("");
      assert.deepEqual(parseNameStatus(output), changes);
    },
    { testCases: 200 },
  );
});

test("a plan narrows only with no deletion, no fullOn match, and few enough files, and names each file once", () => {
  hegel.test(
    (tc) => {
      const changes: Change[] = tc.draw(gs.arrays(change, { maxSize: 8 }));
      const fullOn: string[] = tc.draw(gs.arrays(gs.sampledFrom(["*.lock", "**/config.*", "a/*", "zz"]), { maxSize: 2 }));
      const plan = planNarrowing("run {files} done", fullOn, changes);
      const narrowable =
        changes.length > 0 &&
        changes.length <= MAX_NARROWED_FILES &&
        changes.every((entry) => entry.status !== "D" && !fullOn.some((glob) => matchesPath(glob, entry.path)));
      assert.equal("files" in plan, narrowable);
      if (!("files" in plan)) return;
      const unique = [...new Set(changes.map((entry) => entry.path))];
      assert.deepEqual([...plan.files].sort(), unique.sort());
      assert.ok(plan.command.startsWith("run ") && plan.command.endsWith(" done"));
      for (const file of unique) assert.ok(plan.command.includes(file), file);
    },
    { testCases: 300 },
  );
});

test("a path glob's * stays in one segment and ** crosses segments", () => {
  hegel.test(
    (tc) => {
      const parts: string[] = tc.draw(gs.arrays(segment, { minSize: 2, maxSize: 4 }));
      const file = parts.join("/");
      assert.ok(matchesPath("**", file));
      assert.equal(matchesPath("*", file), false);
      assert.ok(matchesPath(`${parts[0]}/**`, file));
      assert.ok(matchesPath(`**/${parts.at(-1)}`, file));
      assert.ok(matchesPath(file, file));
    },
    { testCases: 200 },
  );
});

test("a failed git listing or no change runs the full command", () => {
  assert.deepEqual(planNarrowing("x {files}", [], null), { full: "git could not list the changed files" });
  assert.deepEqual(planNarrowing("x {files}", [], []), { full: "no file changed" });
  assert.equal(parseNameStatus("M\0"), null);
});

test("parseNameStatus refuses a field that is not git's", () => {
  assert.deepEqual(parseNameStatus("M\0a"), [{ status: "M", path: "a" }]);
  for (const output of ["m\0a\0", "xM\0a\0", "M1x\0a\0", "M\0\0"]) assert.equal(parseNameStatus(output), null, output);
});

test("each way to the full command names its reason, and the narrowed files are sorted", () => {
  const many = Array.from({ length: MAX_NARROWED_FILES }, (_, index) => ({ status: "M", path: `f${index}` }));
  assert.deepEqual(planNarrowing("x {files}", [], [{ status: "M", path: "a" }, { status: "D", path: "b" }]), { full: "b was deleted or renamed" });
  assert.deepEqual(planNarrowing("x {files}", ["*.lock"], [{ status: "M", path: "a" }, { status: "M", path: "npm.lock" }]), { full: "npm.lock is in fullOn" });
  assert.deepEqual(planNarrowing("x {files}", [], [...many, { status: "M", path: "z" }]), { full: `${MAX_NARROWED_FILES + 1} files changed, more than ${MAX_NARROWED_FILES}` });
  assert.ok("files" in planNarrowing("x {files}", [], many));
  assert.deepEqual(planNarrowing("x {files}", [], [{ status: "M", path: "b" }, { status: "A", path: "a" }]), { files: ["a", "b"], command: "x a b" });
});

test("a path glob treats every other character as literal", () => {
  assert.equal(matchesPath("zz", "a"), false);
  assert.equal(matchesPath("a.b", "axb"), false);
  assert.equal(matchesPath("*.ts", "d/x.ts"), false);
  assert.equal(matchesPath("a*", "ab/c"), false);
  assert.ok(matchesPath("*.ts", "x.ts"));
  assert.ok(matchesPath("**", "a\nb"));
});
