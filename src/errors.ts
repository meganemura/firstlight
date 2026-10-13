// Failures of firstlight itself: the error type every module throws, and the
// one place that turns it into the {"error","do"} envelope on stderr.
// A failing check is not this; checks are reported by report.ts.

import { writeSync } from "node:fs";

export class AgentError extends Error {
  readonly next: string;

  constructor(message: string, next: string) {
    super(message);
    this.name = "AgentError";
    this.next = next;
  }
}

export function exitWithEnvelope(err: unknown): never {
  const body =
    err instanceof AgentError
      ? { error: err.message, do: err.next }
      : {
          error: `internal error: ${err instanceof Error ? err.message : String(err)}`,
          do: "rerun the same command; if it repeats, report it with this message",
        };
  writeSync(2, `${JSON.stringify(body)}\n`);
  process.exit(1);
}

// The oldest Node major firstlight is tested on; package.json "engines"
// says the same. Older Nodes are refused up front, so a missing API never
// surfaces later as an unrelated stack trace or a hang.
export const NODE_FLOOR = 24;

export function nodeVersionError(version: string): AgentError | null {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
  if (!Number.isInteger(major) || major >= NODE_FLOOR) return null;
  return new AgentError(
    `firstlight needs Node ${NODE_FLOOR} or newer (found ${version})`,
    `install Node ${NODE_FLOOR} or newer, then rerun the same command`,
  );
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
