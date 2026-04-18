// Multicasting primitive so multiple lane extractors (text, reasoning,
// tool-calls, meta) can iterate the same upstream stream independently without
// starving each other. See `plan/04-api-client.md §4.7`.
//
// The underlying generator is pumped once; chunks are buffered in memory and
// each consumer reads at its own offset. When the source ends, consumers drain
// the remaining buffer and then return; an error from the source is re-raised
// into every live consumer.

export class ReusableStream<T> {
  private buffer: T[] = []
  private consumers: Array<{ offset: number; wake: () => void }> = []
  private finished = false
  private error: unknown

  constructor(source: AsyncIterable<T>) {
    void this.pump(source)
  }

  private async pump(source: AsyncIterable<T>): Promise<void> {
    try {
      for await (const chunk of source) {
        this.buffer.push(chunk)
        for (const c of this.consumers) c.wake()
      }
    } catch (e) {
      this.error = e
    } finally {
      this.finished = true
      for (const c of this.consumers) c.wake()
    }
  }

  async *consume(): AsyncGenerator<T> {
    const me = { offset: 0, wake: () => {} }
    this.consumers.push(me)
    try {
      while (true) {
        while (me.offset < this.buffer.length) {
          const next = this.buffer[me.offset]
          me.offset += 1
          yield next as T
        }
        if (this.finished) {
          if (this.error !== undefined) throw this.error
          return
        }
        await new Promise<void>((resolve) => {
          me.wake = resolve
        })
      }
    } finally {
      const idx = this.consumers.indexOf(me)
      if (idx !== -1) this.consumers.splice(idx, 1)
    }
  }
}
