// Properties of `after` validation: every acyclic graph is accepted as
// written, and every graph with a cycle is rejected with a cycle that is
// really in the graph.

import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { checkLikeScripts, configText as initConfigText, DEFAULT_TIMEOUT_SEC, FALLBACK_SCRIPTS, parseConfig, suggestTimeoutSec } from "../src/config.ts";
import { AgentError } from "../src/errors.ts";

type Graph = Map<string, Set<string>>;

// Edges only point from a later name to an earlier one, so the graph is a
// DAG; the key order is shuffled so validation cannot rely on it.
function drawDag(tc: hegel.TestCase): { order: string[]; graph: Graph } {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
  const names = Array.from({ length: count }, (_, i) => `c${i}`);
  const graph: Graph = new Map();
  names.forEach((name, i) => {
    const after = new Set<string>();
    for (let j = 0; j < i; j += 1) if (tc.draw(gs.booleans())) after.add(names[j]!);
    graph.set(name, after);
  });
  const pool = [...names];
  const order: string[] = [];
  while (pool.length > 0) {
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: pool.length - 1 }));
    order.push(pool.splice(index, 1)[0]!);
  }
  return { order, graph };
}

function configText(order: string[], graph: Graph): string {
  const checks: Record<string, { run: string; after: string[] }> = {};
  for (const name of order) checks[name] = { run: "true", after: [...graph.get(name)!] };
  return JSON.stringify({ checks });
}

test("every generated DAG is accepted with its after lists intact", () => {
  hegel.test(
    (tc) => {
      const { order, graph } = drawDag(tc);
      const checks = parseConfig(configText(order, graph), "firstlight.json");
      assert.deepEqual(
        checks.map((check) => [check.name, [...check.after].sort()]),
        order.map((name) => [name, [...graph.get(name)!].sort()]),
      );
    },
    { testCases: 200 },
  );
});

test("every generated cycle is rejected, and the reported cycle is in the graph", () => {
  hegel.test(
    (tc) => {
      const { order, graph } = drawDag(tc);
      const length = tc.draw(gs.integers({ minValue: 1, maxValue: order.length }));
      const loop: string[] = [];
      const pool = [...order];
      for (let i = 0; i < length; i += 1) {
        const index = tc.draw(gs.integers({ minValue: 0, maxValue: pool.length - 1 }));
        loop.push(pool.splice(index, 1)[0]!);
      }
      loop.forEach((name, i) => graph.get(name)!.add(loop[(i + 1) % loop.length]!));

      let error: unknown;
      try {
        parseConfig(configText(order, graph), "firstlight.json");
      } catch (err) {
        error = err;
      }
      assert.ok(error instanceof AgentError, "a cyclic graph was accepted");
      const match = /"after" has a cycle: (.+)$/.exec(error.message);
      assert.ok(match !== null, error.message);
      const reported = match[1]!.split(" -> ");
      assert.equal(reported[0], reported.at(-1));
      for (let i = 0; i + 1 < reported.length; i += 1) {
        assert.ok(graph.get(reported[i]!)!.has(reported[i + 1]!), `${reported[i]} is not after ${reported[i + 1]}`);
      }
    },
    { testCases: 200 },
  );
});

test("the check-like scripts keep package.json order and leave out the fallback scripts and every other name", () => {
  const words = ["lint", "typecheck", "test", "check", "archstrict", "build", "prepack", "checks", "testing"];
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
    const scripts = [
      ...new Set(
        Array.from({ length: count }, () => {
          const head = tc.draw(gs.sampledFrom(words));
          return tc.draw(gs.booleans()) ? `${head}:${tc.draw(gs.sampledFrom(words))}` : head;
        }),
      ),
    ];
    const picked = checkLikeScripts(scripts);
    assert.deepEqual(picked, scripts.filter((name) => picked.includes(name)));
    for (const name of scripts) {
      const head = name.split(":")[0]!;
      const fallback = (FALLBACK_SCRIPTS as readonly string[]).includes(name);
      const checkLike = ["lint", "typecheck", "test", "check", "archstrict"].includes(head);
      assert.equal(picked.includes(name), checkLike && !fallback, name);
    }
  });
});

test("the firstlight.json init writes reads back as the same checks", () => {
  hegel.test((tc) => {
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
    const checks = Array.from({ length: count }, (_, i) => {
      const name = tc.draw(gs.sampledFrom(["lint", "test", "check:arch", "a.b", "x-y"])) + i;
      const timeoutSec = tc.draw(gs.sampledFrom([DEFAULT_TIMEOUT_SEC, 60, 900]));
      const parser = tc.draw(gs.sampledFrom([undefined, "tsc", "vitest", "node-test", "archstrict"]));
      const check = { name, run: `npm run ${name}`, after: [] as string[], timeoutSec };
      return parser === undefined ? check : { ...check, parser };
    });
    assert.deepEqual(parseConfig(initConfigText(checks), "firstlight.json"), checks);
  });
});

test("a suggested timeout is in whole minutes, past the default, and at least three times the pass", () => {
  hegel.test((tc) => {
    const ms = tc.draw(gs.integers({ minValue: 0, maxValue: 3_600_000 }));
    const seconds = suggestTimeoutSec(ms);
    if (ms * 3 <= DEFAULT_TIMEOUT_SEC * 1000) {
      assert.equal(seconds, null);
    } else {
      assert.ok(seconds !== null && seconds % 60 === 0 && seconds > DEFAULT_TIMEOUT_SEC && seconds * 1000 >= ms * 3, String(seconds));
    }
  });
});
