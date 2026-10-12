// The check status state machine and the event vocabulary built on it.
// The supervisor advances a check only through `advance`, and readers fold
// events.jsonl through the same transition table, so the file can never
// describe a path the machine does not allow. This module does no I/O.

export type CheckStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";

// `unknown` is never written. It is derived when the supervisor is gone and
// the check never reached a terminal status.
export type ReportedStatus = CheckStatus | "unknown";

const TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  pending: ["running", "skipped", "cancelled"],
  running: ["passed", "failed", "timed_out", "cancelled"],
  passed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  skipped: [],
};

export const CHECK_STATUSES = Object.keys(TRANSITIONS) as CheckStatus[];

export function isTerminal(status: CheckStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canAdvance(from: CheckStatus, to: CheckStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface CheckSpec {
  name: string;
  run: string;
  after: string[];
  timeoutSec: number;
}

export interface CheckEvent {
  type: "check";
  check: string;
  status: CheckStatus;
  pid?: number;
  exit_code?: number | null;
  at: string;
  elapsed_ms?: number;
}

export type RunOutcome = "done" | "cancelled";

export interface RunEvent {
  type: "run";
  status: RunOutcome;
  at: string;
}

export type RunEventLine = CheckEvent | RunEvent;

export interface CheckState {
  name: string;
  status: CheckStatus;
  pid: number | null;
  exit_code: number | null;
  started_at: string | null;
  elapsed_ms: number | null;
}

export function initialState(name: string): CheckState {
  return { name, status: "pending", pid: null, exit_code: null, started_at: null, elapsed_ms: null };
}

export class IllegalTransition extends Error {
  constructor(check: string, from: CheckStatus, to: CheckStatus) {
    super(`check ${check} cannot go from ${from} to ${to}`);
    this.name = "IllegalTransition";
  }
}

export function advance(state: CheckState, event: CheckEvent): CheckState {
  if (!canAdvance(state.status, event.status)) {
    throw new IllegalTransition(state.name, state.status, event.status);
  }
  return {
    name: state.name,
    status: event.status,
    pid: event.pid ?? state.pid,
    exit_code: event.exit_code !== undefined ? event.exit_code : state.exit_code,
    started_at: event.status === "running" ? event.at : state.started_at,
    elapsed_ms: event.elapsed_ms ?? state.elapsed_ms,
  };
}

export interface FoldedRun {
  checks: CheckState[];
  outcome: RunOutcome | null;
}

export function foldEvents(names: string[], events: RunEventLine[]): FoldedRun {
  const states = new Map(names.map((name) => [name, initialState(name)]));
  let outcome: RunOutcome | null = null;
  for (const event of events) {
    if (event.type === "run") {
      outcome = event.status;
      continue;
    }
    const current = states.get(event.check);
    if (current === undefined) {
      throw new IllegalTransition(event.check, "pending", event.status);
    }
    states.set(event.check, advance(current, event));
  }
  return { checks: names.map((name) => states.get(name)!), outcome };
}

export interface CheckView {
  name: string;
  status: ReportedStatus;
  exit_code: number | null;
  elapsed_ms: number | null;
  started_at: string | null;
  pid: number | null;
  orphan: boolean;
}

// Supervisor liveness is passed in rather than probed here, so the rule
// stays a pure function: a non-terminal check of a run whose supervisor is
// gone and that never wrote its final event has an unknown result.
export function presentChecks(run: FoldedRun, supervisorAlive: boolean): CheckView[] {
  const orphaned = run.outcome === null && !supervisorAlive;
  return run.checks.map((state) => {
    const orphan = orphaned && !isTerminal(state.status);
    return {
      name: state.name,
      status: orphan ? "unknown" : state.status,
      exit_code: state.exit_code,
      elapsed_ms: state.elapsed_ms,
      started_at: state.started_at,
      pid: state.pid,
      orphan,
    };
  });
}

export type Bucket = "passed" | "failed" | "running" | "cancelled";

export function bucketOf(status: ReportedStatus): Bucket {
  switch (status) {
    case "passed":
      return "passed";
    case "pending":
    case "running":
      return "running";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "skipped":
    case "unknown":
      return "failed";
  }
}

export function isSettled(view: CheckView): boolean {
  return view.status === "unknown" || isTerminal(view.status);
}
