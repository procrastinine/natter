import {
  type CompiledSearchText,
  compileSearchText,
  findLiteralSearchRanges,
  IncrementalSearchTextScanner,
  type MessageCorpusSearchResult,
  parseSearchQuery,
  type SearchNameClause,
  type SearchQuery,
  type SearchQueryParseError,
  type SearchTextClause,
  scanSearchTextSegments,
  searchClauseHitsMatch,
} from '../core/search-query'
import type {
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  FolderId,
  MessageId,
  TagId,
} from '../core/types'
import { yieldToEventLoop } from '../lib/yield-to-event-loop'
import { consumeLastUpdatedBranchText } from './branch-text'
import { searchMessageCorpus } from './message-search-service'
import type {
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export type SearchScope = 'last-updated-branch' | 'all-branches'
type SearchResultSource =
  | 'title'
  | 'last-updated-branch'
  | 'all-branches'
  | 'folder'
  | 'tag'
  | 'preview'

export interface SearchFilters {
  includeFolderIds: FolderId[]
  excludeFolderIds: FolderId[]
  includeTagIds: TagId[]
  excludeTagIds: TagId[]
  archived: 'exclude' | 'include' | 'only'
  titleOnly: boolean
}

interface SearchHighlightRange {
  start: number
  end: number
}

export interface SearchResult {
  id: string
  chatId: ChatId
  chat: ChatSidebarRow
  branchLeafId?: MessageId | null
  messageId?: MessageId
  source: SearchResultSource
  title: string
  snippet: string
  highlightRanges: SearchHighlightRange[]
  prefixTruncated: boolean
  suffixTruncated: boolean
  rank: number
}

interface ChatSearchStartedUpdate {
  kind: 'started'
  queryId: string
  candidateCount: number
  candidateChatIds: readonly ChatId[]
}

interface ChatSearchHitUpdate {
  kind: 'hit'
  queryId: string
  result: SearchResult
  completedCount: number
  candidateCount: number
}

interface ChatSearchMissUpdate {
  kind: 'miss'
  queryId: string
  chatId: ChatId
  completedCount: number
  candidateCount: number
}

interface ChatSearchTaskErrorUpdate {
  kind: 'task-error'
  queryId: string
  chatId: ChatId
  message: string
  completedCount: number
  candidateCount: number
}

interface ChatSearchDoneUpdate {
  kind: 'done'
  queryId: string
  completedCount: number
  candidateCount: number
}

interface ChatSearchExcludedUpdate {
  kind: 'excluded'
  queryId: string
  chatId: ChatId
}

export type ChatSearchUpdate =
  | ChatSearchStartedUpdate
  | ChatSearchHitUpdate
  | ChatSearchMissUpdate
  | ChatSearchTaskErrorUpdate
  | ChatSearchDoneUpdate
  | ChatSearchExcludedUpdate

interface ChatSearchOutput {
  queryId: string
  results: SearchResult[]
  candidateCount: number
  completedCount: number
  warnings: SearchQuery['warnings']
}

interface SearchChatsInput {
  queryId: string
  query: string
  scope?: SearchScope
  filters?: SearchFilters
  chatIds?: readonly ChatId[]
  repo?: WorkspaceRepository
  authority?: WorkspaceReadAuthority
  signal?: AbortSignal
  concurrency?: number
  collectResults?: boolean
  onUpdate?: (update: ChatSearchUpdate) => void
}

interface SearchCatalog {
  foldersById: Map<FolderId, ChatFolder>
  tagsById: Map<TagId, ChatTag>
  resolvedFolderIds: Set<FolderId>
  resolvedTagIds: Set<TagId>
  folderIdsByName: Map<string, Set<FolderId>>
  tagIdsByName: Map<string, Set<TagId>>
}

interface SearchField {
  source: SearchResultSource
  text: string
  messageId?: MessageId
}

interface SearchSidebarPage {
  readonly rows: readonly ChatSidebarRow[]
  readonly requestedChatIds?: readonly ChatId[]
}

type SearchSidebarPageRead =
  | { readonly ok: true; readonly result: IteratorResult<SearchSidebarPage> }
  | { readonly ok: false; readonly error: unknown }

interface FieldMatch {
  source: SearchResultSource
  text: string
  matchIndex: number | null
  matchLength: number
  messageId?: MessageId
  prefixTruncated?: boolean
  suffixTruncated?: boolean
}

interface ScanContext {
  queryId: string
  parsed: SearchQuery
  compiledText: CompiledSearchText
  catalog: SearchCatalog
  filters: SearchFilters
  includeFolderIds: ReadonlySet<FolderId>
  excludeFolderIds: ReadonlySet<FolderId>
  includeTagIds: ReadonlySet<TagId>
  excludeTagIds: ReadonlySet<TagId>
  scope: SearchScope
  repo: WorkspaceRepository
  authority: WorkspaceReadAuthority
  signal?: AbortSignal
}

class ChatSearchParseError extends Error {
  readonly position: number

  constructor(error: SearchQueryParseError) {
    super(error.message)
    this.name = 'ChatSearchParseError'
    this.position = error.position
  }
}

class ChatSearchAbortedError extends Error {
  constructor() {
    super('Search aborted')
    this.name = 'AbortError'
  }
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = {
  includeFolderIds: [],
  excludeFolderIds: [],
  includeTagIds: [],
  excludeTagIds: [],
  archived: 'exclude',
  titleOnly: false,
}

const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120
const FALLBACK_SNIPPET_CHARS = 180
const SEARCH_YIELD_BUDGET_MS = 12
const SEARCH_SIDEBAR_PAGE_SIZE = 500
const SEARCH_EXCERPT_FEED_CHARS = 2 * 1024

class BranchSearchCollector {
  private readonly compiled: CompiledSearchText
  private readonly signal: AbortSignal | undefined
  private readonly scanner: IncrementalSearchTextScanner
  private readonly tailLimit: number
  private readonly tailChunks: string[] = []
  private readonly capturedParts: string[] = []
  private tailLength = 0
  private capturedStart = 0
  private capturedEnd = 0
  private captureTargetEnd = 0
  private firstPositive: { readonly index: number; readonly length: number } | null = null

  constructor(compiled: CompiledSearchText, signal?: AbortSignal) {
    this.compiled = compiled
    this.signal = signal
    this.scanner = new IncrementalSearchTextScanner(compiled)
    this.tailLimit =
      SNIPPET_BEFORE +
      compiled.clauses.reduce((longest, clause) => Math.max(longest, clause.needle.length), 0) +
      1
  }

  reset(prefixSegments: readonly string[]): void {
    this.scanner.reset()
    this.tailChunks.length = 0
    this.capturedParts.length = 0
    this.tailLength = 0
    this.capturedStart = 0
    this.capturedEnd = 0
    this.captureTargetEnd = 0
    this.firstPositive = null
    for (let index = 0; index < prefixSegments.length; index += 1) {
      if (index > 0) this.push('\n')
      this.push(prefixSegments[index] ?? '')
    }
  }

  push(text: string): void {
    for (let offset = 0; offset < text.length; offset += SEARCH_EXCERPT_FEED_CHARS) {
      this.pushChunk(text.slice(offset, offset + SEARCH_EXCERPT_FEED_CHARS))
    }
  }

  fieldMatch(fields: readonly SearchField[]): FieldMatch | null {
    const scan = this.scanner.snapshot()
    if (!scan.matches) return null

    const metadataMatch = matchFields(fields, this.compiled)
    if (metadataMatch) return metadataMatch
    if (!this.compiled.hasPositive || !this.firstPositive) {
      const fallback = fields.find((field) => field.text.trim().length > 0)
      return {
        source: fallback?.source ?? 'preview',
        text: fallback?.text ?? '',
        matchIndex: null,
        matchLength: 0,
      }
    }

    return {
      source: 'last-updated-branch',
      text: this.capturedParts.join(''),
      matchIndex: this.firstPositive.index - this.capturedStart,
      matchLength: this.firstPositive.length,
      prefixTruncated: this.capturedStart > 0,
      suffixTruncated: this.capturedEnd < scan.length,
    }
  }

  private pushChunk(chunk: string): void {
    const chunkStart = this.scanner.summary().length
    this.scanner.push(chunk, this.signal)
    if (!this.firstPositive) {
      const firstPositive = this.scanner.summary().firstPositive
      if (!firstPositive) {
        this.appendTail(chunk)
        return
      }
      const tail = this.tailChunks.join('')
      const combinedStart = chunkStart - this.tailLength
      const combined = tail + chunk
      const desiredStart = Math.max(0, firstPositive.index - SNIPPET_BEFORE)
      this.captureTargetEnd = firstPositive.index + firstPositive.length + SNIPPET_AFTER
      const localStart = Math.max(0, desiredStart - combinedStart)
      const localEnd = Math.min(combined.length, this.captureTargetEnd - combinedStart)
      const captured = combined.slice(localStart, Math.max(localStart, localEnd))
      if (captured.length > 0) this.capturedParts.push(captured)
      this.capturedStart = combinedStart + localStart
      this.capturedEnd = this.capturedStart + captured.length
      this.firstPositive = firstPositive
      this.tailChunks.length = 0
      this.tailLength = 0
      return
    }

    if (this.capturedEnd >= this.captureTargetEnd) return
    const localStart = Math.max(0, this.capturedEnd - chunkStart)
    const localEnd = Math.min(chunk.length, this.captureTargetEnd - chunkStart)
    if (localEnd <= localStart) return
    const captured = chunk.slice(localStart, localEnd)
    this.capturedParts.push(captured)
    this.capturedEnd += captured.length
  }

  private appendTail(chunk: string): void {
    if (this.tailLimit === 0 || chunk.length === 0) return
    this.tailChunks.push(chunk)
    this.tailLength += chunk.length
    while (this.tailLength > this.tailLimit) {
      const first = this.tailChunks[0]
      if (first === undefined) break
      const excess = this.tailLength - this.tailLimit
      if (first.length <= excess) {
        this.tailChunks.shift()
        this.tailLength -= first.length
      } else {
        this.tailChunks[0] = first.slice(excess)
        this.tailLength -= excess
      }
    }
  }
}

export function cloneSearchFilters(filters: SearchFilters = DEFAULT_SEARCH_FILTERS): SearchFilters {
  return {
    includeFolderIds: [...filters.includeFolderIds],
    excludeFolderIds: [...filters.excludeFolderIds],
    includeTagIds: [...filters.includeTagIds],
    excludeTagIds: [...filters.excludeTagIds],
    archived: filters.archived,
    titleOnly: filters.titleOnly,
  }
}

export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  return (
    filters.includeFolderIds.length > 0 ||
    filters.excludeFolderIds.length > 0 ||
    filters.includeTagIds.length > 0 ||
    filters.excludeTagIds.length > 0 ||
    filters.archived !== 'exclude' ||
    filters.titleOnly
  )
}

export function hasSearchWork(query: string, filters: SearchFilters): boolean {
  return query.trim().length > 0 || hasActiveSearchFilters(filters)
}

export async function searchChats(input: SearchChatsInput): Promise<ChatSearchOutput> {
  const authority = input.authority
  if (!authority) {
    return runWorkspaceRead(
      'search-session',
      (authority) => searchChats({ ...input, authority }),
      input.signal ? { signal: input.signal } : {},
    )
  }
  const filters = cloneSearchFilters(input.filters)
  const parseResult = parseSearchQuery(input.query)
  if (!parseResult.ok) throw new ChatSearchParseError(parseResult.error)

  const repo = input.repo ?? getWorkspaceRepository()
  const scope = input.scope ?? 'last-updated-branch'
  const linkedAbort = createLinkedSearchAbortController(authority.signal, input.signal)
  const signal = linkedAbort.controller.signal
  const pageIterator = iterateSearchSidebarPages(
    repo,
    authority,
    input.chatIds,
    filters.archived,
    signal,
  )[Symbol.asyncIterator]()
  const firstPage = await pageIterator.next().catch((error: unknown) => {
    linkedAbort.controller.abort()
    linkedAbort.dispose()
    throw error
  })
  if (signal.aborted) {
    linkedAbort.controller.abort()
    linkedAbort.dispose()
    throw new ChatSearchAbortedError()
  }

  const catalog = buildCatalog([], [])
  const context: ScanContext = {
    queryId: input.queryId,
    parsed: parseResult.query,
    compiledText: compileSearchText(parseResult.query.text),
    catalog,
    filters,
    includeFolderIds: new Set(filters.includeFolderIds),
    excludeFolderIds: new Set(filters.excludeFolderIds),
    includeTagIds: new Set(filters.includeTagIds),
    excludeTagIds: new Set(filters.excludeTagIds),
    scope,
    repo,
    authority,
  }
  context.signal = signal

  let completedCount = 0
  let candidateCount = 0
  const resultsByChat = input.collectResults === false ? null : new Map<ChatId, SearchResult>()
  const yieldController = createSearchYieldController()
  const bodyPool = new BoundedSearchTaskPool(boundedConcurrency(input.concurrency))

  const scanCandidateBody = async (chat: ChatSidebarRow): Promise<void> => {
    throwIfAborted(signal)
    try {
      const result =
        scope === 'all-branches'
          ? await scanAllBranchesChat(chat, context)
          : await scanLastUpdatedBranchChat(chat, context)
      completedCount += 1
      if (result) {
        resultsByChat?.set(chat.id, result)
        input.onUpdate?.({
          kind: 'hit',
          queryId: input.queryId,
          result,
          completedCount,
          candidateCount,
        })
      } else {
        input.onUpdate?.({
          kind: 'miss',
          queryId: input.queryId,
          chatId: chat.id,
          completedCount,
          candidateCount,
        })
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      completedCount += 1
      input.onUpdate?.({
        kind: 'task-error',
        queryId: input.queryId,
        chatId: chat.id,
        message: error instanceof Error ? error.message : String(error),
        completedCount,
        candidateCount,
      })
    }
    await yieldController.maybeYield()
  }

  try {
    let pageResult = firstPage
    while (!pageResult.done) {
      throwIfAborted(signal)
      const nextPage = observeSearchSidebarPageRead(pageIterator.next())
      const page = pageResult.value
      await hydrateSearchCatalogForRows(context, page.rows)
      const candidates = page.rows.filter((chat) => chatPassesStaticFilters(chat, context))
      candidateCount += candidates.length
      const candidateChatIds = candidates.map((chat) => chat.id)
      input.onUpdate?.({
        kind: 'started',
        queryId: input.queryId,
        candidateCount,
        candidateChatIds,
      })
      if (page.requestedChatIds) {
        const included = new Set(candidateChatIds)
        for (const chatId of page.requestedChatIds) {
          if (included.has(chatId)) continue
          input.onUpdate?.({ kind: 'excluded', queryId: input.queryId, chatId })
        }
      }
      for (const chat of candidates) {
        throwIfAborted(signal)
        const immediate = matchImmediateChat(chat, context)
        if (immediate) {
          completedCount += 1
          resultsByChat?.set(chat.id, immediate)
          input.onUpdate?.({
            kind: 'hit',
            queryId: input.queryId,
            result: immediate,
            completedCount,
            candidateCount,
          })
        } else if (filters.titleOnly) {
          completedCount += 1
          input.onUpdate?.({
            kind: 'miss',
            queryId: input.queryId,
            chatId: chat.id,
            completedCount,
            candidateCount,
          })
        } else {
          await bodyPool.add(() => scanCandidateBody(chat))
        }
        await yieldController.maybeYield()
      }
      const next = await nextPage
      if (!next.ok) throw next.error
      pageResult = next.result
    }
    await bodyPool.drain()
    throwIfAborted(signal)
    input.onUpdate?.({
      kind: 'done',
      queryId: input.queryId,
      completedCount,
      candidateCount,
    })

    return {
      queryId: input.queryId,
      results: resultsByChat ? [...resultsByChat.values()] : [],
      candidateCount,
      completedCount,
      warnings: parseResult.query.warnings,
    }
  } finally {
    linkedAbort.controller.abort()
    linkedAbort.dispose()
    await bodyPool.settle()
  }
}

async function* iterateSearchSidebarPages(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  chatIds: readonly ChatId[] | undefined,
  archived: SearchFilters['archived'],
  signal: AbortSignal,
): AsyncGenerator<SearchSidebarPage> {
  if (chatIds) {
    const uniqueIds = [...new Set(chatIds)]
    for (let offset = 0; offset < uniqueIds.length; offset += SEARCH_SIDEBAR_PAGE_SIZE) {
      throwIfAborted(signal)
      const requestedChatIds = uniqueIds.slice(offset, offset + SEARCH_SIDEBAR_PAGE_SIZE)
      const page = await queryWorkspace(
        repo,
        authority,
        { kind: 'sidebar.rows-by-id', chatIds: requestedChatIds },
        signal,
      )
      yield {
        rows: page.filter((row): row is ChatSidebarRow => row !== undefined),
        requestedChatIds,
      }
    }
    return
  }

  let cursor: string | undefined
  for (;;) {
    throwIfAborted(signal)
    const page = await queryWorkspace(
      repo,
      authority,
      {
        kind: 'sidebar.catalog-page',
        request: {
          archived,
          orderBy: 'updatedAt',
          direction: 'desc',
          pageDirection: 'forward',
          limit: SEARCH_SIDEBAR_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      },
      signal,
    )
    yield { rows: page.rows }
    if (!page.nextCursor) return
    cursor = page.nextCursor
  }
}

function observeSearchSidebarPageRead(
  read: Promise<IteratorResult<SearchSidebarPage>>,
): Promise<SearchSidebarPageRead> {
  return read.then(
    (result) => ({ ok: true, result }),
    (error: unknown) => ({ ok: false, error }),
  )
}

function matchImmediateChat(chat: ChatSidebarRow, context: ScanContext): SearchResult | null {
  if (context.parsed.text.length === 0) {
    return buildResult({
      chat,
      match: fallbackMatch(chat, context),
      parsed: context.parsed,
    })
  }

  if (context.compiledText.hasNegative && !context.filters.titleOnly) return null

  const metadataMatch = matchFields(metadataFields(chat, context), context.compiledText)
  if (!metadataMatch) return null
  return buildResult({ chat, match: metadataMatch, parsed: context.parsed })
}

async function scanLastUpdatedBranchChat(
  chat: ChatSidebarRow,
  context: ScanContext,
): Promise<SearchResult | null> {
  throwIfAborted(context.signal)
  const branch = await scanFreshLastUpdatedBranch(context, chat)
  throwIfAborted(context.signal)
  if (!branch?.match) return null
  const resultInput: Parameters<typeof buildResult>[0] = {
    chat,
    match: branch.match,
    parsed: context.parsed,
  }
  resultInput.branchLeafId = branch.branchLeafId
  return buildResult(resultInput)
}

async function scanAllBranchesChat(
  chat: ChatSidebarRow,
  context: ScanContext,
): Promise<SearchResult | null> {
  throwIfAborted(context.signal)
  const fields = metadataFields(chat, context)
  const corpus = await searchMessageCorpus(
    {
      chatId: chat.id,
      clauses: context.parsed.text,
      prefixFields: fields.map((field) => ({ key: field.source, text: field.text })),
    },
    {
      repository: context.repo,
      authority: context.authority,
      ...(context.signal ? { signal: context.signal } : {}),
    },
  )
  throwIfAborted(context.signal)
  if (!searchClauseHitsMatch(context.compiledText, corpus.clauseHits)) return null

  const match = allBranchesFieldMatch(fields, corpus, context.compiledText)

  let messageId =
    corpus.newestMatchingMessageId ?? corpus.newestPositiveMessageId ?? match.messageId
  let branchLeafId: MessageId | null | undefined
  if (messageId && (await freshLastUpdatedBranchMatches(chat, context))) {
    messageId = undefined
    branchLeafId = chat.lastUpdatedLeafId
  }

  const resultMatch = { ...match }
  if (branchLeafId !== undefined) delete resultMatch.messageId
  else if (messageId) resultMatch.messageId = messageId

  const resultInput: Parameters<typeof buildResult>[0] = {
    chat,
    match: resultMatch,
    parsed: context.parsed,
  }
  if (messageId) resultInput.messageId = messageId
  if (branchLeafId !== undefined) resultInput.branchLeafId = branchLeafId
  return buildResult(resultInput)
}

function chatPassesStaticFilters(chat: ChatSidebarRow, context: ScanContext): boolean {
  if (context.filters.archived === 'exclude' && chat.archived) return false
  if (context.filters.archived === 'only' && !chat.archived) return false

  if (context.includeFolderIds.size > 0 && !context.includeFolderIds.has(chat.folderId ?? '')) {
    return false
  }
  if (chat.folderId && context.excludeFolderIds.has(chat.folderId)) return false

  if (
    context.includeTagIds.size > 0 &&
    !chat.tags.some((tagId) => context.includeTagIds.has(tagId))
  ) {
    return false
  }
  if (chat.tags.some((tagId) => context.excludeTagIds.has(tagId))) return false

  if (!nameClausesPass(chat.tags, context.parsed.tags, context.catalog.tagIdsByName)) return false
  if (!folderClausesPass(chat.folderId, context.parsed.folders, context.catalog.folderIdsByName)) {
    return false
  }
  return isClausesPass(chat, context.parsed)
}

function nameClausesPass(
  actualIds: readonly string[],
  clauses: readonly SearchNameClause[],
  idsByName: Map<string, Set<string>>,
): boolean {
  for (const clause of clauses) {
    const expected = idsByName.get(normalizeName(clause.value))
    const hit = expected !== undefined && actualIds.some((id) => expected.has(id))
    if (clause.negated ? hit : !hit) return false
  }
  return true
}

function folderClausesPass(
  folderId: FolderId | null,
  clauses: readonly SearchNameClause[],
  idsByName: Map<string, Set<FolderId>>,
): boolean {
  for (const clause of clauses) {
    const expected = folderIdsForClause(clause, idsByName)
    const hit = expected.has(folderId ?? '')
    if (clause.negated ? hit : !hit) return false
  }
  return true
}

function isClausesPass(chat: ChatSidebarRow, parsed: SearchQuery): boolean {
  for (const clause of parsed.is) {
    const hit =
      clause.value === 'pinned'
        ? chat.pinned
        : clause.value === 'archived'
          ? chat.archived
          : isUntitledChat(chat)
    if (clause.negated ? hit : !hit) return false
  }
  return true
}

function matchFields(
  fields: readonly SearchField[],
  compiledText: CompiledSearchText,
): FieldMatch | null {
  const fieldScan = scanSearchTextSegments(
    fields.map((field) => field.text),
    compiledText,
  )
  if (!fieldScan.matches) return null

  if (!compiledText.hasPositive) {
    const fallback = fields.find((field) => field.text.trim().length > 0)
    if (!fallback) return { source: 'preview', text: '', matchIndex: null, matchLength: 0 }
    return {
      source: fallback.source,
      text: fallback.text,
      matchIndex: null,
      matchLength: 0,
      ...(fallback.messageId ? { messageId: fallback.messageId } : {}),
    }
  }

  const best = bestPositiveFieldMatch(fields, compiledText)?.match ?? null
  if (best) return best

  const fallback = fields.find((field) => field.text.trim().length > 0)
  if (!fallback) return { source: 'preview', text: '', matchIndex: null, matchLength: 0 }
  return {
    source: fallback.source,
    text: fallback.text,
    matchIndex: null,
    matchLength: 0,
    ...(fallback.messageId ? { messageId: fallback.messageId } : {}),
  }
}

function allBranchesFieldMatch(
  fields: readonly SearchField[],
  corpus: MessageCorpusSearchResult,
  compiledText: CompiledSearchText,
): FieldMatch {
  if (!compiledText.hasPositive) {
    const fallback = fields.find((field) => field.text.trim().length > 0)
    return {
      source: fallback?.source ?? 'preview',
      text: fallback?.text ?? '',
      matchIndex: null,
      matchLength: 0,
    }
  }

  const metadata = bestPositiveFieldMatch(fields, compiledText)
  const excerpt = corpus.firstPositiveExcerpt
  if (!excerpt || (metadata && metadata.offset <= excerpt.messageMatchIndex)) {
    return (
      metadata?.match ?? {
        source: fields[0]?.source ?? 'preview',
        text: fields[0]?.text ?? '',
        matchIndex: null,
        matchLength: 0,
      }
    )
  }
  return {
    source: 'all-branches',
    text: excerpt.text,
    matchIndex: excerpt.matchIndex,
    matchLength: excerpt.matchLength,
    messageId: excerpt.messageId,
    prefixTruncated: excerpt.prefixTruncated,
    suffixTruncated: excerpt.suffixTruncated,
  }
}

function bestPositiveFieldMatch(
  fields: readonly SearchField[],
  compiledText: CompiledSearchText,
): { match: FieldMatch; offset: number } | null {
  let best: { match: FieldMatch; offset: number } | null = null
  for (const field of fields) {
    const hit = scanSearchTextSegments([field.text], compiledText).firstPositive
    if (!hit || (best && hit.index >= best.offset)) continue
    best = {
      offset: hit.index,
      match: {
        source: field.source,
        text: field.text,
        matchIndex: hit.index,
        matchLength: hit.length,
        ...(field.messageId ? { messageId: field.messageId } : {}),
      },
    }
  }
  return best
}

function metadataFields(chat: ChatSidebarRow, context: ScanContext): SearchField[] {
  const fields: SearchField[] = [{ source: 'title', text: displayTitle(chat) }]
  if (context.filters.titleOnly) return fields

  const folder = chat.folderId ? context.catalog.foldersById.get(chat.folderId) : undefined
  if (folder?.name) fields.push({ source: 'folder', text: folder.name })

  const tagNames = chat.tags
    .map((tagId) => context.catalog.tagsById.get(tagId)?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  if (tagNames.length > 0) fields.push({ source: 'tag', text: tagNames.join(' ') })
  return fields
}

function fallbackMatch(chat: ChatSidebarRow, context: ScanContext): FieldMatch {
  const preview = chat.previewText?.trim()
  if (preview) return { source: 'preview', text: preview, matchIndex: null, matchLength: 0 }
  const metadata = metadataFields(chat, context).find((field) => field.text.trim().length > 0)
  return {
    source: metadata?.source ?? 'preview',
    text: metadata?.text ?? '',
    matchIndex: null,
    matchLength: 0,
  }
}

function buildResult(input: {
  chat: ChatSidebarRow
  match: FieldMatch
  parsed: SearchQuery
  branchLeafId?: MessageId | null
  messageId?: MessageId
}): SearchResult {
  const snippet = buildSnippet(input.match.text, input.match, input.parsed.text)
  const result: SearchResult = {
    id: input.chat.id,
    chatId: input.chat.id,
    chat: input.chat,
    source: input.match.source,
    title: displayTitle(input.chat),
    snippet: snippet.text,
    highlightRanges: snippet.highlightRanges,
    prefixTruncated: snippet.prefixTruncated,
    suffixTruncated: snippet.suffixTruncated,
    rank: 0,
  }
  if ('branchLeafId' in input) result.branchLeafId = input.branchLeafId
  const messageId = input.messageId ?? input.match.messageId
  if (messageId) result.messageId = messageId
  return result
}

function buildSnippet(
  text: string,
  match: Pick<FieldMatch, 'matchIndex' | 'matchLength' | 'prefixTruncated' | 'suffixTruncated'>,
  clauses: readonly SearchTextClause[],
): {
  text: string
  highlightRanges: SearchHighlightRange[]
  prefixTruncated: boolean
  suffixTruncated: boolean
} {
  if (text.length === 0) {
    return { text: '', highlightRanges: [], prefixTruncated: false, suffixTruncated: false }
  }

  const matchIndex = match.matchIndex
  const matchLength = Math.max(0, match.matchLength)
  if (matchIndex === null || matchIndex < 0) {
    const snippet = text.slice(0, FALLBACK_SNIPPET_CHARS)
    return {
      text: snippet,
      highlightRanges: [],
      prefixTruncated: match.prefixTruncated === true,
      suffixTruncated: match.suffixTruncated === true || text.length > snippet.length,
    }
  }

  const rawStart = Math.max(0, matchIndex - SNIPPET_BEFORE)
  const rawEnd = Math.min(text.length, matchIndex + matchLength + SNIPPET_AFTER)
  const start = trimSnippetStart(text, rawStart, matchIndex)
  const end = trimSnippetEnd(text, rawEnd, matchIndex + matchLength)
  const snippet = text.slice(start, end)
  return {
    text: snippet,
    highlightRanges: highlightRanges(snippet, clauses),
    prefixTruncated: match.prefixTruncated === true || start > 0,
    suffixTruncated: match.suffixTruncated === true || end < text.length,
  }
}

function highlightRanges(
  text: string,
  clauses: readonly SearchTextClause[],
): SearchHighlightRange[] {
  const ranges: SearchHighlightRange[] = []
  for (const clause of clauses) {
    if (clause.negated || clause.value.length === 0) continue
    ranges.push(...findLiteralSearchRanges(text, clause.value).ranges)
  }
  return mergeHighlightRanges(ranges)
}

function mergeHighlightRanges(ranges: SearchHighlightRange[]): SearchHighlightRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: SearchHighlightRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (!last || range.start > last.end) {
      merged.push({ ...range })
      continue
    }
    last.end = Math.max(last.end, range.end)
  }
  return merged
}

async function scanFreshLastUpdatedBranch(
  context: ScanContext,
  chat: ChatSidebarRow,
): Promise<
  | {
      readonly branchLeafId: MessageId | null
      readonly match: FieldMatch | null
    }
  | undefined
> {
  throwIfAborted(context.signal)
  const fields = metadataFields(chat, context)
  const collector = new BranchSearchCollector(context.compiledText, context.signal)
  let branchSeparatorPending = fields.length > 0
  const fresh = await consumeLastUpdatedBranchText(
    context.repo,
    context.authority,
    chat.id,
    {
      reset: () => {
        collector.reset(fields.map((field) => field.text))
        branchSeparatorPending = fields.length > 0
      },
      push: (segment) => {
        if (branchSeparatorPending) {
          collector.push('\n')
          branchSeparatorPending = false
        }
        collector.push(segment)
      },
    },
    context.signal,
  )
  if (!fresh) return undefined
  return {
    branchLeafId: fresh.branchLeafId,
    match: collector.fieldMatch(fields),
  }
}

async function freshLastUpdatedBranchMatches(
  chat: ChatSidebarRow,
  context: ScanContext,
): Promise<boolean> {
  const fresh = await scanFreshLastUpdatedBranch(context, chat)
  return fresh?.branchLeafId === chat.lastUpdatedLeafId && fresh.match !== null
}

function queryWorkspace<Q extends WorkspaceQuery>(
  repo: WorkspaceRepository,
  authority: WorkspaceReadAuthority,
  query: Q,
  signal?: AbortSignal,
): Promise<WorkspaceQueryResult<Q>> {
  return repo
    .query(authority, query, { signal: signal ?? authority.signal })
    .then((envelope) => envelope.value)
}

async function hydrateSearchCatalogForRows(
  context: ScanContext,
  rows: readonly ChatSidebarRow[],
): Promise<void> {
  const folderIds = [
    ...new Set(
      rows.flatMap((chat) =>
        chat.folderId && !context.catalog.resolvedFolderIds.has(chat.folderId)
          ? [chat.folderId]
          : [],
      ),
    ),
  ]
  const tagIds = [
    ...new Set(
      rows.flatMap((chat) =>
        chat.tags.filter((tagId) => !context.catalog.resolvedTagIds.has(tagId)),
      ),
    ),
  ]
  if (folderIds.length === 0 && tagIds.length === 0) return
  const [folders, tags] = await Promise.all([
    folderIds.length > 0
      ? queryWorkspace(
          context.repo,
          context.authority,
          { kind: 'folder.get-many', folderIds },
          context.signal,
        )
      : Promise.resolve([]),
    tagIds.length > 0
      ? queryWorkspace(
          context.repo,
          context.authority,
          { kind: 'tag.get-many', tagIds },
          context.signal,
        )
      : Promise.resolve([]),
  ])
  for (const folderId of folderIds) context.catalog.resolvedFolderIds.add(folderId)
  for (const tagId of tagIds) context.catalog.resolvedTagIds.add(tagId)
  for (const folder of folders) {
    if (!folder) continue
    context.catalog.foldersById.set(folder.id, folder)
    addNameIndex(context.catalog.folderIdsByName, folder.name, folder.id)
  }
  for (const tag of tags) {
    if (!tag) continue
    context.catalog.tagsById.set(tag.id, tag)
    addNameIndex(context.catalog.tagIdsByName, tag.name, tag.id)
  }
}

function buildCatalog(folders: readonly ChatFolder[], tags: readonly ChatTag[]): SearchCatalog {
  const folderIdsByName = new Map<string, Set<FolderId>>()
  const tagIdsByName = new Map<string, Set<TagId>>()
  for (const folder of folders) addNameIndex(folderIdsByName, folder.name, folder.id)
  for (const tag of tags) addNameIndex(tagIdsByName, tag.name, tag.id)
  return {
    foldersById: new Map(folders.map((folder) => [folder.id, folder])),
    tagsById: new Map(tags.map((tag) => [tag.id, tag])),
    resolvedFolderIds: new Set(folders.map((folder) => folder.id)),
    resolvedTagIds: new Set(tags.map((tag) => tag.id)),
    folderIdsByName,
    tagIdsByName,
  }
}

function addNameIndex<T extends string>(index: Map<string, Set<T>>, name: string, id: T): void {
  const key = normalizeName(name)
  const ids = index.get(key) ?? new Set<T>()
  ids.add(id)
  index.set(key, ids)
}

function folderIdsForClause(
  clause: SearchNameClause,
  idsByName: Map<string, Set<FolderId>>,
): Set<string> {
  const key = normalizeName(clause.value)
  if (key === 'top-level' || key === 'top level' || key === 'unfiled') return new Set([''])
  return new Set(idsByName.get(key) ?? [])
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function displayTitle(chat: Pick<ChatSidebarRow, 'title'>): string {
  const title = chat.title.trim()
  return title.length > 0 ? title : 'Untitled chat'
}

function isUntitledChat(chat: ChatSidebarRow): boolean {
  return (
    chat.titleStatus === 'untitled' ||
    chat.titleStatus === 'auto-failed' ||
    chat.titleStatus === 'pending'
  )
}

function trimSnippetStart(text: string, rawStart: number, matchIndex: number): number {
  if (rawStart === 0) return 0
  const nextWhitespace = findNextWhitespace(text, rawStart)
  if (nextWhitespace < 0 || nextWhitespace >= matchIndex) return rawStart
  return nextWhitespace + 1
}

function trimSnippetEnd(text: string, rawEnd: number, matchEnd: number): number {
  if (rawEnd >= text.length) return text.length
  const previousWhitespace = text.lastIndexOf(' ', rawEnd)
  if (previousWhitespace <= matchEnd) return rawEnd
  return previousWhitespace
}

function findNextWhitespace(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (/\s/.test(text[index] ?? '')) return index
  }
  return -1
}

class BoundedSearchTaskPool {
  private readonly limit: number
  private readonly active = new Set<Promise<void>>()
  private failure: unknown

  constructor(limit: number) {
    this.limit = limit
  }

  async add(task: () => Promise<void>): Promise<void> {
    while (this.active.size >= this.limit) {
      await Promise.race(this.active)
      this.throwFailure()
    }
    this.throwFailure()
    const running: Promise<void> = Promise.resolve()
      .then(task)
      .catch((error: unknown) => {
        this.failure ??= error
      })
      .finally(() => this.active.delete(running))
    this.active.add(running)
  }

  async drain(): Promise<void> {
    await this.settle()
    this.throwFailure()
  }

  async settle(): Promise<void> {
    await Promise.all([...this.active])
  }

  private throwFailure(): void {
    if (this.failure !== undefined) {
      throw this.failure instanceof Error
        ? this.failure
        : new Error('ChatSearchTaskFailed', { cause: this.failure })
    }
  }
}

function createLinkedSearchAbortController(...signals: readonly (AbortSignal | undefined)[]): {
  readonly controller: AbortController
  readonly dispose: () => void
} {
  const controller = new AbortController()
  const linked: AbortSignal[] = []
  const abort = () => controller.abort()
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    linked.push(signal)
  }
  return {
    controller,
    dispose: () => {
      for (const signal of linked) signal.removeEventListener('abort', abort)
    },
  }
}

function boundedConcurrency(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(1, Math.min(8, Math.floor(value)))
  }
  const hardware =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4
  return Math.max(2, Math.min(8, hardware - 1))
}

function searchNowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function createSearchYieldController(): { maybeYield: () => Promise<void> } {
  let lastYieldAt = searchNowMs()
  return {
    async maybeYield() {
      if (searchNowMs() - lastYieldAt < SEARCH_YIELD_BUDGET_MS) return
      lastYieldAt = searchNowMs()
      await yieldToEventLoop()
      lastYieldAt = searchNowMs()
    },
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ChatSearchAbortedError()
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof ChatSearchAbortedError ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  )
}
