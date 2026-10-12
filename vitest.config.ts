// The vitest setup: the default reporter plus depug's, which prints an
// evidence file and a rerun command for each failed test.

import DepugReporter from "@meganemura/depug/reporter";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    reporters: ["default", new DepugReporter()],
    // The CLI tests start real supervisors and wait on real child processes,
    // and a stop alone can take a few seconds.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
