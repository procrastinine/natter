type SearchKnownIsValue = 'pinned' | 'archived' | 'untitled'

export interface SearchTextClause {
  kind: 'text'
  value: string
  negated: boolean
  quoted: boolean
  position: number
  raw: string
}

export interface SearchNameClause {
  value: string
  negated: boolean
  position: number
  raw: string
}

interface SearchIsClause {
  value: SearchKnownIsValue
  negated: boolean
  position: number
  raw: string
}

interface SearchQueryWarning {
  code: 'unknown-is'
  value: string
  position: number
}

export interface SearchQuery {
  raw: string
  text: SearchTextClause[]
  tags: SearchNameClause[]
  folders: SearchNameClause[]
  is: SearchIsClause[]
  warnings: SearchQueryWarning[]
}

export interface SearchQueryParseError {
  message: string
  position: number
}

type SearchQueryParseResult =
  | { ok: true; query: SearchQuery }
  | { ok: false; error: SearchQueryParseError }

interface Token {
  value: string
  negated: boolean
  quoted: boolean
  position: number
  raw: string
}

const IS_VALUES = new Set<SearchKnownIsValue>(['pinned', 'archived', 'untitled'])

export function parseSearchQuery(raw: string): SearchQueryParseResult {
  const tokens = tokenizeSearchQuery(raw)
  if (!tokens.ok) return tokens

  const query: SearchQuery = {
    raw,
    text: [],
    tags: [],
    folders: [],
    is: [],
    warnings: [],
  }

  for (const token of tokens.tokens) {
    if (token.value.length === 0) continue
    const operatorIndex = token.value.indexOf(':')
    if (operatorIndex <= 0) {
      query.text.push(textClause(token))
      continue
    }

    const operator = token.value.slice(0, operatorIndex).toLocaleLowerCase()
    const value = token.value.slice(operatorIndex + 1).trim()
    if (value.length === 0) {
      query.text.push(textClause(token))
      continue
    }

    if (operator === 'tag') {
      query.tags.push(nameClause(token, value))
      continue
    }
    if (operator === 'folder') {
      query.folders.push(nameClause(token, value))
      continue
    }
    if (operator === 'is') {
      const lowered = value.toLocaleLowerCase()
      if (IS_VALUES.has(lowered as SearchKnownIsValue)) {
        query.is.push({
          value: lowered as SearchKnownIsValue,
          negated: token.negated,
          position: token.position,
          raw: token.raw,
        })
      } else {
        query.warnings.push({ code: 'unknown-is', value, position: token.position })
        query.text.push(textClause({ ...token, value: `is:${value}` }))
      }
      continue
    }

    query.text.push(textClause(token))
  }

  return { ok: true, query }
}

function tokenizeSearchQuery(
  raw: string,
): { ok: true; tokens: Token[] } | { ok: false; error: SearchQueryParseError } {
  const tokens: Token[] = []
  let index = 0
  while (index < raw.length) {
    while (index < raw.length && isWhitespace(raw[index] ?? '')) index += 1
    if (index >= raw.length) break

    const start = index
    let negated = false
    if (raw[index] === '-' && index + 1 < raw.length && !isWhitespace(raw[index + 1] ?? '')) {
      negated = true
      index += 1
    }

    let value = ''
    let quoted = false
    while (index < raw.length && !isWhitespace(raw[index] ?? '')) {
      const char = raw[index] ?? ''
      if (char !== '"') {
        value += char
        index += 1
        continue
      }

      quoted = true
      const quotePosition = index
      index += 1
      while (index < raw.length && raw[index] !== '"') {
        value += raw[index] ?? ''
        index += 1
      }
      if (index >= raw.length) {
        return {
          ok: false,
          error: { message: 'Unclosed quote in search query.', position: quotePosition },
        }
      }
      index += 1
    }

    tokens.push({
      value,
      negated,
      quoted,
      position: start,
      raw: raw.slice(start, index),
    })
  }
  return { ok: true, tokens }
}

function textClause(token: Token): SearchTextClause {
  return {
    kind: 'text',
    value: token.value,
    negated: token.negated,
    quoted: token.quoted,
    position: token.position,
    raw: token.raw,
  }
}

function nameClause(token: Token, value: string): SearchNameClause {
  return {
    value,
    negated: token.negated,
    position: token.position,
    raw: token.raw,
  }
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char)
}
