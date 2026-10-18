// Reading the JSON other processes wrote (firstlight's selector input, the
// recorder's files, V8's coverage), one field at a time. Each reader checks
// the type of every field it uses, so this only has to make a field of any
// value readable. No I/O.

// The parsed text, or undefined for text that is not JSON.
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Text that is not JSON has no fields.
  }
}

// A field of any JSON value. Null and undefined have none, and a named
// field of a primitive or an array reads as undefined, so the caller's type
// check of the field refuses every other shape.
export function field(value: unknown, key: string): unknown {
  return (value as Record<string, unknown> | null | undefined)?.[key];
}
