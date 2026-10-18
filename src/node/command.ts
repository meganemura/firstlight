// The `firstlight-node` command: its arguments, the selector input it reads
// on stdin, the map of the base run's recording (built from the raw
// coverage the first time a selection reads it), the base text and the
// hunks of each changed file some test loaded, from git, and the answer it
// prints. What the answer is, is select.ts's; what a recording says, map.ts's.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROTOCOL_VERSION, type Change, type SelectorAnswer } from "../selection.ts";
import { field, parseJson } from "./json.ts";
import { buildMap, MAP_FILE, parseCoverage, parseMap, parseTestFile, RAW_DIR, TEST_MARKER, type CoverageMap, type RawRecord } from "./map.ts";
import { editsNeeded, parseHunks, selectTests, type Edit, type SelectOptions } from "./select.ts";

const GIT_TIMEOUT_MS = 30_000;

export const HELP = `firstlight-node: choose the test files a change reaches, for firstlight.

Usage:
  firstlight-node select [--always <glob>]... [--ignore <glob>]...
  firstlight-node --help

select   A firstlight selector for vitest. It reads firstlight's selector
         input on stdin and prints the test files that ran the changed
         code during the base run, as {"tests":[{"id":"test/a.test.ts",
         "reason":"..."}]}, or {"full":"<reason>"}.
         The base run records through the setup file
         firstlight/node/vitest-setup, which needs
         test.experimental.viteModuleRunner: false and isolate: true (the
         default) in the vitest config.

         A changed test file selects itself. A changed source file selects
         the tests that ran a function whose body changed, or every test
         that loaded it when the change is outside every function body or
         the file was deleted. A source file no test loaded selects
         nothing. Any other file asks for the full run, because a test may
         read it at run time.

         --always <glob>   Select every recorded test file that matches,
                           such as a test of built output.
         --ignore <glob>   Leave out every changed file that matches.

         In firstlight.json:
           "select": "firstlight-node select --ignore '**/*.md'",
           "runSelected": "vitest run --passWithNoTests {tests}"
`;

export interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

interface Input {
  tree: string;
  base: { tree: string; record: string | null };
  changes: Change[];
}

export async function main(args: readonly string[], stdin: () => Promise<string>, root: string): Promise<Outcome> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { code: 0, stdout: HELP, stderr: "" };
  const options = parseArgs(args);
  if (typeof options === "string") return { code: 2, stdout: "", stderr: `firstlight-node: ${options}\n\n${HELP}` };
  const input = parseInput(await stdin());
  if (typeof input === "string") return { code: 2, stdout: "", stderr: `firstlight-node: ${input}\n` };
  return { code: 0, stdout: `${JSON.stringify(select(input, options, root))}\n`, stderr: "" };
}

function select(input: Input, options: SelectOptions, root: string): SelectorAnswer {
  if (input.base.record === null) return { full: "no recording in the base run" };
  const map = loadMap(input.base.record, root);
  if ("full" in map) return map;
  const edits = new Map(editsNeeded(map, input.changes, options).map((file) => [file, readEdit(root, input.base.tree, input.tree, file)] as const));
  return selectTests(map, input.changes, edits, options);
}

function parseArgs(args: readonly string[]): SelectOptions | string {
  if (args[0] !== "select") return args.length === 0 ? "name a command" : `unknown command ${JSON.stringify(args[0])}`;
  const options = { always: [] as string[], ignore: [] as string[] };
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (flag !== "--always" && flag !== "--ignore") return `unknown option ${JSON.stringify(flag)}`;
    if (value === undefined) return `${flag} needs a glob`;
    options[flag === "--always" ? "always" : "ignore"].push(value);
  }
  return options;
}

// firstlight writes this object; anything else on stdin is a caller that
// does not speak the protocol, and the command says so instead of guessing.
function parseInput(stdin: string): Input | string {
  const raw = parseJson(stdin);
  if (raw === undefined) return "stdin is not one JSON object";
  if (field(raw, "version") !== PROTOCOL_VERSION) return `stdin is not selector input of protocol version ${PROTOCOL_VERSION}`;
  const tree = field(raw, "tree");
  const base = field(raw, "base");
  const baseTree = field(base, "tree");
  const record = field(base, "record");
  if (typeof tree !== "string" || typeof baseTree !== "string" || (record !== null && typeof record !== "string")) {
    return "stdin lacks tree, base.tree, or base.record";
  }
  const changes = field(raw, "changes");
  if (!Array.isArray(changes) || !changes.every((change) => typeof field(change, "status") === "string" && typeof field(change, "path") === "string")) {
    return "stdin lacks a changes list of {status, path}";
  }
  return { tree, base: { tree: baseTree, record }, changes };
}

// The map is written once, and then the raw coverage goes: it is a hundred
// times larger, and the map is all that a later selection reads.
export function loadMap(record: string, root: string): CoverageMap | { full: string } {
  const mapFile = path.join(record, MAP_FILE);
  const written = existsSync(mapFile) ? parseMap(readFileSync(mapFile, "utf8")) : null;
  if (written !== null) return written;
  const raw = path.join(record, RAW_DIR);
  const records = readRaw(raw, root);
  if (records.length === 0) {
    return { full: existsSync(mapFile) ? "the base run's map was written by another version of firstlight-node" : "no recording in the base run" };
  }
  const map = buildMap(records, root);
  if ("full" in map) return map;
  const partial = `${mapFile}.${process.pid}`;
  writeFileSync(partial, JSON.stringify(map));
  renameSync(partial, mapFile);
  rmSync(raw, { recursive: true, force: true });
  return map;
}

function readRaw(raw: string, root: string): RawRecord[] {
  if (!existsSync(raw)) return [];
  const records: RawRecord[] = [];
  for (const name of readdirSync(raw)) {
    const dir = path.join(raw, name);
    const marker = path.join(dir, TEST_MARKER);
    const test = existsSync(marker) ? parseTestFile(readFileSync(marker, "utf8")) : null;
    if (test === null) continue;
    // The marker has no coverage result, so reading it as coverage adds nothing.
    const scripts = readdirSync(dir).flatMap((file) => parseCoverage(readFileSync(path.join(dir, file), "utf8"), root));
    records.push({ ...test, scripts });
  }
  return records;
}

// The current side is firstlight's tree key, which holds untracked files
// too, so a new file diffs like a tracked one and the hunks describe the
// same tree the change list came from.
function readEdit(root: string, from: string, to: string, file: string): Edit | undefined {
  try {
    const base = git(root, ["cat-file", "blob", `${from}:${file}`]);
    // One path is diffed, so no rename can pair it with another.
    const diff = git(root, ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", from, to, "--", file]);
    return { base, hunks: parseHunks(diff) };
  } catch {
    // Git could not show the base text or the diff, and select.ts counts
    // the whole file as changed.
  }
}

// A GIT_DIR inherited from a git hook would point git at another
// repository. Reading trees needs neither a work tree nor an index, so the
// other variables of a hook's environment change nothing here.
function git(root: string, args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["--literal-pathspecs", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
}
