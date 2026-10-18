// The vitest setup: the default reporter plus depug's, which prints an
// evidence file and a rerun command for each failed test, and firstlight's
// recorder, which records what each test file runs when firstlight runs the
// suite in full.

import DepugReporter from "@meganemura/depug/reporter";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default", new DepugReporter()],
    setupFiles: ["./src/node/vitest-setup.ts"],
    // The recorder reads V8's coverage, which names a file only when Node
    // loads it itself rather than through vite's module runner.
    experimental: { viteModuleRunner: false },
    // The CLI tests start real supervisors and wait on real child processes,
    // and a stop alone can take a few seconds.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
