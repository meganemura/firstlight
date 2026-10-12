// Which checks a repository has: firstlight.json, or the package.json
// fallback, validated into CheckSpec values before anything runs. Also owns
// the `after` graph (unknown names, cycles, the transitive selection) and
// what each argument of `firstlight run <arg>...` stands for: a configured
// check, a package.json script or glob, or a shell command, and which
// checks `run --failed` runs again. It reads files and never starts a
// process.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CheckSpec, ReportedStatus } from "./checks.ts";
import { inferParser, PARSER_CHOICES } from "./diagnostics.ts";
import { AgentError, messageOf } from "./errors.ts";
import { expandPattern, isPattern, shellQuote } from "./names.ts";

export const CONFIG_FILE = "firstlight.json";
export const DEFAULT_TIMEOUT_SEC = 600;
export const FALLBACK_SCRIPTS = ["lint", "typecheck", "test", "archstrict"] as const;

// A configured name is one plain word, never whitespace or "*", so an
// argument of `firstlight run` that names it cannot also read as a shell
// command or a script glob.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHECK_KEYS = new Set(["run", "after", "timeoutSec", "parser"]);

export interface Config {
  source: "firstlight.json" | "package.json";
  checks: CheckSpec[];
}

export function loadConfig(root: string): Config {
  const configPath = path.join(root, CONFIG_FILE);
  const text = readOptional(configPath);
  if (text !== null) {
    return { source: "firstlight.json", checks: parseConfig(text, configPath) };
  }
  const scripts = readScripts(path.join(root, "package.json")) ?? [];
  const checks = FALLBACK_SCRIPTS.filter((name) => scripts.includes(name)).map(scriptCheck);
  if (checks.length > 0) return { source: "package.json", checks };
  throw new AgentError(
    `no checks found in ${root}: there is no ${CONFIG_FILE} and package.json has no ${FALLBACK_SCRIPTS.join(", ")} script`,
    `create ${configPath} like {"checks": {"test": {"run": "npm test"}}}, then run \`firstlight run\``,
  );
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
      throw invalid(file, `check "${name}" has unknown key "${key}"; allowed keys are run, after, timeoutSec, parser`);
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
  if (value.parser === undefined) return { name, run: value.run, after, timeoutSec };
  if (typeof value.parser !== "string" || !PARSER_CHOICES.includes(value.parser)) {
    throw invalid(file, `check "${name}" has "parser" ${JSON.stringify(value.parser)}; allowed values are ${PARSER_CHOICES.join(", ")}`);
  }
  return { name, run: value.run, after, timeoutSec, parser: value.parser };
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
