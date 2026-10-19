// The test check of this repository's firstlight.json, as the evaluation
// scripts replay it: the selector's arguments from "select" on, the options
// they stand for, and fullOn. Reading the check itself, rather than taking
// flags, keeps each measurement about the selection firstlight really runs.

import { readFileSync } from "node:fs";
import path from "node:path";

export function testCheck(root) {
  const check = JSON.parse(readFileSync(path.join(root, "firstlight.json"), "utf8")).checks.test;
  const words = check.select.match(/'[^']*'|\S+/g).map((word) => word.replace(/^'(.*)'$/s, "$1"));
  const args = words.slice(words.indexOf("select"));
  const options = { always: [], ignore: [] };
  for (let i = 1; i < args.length; i += 2) options[args[i] === "--always" ? "always" : "ignore"].push(args[i + 1]);
  return { args, options, fullOn: check.fullOn ?? [] };
}
