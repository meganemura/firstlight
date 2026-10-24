// Uniform diagnostics from the log of a failed check: which parser reads a
// check's output (named in firstlight.json, or inferred from its command),
// and the parsers themselves, for tsc, vitest, node:test, and archstrict.
// Each parser reads the text the tool prints by default, because the user's
// command decides the output format and text is what the log holds. This
// module does no I/O: the caller reads the log and package.json.
//
// A parser never throws and never guesses: a line it does not recognize is
// skipped, and a log with nothing it recognizes gives no diagnostics, so the
// caller falls back to the plain log tail. A vitest diagnostic also gets the
// evidence file and rerun command depug printed for its test, when exactly
// one of each side names that test.

export const PARSERS = ["tsc", "vitest", "node-test", "archstrict"] as const;
export type ParserName = (typeof PARSERS)[number];
// "none" in firstlight.json turns inference off for one check.
export const PARSER_CHOICES: readonly string[] = [...PARSERS, "none"];

export interface Diagnostic {
  file: string;
  line: number | null;
  col: number | null;
  rule: string | null;
  message: string;
  // The evidence file depug printed for a vitest test it matched.
  evidence?: string;
  // The command that runs only this test: depug's when it matched one,
  // otherwise the test recorder's.
  rerun?: string;
}

const MESSAGE_MAX = 300;

export function isParserName(value: unknown): value is ParserName {
  return typeof value === "string" && (PARSERS as readonly string[]).includes(value);
}

export function parseDiagnostics(parser: ParserName, log: string, root: string): Diagnostic[] {
  const lines = toLines(log);
  switch (parser) {
    case "tsc":
      return parseTsc(lines);
    case "vitest":
      return attachDepug(parseVitest(lines, root), depugFailures(lines));
    case "node-test":
      return lines.some((line) => /^TAP version \d+$/.test(line)) ? parseNodeTestTap(lines, root) : parseNodeTestSpec(lines, root);
    case "archstrict":
      return parseArchstrict(lines, root);
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  let where = diagnostic.file;
  if (diagnostic.line !== null) {
    where += `:${diagnostic.line}`;
    if (diagnostic.col !== null) where += `:${diagnostic.col}`;
  }
  return [where, diagnostic.rule, diagnostic.message].filter((part) => part !== null && part !== "").join(" ");
}

// A check reads its log through one parser, or through several in order.
export type ParserChoice = ParserName | ParserName[];

export function isParserChoice(value: unknown): value is ParserChoice {
  return isParserName(value) || (Array.isArray(value) && value.length > 0 && value.every(isParserName));
}

export function parserList(choice: ParserChoice): ParserName[] {
  return typeof choice === "string" ? [choice] : choice;
}

// The command is read only when it is simple commands joined by `&&`: a
// pipe, `;`, `||`, or a substitution could run any tool, and a wrong parser
// is worse than none. An `&&` list runs its commands in order and each
// parser skips the lines it does not recognize, so every command's parser
// reads the one log. `npm run <script>` and `npm test` look up the script's
// own command one level deep; that command is not followed further.
export function inferParser(command: string, scriptOf: (name: string) => string | null): ParserChoice | null {
  const segments = command.split("&&");
  const found: ParserName[] = [];
  for (const segment of segments) {
    if (segment.trim().length === 0) return null;
    const words = simpleWords(segment);
    if (words === null) return null;
    for (const parser of parserList(inferSimple(words, scriptOf) ?? [])) {
      if (!found.includes(parser)) found.push(parser);
    }
  }
  if (found.length === 0) return null;
  return found.length === 1 ? found[0]! : found;
}

function inferSimple(words: string[], scriptOf: (name: string) => string | null): ParserChoice | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1;
  if (words[i] === "npx") {
    i += 1;
    while (i < words.length && words[i]!.startsWith("-")) i += 1;
  } else if (words[i] === "pnpm" && words[i + 1] === "exec") {
    i += 2;
  }
  const program = words[i]?.split("/").at(-1);
  const args = words.slice(i + 1);
  switch (program) {
    case "tsc":
    case "vitest":
    case "archstrict":
      return program;
    case "node":
      return nodeRunsTests(args) ? "node-test" : null;
    case "npm": {
      const script = npmScript(args);
      if (script === null) return null;
      const scriptCommand = scriptOf(script);
      if (scriptCommand === null) return null;
      return inferParser(scriptCommand, () => null);
    }
    default:
      return null;
  }
}

function simpleWords(command: string): string[] | null {
  if (/[;&|`<>\n]|\$\(/.test(command)) return null;
  const words: string[] = [];
  for (const raw of command.trim().split(/\s+/)) {
    if (raw.length === 0) continue;
    const quoted = /^'([^']*)'$/.exec(raw) ?? /^"([^"]*)"$/.exec(raw);
    words.push(quoted === null ? raw : quoted[1]!);
  }
  return words;
}

const NODE_VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file"]);

// `--test` counts only before the script: after it, it is the script's own.
function nodeRunsTests(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--test") return true;
    if (!arg.startsWith("-") && !NODE_VALUE_FLAGS.has(args[i - 1] ?? "")) return false;
  }
  return false;
}

function npmScript(args: string[]): string | null {
  const rest = args.filter((arg) => !arg.startsWith("-") || arg === "--");
  const [verb, name] = rest;
  if (verb === "test" || verb === "t" || verb === "tst") return "test";
  if ((verb === "run" || verb === "run-script" || verb === "rum" || verb === "urn") && name !== undefined && name !== "--") return name;
  return null;
}

function toLines(log: string): string[] {
  return log.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split(/\r\n|\n|\r/);
}

function positive(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= MESSAGE_MAX ? flat : `${flat.slice(0, MESSAGE_MAX - 3)}...`;
}

// The first line of an error, joined with the next ones while it ends in
// ":", because assert's "Expected values to be strictly equal:" says
// nothing until the "7 !== 6" that follows it.
function headline(lines: readonly string[]): string {
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  let message = kept[0] ?? "";
  for (let i = 1; i < kept.length && message.endsWith(":") && message.length < MESSAGE_MAX; i += 1) {
    message += ` ${kept[i]}`;
  }
  return clip(message);
}

// A stack path relative to the root, or null when it is outside the
// project: a dependency, a Node internal, or another directory.
function projectPath(raw: string, root: string): string | null {
  let file = raw;
  if (file.startsWith("file://")) {
    try {
      file = decodeURIComponent(file.slice("file://".length));
    } catch {
      return null;
    }
  }
  if (file.startsWith("node:") || file.includes("node_modules/") || file.length === 0) return null;
  if (!file.startsWith("/")) return file;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return file.startsWith(prefix) && file.length > prefix.length ? file.slice(prefix.length) : null;
}

function displayPath(raw: string, root: string): string {
  return projectPath(raw, root) ?? raw;
}

// tsc --pretty false: `src/a.ts(3,7): error TS2322: message`. --pretty:
// `src/a.ts:3:7 - error TS2322: message` once the colors are gone. The
// indented lines after either are elaboration and are left to the log.
function parseTsc(lines: readonly string[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of lines) {
    const plain = /^(\S.*?)\((\d+),(\d+)\): (?:error|warning) (TS\d+): (.*)$/.exec(line);
    const pretty = plain === null ? /^(\S.*?):(\d+):(\d+) - (?:error|warning) (TS\d+): (.*)$/.exec(line) : null;
    const match = plain ?? pretty;
    if (match === null) continue;
    out.push({ file: match[1]!, line: positive(match[2]), col: positive(match[3]), rule: match[4]!, message: clip(match[5]!) });
  }
  return out;
}

const VITEST_FRAME = /^\s*❯ (?:(.+) )?(\S+?):(\d+):(\d+)$/;

// A vitest failure keeps the test file and full name of its header, which
// the diagnostic's own file (the first project frame) can differ from.
interface VitestFailure {
  diagnostic: Diagnostic;
  testFile: string;
  name: string | null;
}

// vitest's default reporter: a ` FAIL  file > suite > test` header (or
// ` FAIL  file [ file ]` for a file that failed to load), the error, then
// `❯ [fn] file:line:col` frames, each followed by a code frame.
function parseVitest(lines: readonly string[], root: string): VitestFailure[] {
  const out: VitestFailure[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^ FAIL {2}(\S+?)(?: > (.+)| \[ .+ \])$/.exec(lines[i]!);
    if (header === null) continue;
    const testFile = header[1]!;
    const message: string[] = [];
    let frame: { file: string; line: number | null; col: number | null } | null = null;
    let j = i + 1;
    let inError = true;
    for (; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (/^ FAIL {2}/.test(line) || /^⎯{3,}/.test(line)) break;
      const found = VITEST_FRAME.exec(line);
      if (found !== null) {
        inError = false;
        const file: string | null = frame === null ? projectPath(found[2]!, root) : null;
        if (file !== null) frame = { file, line: positive(found[3]), col: positive(found[4]) };
        continue;
      }
      if (inError) message.push(line);
    }
    const diagnostic: Diagnostic = {
      file: frame?.file ?? testFile,
      line: frame?.line ?? null,
      col: frame?.col ?? null,
      rule: header[2] ?? null,
      message: headline(message),
    };
    out.push({ diagnostic, testFile, name: header[2] ?? null });
    i = j - 1;
  }
  return out;
}

interface DepugFailure {
  testFile: string;
  // The suite and test names joined by a space, as vitest's -t matches them.
  name: string;
  evidence: string;
  rerun: string;
}

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const DEPUG_TARGET = new RegExp(`(?:^|\\s)vitest run (${JSON_STRING}) -t (${JSON_STRING})(?:\\s|$)`);
const REGEX_METACHARACTER = /[.*+?^${}()|[\]\\]/g;

// depug's vitest reporter prints `depug evidence: <absolute path> (<note>)`
// and, on the next line, `depug rerun: <command>`. The command is the only
// place that names the test: `vitest run "<file>" -t "<pattern>"`, both
// JSON strings, where the pattern is the names joined by a space, with
// regex metacharacters escaped, between `^` and `$`. A pattern that does
// not escape back to itself is not depug's, so it names nothing.
function depugFailures(lines: readonly string[]): DepugFailure[] {
  const out: DepugFailure[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const evidence = /^depug evidence: ((?:\/|[A-Za-z]:[\\/]).*?)(?: \([^()]*\))?$/.exec(lines[i]!);
    if (evidence === null) continue;
    const rerun = /^depug rerun: (\S.*)$/.exec(lines[i + 1]!);
    if (rerun === null) continue;
    i += 1;
    const target = DEPUG_TARGET.exec(rerun[1]!);
    if (target === null) continue;
    let testFile: unknown;
    let pattern: unknown;
    try {
      testFile = JSON.parse(target[1]!);
      pattern = JSON.parse(target[2]!);
    } catch {
      continue;
    }
    if (typeof testFile !== "string" || typeof pattern !== "string") continue;
    const anchored = /^\^(.*)\$$/s.exec(pattern);
    if (anchored === null) continue;
    const name = anchored[1]!.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
    if (name.replace(REGEX_METACHARACTER, "\\$&") !== anchored[1]) continue;
    out.push({ testFile, name, evidence: evidence[1]!, rerun: rerun[1]! });
  }
  return out;
}

// A test recorder's failed vitest tests get depug's evidence the same way
// the vitest parser's failures do, and depug's rerun, which keeps the seed,
// in place of the recorder's.
export function attachDepugToTests(tests: readonly Diagnostic[], log: string): Diagnostic[] {
  const failures = tests.map((diagnostic) => ({ diagnostic, testFile: diagnostic.file, name: diagnostic.rule }));
  return attachDepug(failures, depugFailures(toLines(log)));
}

// vitest's header joins the names with " > " and depug's pattern with a
// space, so two tests can share a key ("a > b c" and "a b > c"), and a name
// that itself holds " > " reads back as two names. The key names one test
// only when exactly one diagnostic and one depug failure carry it.
function attachDepug(failures: readonly VitestFailure[], depug: readonly DepugFailure[]): Diagnostic[] {
  const keyOf = (testFile: string, name: string): string => JSON.stringify([testFile, name]);
  const counts = new Map<string, number>();
  for (const failure of failures) {
    if (failure.name === null) continue;
    const key = keyOf(failure.testFile, failure.name.split(" > ").join(" "));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const byKey = new Map<string, DepugFailure[]>();
  for (const entry of depug) {
    const key = keyOf(entry.testFile, entry.name);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return failures.map((failure) => {
    if (failure.name === null) return failure.diagnostic;
    const key = keyOf(failure.testFile, failure.name.split(" > ").join(" "));
    const matches = byKey.get(key) ?? [];
    if (counts.get(key) !== 1 || matches.length !== 1) return failure.diagnostic;
    return { ...failure.diagnostic, evidence: matches[0]!.evidence, rerun: matches[0]!.rerun };
  });
}

const STACK_FRAME = /^\s*at (?:.*? \()?(\S+?):(\d+):(\d+)\)?$/;

function firstProjectFrame(lines: readonly string[], root: string): { file: string; line: number | null; col: number | null } | null {
  for (const line of lines) {
    const found = STACK_FRAME.exec(line);
    if (found === null) continue;
    const file = projectPath(found[1]!, root);
    if (file !== null) return { file, line: positive(found[2]), col: positive(found[3]) };
  }
  return null;
}

function locationOf(text: string | undefined, root: string): { file: string; line: number | null; col: number | null } | null {
  if (text === undefined) return null;
  const found = /^(.+?):(\d+):(\d+)$/.exec(text.trim());
  if (found === null) return text.trim().length === 0 ? null : { file: displayPath(text.trim(), root), line: null, col: null };
  return { file: displayPath(found[1]!, root), line: positive(found[2]), col: positive(found[3]) };
}

// node --test with the spec reporter: after `✖ failing tests:`, each
// failure is an optional `test at file:line:col`, `✖ name (time)`, and the
// indented error with its `at` stack.
function parseNodeTestSpec(lines: readonly string[], root: string): Diagnostic[] {
  const start = lines.findIndex((line) => /^✖ failing tests:$/.test(line));
  if (start === -1) return [];
  const fullNames = specFailures(lines.slice(0, start));
  const out: Diagnostic[] = [];
  let location: string | undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const at = /^test at (.+)$/.exec(line);
    if (at !== null) {
      location = at[1];
      continue;
    }
    const failed = /^✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (failed === null) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && (lines[j]!.startsWith(" ") || lines[j]!.length === 0); j += 1) body.push(lines[j]!);
    const frameStart = body.findIndex((entry) => STACK_FRAME.test(entry));
    const message = headline(frameStart === -1 ? body : body.slice(0, frameStart));
    const where = firstProjectFrame(body, root) ?? locationOf(location, root);
    out.push({
      file: where?.file ?? "",
      line: where?.line ?? null,
      col: where?.col ?? null,
      rule: takeFullName(fullNames, failed[1]!),
      message: message.replace(/^'(.*)'$/, "$1"),
    });
    location = undefined;
    i = j - 1;
  }
  return out.filter((diagnostic) => diagnostic.file.length > 0);
}

// The failing section names a test by its own name only, so the tree above
// it, two spaces per suite, gives the full name. A suite opens with `▶ name`
// and closes with a `✖ name` line at the same depth.
function specFailures(lines: readonly string[]): string[] {
  const suites: string[] = [];
  const failures: string[] = [];
  for (const line of lines) {
    const entry = /^((?: {2})*)([▶✖]) (.+?)(?: \([\d.]+m?s\))?$/.exec(line);
    if (entry === null) continue;
    const depth = entry[1]!.length / 2;
    if (entry[2] === "▶") {
      suites.length = depth;
      suites[depth] = entry[3]!;
    } else if (suites.length === depth + 1 && suites[depth] === entry[3]) {
      suites.length = depth;
    } else {
      failures.push([...suites.slice(0, depth), entry[3]!].join(" > "));
    }
  }
  return failures;
}

function takeFullName(fullNames: string[], name: string): string {
  const index = fullNames.findIndex((full) => full === name || full.endsWith(` > ${name}`));
  if (index === -1) return name;
  return fullNames.splice(index, 1)[0]!;
}

// node --test --test-reporter=tap: `# Subtest: name` lines nest by four
// spaces, and each `not ok` carries a YAML block. A suite that failed only
// because a subtest did (`subtestsFailed`) adds nothing of its own.
function parseNodeTestTap(lines: readonly string[], root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const subtest = /^((?: {4})*)# Subtest: (.*)$/.exec(line);
    if (subtest !== null) {
      const depth = subtest[1]!.length / 4;
      names.length = depth;
      names[depth] = subtest[2]!;
      continue;
    }
    const failed = /^((?: {4})*)not ok \d+ - (.*?)(?: # .*)?$/.exec(line);
    if (failed === null) continue;
    const indent = failed[1]!;
    const depth = indent.length / 4;
    const fields = new Map<string, string[]>();
    let j = i + 1;
    if (lines[j] === `${indent}  ---`) {
      let key: string | null = null;
      for (j += 1; j < lines.length && lines[j] !== `${indent}  ...`; j += 1) {
        const entry = lines[j]!;
        const field = entry.startsWith(`${indent}  `) ? /^([A-Za-z_]+):(?: (.*))?$/.exec(entry.slice(indent.length + 2)) : null;
        if (field !== null) {
          key = field[1]!;
          const value = field[2] ?? "";
          fields.set(key, value === "|-" || value === "|" || value === ">-" ? [] : [unquote(value)]);
        } else if (key !== null) {
          fields.get(key)!.push(entry.slice(indent.length + 4));
        }
      }
    }
    i = j;
    if (fields.get("failureType")?.[0] === "subtestsFailed") continue;
    const name = [...names.slice(0, depth), failed[2]!].join(" > ");
    const kind = fields.get("name")?.[0];
    const error = headline(fields.get("error") ?? []);
    const where = firstProjectFrame((fields.get("stack") ?? []).map((frame) => `at ${frame}`), root) ?? locationOf(fields.get("location")?.[0], root);
    if (where === null) continue;
    out.push({
      file: where.file,
      line: where.line,
      col: where.col,
      rule: name,
      message: clip(kind === undefined || kind.length === 0 ? error : `${kind}: ${error}`),
    });
  }
  return out;
}

function unquote(value: string): string {
  const quoted = /^'(.*)'$/.exec(value);
  return quoted === null ? value : quoted[1]!.replace(/''/g, "'");
}

// archstrict check: `[rule] /abs/path:line:col`, then the indented
// evidence (after an optional `frozen: true`), `because:`, and `do:`. The
// grouped form past 20 violations prints the same block for each example.
function parseArchstrict(lines: readonly string[], root: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^\[([a-z][a-z0-9-]*)\] (.+?):(\d+):(\d+)$/.exec(lines[i]!);
    if (head === null) continue;
    let evidence = "";
    for (let j = i + 1; j < lines.length && lines[j]!.startsWith("  "); j += 1) {
      const entry = lines[j]!.trim();
      if (entry === "frozen: true") continue;
      evidence = entry.replace(/^evidence: /, "");
      break;
    }
    out.push({ file: displayPath(head[2]!, root), line: positive(head[3]), col: positive(head[4]), rule: head[1]!, message: clip(evidence) });
  }
  return out;
}
