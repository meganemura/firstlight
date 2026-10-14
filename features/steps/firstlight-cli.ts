// Runs firstlight from source, the way this repository runs itself, in a
// scratch repository whose state directory is its own, and reads the JSON
// Lines it prints.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface CheckLine {
  name: string;
  status: string;
}

export interface FirstlightOutput {
  exitCode: number;
  checks: CheckLine[];
  next: string;
}

export function runFirstlight(args: string[], root: string, stateHome: string): FirstlightOutput {
  const result = spawnSync(process.execPath, [CLI, ...args, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });
  if (result.error) throw result.error;
  const lines = result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
  const summary = lines.find((line) => line.type === "summary");
  return {
    exitCode: result.status ?? 1,
    checks: lines.filter((line) => line.type === "check").map((line) => ({ name: line.name, status: line.status })),
    next: summary?.next ?? "",
  };
}
