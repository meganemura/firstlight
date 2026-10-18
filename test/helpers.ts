// Shared fixtures for the CLI tests: a throwaway git repository with its own
// XDG_STATE_HOME, the real CLI run as a child process, and readers for the
// state files. Every process the tests signal is one a run recorded.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CLI = path.resolve(import.meta.dirname, "..", "src", "cli.ts");

export interface Repo {
  root: string;
  xdg: string;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export function makeRepo(files: Record<string, unknown>): Repo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-repo-")));
  const xdg = realpathSync(mkdtempSync(path.join(tmpdir(), "firstlight-state-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { root, xdg };
}

export function cli(repo: Repo, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repo.root,
      env: { ...process.env, ...env, XDG_STATE_HOME: repo.xdg },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

export function parseLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function checkStatuses(stdout: string): Record<string, unknown> {
  const statuses: Record<string, unknown> = {};
  for (const line of parseLines(stdout)) {
    if (line.type === "check") statuses[line.name as string] = line.status;
  }
  return statuses;
}

export interface RunFiles {
  id: string;
  dir: string;
  run: { supervisor_pid: number; checks: { name: string }[] };
  events: Record<string, unknown>[];
}

export function currentRun(repo: Repo): RunFiles {
  const base = path.join(repo.xdg, "firstlight");
  const [key] = readdirSync(base);
  const id = readFileSync(path.join(base, key!, "current"), "utf8").trim();
  return runFiles(repo, id);
}

export function runFiles(repo: Repo, id: string): RunFiles {
  const base = path.join(repo.xdg, "firstlight");
  const [key] = readdirSync(base);
  const dir = path.join(base, key!, "runs", id);
  const run = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunFiles["run"];
  let text = "";
  try {
    text = readFileSync(path.join(dir, "events.jsonl"), "utf8");
  } catch {
    // No event yet.
  }
  const events = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { id, dir, run, events };
}

export function checkPid(files: RunFiles, check: string): number | null {
  const started = files.events.find((event) => event.check === check && event.status === "running");
  return (started?.pid as number | undefined) ?? null;
}

export async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(25);
  }
}

// A process that has exited but was never reaped still answers kill(pid, 0),
// so /proc decides on Linux.
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !isZombie(pid);
}

export function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  let entries: string[];
  try {
    entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  return entries.some((name) => {
    const fields = procStat(Number(name));
    return fields !== null && fields.pgrp === pgid && fields.state !== "Z" && fields.state !== "X";
  });
}

function isZombie(pid: number): boolean {
  const fields = procStat(pid);
  return fields !== null && (fields.state === "Z" || fields.state === "X");
}

function procStat(pid: number): { state: string; pgrp: number } | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { state: rest[0]!, pgrp: Number(rest[2]) };
}

export function killGroup(pgid: number | null): void {
  if (pgid === null) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export async function cleanup(repo: Repo, groups: (number | null)[] = []): Promise<void> {
  await cli(repo, ["stop"]);
  for (const pgid of groups) killGroup(pgid);
  rmSync(repo.root, { recursive: true, force: true });
  rmSync(repo.xdg, { recursive: true, force: true });
}
