export class LruMap<Key, Value> {
  readonly #entries = new Map<Key, Value>()
  readonly maxEntries: number

  constructor(maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('LruMap maxEntries must be a positive integer')
    }
    this.maxEntries = maxEntries
  }

  get size(): number {
    return this.#entries.size
  }

  get(key: Key): Value | undefined {
    const value = this.#entries.get(key)
    if (value === undefined && !this.#entries.has(key)) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, value as Value)
    return value
  }

  set(key: Key, value: Value): void {
    this.#entries.delete(key)
    this.#entries.set(key, value)
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }

  delete(key: Key): boolean {
    return this.#entries.delete(key)
  }

  clear(): void {
    this.#entries.clear()
  }

  keys(): IterableIterator<Key> {
    return this.#entries.keys()
  }
}
