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
  // one, never a higher one. The part says which side of the selector
  // protocol a file is on: firstlight's core, the protocol itself, or the
  // Node selector, which speaks only the protocol. Inside the Node selector,
  // the recorder and the file names it shares with the command are parts of
  // their own, so that the recorder can import nothing else of src/.
  classify: [
    { glob: "src/baseline.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/cache.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/checks.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/diagnostics.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/eta.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/names.ts", tags: ["layer:machine", "part:core"] },
    { glob: "src/selection.ts", tags: ["layer:machine", "part:protocol"] },
    { glob: "src/config.ts", tags: ["layer:base", "part:core"] },
    { glob: "src/errors.ts", tags: ["layer:base", "part:core"] },
    { glob: "src/processes.ts", tags: ["layer:base", "part:core"] },
    { glob: "src/store.ts", tags: ["layer:base", "part:core"] },
    { glob: "src/tree.ts", tags: ["layer:base", "part:core"] },
    { glob: "src/report.ts", tags: ["layer:run", "part:core"] },
    { glob: "src/supervisor.ts", tags: ["layer:run", "part:core"] },
    { glob: "src/cli.ts", tags: ["layer:entry", "part:core"] },
    { glob: "src/node/**", tags: ["layer:adapter", "part:node"] },
    { glob: "src/node/layout.ts", tags: ["layer:adapter", "part:node-layout"] },
    { glob: "src/node/vitest-setup.ts", tags: ["layer:adapter", "part:node-recorder"] },
  ],
  // One module per source file, so every import between two files of src/
  // is checked. After an edit, run archstrict init to regenerate
  // archstrict.types.ts.
  declaredModules: [
    // Each directory and TypeScript source file directly in src/.
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
    { name: "selection.ts", glob: "src/selection.ts", surface: "selection.ts" },
    { name: "store.ts", glob: "src/store.ts", surface: "store.ts" },
    { name: "supervisor.ts", glob: "src/supervisor.ts", surface: "supervisor.ts" },
    { name: "tree.ts", glob: "src/tree.ts", surface: "tree.ts" },
    // The Node selector: the vitest recorder and the firstlight-node command.
    // It has no surface file, so nothing outside it may import it.
    { name: "node", glob: "src/node/**" },
    // Each other top-level directory that holds TypeScript source, and each top-level TypeScript source file.
    { name: "vitest.config.ts", glob: "vitest.config.ts", surface: "vitest.config.ts" },
  ],
  // No frozen debt. A later violation in any of these fails check rather
  // than landing in the todo file.
  strict: [
    "baseline.ts",
    "cache.ts",
    "checks.ts",
    "cli.ts",
    "config.ts",
    "diagnostics.ts",
    "errors.ts",
    "eta.ts",
    "names.ts",
    "node",
    "processes.ts",
    "report.ts",
    "selection.ts",
    "store.ts",
    "supervisor.ts",
    "tree.ts",
    "vitest.config.ts",
  ],
  edges: {
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["machine", "base", "run", "entry", "adapter"] },
        direction: "downward-only",
        because:
          "checks.ts is the pure state machine everything else folds through, eta.ts the pure estimate on top of it, baseline.ts the pure comparison of a run's failures with an earlier run's, cache.ts the pure cache keys and reuse lookup, selection.ts the pure selector protocol (when to ask a selector, its answer, and the narrowed command), diagnostics.ts the pure log parsers and parser inference, and names.ts the pure glob and log-file naming; config, errors, processes, store, and tree do the I/O; report and supervisor build on them; cli.ts is the entry and nothing imports it; src/node is a selector firstlight runs as a command, so nothing in the core may import it",
      },
    ],
    allowDeny: [
      {
        source: "part:node",
        targetNamespace: "part",
        allow: ["protocol", "node-layout"],
        because:
          "the Node selector is one language's plug-in, and the selector protocol in selection.ts is the only thing it shares with firstlight; another language's selector gets no more than that",
      },
      {
        source: "part:node-recorder",
        targetNamespace: "part",
        allow: ["node-layout"],
        because:
          "the recorder starts V8's coverage, and V8 under-reports the functions of a module that loaded before then, so a file of src/ the recorder imports drops out of the map and a change to it selects too few tests; layout.ts holds only constants",
      },
    ],
  },
  because:
    "src/ is a handful of files, so each file is its own module and every import between two of them is checked, and src/node, the Node selector, is one module of its own. The layer order keeps the state machine and the other pure parts free of I/O and keeps the CLI entry on top; the part rule keeps the Node selector on the far side of the selector protocol.",
} satisfies Config;
