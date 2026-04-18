import { describe, expect, it } from 'vitest'
import { modelsCacheKey } from '../../src/core/cache-keys'

describe('modelsCacheKey', () => {
  it('differs when supportedParameters differs', () => {
    const a = modelsCacheKey({ supportedParameters: ['tools'] })
    const b = modelsCacheKey({ supportedParameters: ['tools', 'response_format'] })
    expect(a).not.toEqual(b)
  })

  it('differs when outputModalities differs', () => {
    const a = modelsCacheKey({ outputModalities: ['text'] })
    const b = modelsCacheKey({ outputModalities: ['text', 'image'] })
    expect(a).not.toEqual(b)
  })

  it('is stable regardless of array order', () => {
    const a = modelsCacheKey({ supportedParameters: ['tools', 'response_format'] })
    const b = modelsCacheKey({ supportedParameters: ['response_format', 'tools'] })
    expect(a).toEqual(b)
  })

  it('dedupes and trims supportedParameters entries', () => {
    const a = modelsCacheKey({ supportedParameters: ['tools', ' tools ', 'tools'] })
    const b = modelsCacheKey({ supportedParameters: ['tools'] })
    expect(a).toEqual(b)
  })

  it('empty and undefined query collapse to the same key', () => {
    const a = modelsCacheKey({})
    const b = modelsCacheKey({ outputModalities: [], supportedParameters: [] })
    expect(a).toEqual(b)
  })

  it('is stable regardless of top-level key order', () => {
    const a = modelsCacheKey({
      outputModalities: ['text'],
      supportedParameters: ['tools'],
    })
    const b = modelsCacheKey({
      supportedParameters: ['tools'],
      outputModalities: ['text'],
    })
    expect(a).toEqual(b)
  })
})
