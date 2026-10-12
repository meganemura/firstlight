// Check names as a person types them and as files on disk: the npm-run-all
// glob over package.json script names, the log file name each check gets,
// and the shell quoting of a word. It only computes; reading package.json is
// config.ts's, and creating the files is the store's. No I/O.

// npm-run-all reads "lint:*" as a path glob with ":" for "/", so "*" stays
// inside one segment and "**" crosses them. Only "*" is special here; any
// other character is literal.
export function isPattern(word: string): boolean {
  return word.includes("*");
}

export function patternRegExp(pattern: string): RegExp {
  let source = "";
  for (const part of pattern.split(/(\*+)/)) {
    if (part.length === 0) continue;
    if (part.startsWith("*")) source += part.length === 1 ? "[^:]*" : ".*";
    else source += part.replace(/[\\^$.|?+()[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su");
}

export function matchesPattern(pattern: string, name: string): boolean {
  return patternRegExp(pattern).test(name);
}

// Keeps the order of `names`, which is package.json order, as npm-run-all
// does.
export function expandPattern(pattern: string, names: readonly string[]): string[] {
  const re = patternRegExp(pattern);
  return names.filter((name) => re.test(name));
}

// The supervisor writes its own stderr to supervisor.log beside the check
// logs.
const RESERVED_LOG_BASES = ["supervisor"];
// Leaves room for "-<n>.log" under the usual 255-byte file name limit.
const MAX_LOG_BASE = 100;

export function logBase(name: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, MAX_LOG_BASE);
  return base.length === 0 ? "_" : base;
}

// Two names can map to one file ("a:b" and "a_b"), and on a case-insensitive
// file system "Test" and "test" already do; a later claimant gets "-2",
// "-3", and so on. A name that is already a safe base claims first, so a
// check from firstlight.json keeps `<name>.log` whatever runs beside it.
export function logFileNames(names: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const taken = new Set(RESERVED_LOG_BASES);
  const claim = (name: string): void => {
    if (files.has(name)) return;
    const base = logBase(name);
    let file = base;
    for (let n = 2; taken.has(file.toLowerCase()); n += 1) file = `${base}-${n}`;
    taken.add(file.toLowerCase());
    files.set(name, `${file}.log`);
  };
  for (const name of names) if (logBase(name) === name) claim(name);
  for (const name of names) claim(name);
  return new Map(names.map((name) => [name, files.get(name)!]));
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
