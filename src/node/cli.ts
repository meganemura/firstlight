#!/usr/bin/env node
// The firstlight-node bin: hands its arguments, stdin, and the directory it
// runs in to command.ts and writes back what it answers. Any failure exits
// 1 with one line on stderr, which firstlight shows beside its full run.

import { main } from "./command.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  const outcome = await main(process.argv.slice(2), readStdin, process.cwd());
  process.stdout.write(outcome.stdout);
  process.stderr.write(outcome.stderr);
  process.exitCode = outcome.code;
} catch (err) {
  process.stderr.write(`firstlight-node: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
