// The names a recording is written under, shared by the recorder and the
// selector. Only constants: the recorder imports this before it starts
// V8's coverage, and V8 under-reports the functions of a module that loaded
// before then, so nothing here may hold code a test runs.

// firstlight's name for the variable, as selection.ts sets it. The recorder
// does not import selection.ts, because its functions would then go
// unrecorded in this repository's own suite.
export const RECORD_ENV = "FIRSTLIGHT_RECORD";
// The file each finished test gets a line in, as tests.ts names it.
export const TESTS_ENV = "FIRSTLIGHT_TESTS";

// Under $FIRSTLIGHT_RECORD: one directory per test file under RAW_DIR,
// holding TEST_MARKER and any number of coverage files, the worker's own
// and one for each process the test started, and after the first
// selection MAP_FILE in their place.
export const RAW_DIR = "raw";
export const TEST_MARKER = "test.json";
export const MAP_FILE = "map.json";
