// Which checks a repository has: firstlight.json, or the package.json
// fallback, validated into CheckSpec values before anything runs. Also owns
// the `after` graph (unknown names, cycles, the transitive selection) and
// what each argument of `firstlight run <arg>...` stands for: a configured
// check, a package.json script or glob, or a shell command, and which
// checks `run --failed` runs again. It reads files and never starts a
// process.

import { readFileSync } from "node:fs";
import path from "node:path";
import { FILES_PLACEHOLDER } from "./affected.ts";
import type { CheckSpec, ReportedStatus } from "./checks.ts";
import { inferParser, isParserChoice, PARSER_CHOICES, PARSERS } from "./diagnostics.ts";
import { AgentError, messageOf } from "./errors.ts";
import { expandPattern, isPattern, shellQuote } from "./names.ts";

export const CONFIG_FILE = "firstlight.json";
export const DEFAULT_TIMEOUT_SEC = 600;
export const FALLBACK_SCRIPTS = ["lint", "typecheck", "test", "archstrict"] as const;
// Script names that look like a check by their first ":" segment. The
// fallback does not run them: a name like test:mutation or check can take
// hours or chain the others, so a guess would duplicate or stall work. They
// are only named, so the reader can pick.
const CHECK_LIKE = new Set(["lint", "typecheck", "test", "check", "archstrict"]);

// A configured name is one plain word, never whitespace or "*", so an
// argument of `firstlight run` that names it cannot also read as a shell
// command or a script glob. ":" is allowed so a check can keep the name of
// the script it runs, like check:architecture.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CHECK_KEYS = new Set(["run", "after", "timeoutSec", "parser", "affected", "fullOn"]);

export interface Config {
  source: "firstlight.json" | "package.json";
  checks: CheckSpec[];
  // The check-like package.json scripts the fallback left out, in
  // package.json order; empty when firstlight.json decides the checks.
  notRun: string[];
}

export function loadConfig(root: string): Config {
  const configPath = path.join(root, CONFIG_FILE);
  const text = readOptional(configPath);
  if (text !== null) {
    return { source: "firstlight.json", checks: parseConfig(text, configPath), notRun: [] };
  }
  const scripts = readScripts(path.join(root, "package.json")) ?? [];
  const checks = FALLBACK_SCRIPTS.filter((name) => scripts.includes(name)).map(scriptCheck);
  const notRun = checkLikeScripts(scripts);
  if (checks.length > 0) return { source: "package.json", checks, notRun };
  const named = notRun.length === 0 ? "" : ` (scripts that look like checks: ${notRun.join(", ")})`;
  throw new AgentError(
    `no checks found in ${root}: there is no ${CONFIG_FILE} and package.json has no ${FALLBACK_SCRIPTS.join(", ")} script${named}`,
    notRun.length === 0
      ? `create ${configPath} like {"checks": {"test": {"run": "npm test"}}}, then run \`firstlight run\``
      : `run \`firstlight run ${notRun.map(shellQuote).join(" ")}\`, or write ${configPath} with \`firstlight init ${notRun.map(shellQuote).join(" ")} --write\``,
  );
}

export function checkLikeScripts(scripts: readonly string[]): string[] {
  const fallback: readonly string[] = FALLBACK_SCRIPTS;
  return scripts.filter((name) => !fallback.includes(name) && CHECK_LIKE.has(name.split(":")[0]!));
}

export function parseConfig(text: string, file: string): CheckSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw invalid(file, `it is not valid JSON (${messageOf(err)})`);
  }
  if (!isRecord(raw)) throw invalid(file, "the top level must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "checks") throw invalid(file, `unknown top-level key "${key}"; only "checks" is allowed`);
  }
  if (!isRecord(raw.checks) || Object.keys(raw.checks).length === 0) {
    throw invalid(file, `"checks" must be an object with at least one check`);
  }
  const checks: CheckSpec[] = [];
  for (const [name, value] of Object.entries(raw.checks)) {
    checks.push(parseCheck(name, value, file));
  }
  validateGraph(checks, file);
  return checks;
}

function parseCheck(name: string, value: unknown, file: string): CheckSpec {
  if (!NAME_RE.test(name)) {
    throw invalid(file, `check name "${name}" must match ${NAME_RE.source}`);
  }
  if (!isRecord(value)) throw invalid(file, `check "${name}" must be an object`);
  for (const key of Object.keys(value)) {
    if (!CHECK_KEYS.has(key)) {
      throw invalid(file, `check "${name}" has unknown key "${key}"; allowed keys are run, after, timeoutSec, parser, affected, fullOn`);
    }
  }
  if (typeof value.run !== "string" || value.run.trim().length === 0) {
    throw invalid(file, `check "${name}" needs "run", a non-empty shell command string`);
  }
  let after: string[] = [];
  if (value.after !== undefined) {
    if (!Array.isArray(value.after) || !value.after.every((dep) => typeof dep === "string")) {
      throw invalid(file, `check "${name}" has "after" that is not an array of check names`);
    }
    after = [...new Set(value.after as string[])];
  }
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (value.timeoutSec !== undefined) {
    if (typeof value.timeoutSec !== "number" || !Number.isFinite(value.timeoutSec) || value.timeoutSec <= 0) {
      throw invalid(file, `check "${name}" has "timeoutSec" that is not a positive number`);
    }
    timeoutSec = value.timeoutSec;
  }
  const spec: CheckSpec = { name, run: value.run, after, timeoutSec };
  if (value.parser !== undefined) {
    if (!(value.parser === "none" || isParserChoice(value.parser))) {
      throw invalid(
        file,
        `check "${name}" has "parser" ${JSON.stringify(value.parser)}; allowed values are ${PARSER_CHOICES.join(", ")}, or a list of ${PARSERS.join(", ")}`,
      );
    }
    spec.parser = value.parser;
  }
  if (value.affected !== undefined) {
    if (typeof value.affected !== "string" || !value.affected.includes(FILES_PLACEHOLDER)) {
      throw invalid(file, `check "${name}" has "affected" that is not a shell command holding ${FILES_PLACEHOLDER}, like "vitest related --run ${FILES_PLACEHOLDER}"`);
    }
    spec.affected = value.affected;
  }
  if (value.fullOn !== undefined) {
    if (!Array.isArray(value.fullOn) || !value.fullOn.every((glob) => typeof glob === "string" && glob.length > 0)) {
      throw invalid(file, `check "${name}" has "fullOn" that is not an array of path globs`);
    }
    if (spec.affected === undefined) throw invalid(file, `check "${name}" has "fullOn" without "affected"`);
    spec.fullOn = value.fullOn as string[];
  }
  return spec;
}

function validateGraph(checks: CheckSpec[], file: string): void {
  const byName = new Map(checks.map((check) => [check.name, check]));
  for (const check of checks) {
    for (const dep of check.after) {
      if (!byName.has(dep)) {
        throw invalid(file, `check "${check.name}" is after unknown check "${dep}"`);
      }
    }
  }
  const cycle = findCycle(checks, byName);
  if (cycle !== null) {
    throw invalid(file, `"after" has a cycle: ${cycle.join(" -> ")}`);
  }
}

function findCycle(checks: CheckSpec[], byName: Map<string, CheckSpec>): string[] | null {
  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (name: string): string[] | null => {
    if (onStack.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (done.has(name)) return null;
    stack.push(name);
    onStack.add(name);
    for (const dep of byName.get(name)!.after) {
      const cycle = visit(dep);
      if (cycle !== null) return cycle;
    }
    stack.pop();
    onStack.delete(name);
    done.add(name);
    return null;
  };
  for (const check of checks) {
    const cycle = visit(check.name);
    if (cycle !== null) return cycle;
  }
  return null;
}

// Keeps config order, so output order follows the file the user wrote.
export function selectChecks(checks: CheckSpec[], requested: string[]): CheckSpec[] {
  if (requested.length === 0) return checks;
  const byName = new Map(checks.map((check) => [check.name, check]));
  const unknown = requested.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new AgentError(
      `unknown check: ${unknown.join(", ")}`,
      `run \`firstlight run\` with no names, or pick from: ${checks.map((check) => check.name).join(", ")}`,
    );
  }
  const wanted = new Set<string>();
  const add = (name: string): void => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dep of byName.get(name)!.after) add(dep);
  };
  for (const name of requested) add(name);
  return checks.filter((check) => wanted.has(check.name));
}

// A word of `firstlight run` is a configured check first, then a
// package.json script or glob. An argument with whitespace, or any argument
// after `--`, is a shell command named by itself. Arguments keep their
// order, and a configured check's `after` dependencies come just before it.
export function resolveRun(root: string, args: readonly string[], commands: readonly string[]): CheckSpec[] {
  const configured = configuredChecks(root);
  const byName = new Map(configured.map((check) => [check.name, check]));
  let scripts: string[] | null | undefined;
  const scriptNames = (): string[] | null => {
    if (scripts === undefined) scripts = readScripts(path.join(root, "package.json"));
    return scripts;
  };

  const picked: CheckSpec[] = [];
  const add = (spec: CheckSpec): void => {
    const same = picked.find((check) => check.name === spec.name);
    if (same === undefined) {
      picked.push(spec);
    } else if (same.run !== spec.run) {
      throw new AgentError(
        `two checks are named "${spec.name}": one runs \`${same.run}\` and one runs \`${spec.run}\``,
        "drop one of the two arguments, or rename the check in firstlight.json",
      );
    }
  };
  const addCommand = (command: string): void => {
    if (command.trim().length === 0) {
      throw new AgentError("an empty command was given to `firstlight run`", "drop the empty argument");
    }
    add(commandCheck(command));
  };
  const unknown: string[] = [];

  for (const arg of args) {
    if (/\s/u.test(arg)) {
      addCommand(arg);
    } else if (byName.has(arg)) {
      for (const check of selectChecks(configured, [arg])) add(check);
    } else if (isPattern(arg)) {
      const available = scriptNames();
      const matched = expandPattern(arg, available ?? []);
      if (matched.length === 0) {
        const why = available === null ? "there is no package.json" : `the scripts are: ${available.join(", ") || "(none)"}`;
        throw new AgentError(
          `no package.json script matches "${arg}"; ${why}`,
          available === null || available.length === 0
            ? `quote a shell command instead, like \`firstlight run "make test"\``
            : `pick a pattern that matches one of: ${available.join(", ")}`,
        );
      }
      for (const name of matched) add(byName.get(name) ?? scriptCheck(name));
    } else if (scriptNames()?.includes(arg)) {
      add(scriptCheck(arg));
    } else {
      unknown.push(arg);
    }
  }
  for (const command of commands) addCommand(command);

  if (unknown.length > 0) {
    const available = scriptNames();
    const choices = [
      `configured checks: ${configured.length === 0 ? "(none)" : configured.map((check) => check.name).join(", ")}`,
      available === null ? "no package.json" : `package.json scripts: ${available.length === 0 ? "(none)" : available.join(", ")}`,
    ];
    throw new AgentError(
      `unknown check or script: ${unknown.join(", ")} (${choices.join("; ")})`,
      `pick a check or script from that list, or run a shell command by quoting it, like \`firstlight run "make test"\`, or after --, like \`firstlight run -- ${shellQuote(unknown[0]!)}\``,
    );
  }
  return picked;
}

export interface PreviousCheck {
  spec: CheckSpec;
  status: ReportedStatus;
}

export interface FailedSelection {
  checks: CheckSpec[];
  // Checks that did not pass, but came from firstlight.json and are no
  // longer in it.
  dropped: string[];
}

// `firstlight run --failed`: every check of the latest run that did not
// pass, resolved against the current firstlight.json the way `run <name>`
// resolves a word. A configured check comes with its `after` checks, which
// the cache then reuses where it can. A script or shell command given on
// the command line has no entry in firstlight.json, so it runs the command
// it ran before. A configured check that has since left firstlight.json is
// dropped rather than run from a stale record.
export function selectFailed(configured: CheckSpec[], previous: readonly PreviousCheck[]): FailedSelection {
  const byName = new Map(configured.map((check) => [check.name, check]));
  const picked: CheckSpec[] = [];
  const dropped: string[] = [];
  const add = (spec: CheckSpec): void => {
    if (!picked.some((check) => check.name === spec.name)) picked.push(spec);
  };
  for (const { spec, status } of previous) {
    if (status === "passed") continue;
    if (byName.has(spec.name)) {
      for (const check of selectChecks(configured, [spec.name])) add(check);
    } else if (spec.after.length === 0 && (spec.run === scriptCheck(spec.name).run || spec.run === spec.name)) {
      add(spec);
    } else {
      dropped.push(spec.name);
    }
  }
  return { checks: picked, dropped };
}

// The checks of firstlight.json alone, without the package.json fallback:
// what a word given to `run` can name as a configured check.
export interface Proposal {
  checks: CheckSpec[];
  // Check-like scripts the proposal does not hold, in package.json order.
  leftOut: string[];
}

// What `firstlight init` would write: each picked script as the check
// `run` would make of it, so a later run shares its cache keys and
// durations with the runs before init, plus the parser inferred from the
// script. With no names, the picked scripts are the package.json fallback.
export function proposeChecks(root: string, args: readonly string[]): Proposal {
  const file = path.join(root, "package.json");
  const commands = readScriptCommands(file);
  if (commands === null) {
    throw new AgentError(
      `there is no package.json in ${root}, and firstlight init proposes checks from its scripts`,
      `write ${path.join(root, CONFIG_FILE)} by hand, like {"checks": {"test": {"run": "make test"}}}`,
    );
  }
  const scripts = Object.keys(commands);
  const checkLike = checkLikeScripts(scripts);
  let picked: string[];
  if (args.length === 0) {
    picked = FALLBACK_SCRIPTS.filter((name) => scripts.includes(name));
    if (picked.length === 0) {
      throw new AgentError(
        `package.json has no ${FALLBACK_SCRIPTS.join(", ")} script, so firstlight init has nothing to propose`,
        checkLike.length === 0
          ? `name the scripts to check, like \`firstlight init ${scripts[0] ?? "test"}\``
          : `name the scripts to check, like \`firstlight init ${checkLike.map(shellQuote).join(" ")}\``,
      );
    }
  } else {
    picked = [];
    for (const arg of args) {
      if (/\s/u.test(arg)) {
        throw new AgentError(
          `firstlight init picks package.json scripts, and "${arg}" is a shell command`,
          `add it to ${CONFIG_FILE} by hand, like {"checks": {"name": {"run": ${JSON.stringify(arg)}}}}`,
        );
      }
      const matched = isPattern(arg) ? expandPattern(arg, scripts) : scripts.includes(arg) ? [arg] : [];
      if (matched.length === 0) {
        throw new AgentError(
          `no package.json script ${isPattern(arg) ? "matches" : "is named"} "${arg}"; the scripts are: ${scripts.join(", ") || "(none)"}`,
          `pick from: ${scripts.join(", ") || "(none)"}`,
        );
      }
      for (const name of matched) if (!picked.includes(name)) picked.push(name);
    }
  }
  const scriptOf = (name: string): string | null => commands[name] ?? null;
  const checks = picked.map((name): CheckSpec => {
    const check = scriptCheck(name);
    const parser = inferParser(check.run, scriptOf);
    return parser === null ? check : { ...check, parser };
  });
  return { checks, leftOut: checkLike.filter((name) => !picked.includes(name)) };
}

// A timeout that leaves room for a check that once passed in `ms`: three
// times that, in whole minutes, or null when the default already does.
export function suggestTimeoutSec(ms: number): number | null {
  const seconds = Math.ceil((ms * 3) / 60_000) * 60;
  return seconds > DEFAULT_TIMEOUT_SEC ? seconds : null;
}

// The firstlight.json text for `checks`, with only the keys that differ
// from the defaults, so the file reads like one written by hand.
export function configText(checks: readonly CheckSpec[]): string {
  const body: Record<string, Record<string, unknown>> = {};
  for (const check of checks) {
    const entry: Record<string, unknown> = { run: check.run };
    if (check.after.length > 0) entry.after = check.after;
    if (check.timeoutSec !== DEFAULT_TIMEOUT_SEC) entry.timeoutSec = check.timeoutSec;
    if (check.parser !== undefined && check.parser !== null) entry.parser = check.parser;
    body[check.name] = entry;
  }
  return `${JSON.stringify({ checks: body }, null, 2)}\n`;
}

export function configuredChecks(root: string): CheckSpec[] {
  const configPath = path.join(root, CONFIG_FILE);
  const configText = readOptional(configPath);
  return configText === null ? [] : parseConfig(configText, configPath);
}

export function scriptCheck(script: string): CheckSpec {
  return { name: script, run: `npm run ${shellQuote(script)}`, after: [], timeoutSec: DEFAULT_TIMEOUT_SEC };
}

export function commandCheck(command: string): CheckSpec {
  return { name: command, run: command, after: [], timeoutSec: DEFAULT_TIMEOUT_SEC };
}

// The parser each check's log is read with, decided once when the run
// starts so `results` and `follow` read the log the same way later. A
// "parser" in firstlight.json wins, and "none" turns inference off.
export function withParsers(root: string, checks: readonly CheckSpec[]): CheckSpec[] {
  let scripts: Record<string, string> | null | undefined;
  const scriptOf = (name: string): string | null => {
    if (scripts === undefined) scripts = readScriptCommands(path.join(root, "package.json"));
    return scripts?.[name] ?? null;
  };
  return checks.map((check) => {
    if (check.parser === "none") return { ...check, parser: null };
    // A check `run --failed` carries over from the previous run keeps the
    // parser that run decided, null included.
    if (check.parser !== undefined) return check;
    return { ...check, parser: inferParser(check.run, scriptOf) };
  });
}

// Script names in package.json order, or null when there is no package.json.
function readScripts(file: string): string[] | null {
  const scripts = readScriptCommands(file);
  return scripts === null ? null : Object.keys(scripts);
}

function readScriptCommands(file: string): Record<string, string> | null {
  const text = readOptional(file);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AgentError(`${file} is not valid JSON (${messageOf(err)})`, `fix ${file}, then rerun the command`);
  }
  const scripts = isRecord(raw) && isRecord(raw.scripts) ? raw.scripts : {};
  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === "string") commands[name] = command;
  }
  return commands;
}

function invalid(file: string, reason: string): AgentError {
  return new AgentError(`invalid ${path.basename(file)}: ${reason}`, `fix ${file}, then rerun the command`);
}

function readOptional(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AgentError(`could not read ${file}: ${messageOf(err)}`, `check permissions on ${file}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
