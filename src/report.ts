// How a run looks to the agent that asked: short plain text by default, or
// JSON Lines (one object per check, then one summary) with --json. It only
// formats a RunSnapshot and its estimate; deciding exit codes and next
// commands is the CLI's. A failed check's log is read through its parser,
// when it has one, so its diagnostics come before the tail, each with the
// evidence file and rerun command depug printed for it, when there are. `results --new`
// gets its own text and JSON here too, from a comparison the CLI made.

import { countFailures, isUnproven, type CheckComparison } from "./baseline.ts";
import { bucketOf, isSettled, type CheckView } from "./checks.ts";
import { FALLBACK_SCRIPTS } from "./config.ts";
import { formatDiagnostic, isParserName, parseDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { formatSeconds, type CheckEta, type RunEta } from "./eta.ts";
import { logPaths, readLogEnd, tailLines, type RunRecord, type RunSnapshot } from "./store.ts";

export const TAIL_LINES = 40;
// With diagnostics, they carry the substance, and the tail only shows the
// context the parser did not read, such as a summary.
export const DIAGNOSTIC_TAIL_LINES = 10;
export const DIAGNOSTIC_LIMIT = 20;

interface LogReport {
  diagnostics: Diagnostic[];
  more: number;
  tail: string[];
}

// Every diagnostic in the log of one check of a run, through the parser
// that run recorded for it.
export function checkDiagnostics(run: RunRecord, dir: string, name: string): Diagnostic[] {
  const parser = run.checks.find((check) => check.name === name)?.parser;
  if (!isParserName(parser)) return [];
  return parseDiagnostics(parser, readLogEnd(logPaths(dir, run.checks).get(name)!), run.root);
}

// `shown` narrows the diagnostics printed, as `results --new` does; the
// tail stays short whenever the log has any.
function logReport(snapshot: RunSnapshot, view: CheckView, file: string, shown?: readonly Diagnostic[]): LogReport {
  const all = checkDiagnostics(snapshot.run, snapshot.dir, view.name);
  const printed = shown ?? all;
  return {
    diagnostics: printed.slice(0, DIAGNOSTIC_LIMIT),
    more: Math.max(0, printed.length - DIAGNOSTIC_LIMIT),
    tail: tailLines(file, all.length > 0 ? DIAGNOSTIC_TAIL_LINES : TAIL_LINES),
  };
}

// What `results --new` compared: the baseline run of each check that has
// one, and one entry per failed check of the run.
export interface Comparison {
  baselines: ReadonlyMap<string, string>;
  checks: ReadonlyMap<string, CheckComparison>;
}

interface Compared {
  baseline: string | null;
  comparison: CheckComparison | undefined;
}

function comparedOf(comparison: Comparison, view: CheckView): Compared {
  return { baseline: comparison.baselines.get(view.name) ?? null, comparison: comparison.checks.get(view.name) };
}

export interface Summary {
  type: "summary";
  run: string;
  failed: string[];
  running: string[];
  passed: string[];
  cancelled: string[];
  next: string | null;
  eta_ms: number | null;
  not_run?: string[];
}

export function summarize(snapshot: RunSnapshot, next: string | null, eta: RunEta, notRun: string[] = []): Summary {
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
  if (notRun.length > 0) summary.not_run = notRun;
  return summary;
}

function showsLog(view: CheckView): boolean {
  return view.status === "failed" || view.status === "timed_out";
}

export function jsonLines(snapshot: RunSnapshot, next: string | null, eta: RunEta, notRun: string[] = []): string {
  const lines = snapshot.checks.map((view) => checkJson(snapshot, view, eta));
  lines.push(JSON.stringify(summarize(snapshot, next, eta, notRun)));
  return `${lines.join("\n")}\n`;
}

// One line for the check, then, for a failed check, one line per
// diagnostic, without a trailing newline. With `compared`, the check line
// gains `new` and `baseline` (and `old_diagnostics` when it failed), and
// only the new diagnostics follow it.
export function checkJson(snapshot: RunSnapshot, view: CheckView, eta: RunEta, compared?: Compared): string {
  const log = logPaths(snapshot.dir, snapshot.run.checks).get(view.name)!;
  const checkEta = etaOf(eta, view);
  const line: Record<string, unknown> = {
    type: "check",
    name: view.name,
    status: view.status,
    exit_code: view.exit_code,
    elapsed_ms: view.elapsed_ms,
    log,
    eta_ms: roundMs(checkEta.eta_ms),
    overdue: checkEta.overdue,
    cached_from: view.cached_from,
  };
  if (view.orphan) line.orphan = true;
  if (compared !== undefined) {
    line.new = compared.comparison?.isNew ?? false;
    line.baseline = compared.baseline;
  }
  if (!showsLog(view)) return JSON.stringify(line);
  if (compared !== undefined) line.old_diagnostics = compared.comparison?.oldDiagnostics ?? 0;
  const report = logReport(snapshot, view, log, compared?.comparison?.newDiagnostics);
  if (report.more > 0) line.more_diagnostics = report.more;
  line.tail = report.tail;
  const diagnostics = report.diagnostics.map((diagnostic) =>
    JSON.stringify({
      type: "diagnostic",
      check: view.name,
      file: diagnostic.file,
      line: diagnostic.line,
      col: diagnostic.col,
      rule: diagnostic.rule,
      message: diagnostic.message,
      ...depugFields(diagnostic),
    }),
  );
  return [JSON.stringify(line), ...diagnostics].join("\n");
}

// `focus` puts one check first with its log, as `run` does for the check
// that failed first; the others get one status line each.
export function text(
  snapshot: RunSnapshot,
  next: string | null,
  eta: RunEta,
  focus: string | null = null,
  notRun: string[] = [],
): string {
  const out: string[] = [];
  const ordered =
    focus === null
      ? snapshot.checks
      : [...snapshot.checks.filter((v) => v.name === focus), ...snapshot.checks.filter((v) => v.name !== focus)];
  for (const view of ordered) {
    out.push(statusLine(snapshot, view, eta));
    if (showsLog(view) && (focus === null || view.name === focus)) out.push(...logBlock(snapshot, view));
  }
  return `${out.join("\n")}\n${notRunText(notRun)}${summaryText(snapshot, next, eta)}`;
}

// The lines after the check lines: the counts, then the next command.
export function summaryText(snapshot: RunSnapshot, next: string | null, eta: RunEta): string {
  const out = [countsLine(snapshot, eta)];
  if (next !== null) {
    const waiting = !snapshot.checks.every(isSettled) && eta.eta_ms !== null;
    out.push(waiting ? `next: ${next} (about ${formatSeconds(eta.eta_ms!)} left)` : `next: ${next}`);
  }
  return `${out.join("\n")}\n`;
}

// One status change, as `follow` prints it. A running check gets no
// elapsed time: when `follow` replays history, the time since it started
// is not the time it had run when it changed.
export function changeText(snapshot: RunSnapshot, view: CheckView, eta: RunEta): string {
  if (view.status === "running") {
    const checkEta = etaOf(eta, view);
    return checkEta.eta_ms === null
      ? `${view.name} running\n`
      : `${view.name} running (about ${formatSeconds(checkEta.eta_ms)} left)\n`;
  }
  const out = [statusLine(snapshot, view, eta)];
  if (showsLog(view)) out.push(...logBlock(snapshot, view));
  return `${out.join("\n")}\n`;
}

function logBlock(snapshot: RunSnapshot, view: CheckView, compared?: Compared): string[] {
  const file = logPaths(snapshot.dir, snapshot.run.checks).get(view.name)!;
  const report = logReport(snapshot, view, file, compared?.comparison?.newDiagnostics);
  const more = report.more === 0 ? [] : [`  (${report.more} more ${plural(report.more, "diagnostic")} in the log)`];
  const old = compared?.comparison?.oldDiagnostics ?? 0;
  const known = old === 0 ? [] : [`  (${old} ${plural(old, "diagnostic")} already in run ${compared!.baseline})`];
  return [
    ...report.diagnostics.flatMap((diagnostic) => [`  ${formatDiagnostic(diagnostic)}`, ...depugLines(diagnostic)]),
    ...more,
    ...known,
    `  log: ${file}`,
    ...(report.tail.length === 0 ? ["    (no output)"] : report.tail.map((line) => `    ${line}`)),
  ];
}

function depugFields(diagnostic: Diagnostic): { evidence?: string; rerun?: string } {
  return diagnostic.evidence === undefined ? {} : { evidence: diagnostic.evidence, rerun: diagnostic.rerun };
}

function depugLines(diagnostic: Diagnostic): string[] {
  return [
    ...(diagnostic.evidence === undefined ? [] : [`    evidence: ${diagnostic.evidence}`]),
    ...(diagnostic.rerun === undefined ? [] : [`    rerun: ${diagnostic.rerun}`]),
  ];
}

export interface NewSummary extends Summary {
  new: string[];
  new_failures: number;
  old_failures: number;
  no_baseline: string[];
}

export function summarizeNew(snapshot: RunSnapshot, comparison: Comparison, next: string | null, eta: RunEta): NewSummary {
  const counts = countFailures([...comparison.checks.values()]);
  return {
    ...summarize(snapshot, next, eta),
    new: [...comparison.checks.values()].filter((check) => check.isNew).map((check) => check.name),
    new_failures: counts.new,
    old_failures: counts.old,
    no_baseline: snapshot.checks.filter((view) => !comparison.baselines.has(view.name)).map((view) => view.name),
  };
}

// Every check, as `results --json` prints it with the fields of `compared`,
// then only the new diagnostics, then the summary.
export function newJsonLines(snapshot: RunSnapshot, comparison: Comparison, next: string | null, eta: RunEta): string {
  const lines = snapshot.checks.map((view) => checkJson(snapshot, view, eta, comparedOf(comparison, view)));
  lines.push(JSON.stringify(summarizeNew(snapshot, comparison, next, eta)));
  return `${lines.join("\n")}\n`;
}

// Only the checks with a new failure, with their new diagnostics, and the
// checks that proved nothing yet; passes and known failures are counts.
export function newText(snapshot: RunSnapshot, comparison: Comparison, next: string | null, eta: RunEta): string {
  const out: string[] = [];
  for (const view of snapshot.checks) {
    const compared = comparedOf(comparison, view);
    if (compared.comparison?.isNew === true) {
      out.push(statusLine(snapshot, view, eta), ...logBlock(snapshot, view, compared));
    } else if (isUnproven(view.status)) {
      out.push(statusLine(snapshot, view, eta));
    }
  }
  const summary = summarizeNew(snapshot, comparison, next, eta);
  if (comparison.baselines.size === 0) {
    out.push("no earlier run to compare with, so every failure counts as new");
  } else {
    const missing = [...comparison.checks.keys()].filter((name) => !comparison.baselines.has(name));
    if (missing.length > 0) {
      out.push(`no earlier result for ${missing.join(", ")}, so ${missing.length === 1 ? "its" : "their"} failures count as new`);
    }
  }
  const skipped = snapshot.checks.filter((view) => view.status === "skipped").length;
  const notNew = [
    summary.old_failures > 0 ? `${summary.old_failures} ${plural(summary.old_failures, "failure")} already in the previous run` : "",
    summary.passed.length > 0 ? `${summary.passed.length} passed` : "",
    skipped > 0 ? `${skipped} skipped` : "",
  ].filter((part) => part !== "");
  if (notNew.length > 0) out.push(`not new: ${notNew.join(", ")}`);
  const fresh = summary.new_failures === 0 ? "no new failures" : `${summary.new_failures} new ${plural(summary.new_failures, "failure")}`;
  const unproven = [
    ["running", summary.running.length],
    ["cancelled", summary.cancelled.length],
    ["unknown", snapshot.checks.filter((view) => view.status === "unknown").length],
  ]
    .filter(([, count]) => count !== 0)
    .map(([kind, count]) => `${count} ${kind}`);
  out.push(`run ${snapshot.run.id}: ${[fresh, ...unproven].join(", ")}`);
  if (next !== null) {
    const waiting = !snapshot.checks.every(isSettled) && eta.eta_ms !== null;
    out.push(waiting ? `next: ${next} (about ${formatSeconds(eta.eta_ms!)} left)` : `next: ${next}`);
  }
  return `${out.join("\n")}\n`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// Only a run without firstlight.json has these: the check-like scripts the
// package.json fallback did not run.
export function notRunText(notRun: string[]): string {
  if (notRun.length === 0) return "";
  return `not run: ${notRun.join(", ")} (without firstlight.json, only ${FALLBACK_SCRIPTS.join(", ")} run; name a script, like firstlight run ${notRun[0]}, or list it in firstlight.json)\n`;
}

export function allPassedText(snapshot: RunSnapshot, notRun: string[] = []): string {
  const seconds = (Date.now() - Date.parse(snapshot.run.started_at)) / 1000;
  const count = snapshot.checks.length;
  const cached = cachedCount(snapshot);
  const notes = cached === 0 ? `run ${snapshot.run.id}` : `${cached} cached, run ${snapshot.run.id}`;
  return `passed ${count} check${count === 1 ? "" : "s"} in ${seconds.toFixed(1)}s (${notes})\n${notRunText(notRun)}`;
}

function statusLine(snapshot: RunSnapshot, view: CheckView, eta: RunEta): string {
  const details: string[] = [];
  if (view.orphan) {
    details.push("orphan: the supervisor is gone, so the result is unknown");
  } else if (view.cached_from !== null) {
    details.push(`cached from run ${view.cached_from}`);
    if (view.elapsed_ms !== null) details.push(`${(view.elapsed_ms / 1000).toFixed(1)}s originally`);
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
  const cached = cachedCount(snapshot);
  return `run ${snapshot.run.id}: ${parts.join(", ")}${cached === 0 ? "" : ` (${cached} cached)`}`;
}

function cachedCount(snapshot: RunSnapshot): number {
  return snapshot.checks.filter((view) => view.cached_from !== null).length;
}

function etaOf(eta: RunEta, view: CheckView): CheckEta {
  return eta.checks.get(view.name) ?? { eta_ms: null, overdue: false };
}

function roundMs(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms);
}
