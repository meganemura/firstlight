import type { Config } from "./archstrict.types.js";

// Public surface: other modules may import a directory module only through
// its own surface file (named by `surface` below), or through the files its own
// package.json exports map names. An import that reaches any other file in
// the directory is a violation. A directory module with no such file is
// entirely private. A module whose glob names one file is that file, so its
// entry names the file itself as its surface.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  // Kept out of analysis entirely:
  // - archstrict's own two files, which are never module content;
  // - hidden directories at any depth (.git, tool state), which tsc's own
  //   default include also skips;
  // - common noise directories that init found on disk (test, tmp), and
  //   the nukadoko scenarios (features, nukadoko.config.ts), which test
  //   the CLI like test/ does.
  //   Remove one of these entries if that directory holds module content.
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
    "tmp/**",
    "features/**",
    "nukadoko.config.ts",
  ],
  // The layers, bottom to top. A file may import its own layer or a lower
  // one, never a higher one.
  classify: [
    { glob: "src/affected.ts", tags: ["layer:machine"] },
    { glob: "src/baseline.ts", tags: ["layer:machine"] },
    { glob: "src/cache.ts", tags: ["layer:machine"] },
    { glob: "src/checks.ts", tags: ["layer:machine"] },
    { glob: "src/diagnostics.ts", tags: ["layer:machine"] },
    { glob: "src/eta.ts", tags: ["layer:machine"] },
    { glob: "src/names.ts", tags: ["layer:machine"] },
    { glob: "src/config.ts", tags: ["layer:base"] },
    { glob: "src/errors.ts", tags: ["layer:base"] },
    { glob: "src/processes.ts", tags: ["layer:base"] },
    { glob: "src/store.ts", tags: ["layer:base"] },
    { glob: "src/tree.ts", tags: ["layer:base"] },
    { glob: "src/report.ts", tags: ["layer:run"] },
    { glob: "src/supervisor.ts", tags: ["layer:run"] },
    { glob: "src/cli.ts", tags: ["layer:entry"] },
  ],
  // One module per source file, so every import between two files of src/
  // is checked. After an edit, run archstrict init to regenerate
  // archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
    { name: "affected.ts", glob: "src/affected.ts", surface: "affected.ts" },
    { name: "baseline.ts", glob: "src/baseline.ts", surface: "baseline.ts" },
    { name: "cache.ts", glob: "src/cache.ts", surface: "cache.ts" },
    { name: "checks.ts", glob: "src/checks.ts", surface: "checks.ts" },
    { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
    { name: "config.ts", glob: "src/config.ts", surface: "config.ts" },
    { name: "diagnostics.ts", glob: "src/diagnostics.ts", surface: "diagnostics.ts" },
    { name: "eta.ts", glob: "src/eta.ts", surface: "eta.ts" },
    { name: "names.ts", glob: "src/names.ts", surface: "names.ts" },
    { name: "errors.ts", glob: "src/errors.ts", surface: "errors.ts" },
    { name: "processes.ts", glob: "src/processes.ts", surface: "processes.ts" },
    { name: "report.ts", glob: "src/report.ts", surface: "report.ts" },
    { name: "store.ts", glob: "src/store.ts", surface: "store.ts" },
    { name: "supervisor.ts", glob: "src/supervisor.ts", surface: "supervisor.ts" },
    { name: "tree.ts", glob: "src/tree.ts", surface: "tree.ts" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "vitest.config.ts", glob: "vitest.config.ts", surface: "vitest.config.ts" },
  ],
  // No frozen debt. A later violation in any of these fails check rather
  // than landing in the todo file.
  strict: [
    "affected.ts",
    "baseline.ts",
    "cache.ts",
    "checks.ts",
    "cli.ts",
    "config.ts",
    "diagnostics.ts",
    "errors.ts",
    "eta.ts",
    "names.ts",
    "processes.ts",
    "report.ts",
    "store.ts",
    "supervisor.ts",
    "tree.ts",
    "vitest.config.ts",
  ],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["machine", "base", "run", "entry"] },
        direction: "downward-only",
        because:
          "checks.ts is the pure state machine everything else folds through, eta.ts the pure estimate on top of it, baseline.ts the pure comparison of a run's failures with an earlier run's, cache.ts the pure cache keys and reuse lookup, affected.ts the pure narrowing of a check to the changed files, diagnostics.ts the pure log parsers and parser inference, and names.ts the pure glob and log-file naming; config, errors, processes, store, and tree do the I/O; report and supervisor build on them; cli.ts is the entry and nothing imports it",
      },
    ],
  },
  because:
    "src/ is a handful of files, so each file is its own module and every import between two of them is checked. The layer order keeps the state machine and the other pure parts free of I/O and keeps the CLI entry on top.",
} satisfies Config;
