import {
  buildBranchCacheRow,
  messageRenderableText,
} from '../core/branch-flatten'
import {
  firstPositiveMatch,
  hasNegativeTextTerms,
  hasPositiveTextTerms,
  parseSearchQuery,
  textMatchesClauses,
  type SearchNameClause,
  type SearchQuery,
  type SearchQueryParseError,
  type SearchTextClause,
} from '../core/search-query'
import type {
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatId,
  ChatTag,
  FolderId,
  Message,
  MessageId,
  TagId,
} from '../core/types'
import { isChatBranchCacheFresh } from './branch-cache'
import type { WorkspaceRepository } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

export type SearchScope = 'last-updated-branch' | 'all-branches'
export type SearchResultSource = 'title' | 'branch-cache' | 'all-branches' | 'folder' | 'tag' | 'preview'

export interface SearchFilters {
  includeFolderIds: FolderId[]
  excludeFolderIds: FolderId[]
  includeTagIds: TagId[]
  excludeTagIds: TagId[]
  archived: 'exclude' | 'include' | 'only'
  titleOnly: boolean
}

export interface SearchHighlightRange {
  start: number
  end: number
}

export interface SearchResult {
  id: string
  chatId: ChatId
  chat: Chat
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

export interface ChatSearchStartedUpdate {
  kind: 'started'
  queryId: string
  candidateCount: number
}

export interface ChatSearchHitUpdate {
  kind: 'hit'
  queryId: string
  result: SearchResult
  completedCount: number
  candidateCount: number
}

export interface ChatSearchMissUpdate {
  kind: 'miss'
  queryId: string
  chatId: ChatId
  completedCount: number
  candidateCount: number
}

export interface ChatSearchTaskErrorUpdate {
  kind: 'task-error'
  queryId: string
  chatId: ChatId
  message: string
  completedCount: number
  candidateCount: number
}

export interface ChatSearchDoneUpdate {
  kind: 'done'
  queryId: string
  completedCount: number
  candidateCount: number
}

export type ChatSearchUpdate =
  | ChatSearchStartedUpdate
  | ChatSearchHitUpdate
  | ChatSearchMissUpdate
  | ChatSearchTaskErrorUpdate
  | ChatSearchDoneUpdate

export interface ChatSearchOutput {
  queryId: string
  results: SearchResult[]
  candidateCount: number
  completedCount: number
  warnings: SearchQuery['warnings']
}

export interface SearchChatsInput {
  queryId: string
  query: string
  scope?: SearchScope
  filters?: SearchFilters
  chatIds?: readonly ChatId[]
  repo?: WorkspaceRepository
  signal?: AbortSignal
  concurrency?: number
  onUpdate?: (update: ChatSearchUpdate) => void
}

interface SearchCatalog {
  foldersById: Map<FolderId, ChatFolder>
  tagsById: Map<TagId, ChatTag>
  folderIdsByName: Map<string, Set<FolderId>>
  tagIdsByName: Map<string, Set<TagId>>
}

interface SearchField {
  source: SearchResultSource
  text: string
  messageId?: MessageId
}

interface FieldMatch {
  source: SearchResultSource
  text: string
  matchIndex: number | null
  matchLength: number
  messageId?: MessageId
}

interface ScanContext {
  queryId: string
  parsed: SearchQuery
  catalog: SearchCatalog
  filters: SearchFilters
  scope: SearchScope
  repo: WorkspaceRepository
  signal?: AbortSignal
}

export class ChatSearchParseError extends Error {
  readonly position: number

  constructor(error: SearchQueryParseError) {
    super(error.message)
    this.name = 'ChatSearchParseError'
    this.position = error.position
  }
}

export class ChatSearchAbortedError extends Error {
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
const TITLE_PASS_YIELD_INTERVAL = 64

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
  const filters = cloneSearchFilters(input.filters)
  const parseResult = parseSearchQuery(input.query)
  if (!parseResult.ok) throw new ChatSearchParseError(parseResult.error)

  const repo = input.repo ?? getWorkspaceRepository()
  const scope = input.scope ?? 'last-updated-branch'
  const [chats, folders, tags] = await Promise.all([
    repo.listChats(),
    repo.listFolders(),
    repo.listTags(),
  ])
  throwIfAborted(input.signal)

  const catalog = buildCatalog(folders, tags)
  const context: ScanContext = {
    queryId: input.queryId,
    parsed: parseResult.query,
    catalog,
    filters,
    scope,
    repo,
  }
  if (input.signal) context.signal = input.signal

  const chatIdFilter = input.chatIds ? new Set(input.chatIds) : null
  const candidates = chats.filter(
    (chat) => (!chatIdFilter || chatIdFilter.has(chat.id)) && chatPassesStaticFilters(chat, context),
  )
  let completedCount = 0
  const resultsByChat = new Map<ChatId, SearchResult>()
  const remaining: Chat[] = []

  input.onUpdate?.({
    kind: 'started',
    queryId: input.queryId,
    candidateCount: candidates.length,
  })

  for (let index = 0; index < candidates.length; index += 1) {
    throwIfAborted(input.signal)
    const chat = candidates[index]
    if (!chat) continue
    const immediate = matchImmediateChat(chat, context)
    if (immediate) {
      completedCount += 1
      resultsByChat.set(chat.id, immediate)
      input.onUpdate?.({
        kind: 'hit',
        queryId: input.queryId,
        result: immediate,
        completedCount,
        candidateCount: candidates.length,
      })
    } else if (filters.titleOnly) {
      completedCount += 1
      input.onUpdate?.({
        kind: 'miss',
        queryId: input.queryId,
        chatId: chat.id,
        completedCount,
        candidateCount: candidates.length,
      })
    } else {
      remaining.push(chat)
    }
    if (index > 0 && index % TITLE_PASS_YIELD_INTERVAL === 0) await yieldToEventLoop()
  }

  const concurrency = boundedConcurrency(input.concurrency)
  let nextIndex = 0
  async function scanNext(): Promise<void> {
    while (true) {
      throwIfAborted(input.signal)
      const index = nextIndex
      nextIndex += 1
      const chat = remaining[index]
      if (!chat) return
      try {
        const result =
          scope === 'all-branches'
            ? await scanAllBranchesChat(chat, context)
            : await scanLastUpdatedBranchChat(chat, context)
        completedCount += 1
        if (result) {
          resultsByChat.set(chat.id, result)
          input.onUpdate?.({
            kind: 'hit',
            queryId: input.queryId,
            result,
            completedCount,
            candidateCount: candidates.length,
          })
        } else {
          input.onUpdate?.({
            kind: 'miss',
            queryId: input.queryId,
            chatId: chat.id,
            completedCount,
            candidateCount: candidates.length,
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
          candidateCount: candidates.length,
        })
      }
      await yieldToEventLoop()
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, scanNext))
  throwIfAborted(input.signal)
  input.onUpdate?.({
    kind: 'done',
    queryId: input.queryId,
    completedCount,
    candidateCount: candidates.length,
  })

  return {
    queryId: input.queryId,
    results: [...resultsByChat.values()],
    candidateCount: candidates.length,
    completedCount,
    warnings: parseResult.query.warnings,
  }
}

function matchImmediateChat(chat: Chat, context: ScanContext): SearchResult | null {
  if (context.parsed.text.length === 0) {
    return buildResult({
      chat,
      match: fallbackMatch(chat, context),
      parsed: context.parsed,
    })
  }

  if (hasNegativeTextTerms(context.parsed) && !context.filters.titleOnly) return null

  const metadataMatch = matchFields(metadataFields(chat, context), context.parsed)
  if (!metadataMatch) return null
  return buildResult({ chat, match: metadataMatch, parsed: context.parsed })
}

async function scanLastUpdatedBranchChat(
  chat: Chat,
  context: ScanContext,
): Promise<SearchResult | null> {
  throwIfAborted(context.signal)
  const cache = await readFreshBranchCache(context.repo, chat, context.signal)
  throwIfAborted(context.signal)
  const fields = [...metadataFields(chat, context)]
  if (cache?.textContent) {
    fields.push({ source: 'branch-cache', text: cache.textContent })
  }
  const match = matchFields(fields, context.parsed)
  if (!match) return null
  const resultInput: Parameters<typeof buildResult>[0] = {
    chat,
    match,
    parsed: context.parsed,
  }
  if (cache) resultInput.branchLeafId = cache.branchLeafId
  return buildResult(resultInput)
}

async function scanAllBranchesChat(
  chat: Chat,
  context: ScanContext,
): Promise<SearchResult | null> {
  throwIfAborted(context.signal)
  const messages = await context.repo.listMessages(chat.id)
  throwIfAborted(context.signal)
  const corpus = buildAllBranchesCorpus(messages, context.signal)
  const fields = [...metadataFields(chat, context)]
  if (corpus.text.length > 0) fields.push({ source: 'all-branches', text: corpus.text })

  const match = matchFields(fields, context.parsed)
  if (!match) return null

  let messageId = latestMatchingMessageId(corpus.messages, context.parsed) ?? match.messageId
  let branchLeafId: MessageId | null | undefined
  if (messageId && (await freshLastUpdatedBranchMatches(chat, context))) {
    messageId = undefined
    branchLeafId = chat.lastUpdatedLeafId
  }

  const resultInput: Parameters<typeof buildResult>[0] = {
    chat,
    match: { ...match, ...(messageId ? { messageId } : {}) },
    parsed: context.parsed,
  }
  if (messageId) resultInput.messageId = messageId
  if (branchLeafId !== undefined) resultInput.branchLeafId = branchLeafId
  return buildResult(resultInput)
}

function chatPassesStaticFilters(chat: Chat, context: ScanContext): boolean {
  if (context.filters.archived === 'exclude' && chat.archived) return false
  if (context.filters.archived === 'only' && !chat.archived) return false

  if (
    context.filters.includeFolderIds.length > 0 &&
    !context.filters.includeFolderIds.includes(chat.folderId ?? '')
  ) {
    return false
  }
  if (chat.folderId && context.filters.excludeFolderIds.includes(chat.folderId)) return false

  if (
    context.filters.includeTagIds.length > 0 &&
    !chat.tags.some((tagId) => context.filters.includeTagIds.includes(tagId))
  ) {
    return false
  }
  if (chat.tags.some((tagId) => context.filters.excludeTagIds.includes(tagId))) return false

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

function isClausesPass(chat: Chat, parsed: SearchQuery): boolean {
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

function matchFields(fields: readonly SearchField[], parsed: SearchQuery): FieldMatch | null {
  const combined = fields.map((field) => field.text).join('\n')
  if (!textMatchesClauses(combined, parsed.text)) return null

  if (!hasPositiveTextTerms(parsed)) {
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

  let best: FieldMatch | null = null
  for (const field of fields) {
    const hit = firstPositiveMatch(field.text, parsed.text)
    if (!hit) continue
    if (!best || hit.index < (best.matchIndex ?? Number.POSITIVE_INFINITY)) {
      best = {
        source: field.source,
        text: field.text,
        matchIndex: hit.index,
        matchLength: hit.length,
        ...(field.messageId ? { messageId: field.messageId } : {}),
      }
    }
  }
  return best
}

function metadataFields(chat: Chat, context: ScanContext): SearchField[] {
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

function fallbackMatch(chat: Chat, context: ScanContext): FieldMatch {
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
  chat: Chat
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
  match: Pick<FieldMatch, 'matchIndex' | 'matchLength'>,
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
      prefixTruncated: false,
      suffixTruncated: text.length > snippet.length,
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
    prefixTruncated: start > 0,
    suffixTruncated: end < text.length,
  }
}

function highlightRanges(
  text: string,
  clauses: readonly SearchTextClause[],
): SearchHighlightRange[] {
  const ranges: SearchHighlightRange[] = []
  const lowered = text.toLocaleLowerCase()
  for (const clause of clauses) {
    if (clause.negated || clause.value.length === 0) continue
    const needle = clause.value.toLocaleLowerCase()
    let index = lowered.indexOf(needle)
    while (index >= 0) {
      ranges.push({ start: index, end: index + clause.value.length })
      index = lowered.indexOf(needle, index + Math.max(needle.length, 1))
    }
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

async function readFreshBranchCache(
  repo: WorkspaceRepository,
  chat: Chat,
  signal?: AbortSignal,
): Promise<ChatBranchCache | undefined> {
  throwIfAborted(signal)
  const current = await repo.getChat(chat.id)
  if (!current) {
    await repo.deleteChatBranchCache(chat.id)
    return undefined
  }
  const existing = await repo.getChatBranchCache(chat.id)
  if (isChatBranchCacheFresh(current, existing)) return existing
  if (current.lastUpdatedLeafId === null) {
    if (existing) await repo.deleteChatBranchCache(chat.id)
    return undefined
  }
  const messages = await repo.listMessages(chat.id)
  throwIfAborted(signal)
  return repo.putChatBranchCache(
    buildBranchCacheRow({
      chatId: chat.id,
      branchLeafId: current.lastUpdatedLeafId,
      messages,
    }),
  )
}

async function freshLastUpdatedBranchMatches(chat: Chat, context: ScanContext): Promise<boolean> {
  const cache = await context.repo.getChatBranchCache(chat.id)
  if (!isChatBranchCacheFresh(chat, cache)) return false
  return textMatchesClauses(cache.textContent, context.parsed.text)
}

function buildAllBranchesCorpus(
  messages: readonly Message[],
  signal?: AbortSignal,
): { text: string; messages: Array<{ message: Message; text: string; start: number; end: number }> } {
  const liveMessages = messages
    .filter((message) => !message.deleted)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  const chunks: string[] = []
  const indexed: Array<{ message: Message; text: string; start: number; end: number }> = []
  let offset = 0

  for (const message of liveMessages) {
    throwIfAborted(signal)
    const text = messageRenderableText(message)
    if (text.length === 0) continue
    if (chunks.length > 0) {
      chunks.push('\n\n')
      offset += 2
    }
    const start = offset
    chunks.push(text)
    offset += text.length
    indexed.push({ message, text, start, end: offset })
  }

  return { text: chunks.join(''), messages: indexed }
}

function latestMatchingMessageId(
  messages: readonly { message: Message; text: string }[],
  parsed: SearchQuery,
): MessageId | undefined {
  let fallback: Message | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const row = messages[index]
    if (!row) continue
    if (textMatchesClauses(row.text, parsed.text)) return row.message.id
    if (!fallback && firstPositiveMatch(row.text, parsed.text)) fallback = row.message
  }
  return fallback?.id
}

function buildCatalog(folders: readonly ChatFolder[], tags: readonly ChatTag[]): SearchCatalog {
  const folderIdsByName = new Map<string, Set<FolderId>>()
  const tagIdsByName = new Map<string, Set<TagId>>()
  for (const folder of folders) addNameIndex(folderIdsByName, folder.name, folder.id)
  for (const tag of tags) addNameIndex(tagIdsByName, tag.name, tag.id)
  return {
    foldersById: new Map(folders.map((folder) => [folder.id, folder])),
    tagsById: new Map(tags.map((tag) => [tag.id, tag])),
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

function displayTitle(chat: Pick<Chat, 'title'>): string {
  const title = chat.title.trim()
  return title.length > 0 ? title : 'Untitled chat'
}

function isUntitledChat(chat: Chat): boolean {
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

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ChatSearchAbortedError()
}

function isAbortError(error: unknown): boolean {
  return error instanceof ChatSearchAbortedError || (error as { name?: string })?.name === 'AbortError'
}
