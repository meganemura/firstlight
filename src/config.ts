// Which checks a repository has: firstlight.json, or the package.json
// fallback, validated into CheckSpec values before anything runs. Also owns
// the `after` graph: unknown names, cycles, and the transitive selection for
// `firstlight run <check>...`. It reads files and never starts a process.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CheckSpec } from "./checks.ts";
import { AgentError, messageOf } from "./errors.ts";

export const CONFIG_FILE = "firstlight.json";
export const DEFAULT_TIMEOUT_SEC = 600;
export const FALLBACK_SCRIPTS = ["lint", "typecheck", "test", "archstrict"] as const;

// A check name becomes `<name>.log` in the state directory, so it must be a
// safe file name.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHECK_KEYS = new Set(["run", "after", "timeoutSec"]);

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
  const pkgPath = path.join(root, "package.json");
  const pkgText = readOptional(pkgPath);
  if (pkgText !== null) {
    const checks = fallbackChecks(pkgText, pkgPath);
    if (checks.length > 0) return { source: "package.json", checks };
  }
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
      throw invalid(file, `check "${name}" has unknown key "${key}"; allowed keys are run, after, timeoutSec`);
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
  return { name, run: value.run, after, timeoutSec };
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

function fallbackChecks(text: string, file: string): CheckSpec[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AgentError(
      `${file} is not valid JSON (${messageOf(err)})`,
      `fix ${file}, or create ${path.join(path.dirname(file), CONFIG_FILE)}`,
    );
  }
  const scripts = isRecord(raw) && isRecord(raw.scripts) ? raw.scripts : {};
  return FALLBACK_SCRIPTS.filter((name) => typeof scripts[name] === "string").map((name) => ({
    name,
    run: `npm run ${name}`,
    after: [],
    timeoutSec: DEFAULT_TIMEOUT_SEC,
  }));
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
