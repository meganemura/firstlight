// The estimated time left for checks that have not finished, from how long
// the same check took when it last passed. It only computes; reading earlier
// runs is the store's, and printing the estimate is the report's. No I/O.

import { isSettled, type CheckSpec, type CheckState, type CheckView } from "./checks.ts";

export interface PastRun {
  checks: CheckSpec[];
  states: CheckState[];
}

export interface CheckEta {
  eta_ms: number | null;
  overdue: boolean;
}

export interface RunEta {
  checks: Map<string, CheckEta>;
  eta_ms: number | null;
  typical: ReadonlyMap<string, number>;
}

// Only a pass counts: a failed, timed-out, or cancelled check stopped early,
// so its elapsed time says nothing about a full run. A changed `run` command
// is a different check that happens to share the name.
export function typicalDurations(specs: CheckSpec[], newestFirst: PastRun[]): Map<string, number> {
  const typical = new Map<string, number>();
  for (const spec of specs) {
    for (const past of newestFirst) {
      const pastSpec = past.checks.find((check) => check.name === spec.name);
      if (pastSpec === undefined || pastSpec.run !== spec.run) continue;
      const state = past.states.find((check) => check.name === spec.name);
      if (state?.status === "passed" && state.elapsed_ms !== null) {
        typical.set(spec.name, state.elapsed_ms);
        break;
      }
    }
  }
  return typical;
}

export function estimate(
  views: CheckView[],
  specs: CheckSpec[],
  typical: ReadonlyMap<string, number>,
  now: number,
): RunEta {
  const byName = new Map(views.map((view) => [view.name, view]));
  const after = new Map(specs.map((spec) => [spec.name, spec.after]));
  const memo = new Map<string, CheckEta>();

  // The after graph is acyclic once config.ts accepted it, so the recursion
  // ends.
  const remaining = (name: string): CheckEta => {
    const known = memo.get(name);
    if (known !== undefined) return known;
    const result = remainingOf(name);
    memo.set(name, result);
    return result;
  };

  const remainingOf = (name: string): CheckEta => {
    const view = byName.get(name);
    if (view === undefined) return { eta_ms: null, overdue: false };
    if (isSettled(view)) return { eta_ms: 0, overdue: false };
    const usual = typical.get(name);
    if (usual === undefined) return { eta_ms: null, overdue: false };
    if (view.status === "running") {
      if (view.started_at === null) return { eta_ms: null, overdue: false };
      const elapsed = now - Date.parse(view.started_at);
      return elapsed > usual ? { eta_ms: 0, overdue: true } : { eta_ms: usual - elapsed, overdue: false };
    }
    let wait = 0;
    for (const dep of after.get(name) ?? []) {
      const depEta = remaining(dep).eta_ms;
      if (depEta === null) return { eta_ms: null, overdue: false };
      wait = Math.max(wait, depEta);
    }
    return { eta_ms: usual + wait, overdue: false };
  };

  const checks = new Map(views.map((view) => [view.name, remaining(view.name)]));
  let overall: number | null = 0;
  for (const view of views) {
    if (isSettled(view)) continue;
    const eta = checks.get(view.name)!.eta_ms;
    overall = eta === null || overall === null ? null : Math.max(overall, eta);
  }
  return { checks, eta_ms: overall, typical };
}

// Whole seconds above 10 s, where a tenth is noise; one decimal below.
export function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
}
