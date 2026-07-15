import { describe, expect, it } from 'vitest'
import { BoundedDebugBuffer, encodeJson } from '../../tools/debug-buffer'

describe('bounded debug buffer', () => {
  it('evicts oldest entries by byte and count limits while preserving order', () => {
    const buffer = new BoundedDebugBuffer(3, 5)
    const entry = (label: string, bytes: number) => ({
      label,
      payload: new Uint8Array(bytes),
    })

    buffer.push(entry('a', 2))
    buffer.push(entry('b', 2))
    buffer.push(entry('c', 2))
    expect(buffer.entries().map(({ label }) => label)).toEqual(['b', 'c'])
    expect(buffer.byteLength).toBe(4)

    buffer.push(entry('d', 1))
    buffer.push(entry('e', 1))
    expect(buffer.entries().map(({ label }) => label)).toEqual(['c', 'd', 'e'])
    expect(buffer.byteLength).toBe(4)

    buffer.clear()
    expect(buffer.entries()).toEqual([])
    expect(buffer.length).toBe(0)
    expect(buffer.byteLength).toBe(0)
  })

  it('enforces the cap on UTF-8 bytes and never returns an unserializable value', () => {
    expect(encodeJson('é', 3)).toEqual({ payload: null, reason: 'over-byte-cap' })

    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(encodeJson(circular, 1024)).toEqual({ payload: null, reason: 'unserializable' })
  })
})
