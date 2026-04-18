// Runtime assertions for invariants. Use these only where an internal invariant
// is load-bearing (branch-pruning in a reducer, post-condition of a
// transformation). User input and untrusted JSON get Zod at the boundary, not
// these.

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// Exhaustiveness helper for discriminated unions. Place in a default/else branch
// to make TypeScript verify every variant is handled; throws if reached at
// runtime (which indicates either a new variant was added without updating this
// switch, or an untyped value snuck past a boundary).
export function assertNever(x: never): never {
  throw new Error(`Unexpected variant: ${String(x)}`)
}
