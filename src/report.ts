// How a run looks to the agent that asked: short plain text by default, or
// JSON Lines (one object per check, then one summary) with --json. It only
// formats a RunSnapshot and its estimate; deciding exit codes and next
// commands is the CLI's.

import { bucketOf, isSettled, type CheckView } from "./checks.ts";
import { formatSeconds, type CheckEta, type RunEta } from "./eta.ts";
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
  eta_ms: number | null;
}

export function summarize(snapshot: RunSnapshot, next: string | null, eta: RunEta): Summary {
  const summary: Summary = {
    type: "summary",
    run: snapshot.run.id,
    failed: [],
    running: [],
    passed: [],
    cancelled: [],
    next,
    eta_ms: roundMs(eta.eta_ms),
  };
  for (const view of snapshot.checks) summary[bucketOf(view.status)].push(view.name);
  return summary;
}

function showsLog(view: CheckView): boolean {
  return view.status === "failed" || view.status === "timed_out";
}

export function jsonLines(snapshot: RunSnapshot, next: string | null, eta: RunEta): string {
  const lines = snapshot.checks.map((view) => {
    const checkEta = etaOf(eta, view);
    const line: Record<string, unknown> = {
      type: "check",
      name: view.name,
      status: view.status,
      exit_code: view.exit_code,
      elapsed_ms: view.elapsed_ms,
      log: logPath(snapshot.dir, view.name),
      eta_ms: roundMs(checkEta.eta_ms),
      overdue: checkEta.overdue,
    };
    if (view.orphan) line.orphan = true;
    if (showsLog(view)) line.tail = tailLines(logPath(snapshot.dir, view.name), TAIL_LINES);
    return JSON.stringify(line);
  });
  lines.push(JSON.stringify(summarize(snapshot, next, eta)));
  return `${lines.join("\n")}\n`;
}

// `focus` puts one check first with its log, as `run` does for the check
// that failed first; the others get one status line each.
export function text(snapshot: RunSnapshot, next: string | null, eta: RunEta, focus: string | null = null): string {
  const out: string[] = [];
  const ordered =
    focus === null
      ? snapshot.checks
      : [...snapshot.checks.filter((v) => v.name === focus), ...snapshot.checks.filter((v) => v.name !== focus)];
  for (const view of ordered) {
    out.push(statusLine(snapshot, view, eta));
    if (showsLog(view) && (focus === null || view.name === focus)) {
      const file = logPath(snapshot.dir, view.name);
      const tail = tailLines(file, TAIL_LINES);
      out.push(`  log: ${file}`);
      if (tail.length === 0) out.push("    (no output)");
      for (const line of tail) out.push(`    ${line}`);
    }
  }
  out.push(countsLine(snapshot, eta));
  if (next !== null) {
    const waiting = !snapshot.checks.every(isSettled) && eta.eta_ms !== null;
    out.push(waiting ? `next: ${next} (about ${formatSeconds(eta.eta_ms!)} left)` : `next: ${next}`);
  }
  return `${out.join("\n")}\n`;
}

export function allPassedText(snapshot: RunSnapshot): string {
  const seconds = (Date.now() - Date.parse(snapshot.run.started_at)) / 1000;
  const count = snapshot.checks.length;
  return `passed ${count} check${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s (run ${snapshot.run.id})\n`;
}

function statusLine(snapshot: RunSnapshot, view: CheckView, eta: RunEta): string {
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
    const checkEta = etaOf(eta, view);
    const usual = eta.typical.get(view.name);
    if (checkEta.overdue && usual !== undefined) {
      details.push(`past its usual ${(usual / 1000).toFixed(1)}s`);
    } else if (!isSettled(view) && checkEta.eta_ms !== null) {
      details.push(`about ${formatSeconds(checkEta.eta_ms)} left`);
    }
  }
  return details.length === 0 ? `${view.name} ${view.status}` : `${view.name} ${view.status} (${details.join(", ")})`;
}

function countsLine(snapshot: RunSnapshot, eta: RunEta): string {
  const summary = summarize(snapshot, null, eta);
  const parts = (["failed", "running", "cancelled", "passed"] as const)
    .filter((bucket) => summary[bucket].length > 0)
    .map((bucket) => `${summary[bucket].length} ${bucket}`);
  return `run ${snapshot.run.id}: ${parts.join(", ")}`;
}

function etaOf(eta: RunEta, view: CheckView): CheckEta {
  return eta.checks.get(view.name) ?? { eta_ms: null, overdue: false };
}

function roundMs(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms);
}
