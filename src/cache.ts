// Cache keys for checks and the lookup of a result that an earlier run
// already decided. A key names exactly what a pass depends on as far as
// firstlight can see: the working tree, the check's command, and the keys
// of its `after` checks. Computing the tree key is tree.ts's, and reading
// earlier runs is the store's. No I/O.

import { createHash } from "node:crypto";
import type { CheckSpec, CheckState } from "./checks.ts";

// Bumped when the inputs of a key change meaning, so an old key can never
// match a new one by accident.
const KEY_VERSION = "firstlight-cache-1";

// The check's name is left out: two names for one command on one tree
// prove the same thing. timeoutSec is left out too: a pass that finished
// in time is a pass under any limit that let it finish. Environment
// variables are left out because firstlight cannot know which ones a
// command reads.
export function cacheKey(tree: string, run: string, depKeys: readonly string[]): string {
  const deps = [...depKeys].sort();
  return createHash("sha256").update(JSON.stringify([KEY_VERSION, tree, run, deps])).digest("hex");
}

// The after graph is acyclic once config.ts accepted it, so the recursion
// ends. A dependency outside `specs` cannot come from config.ts or
// resolveRun; it still gets a key of its own rather than none.
export function cacheKeys(specs: readonly CheckSpec[], tree: string): Map<string, string> {
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const keys = new Map<string, string>();
  const keyOf = (name: string): string => {
    const known = keys.get(name);
    if (known !== undefined) return known;
    const spec = byName.get(name);
    const key = spec === undefined ? cacheKey(tree, `missing check ${name}`, []) : cacheKey(tree, spec.run, spec.after.map(keyOf));
    keys.set(name, key);
    return key;
  };
  for (const spec of specs) keyOf(spec.name);
  return new Map(specs.map((spec) => [spec.name, keys.get(spec.name)!]));
}

export interface PastCacheRun {
  id: string;
  keys: Readonly<Record<string, string>>;
  states: CheckState[];
}

export interface Reuse {
  run: string;
  elapsed_ms: number;
  // Absent in a run written before failures were reused: that was a pass.
  status?: "passed" | "failed";
  exit_code?: number;
  // The log of the run that ran a reused failure, which the new run copies.
  log?: string;
}

// The newest pass on the same key is reused. A failure is reused only once
// it has repeated: two runs that really ran the check on the same key
// failed, and no run on that key passed. The first run again after a failure still
// runs, because a failure can come from outside the tree (a service that
// was down, a flaky test) and that run is how an agent finds out; a third
// run of the same failure on the same tree only costs the time to learn
// what it already knows. A failure is decided only when the command itself
// exited non-zero; one that never started, timed out, was cancelled,
// skipped, or unknown proved nothing. A result that was itself reused
// points at the run that really ran the check, so a chain of unchanged
// runs keeps one origin and its real duration.
export function findReuse(keys: ReadonlyMap<string, string>, newestFirst: readonly PastCacheRun[]): Map<string, Reuse> {
  const found = new Map<string, Reuse>();
  for (const [name, key] of keys) {
    const decided = newestFirst.flatMap((past) => {
      const state = past.states.find((candidate) => past.keys[candidate.name] === key && isDecided(candidate));
      return state === undefined ? [] : [{ id: past.id, state }];
    });
    const pass = decided.find((entry) => entry.state.status === "passed");
    if (pass !== undefined) {
      found.set(name, { run: pass.state.cached_from ?? pass.id, elapsed_ms: pass.state.elapsed_ms ?? 0, status: "passed" });
      continue;
    }
    const newest = decided[0];
    if (newest === undefined) continue;
    const ranAndFailed = decided.filter((entry) => entry.state.cached_from === null).length;
    if (newest.state.cached_from !== null || ranAndFailed >= 2) {
      found.set(name, {
        run: newest.state.cached_from ?? newest.id,
        elapsed_ms: newest.state.elapsed_ms ?? 0,
        status: "failed",
        exit_code: newest.state.exit_code!,
      });
    }
  }
  return found;
}

function isDecided(state: CheckState): boolean {
  return state.status === "passed" || (state.status === "failed" && state.exit_code !== null && state.exit_code !== 0);
}
