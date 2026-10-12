// How a run looks to the agent that asked: short plain text by default, or
// JSON Lines (one object per check, then one summary) with --json. It only
// formats a RunSnapshot; deciding exit codes and next commands is the CLI's.

import { bucketOf, type CheckView } from "./checks.ts";
import { logPath, tailLines, type RunSnapshot } from "./store.ts";

export const TAIL_LINES = 40;

export interface Summary {
  type: "summary";
  run: string;
  failed: string[];
  running: string[];
  passed: string[];
  cancelled: string[];
  next: string | null;
}

export function summarize(snapshot: RunSnapshot, next: string | null): Summary {
  const summary: Summary = {
    type: "summary",
    run: snapshot.run.id,
    failed: [],
    running: [],
    passed: [],
    cancelled: [],
    next,
  };
  for (const view of snapshot.checks) summary[bucketOf(view.status)].push(view.name);
  return summary;
}

function showsLog(view: CheckView): boolean {
  return view.status === "failed" || view.status === "timed_out";
}

export function jsonLines(snapshot: RunSnapshot, next: string | null): string {
  const lines = snapshot.checks.map((view) => {
    const line: Record<string, unknown> = {
      type: "check",
      name: view.name,
      status: view.status,
      exit_code: view.exit_code,
      elapsed_ms: view.elapsed_ms,
      log: logPath(snapshot.dir, view.name),
    };
    if (view.orphan) line.orphan = true;
    if (showsLog(view)) line.tail = tailLines(logPath(snapshot.dir, view.name), TAIL_LINES);
    return JSON.stringify(line);
  });
  lines.push(JSON.stringify(summarize(snapshot, next)));
  return `${lines.join("\n")}\n`;
}

// `focus` puts one check first with its log, as `run` does for the check
// that failed first; the others get one status line each.
export function text(snapshot: RunSnapshot, next: string | null, focus: string | null = null): string {
  const out: string[] = [];
  const ordered =
    focus === null
      ? snapshot.checks
      : [...snapshot.checks.filter((v) => v.name === focus), ...snapshot.checks.filter((v) => v.name !== focus)];
  for (const view of ordered) {
    out.push(statusLine(snapshot, view));
    if (showsLog(view) && (focus === null || view.name === focus)) {
      const file = logPath(snapshot.dir, view.name);
      const tail = tailLines(file, TAIL_LINES);
      out.push(`  log: ${file}`);
      if (tail.length === 0) out.push("    (no output)");
      for (const line of tail) out.push(`    ${line}`);
    }
  }
  out.push(countsLine(snapshot));
  if (next !== null) out.push(`next: ${next}`);
  return `${out.join("\n")}\n`;
}

export function allPassedText(snapshot: RunSnapshot): string {
  const seconds = (Date.now() - Date.parse(snapshot.run.started_at)) / 1000;
  const count = snapshot.checks.length;
  return `passed ${count} check${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s (run ${snapshot.run.id})\n`;
}

function statusLine(snapshot: RunSnapshot, view: CheckView): string {
  const details: string[] = [];
  if (view.orphan) {
    details.push("orphan: the supervisor is gone, so the result is unknown");
  } else if (view.status === "skipped") {
    const spec = snapshot.run.checks.find((check) => check.name === view.name);
    details.push(`needs ${spec?.after.join(", ") ?? "?"}`);
  } else {
    if (view.exit_code !== null) details.push(`exit ${view.exit_code}`);
    const elapsed =
      view.elapsed_ms ?? (view.status === "running" && view.started_at !== null ? Date.now() - Date.parse(view.started_at) : null);
    if (elapsed !== null) details.push(`${(elapsed / 1000).toFixed(1)}s`);
  }
  return details.length === 0 ? `${view.name} ${view.status}` : `${view.name} ${view.status} (${details.join(", ")})`;
}

function countsLine(snapshot: RunSnapshot): string {
  const summary = summarize(snapshot, null);
  const parts = (["failed", "running", "cancelled", "passed"] as const)
    .filter((bucket) => summary[bucket].length > 0)
    .map((bucket) => `${summary[bucket].length} ${bucket}`);
  return `run ${snapshot.run.id}: ${parts.join(", ")}`;
}
