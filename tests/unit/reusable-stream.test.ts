import { describe, expect, it } from 'vitest'
import { ReusableStream } from '../../src/lib/reusable-stream'

async function* source<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    await Promise.resolve() // yield the event loop so consumers can interleave
    yield item
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe('ReusableStream', () => {
  it('delivers the same sequence to multiple consumers independently', async () => {
    const rs = new ReusableStream<number>(source([1, 2, 3, 4]))
    const [a, b] = await Promise.all([collect(rs.consume()), collect(rs.consume())])
    expect(a).toEqual([1, 2, 3, 4])
    expect(b).toEqual([1, 2, 3, 4])
  })

  it('late-subscribing consumers still replay from the beginning', async () => {
    const rs = new ReusableStream<number>(source([10, 20, 30]))
    const first = await collect(rs.consume())
    expect(first).toEqual([10, 20, 30])
    const late = await collect(rs.consume())
    expect(late).toEqual([10, 20, 30])
  })

  it('propagates source errors to every consumer', async () => {
    async function* boom(): AsyncGenerator<number> {
      yield 1
      throw new Error('bang')
    }
    const rs = new ReusableStream<number>(boom())
    await expect(collect(rs.consume())).rejects.toThrow(/bang/)
    await expect(collect(rs.consume())).rejects.toThrow(/bang/)
  })
})
