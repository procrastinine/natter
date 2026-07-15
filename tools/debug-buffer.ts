const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface EncodedDebugEntry {
  label: string
  payload: Uint8Array
}

export type EncodedJsonResult =
  | { payload: Uint8Array; reason: 'available' }
  | { payload: null; reason: 'over-byte-cap' | 'unserializable' }

export class BoundedDebugBuffer {
  readonly #slots: Array<EncodedDebugEntry | undefined>
  readonly #maximumBytes: number
  #start = 0
  #count = 0
  #byteLength = 0

  constructor(maximumEntries: number, maximumBytes: number) {
    this.#slots = new Array(maximumEntries)
    this.#maximumBytes = maximumBytes
  }

  get length(): number {
    return this.#count
  }

  get byteLength(): number {
    return this.#byteLength
  }

  push(entry: EncodedDebugEntry): void {
    if (entry.payload.byteLength > this.#maximumBytes) return
    while (
      this.#count > 0 &&
      (this.#count === this.#slots.length ||
        this.#byteLength + entry.payload.byteLength > this.#maximumBytes)
    ) {
      this.#evictOldest()
    }
    const index = (this.#start + this.#count) % this.#slots.length
    this.#slots[index] = entry
    this.#count += 1
    this.#byteLength += entry.payload.byteLength
  }

  clear(): void {
    for (let offset = 0; offset < this.#count; offset += 1) {
      this.#slots[(this.#start + offset) % this.#slots.length] = undefined
    }
    this.#start = 0
    this.#count = 0
    this.#byteLength = 0
  }

  entries(): EncodedDebugEntry[] {
    return this.#sliceFrom(0)
  }

  last(count: number): EncodedDebugEntry[] {
    return this.#sliceFrom(Math.max(0, this.#count - Math.max(0, count)))
  }

  lastEntry(): EncodedDebugEntry | undefined {
    if (this.#count === 0) return undefined
    return this.#slots[(this.#start + this.#count - 1) % this.#slots.length]
  }

  #sliceFrom(firstOffset: number): EncodedDebugEntry[] {
    const result: EncodedDebugEntry[] = []
    for (let offset = firstOffset; offset < this.#count; offset += 1) {
      const entry = this.#slots[(this.#start + offset) % this.#slots.length]
      if (entry) result.push(entry)
    }
    return result
  }

  #evictOldest(): void {
    const entry = this.#slots[this.#start]
    if (entry) this.#byteLength -= entry.payload.byteLength
    this.#slots[this.#start] = undefined
    this.#start = (this.#start + 1) % this.#slots.length
    this.#count -= 1
  }
}

export function encodeDebugEntry(
  label: string,
  payload: unknown,
  maximumPayloadBytes: number,
): EncodedDebugEntry {
  const encoded = encodeJson(payload, maximumPayloadBytes)
  if (encoded.payload) return { label, payload: encoded.payload }
  return {
    label,
    payload: encoder.encode(
      JSON.stringify({
        debugCapture: 'omitted',
        reason: encoded.reason,
        maximumPayloadBytes,
      }),
    ),
  }
}

export function encodeJson(value: unknown, maximumBytes: number): EncodedJsonResult {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    return { payload: null, reason: 'unserializable' }
  }
  if (json === undefined) return { payload: null, reason: 'unserializable' }
  if (json.length > maximumBytes) return { payload: null, reason: 'over-byte-cap' }
  const payload = encoder.encode(json)
  if (payload.byteLength > maximumBytes) return { payload: null, reason: 'over-byte-cap' }
  return { payload, reason: 'available' }
}

export function decodeDebugPayload(payload: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(payload)) as unknown
  } catch {
    return { debugCapture: 'unreadable' }
  }
}

export function dumpDebugEntries(entries: readonly EncodedDebugEntry[]): string {
  return entries.map((entry) => `${entry.label} ${decoder.decode(entry.payload)}`).join('\n')
}
