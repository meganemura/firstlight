// Narrowing a check to the files that changed since it last passed in full:
// which changes allow it, and the command it then runs. A check opts in
// with an `affected` command that holds `{files}`, like
// `vitest related --run {files}`; the tool behind that command decides
// which tests a file reaches. Reading git and the kept runs is tree.ts's
// and the store's. No I/O.

import { shellQuote } from "./names.ts";

export const FILES_PLACEHOLDER = "{files}";
// Past this many files the narrowed command line gets long and the
// narrowing saves little; the full command runs instead.
export const MAX_NARROWED_FILES = 200;

export interface Change {
  status: string;
  path: string;
}

// `git diff --name-status -z --no-renames` prints a status field and a path
// field per change, each ended by NUL. A rename comes out as a deletion and
// an addition.
export function parseNameStatus(output: string): Change[] | null {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return null;
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i]!;
    const file = fields[i + 1]!;
    if (!/^[A-Z][0-9]*$/.test(status) || file.length === 0) return null;
    changes.push({ status, path: file });
  }
  return changes;
}

export type Plan = { files: string[]; command: string } | { full: string };

// Every way out is the full command, never a guess: a deleted file can
// break a test that imports it, yet no tool finds that test from a path
// that no longer exists; a file named by `fullOn` (a lockfile, the test
// runner's config) reaches every test.
export function planNarrowing(affected: string, fullOn: readonly string[], changes: readonly Change[] | null): Plan {
  if (changes === null) return { full: "git could not list the changed files" };
  if (changes.length === 0) return { full: "no file changed" };
  const deleted = changes.find((change) => change.status === "D");
  if (deleted !== undefined) return { full: `${deleted.path} was deleted or renamed` };
  const pinned = changes.find((change) => fullOn.some((pattern) => matchesPath(pattern, change.path)));
  if (pinned !== undefined) return { full: `${pinned.path} is in fullOn` };
  if (changes.length > MAX_NARROWED_FILES) return { full: `${changes.length} files changed, more than ${MAX_NARROWED_FILES}` };
  const files = [...new Set(changes.map((change) => change.path))].sort();
  return { files, command: substituteFiles(affected, files) };
}

export function substituteFiles(affected: string, files: readonly string[]): string {
  return affected.replaceAll(FILES_PLACEHOLDER, files.map(shellQuote).join(" "));
}

// A path glob: "*" stays inside one "/" segment, "**" crosses them, and
// any other character is literal, the same rules as the script patterns
// with "/" in place of ":".
export function matchesPath(pattern: string, file: string): boolean {
  let source = "";
  for (const part of pattern.split(/(\*+)/)) {
    if (part.length === 0) continue;
    if (part.startsWith("*")) source += part.length === 1 ? "[^/]*" : ".*";
    else source += part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su").test(file);
}
