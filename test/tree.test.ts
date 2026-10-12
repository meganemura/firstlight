import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { treeKey } from "../src/tree.ts";

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function committedRepo(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-tree-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  writeFileSync(path.join(root, ".gitignore"), "ignored/\n*.log\n");
  writeFileSync(path.join(root, "a.txt"), "a\n");
  writeFileSync(path.join(root, "b.txt"), "b\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "init"]);
  return root;
}

test("an unchanged tree gives the same key, and an ignored file does not change it", () => {
  const root = committedRepo();
  const key = treeKey(root);
  assert.match(key ?? "", /^[0-9a-f]{40,64}$/);
  assert.equal(treeKey(root), key);
  mkdirSync(path.join(root, "ignored"));
  writeFileSync(path.join(root, "ignored", "x.txt"), "x\n");
  writeFileSync(path.join(root, "run.log"), "noise\n");
  assert.equal(treeKey(root), key);
});

test("editing a tracked file, adding an untracked file, or deleting a file changes the key", () => {
  const root = committedRepo();
  const clean = treeKey(root);

  writeFileSync(path.join(root, "a.txt"), "a changed\n");
  const edited = treeKey(root);
  assert.notEqual(edited, clean);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  assert.equal(treeKey(root), clean);

  writeFileSync(path.join(root, "new.txt"), "new\n");
  const added = treeKey(root);
  assert.notEqual(added, clean);
  unlinkSync(path.join(root, "new.txt"));

  unlinkSync(path.join(root, "b.txt"));
  const deleted = treeKey(root);
  assert.notEqual(deleted, clean);
  assert.equal(new Set([clean, edited, added, deleted]).size, 4);
});

test("computing the key leaves the user's index and staged changes as they were", () => {
  const root = committedRepo();
  writeFileSync(path.join(root, "a.txt"), "staged\n");
  git(root, ["add", "a.txt"]);
  writeFileSync(path.join(root, "a.txt"), "staged, then edited\n");
  writeFileSync(path.join(root, "untracked.txt"), "u\n");
  const indexFile = path.join(root, ".git", "index");
  const indexBefore = readFileSync(indexFile);
  const cachedBefore = git(root, ["diff", "--cached", "--name-status"]);
  const statusBefore = git(root, ["status", "--porcelain"]);

  assert.notEqual(treeKey(root), null);

  assert.equal(git(root, ["diff", "--cached", "--name-status"]), cachedBefore);
  assert.equal(git(root, ["status", "--porcelain"]), statusBefore);
  assert.deepEqual(readFileSync(indexFile), indexBefore);
  assert.equal(git(root, ["diff", "--cached", "--name-status"]), "M\ta.txt\n");
});

test("a repository with no commit and no index still has a key", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-tree-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  writeFileSync(path.join(root, "a.txt"), "a\n");
  assert.match(treeKey(root) ?? "", /^[0-9a-f]{40,64}$/);
});

test("a directory outside git, or a subdirectory of a repository, has no key", () => {
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-tree-")));
  onTestFinished(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(treeKey(plain), null);
  const root = committedRepo();
  mkdirSync(path.join(root, "sub"));
  assert.equal(treeKey(path.join(root, "sub")), null);
});
