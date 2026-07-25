import type { ChatId, MessageId } from './types'

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

interface CompiledSearchTextClause {
  readonly clause: SearchTextClause
  readonly needle: string
}

export interface CompiledSearchText {
  readonly clauses: readonly CompiledSearchTextClause[]
  readonly hasPositive: boolean
  readonly hasNegative: boolean
}

export interface SearchTextMatch {
  readonly index: number
  readonly length: number
}

interface SearchTextRange {
  readonly start: number
  readonly end: number
}

export interface LiteralSearchRanges {
  readonly ranges: readonly SearchTextRange[]
  readonly totalCount: number
}

export interface SearchTextScan {
  readonly clauseHits: readonly boolean[]
  readonly matches: boolean
  readonly firstPositive: SearchTextMatch | null
  readonly length: number
}

export type SearchTextMatchSummary = Omit<SearchTextScan, 'clauseHits'>

interface MessageCorpusSearchPrefixField {
  readonly key: string
  readonly text: string
}

export interface MessageCorpusSearchRequest {
  readonly chatId: ChatId
  readonly clauses: readonly SearchTextClause[]
  readonly prefixFields?: readonly MessageCorpusSearchPrefixField[]
  readonly collectMatchingMessageIds?: boolean
}

export interface MessageCorpusSearchExcerpt {
  readonly messageId: MessageId
  readonly text: string
  readonly matchIndex: number
  readonly matchLength: number
  readonly messageMatchIndex: number
  readonly prefixTruncated: boolean
  readonly suffixTruncated: boolean
}

export interface MessageCorpusSearchResult {
  readonly clauseHits: readonly boolean[]
  readonly matchingMessageIds: readonly MessageId[]
  readonly newestMatchingMessageId?: MessageId
  readonly newestPositiveMessageId?: MessageId
  readonly firstPositiveExcerpt?: MessageCorpusSearchExcerpt
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
const SEARCH_TEXT_CHUNK_CHARS = 64 * 1024
const SEARCH_AUTOMATA = new WeakMap<CompiledSearchText, SearchAutomaton>()

interface SearchAutomatonNode {
  readonly transitions: Map<string, number>
  readonly outputs: number[]
  failure: number
  outputLink: number
}

interface SearchAutomaton {
  readonly nodes: readonly SearchAutomatonNode[]
}

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

export function compileSearchText(clauses: readonly SearchTextClause[]): CompiledSearchText {
  const compiled = clauses.map((clause) => ({
    clause,
    needle: clause.value.toLocaleLowerCase(),
  }))
  const result: CompiledSearchText = {
    clauses: compiled,
    hasPositive: clauses.some((clause) => !clause.negated),
    hasNegative: clauses.some((clause) => clause.negated),
  }
  SEARCH_AUTOMATA.set(result, buildSearchAutomaton(result))
  return result
}

export function literalSearchText(value: string): CompiledSearchText {
  return compileSearchText([literalSearchClause(value)])
}

export function literalSearchClause(value: string): SearchTextClause {
  return {
    kind: 'text',
    value,
    negated: false,
    quoted: true,
    position: 0,
    raw: value,
  }
}

export class IncrementalSearchTextScanner {
  private readonly compiled: CompiledSearchText
  private readonly automaton: SearchAutomaton
  private readonly hits: boolean[]
  private readonly reportedTerminals: Int32Array
  private readonly touchedHits: number[] = []
  private readonly touchedTerminals: number[] = []
  private readonly baseMissingPositiveCount: number
  private readonly baseNegativeHitCount: number
  private readonly baseFirstPositiveMatch: SearchTextMatch | null
  private state = 0
  private scannedLength = 0
  private firstPositiveMatch: SearchTextMatch | null = null
  private missingPositiveCount = 0
  private negativeHitCount = 0

  constructor(compiled: CompiledSearchText) {
    this.compiled = compiled
    this.automaton = SEARCH_AUTOMATA.get(compiled) ?? buildSearchAutomaton(compiled)
    this.hits = compiled.clauses.map(({ needle }) => needle.length === 0)
    this.reportedTerminals = new Int32Array(this.automaton.nodes.length)
    this.reportedTerminals.fill(-1)
    for (let index = 0; index < compiled.clauses.length; index += 1) {
      const clause = compiled.clauses[index]
      if (!clause) continue
      if (clause.needle.length === 0) {
        if (clause.clause.negated) this.negativeHitCount += 1
        else this.firstPositiveMatch ??= { index: 0, length: 0 }
      } else if (!clause.clause.negated) this.missingPositiveCount += 1
    }
    this.baseMissingPositiveCount = this.missingPositiveCount
    this.baseNegativeHitCount = this.negativeHitCount
    this.baseFirstPositiveMatch = this.firstPositiveMatch
  }

  push(text: string, signal?: AbortSignal): void {
    for (let offset = 0; offset < text.length; offset += SEARCH_TEXT_CHUNK_CHARS) {
      throwIfSearchAborted(signal)
      const lowered = text.slice(offset, offset + SEARCH_TEXT_CHUNK_CHARS).toLocaleLowerCase()
      for (let index = 0; index < lowered.length; index += 1) {
        const char = lowered[index]
        if (char === undefined) continue
        this.advance(char)
        this.reportMatches(this.scannedLength + index)
      }
      this.scannedLength += lowered.length
    }
  }

  snapshot(): SearchTextScan {
    const clauseHits = Object.freeze([...this.hits])
    return {
      clauseHits,
      ...this.summary(),
    }
  }

  summary(): SearchTextMatchSummary {
    return {
      matches: this.missingPositiveCount === 0 && this.negativeHitCount === 0,
      firstPositive: this.firstPositiveMatch,
      length: this.scannedLength,
    }
  }

  reset(): void {
    for (const index of this.touchedHits) this.hits[index] = false
    this.touchedHits.length = 0
    for (const terminal of this.touchedTerminals) this.reportedTerminals[terminal] = -1
    this.touchedTerminals.length = 0
    this.state = 0
    this.scannedLength = 0
    this.firstPositiveMatch = this.baseFirstPositiveMatch
    this.missingPositiveCount = this.baseMissingPositiveCount
    this.negativeHitCount = this.baseNegativeHitCount
  }

  private advance(char: string): void {
    let next = this.automaton.nodes[this.state]?.transitions.get(char)
    while (next === undefined && this.state !== 0) {
      this.state = this.automaton.nodes[this.state]?.failure ?? 0
      next = this.automaton.nodes[this.state]?.transitions.get(char)
    }
    this.state = next ?? 0
  }

  private reportMatches(endIndex: number): void {
    const stateNode = this.automaton.nodes[this.state]
    if (!stateNode) return
    let terminal = stateNode.outputs.length > 0 ? this.state : stateNode.outputLink
    if (terminal === 0) return
    terminal = this.nextUnreportedTerminal(terminal)
    while (terminal !== 0) {
      const node = this.automaton.nodes[terminal]
      if (!node) return
      for (const clauseIndex of node.outputs) {
        if (this.hits[clauseIndex]) continue
        const compiledClause = this.compiled.clauses[clauseIndex]
        if (!compiledClause) continue
        this.hits[clauseIndex] = true
        this.touchedHits.push(clauseIndex)
        if (compiledClause.clause.negated) {
          this.negativeHitCount += 1
          continue
        }
        this.missingPositiveCount -= 1
        const match: SearchTextMatch = {
          index: endIndex - compiledClause.needle.length + 1,
          length: compiledClause.clause.value.length,
        }
        if (!this.firstPositiveMatch || match.index < this.firstPositiveMatch.index) {
          this.firstPositiveMatch = match
        }
      }
      const next = this.nextUnreportedTerminal(node.outputLink)
      this.touchedTerminals.push(terminal)
      this.reportedTerminals[terminal] = next
      terminal = next
    }
  }

  private nextUnreportedTerminal(node: number): number {
    if (node === 0 || this.reportedTerminals[node] === -1) return node
    let current = node
    const path: number[] = []
    while (current !== 0 && this.reportedTerminals[current] !== -1) {
      path.push(current)
      current = this.reportedTerminals[current] ?? 0
    }
    for (const traversed of path) this.reportedTerminals[traversed] = current
    return current
  }
}

function buildSearchAutomaton(compiled: CompiledSearchText): SearchAutomaton {
  const nodes: SearchAutomatonNode[] = [createSearchAutomatonNode()]
  for (let clauseIndex = 0; clauseIndex < compiled.clauses.length; clauseIndex += 1) {
    const needle = compiled.clauses[clauseIndex]?.needle ?? ''
    if (needle.length === 0) continue
    let nodeIndex = 0
    for (let index = 0; index < needle.length; index += 1) {
      const char = needle[index]
      if (char === undefined) continue
      const node = nodes[nodeIndex]
      if (!node) break
      let next = node.transitions.get(char)
      if (next === undefined) {
        next = nodes.length
        node.transitions.set(char, next)
        nodes.push(createSearchAutomatonNode())
      }
      nodeIndex = next
    }
    nodes[nodeIndex]?.outputs.push(clauseIndex)
  }

  const queue: number[] = []
  for (const child of nodes[0]?.transitions.values() ?? []) queue.push(child)
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const nodeIndex = queue[queueIndex]
    const node = nodeIndex === undefined ? undefined : nodes[nodeIndex]
    if (!node) continue
    const failureNode = nodes[node.failure]
    node.outputLink = failureNode?.outputs.length ? node.failure : (failureNode?.outputLink ?? 0)
    for (const [char, childIndex] of node.transitions) {
      let failure = node.failure
      let fallback = nodes[failure]?.transitions.get(char)
      while (fallback === undefined && failure !== 0) {
        failure = nodes[failure]?.failure ?? 0
        fallback = nodes[failure]?.transitions.get(char)
      }
      const child = nodes[childIndex]
      if (child) child.failure = fallback ?? 0
      queue.push(childIndex)
    }
  }
  return { nodes }
}

function createSearchAutomatonNode(): SearchAutomatonNode {
  return { transitions: new Map(), outputs: [], failure: 0, outputLink: 0 }
}

export function scanSearchTextSegments(
  segments: Iterable<string>,
  compiled: CompiledSearchText,
  options: { separator?: string; signal?: AbortSignal } = {},
): SearchTextScan {
  const scanner = new IncrementalSearchTextScanner(compiled)
  const separator = options.separator ?? '\n'
  let index = 0
  for (const segment of segments) {
    if (index > 0) scanner.push(separator, options.signal)
    scanner.push(segment, options.signal)
    index += 1
  }
  return scanner.snapshot()
}

export function literalSearchHasMatchEndingAfter(
  segments: Iterable<string>,
  value: string,
  threshold: number,
  signal?: AbortSignal,
): boolean {
  if (value.length === 0) return false
  const compiled = literalSearchText(value)
  const needleLength = compiled.clauses[0]?.needle.length ?? 0
  const scanStart = Math.max(0, threshold - needleLength + 1)
  const scanner = new IncrementalSearchTextScanner(compiled)
  let offset = 0
  for (const segment of segments) {
    const end = offset + segment.length
    if (end > scanStart) scanner.push(segment.slice(Math.max(0, scanStart - offset)), signal)
    offset = end
  }
  return scanner.summary().matches
}

export function findLiteralSearchRanges(
  text: string,
  value: string,
  limit = Number.POSITIVE_INFINITY,
): LiteralSearchRanges {
  const needle = value.toLocaleLowerCase()
  if (needle.length === 0) return { ranges: [], totalCount: 0 }
  const lowered = text.toLocaleLowerCase()
  const ranges: SearchTextRange[] = []
  let totalCount = 0
  let index = lowered.indexOf(needle)
  while (index >= 0) {
    totalCount += 1
    if (ranges.length < limit) ranges.push({ start: index, end: index + value.length })
    index = lowered.indexOf(needle, index + needle.length)
  }
  return { ranges, totalCount }
}

export function searchClauseHitsMatch(
  compiled: CompiledSearchText,
  hits: readonly boolean[],
): boolean {
  for (let index = 0; index < compiled.clauses.length; index += 1) {
    const clause = compiled.clauses[index]?.clause
    if (!clause) continue
    const hit = hits[index] === true
    if (clause.negated ? hit : !hit) return false
  }
  return true
}

export function sliceTextSegments(
  segments: Iterable<string>,
  start: number,
  end: number,
  separator = '\n',
): string {
  if (end <= start) return ''
  const chunks: string[] = []
  let offset = 0
  let index = 0
  const append = (text: string) => {
    const nextOffset = offset + text.length
    if (nextOffset > start && offset < end) {
      chunks.push(text.slice(Math.max(0, start - offset), Math.min(text.length, end - offset)))
    }
    offset = nextOffset
  }
  for (const segment of segments) {
    if (index > 0) append(separator)
    append(segment)
    if (offset >= end) break
    index += 1
  }
  return chunks.join('')
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

function throwIfSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Search aborted', 'AbortError')
}
