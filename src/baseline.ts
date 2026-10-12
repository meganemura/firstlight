// Which failures of a run are new: the earlier result each check is
// compared with, and the comparison of the two. It only computes; reading
// the earlier runs is the store's, and parsing and printing their logs is
// the report's. No I/O.
//
// A diagnostic is identified by its file, rule, and message, without its
// line and column, so code that only moved does not count as a new
// failure. The cost is that a second copy of a known error in the same
// file, with the same rule and message, is not new either.

import type { CheckSpec, CheckState, ReportedStatus } from "./checks.ts";
import type { Diagnostic } from "./diagnostics.ts";

export interface PastBaselineRun {
  id: string;
  checks: CheckSpec[];
  states: CheckState[];
}

export interface Baseline {
  run: string;
  status: "passed" | "failed" | "timed_out";
}

// What one check says, in the latest run or in its baseline. A baseline
// that passed has no diagnostics.
export interface Outcome {
  failed: boolean;
  diagnostics: readonly Diagnostic[];
}

export interface LatestOutcome extends Outcome {
  name: string;
}

export interface CheckComparison {
  name: string;
  // The check has at least one new failure.
  isNew: boolean;
  newDiagnostics: Diagnostic[];
  oldDiagnostics: number;
}

export interface FailureCounts {
  new: number;
  old: number;
}

export function isFailure(status: ReportedStatus): boolean {
  return status === "failed" || status === "timed_out";
}

// The baseline of a check is the newest earlier kept run in which a check
// with the same name and the same `run` command passed, failed, or timed
// out. Per check rather than one run for all, because `run --failed` and
// `run <name>` leave runs that hold only some of the checks. A cancelled,
// skipped, or unfinished result proved nothing either way, so it is passed
// over; a changed command is a different check that shares the name.
export function findBaselines(specs: readonly CheckSpec[], newestFirst: readonly PastBaselineRun[]): Map<string, Baseline> {
  const baselines = new Map<string, Baseline>();
  for (const spec of specs) {
    for (const past of newestFirst) {
      const pastSpec = past.checks.find((check) => check.name === spec.name);
      if (pastSpec === undefined || pastSpec.run !== spec.run) continue;
      const status = past.states.find((check) => check.name === spec.name)?.status;
      if (status === "passed" || status === "failed" || status === "timed_out") {
        baselines.set(spec.name, { run: past.id, status });
        break;
      }
    }
  }
  return baselines;
}

export function diagnosticKey(diagnostic: Diagnostic): string {
  return JSON.stringify([diagnostic.file, diagnostic.rule, diagnostic.message]);
}

// One entry per failed check of the latest run, in its order. A failure
// with diagnostics is compared diagnostic by diagnostic; a failure without
// them is new when its baseline did not fail. A check without a baseline
// has only new failures.
export function compareFailures(latest: readonly LatestOutcome[], baselines: ReadonlyMap<string, Outcome>): CheckComparison[] {
  const comparisons: CheckComparison[] = [];
  for (const check of latest) {
    if (!check.failed) continue;
    const baseline = baselines.get(check.name);
    if (check.diagnostics.length === 0) {
      comparisons.push({ name: check.name, isNew: baseline?.failed !== true, newDiagnostics: [], oldDiagnostics: 0 });
      continue;
    }
    const known = new Set(baseline?.failed === true ? baseline.diagnostics.map(diagnosticKey) : []);
    const newDiagnostics = check.diagnostics.filter((diagnostic) => !known.has(diagnosticKey(diagnostic)));
    comparisons.push({
      name: check.name,
      isNew: newDiagnostics.length > 0,
      newDiagnostics,
      oldDiagnostics: check.diagnostics.length - newDiagnostics.length,
    });
  }
  return comparisons;
}

// A failure is one diagnostic, or one failed check that has none.
export function countFailures(comparisons: readonly CheckComparison[]): FailureCounts {
  let fresh = 0;
  let old = 0;
  for (const comparison of comparisons) {
    if (comparison.newDiagnostics.length === 0 && comparison.oldDiagnostics === 0) {
      if (comparison.isNew) fresh += 1;
      else old += 1;
    } else {
      fresh += comparison.newDiagnostics.length;
      old += comparison.oldDiagnostics;
    }
  }
  return { new: fresh, old };
}

// A check that proved nothing yet: still to finish, stopped, or left
// without a result by its supervisor. A skipped check is not one of these:
// it is judged through the `after` check whose failure skipped it.
export function isUnproven(status: ReportedStatus): boolean {
  return status === "pending" || status === "running" || status === "cancelled" || status === "unknown";
}
