import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_ORIGINS, isImageOriginAllowed } from '../../src/core/image-allowlist'
import { normalizeOrigin } from '../../src/ui/settings/ImageAllowlistPanel'

describe('image-allowlist defaults', () => {
  it('allows built-in https origins exactly', () => {
    expect(isImageOriginAllowed('https://openrouter.ai/logo.png', DEFAULT_IMAGE_ORIGINS)).toBe(true)
  })

  it('allows subdomains under wildcard entries', () => {
    expect(isImageOriginAllowed('https://cdn.huggingface.co/pic.png', DEFAULT_IMAGE_ORIGINS)).toBe(
      true,
    )
    expect(isImageOriginAllowed('https://files.openrouter.ai/pic.png', DEFAULT_IMAGE_ORIGINS)).toBe(
      true,
    )
  })

  it('accepts data: URIs and blob: URLs', () => {
    expect(
      isImageOriginAllowed('data:image/png;base64,iVBORw0KGgoAAAANS', DEFAULT_IMAGE_ORIGINS),
    ).toBe(true)
    expect(isImageOriginAllowed('blob:https://openrouter.ai/abc-123', DEFAULT_IMAGE_ORIGINS)).toBe(
      true,
    )
  })

  it('blocks other origins', () => {
    expect(isImageOriginAllowed('https://evil.example.com/pixel.gif', DEFAULT_IMAGE_ORIGINS)).toBe(
      false,
    )
    expect(isImageOriginAllowed('http://openrouter.ai/insecure.png', DEFAULT_IMAGE_ORIGINS)).toBe(
      false,
    )
  })

  it('respects user-added origins appended to the list', () => {
    const augmented = [...DEFAULT_IMAGE_ORIGINS, 'https://cdn.mysite.example']
    expect(isImageOriginAllowed('https://cdn.mysite.example/one.png', augmented)).toBe(true)
  })
})

describe('normalizeOrigin', () => {
  it('lower-cases and strips a trailing slash', () => {
    expect(normalizeOrigin('https://Example.com/')).toBe('https://example.com')
  })

  it('adds https scheme when none is supplied', () => {
    expect(normalizeOrigin('example.com')).toBe('https://example.com')
  })

  it('leaves wildcard patterns intact', () => {
    expect(normalizeOrigin('*.example.com')).toBe('https://*.example.com')
  })

  it('preserves data: and blob: prefixes', () => {
    expect(normalizeOrigin('data:image/png;base64,abc')).toBe('data:image/png;base64,abc')
    expect(normalizeOrigin('blob:https://host/xyz')).toBe('blob:https://host/xyz')
  })

  it('returns null for empty input', () => {
    expect(normalizeOrigin('')).toBe(null)
    expect(normalizeOrigin('   ')).toBe(null)
  })
})
