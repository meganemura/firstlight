// The tree key: the git tree hash of the working tree as it is on disk,
// untracked files included and ignored files left out. It is the part of a
// cache key that stands for the files a check reads. It runs git against a
// temporary index of its own; the user's index and refs stay as they were.
// Blobs for changed files land in the object store as loose objects, which
// git's own gc prunes like any other unreferenced object.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 60_000;

// Not a git repository, no git, or any git failure gives null: without a
// key nothing is reused, which is never wrong, only slower.
export function treeKey(root: string): string | null {
  const base = { ...process.env };
  delete base.GIT_DIR;
  delete base.GIT_WORK_TREE;
  delete base.GIT_INDEX_FILE;
  const git = (args: string[], env: NodeJS.ProcessEnv = base): string =>
    execFileSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();

  let realIndex: string;
  try {
    // A directory inside some other repository is not that repository's root.
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(root)) return null;
    realIndex = path.resolve(root, git(["rev-parse", "--git-path", "index"]));
  } catch {
    return null;
  }

  const dir = mkdtempSync(path.join(tmpdir(), "firstlight-index-"));
  const index = path.join(dir, "index");
  const env = { ...base, GIT_INDEX_FILE: index };
  try {
    // A copy of the real index carries its stat data, so `git add` hashes
    // only the files that changed. A copy git cannot use (a split index,
    // say) falls back to an empty index, which only costs time.
    for (const seed of [true, false]) {
      rmSync(index, { force: true });
      try {
        if (seed) copyFileSync(realIndex, index);
        git(["add", "-A"], env);
        return git(["write-tree"], env);
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The changes between two tree keys, as `git diff --name-status -z` prints
// them, or null when git cannot say: a tree written long ago may be gone
// after `git gc`, and then the caller runs the full check.
export function changedPaths(root: string, from: string, to: string): string | null {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  try {
    return execFileSync("git", ["diff", "--name-status", "-z", "--no-renames", from, to], {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
