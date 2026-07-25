// `ulidx`'s monotonic factory is used so ULIDs generated within the same
// millisecond still strictly increase (the random tail increments). The
// module-local factory is shared across all callers in this tab so ordering is
// consistent for in-process generation. Cross-tab ordering is lexicographic via
// the shared timestamp prefix and therefore remains subject to wall-clock skew.

import { monotonicFactory } from 'ulidx'

const monotonic = monotonicFactory()

// Canonical new-ID helper. Always prefer this over calling `ulid()` directly so
// the monotonic guarantee holds across the module.
export function newId(): string {
  return monotonic()
}
