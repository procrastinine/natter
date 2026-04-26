import { describe, expect, it } from 'vitest'
import { parseSearchQuery } from '../../src/core/search-query'

function parsed(raw: string) {
  const result = parseSearchQuery(raw)
  if (!result.ok) throw new Error(result.error.message)
  return result.query
}

describe('search query parser', () => {
  it('parses positive terms', () => {
    const query = parsed('foo bar')
    expect(query.text.map((clause) => clause.value)).toEqual(['foo', 'bar'])
    expect(query.text.every((clause) => !clause.negated)).toBe(true)
  })

  it('parses quoted phrases as one term', () => {
    const query = parsed('"foo bar"')
    expect(query.text).toMatchObject([{ value: 'foo bar', quoted: true, negated: false }])
  })

  it('parses leading-minus negative terms without splitting inline hyphens', () => {
    expect(parsed('-foo').text).toMatchObject([{ value: 'foo', negated: true }])
    expect(parsed('foo-bar').text).toMatchObject([{ value: 'foo-bar', negated: false }])
  })

  it('parses tag, folder, and is clauses', () => {
    const query = parsed('tag:research -tag:draft folder:work is:pinned')
    expect(query.tags).toMatchObject([
      { value: 'research', negated: false },
      { value: 'draft', negated: true },
    ])
    expect(query.folders).toMatchObject([{ value: 'work', negated: false }])
    expect(query.is).toMatchObject([{ value: 'pinned', negated: false }])
  })

  it('allows quoted operator values', () => {
    const query = parsed('tag:"research notes" -folder:"old work"')
    expect(query.tags).toMatchObject([{ value: 'research notes', negated: false }])
    expect(query.folders).toMatchObject([{ value: 'old work', negated: true }])
  })

  it('reports unclosed quotes with a position', () => {
    const result = parseSearchQuery('foo "bar baz')
    expect(result).toMatchObject({
      ok: false,
      error: { position: 4 },
    })
  })

  it('treats unknown is values as literal terms with a warning', () => {
    const query = parsed('is:weird')
    expect(query.warnings).toEqual([{ code: 'unknown-is', value: 'weird', position: 0 }])
    expect(query.text).toMatchObject([{ value: 'is:weird', negated: false }])
  })
})
