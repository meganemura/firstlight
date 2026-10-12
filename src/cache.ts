// Cache keys for checks and the lookup of a pass that an earlier run
// already proved. A key names exactly what a pass depends on as far as
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
}

// Only a pass is reused: a failure may be flaky, and a timed-out, cancelled,
// skipped, or unknown check proved nothing. A pass that was itself reused
// points at the run that really ran the check, so a chain of unchanged runs
// keeps one origin and its real duration.
export function findReuse(keys: ReadonlyMap<string, string>, newestFirst: readonly PastCacheRun[]): Map<string, Reuse> {
  const found = new Map<string, Reuse>();
  for (const [name, key] of keys) {
    for (const past of newestFirst) {
      const state = past.states.find((candidate) => past.keys[candidate.name] === key && candidate.status === "passed");
      if (state === undefined) continue;
      found.set(name, { run: state.cached_from ?? past.id, elapsed_ms: state.elapsed_ms ?? 0 });
      break;
    }
  }
  return found;
}
