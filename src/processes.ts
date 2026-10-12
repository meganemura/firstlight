// Process liveness and process-group signalling for pids firstlight started.
// Nothing here looks processes up by name or pattern: every call takes a pid
// that a run record or an event recorded.

import { readFileSync } from "node:fs";

export function isPidAlive(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  return !isZombie(pid);
}

// A detached supervisor is reparented when the CLI exits. If the new parent
// never reaps (a container whose pid 1 is not an init), a dead supervisor
// stays a zombie and kill(pid, 0) keeps succeeding, which would hide an
// orphan forever. Linux exposes the state in /proc; elsewhere we fall back
// to kill(pid, 0) alone.
function isZombie(pid: number): boolean {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
  return state === "Z" || state === "X";
}

export function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function signalPid(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
