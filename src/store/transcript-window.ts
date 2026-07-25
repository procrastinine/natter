import type { BranchPathDescriptor, BranchPathSpan } from '../core/branch-session'
import { TRANSCRIPT_BODY_READ_BATCH_ROWS } from '../core/transcript-work-budget'
import type { Message, MessageId } from '../core/types'
import { PersistentStringMap } from '../lib/persistent-string-map'
import {
  type MessageHeaderRow,
  rebaseHydratedMessageHeader,
  sameMessageHeaderStructure,
  sameMessageHeaderValue,
} from './message-storage'

export interface TranscriptBodyPage {
  readonly chatId: string
  readonly leafId: MessageId | null
  readonly branchLength: number
  readonly offset: number
  readonly headers: readonly MessageHeaderRow[]
  readonly messages: readonly Message[]
}

export interface TranscriptBodyPageChunk {
  readonly offset: number
  readonly headers: readonly MessageHeaderRow[]
  readonly messages: readonly Message[]
  readonly bodyVersions: readonly number[]
  readonly bodyExact: readonly boolean[]
}

export interface TranscriptBodyPresentation {
  readonly header: MessageHeaderRow
  readonly message: Message
  readonly bodyVersion: number
}

export interface TranscriptBodyRevision {
  readonly header: MessageHeaderRow
  readonly presentation?: TranscriptBodyPresentation
}

export interface TranscriptBodyPageLeaf {
  readonly kind: 'page'
  readonly offset: number
  readonly page: TranscriptBodyPageChunk
  readonly rowCount: number
  readonly staleBodyCount: number
  readonly pageCount: 1
}

export interface TranscriptBodyPageBranch {
  readonly kind: 'branch'
  readonly level: number
  readonly slots: readonly TranscriptBodyPageSlot[]
  readonly rowCount: number
  readonly staleBodyCount: number
  readonly pageCount: number
}

export interface TranscriptBodyPageSlot {
  readonly index: number
  readonly child: TranscriptBodyPageTree
}

export type TranscriptBodyPageTree = TranscriptBodyPageLeaf | TranscriptBodyPageBranch

interface TranscriptBodyRowLocator {
  readonly pathIndex: number
  readonly pageOffset: number
  readonly rowIndex: number
}

export interface TranscriptBodyWindow {
  readonly chatId: string
  readonly leafId: MessageId | null
  readonly branchLength: number
  readonly pathIdentity: object
  readonly offset: number
  readonly rowCount: number
  readonly staleBodyCount: number
  readonly pages: TranscriptBodyPageBranch | null
  readonly rowLocatorsById: PersistentStringMap<TranscriptBodyRowLocator>
}

export interface TranscriptBodyWindowRow {
  readonly pathIndex: number
  readonly header: MessageHeaderRow
  readonly message: Message
  readonly bodyVersion: number
  readonly bodyExact: boolean
}

export interface TranscriptBodyStaleSpan {
  readonly offset: number
  readonly limit: number
}

export type TranscriptBodyTransition =
  | { readonly kind: 'exact'; readonly window: TranscriptBodyWindow }
  | {
      readonly kind: 'divergent'
      readonly commonPrefix: TranscriptBodyWindow
      readonly terminalFallback: TranscriptBodyWindow | null
      readonly suffix: BranchPathSpan
    }
  | { readonly kind: 'terminal'; readonly window: TranscriptBodyWindow }
  | { readonly kind: 'cold' }

const PAGE_TREE_ROOT_LEVEL = 8
const PAGE_TREE_RADIX = 64

export function transcriptBodyWindowFromPage(
  page: TranscriptBodyPage,
  path: BranchPathDescriptor<MessageHeaderRow>,
): TranscriptBodyWindow {
  validateTranscriptBodyPage(page)
  validateTranscriptBodyPageIdentity(page, path)
  const leaf = pageLeaf(pageChunk(page))
  return Object.freeze({
    chatId: page.chatId,
    leafId: page.leafId,
    branchLength: page.branchLength,
    pathIdentity: path.identity,
    offset: page.offset,
    rowCount: page.headers.length,
    staleBodyCount: 0,
    pages: page.headers.length > 0 ? insertPageLeaf(null, leaf) : null,
    rowLocatorsById: indexPageRows(page),
  })
}

export function transcriptBodyPointWindow(
  presentation: TranscriptBodyPresentation,
): TranscriptBodyWindow {
  const page: TranscriptBodyPage = Object.freeze({
    chatId: presentation.header.chatId,
    leafId: presentation.header.id,
    branchLength: 1,
    offset: 0,
    headers: Object.freeze([presentation.header]),
    messages: Object.freeze([presentation.message]),
  })
  validateTranscriptBodyPage(page)
  const leaf = pageLeaf(pageChunk(page))
  return Object.freeze({
    chatId: page.chatId,
    leafId: page.leafId,
    branchLength: 1,
    pathIdentity: Object.freeze({}),
    offset: 0,
    rowCount: 1,
    staleBodyCount: 0,
    pages: insertPageLeaf(null, leaf),
    rowLocatorsById: indexPageRows(page),
  })
}

export function emptyTranscriptBodyWindow(
  chatId: string,
  path: BranchPathDescriptor<MessageHeaderRow>,
): TranscriptBodyWindow {
  if (path.length !== 0 || path.leaf !== null) throw new Error('TranscriptBodyEmptyPathInvalid')
  return Object.freeze({
    chatId,
    leafId: null,
    branchLength: 0,
    pathIdentity: path.identity,
    offset: 0,
    rowCount: 0,
    staleBodyCount: 0,
    pages: null,
    rowLocatorsById: PersistentStringMap.empty<TranscriptBodyRowLocator>(),
  })
}

export function prependTranscriptBodyPage(
  window: TranscriptBodyWindow,
  page: TranscriptBodyPage,
): TranscriptBodyWindow {
  validateTranscriptBodyPage(page)
  if (
    page.chatId !== window.chatId ||
    page.leafId !== window.leafId ||
    page.branchLength !== window.branchLength ||
    page.offset + page.headers.length !== window.offset ||
    page.headers.length === 0
  ) {
    throw new Error('TranscriptBodyPageNotAdjacent')
  }
  const currentFirst = transcriptBodyWindowFirstRow(window)?.header
  const incomingLast = page.headers.at(-1)
  if (currentFirst && incomingLast && currentFirst.parentId !== incomingLast.id) {
    throw new Error('TranscriptBodyPageBoundaryMismatch')
  }
  let rowLocatorsById = window.rowLocatorsById
  for (const [messageId, locator] of pageRowLocatorEntries(page)) {
    if (rowLocatorsById.has(messageId)) throw new Error('TranscriptBodyPageDuplicateRow')
    rowLocatorsById = rowLocatorsById.set(messageId, locator)
  }
  return Object.freeze({
    ...window,
    offset: page.offset,
    rowCount: window.rowCount + page.headers.length,
    staleBodyCount: window.staleBodyCount,
    pages: insertPageLeaf(window.pages, pageLeaf(pageChunk(page))),
    rowLocatorsById,
  })
}

export function appendTranscriptBodyPage(
  window: TranscriptBodyWindow,
  page: TranscriptBodyPage,
): TranscriptBodyWindow {
  validateTranscriptBodyPage(page)
  if (
    page.chatId !== window.chatId ||
    page.leafId !== window.leafId ||
    page.branchLength !== window.branchLength ||
    page.offset !== window.offset + window.rowCount ||
    page.headers.length === 0
  ) {
    throw new Error('TranscriptBodyPageNotAdjacent')
  }
  const currentLast = transcriptBodyWindowLastRow(window)?.header
  const incomingFirst = page.headers[0]
  if (currentLast && incomingFirst && incomingFirst.parentId !== currentLast.id) {
    throw new Error('TranscriptBodyPageBoundaryMismatch')
  }
  let rowLocatorsById = window.rowLocatorsById
  for (const [messageId, locator] of pageRowLocatorEntries(page)) {
    if (rowLocatorsById.has(messageId)) throw new Error('TranscriptBodyPageDuplicateRow')
    rowLocatorsById = rowLocatorsById.set(messageId, locator)
  }
  return Object.freeze({
    ...window,
    rowCount: window.rowCount + page.headers.length,
    staleBodyCount: window.staleBodyCount,
    pages: insertPageLeaf(window.pages, pageLeaf(pageChunk(page))),
    rowLocatorsById,
  })
}

export function transitionTranscriptBodyWindow(
  path: BranchPathDescriptor<MessageHeaderRow>,
  presentations: readonly TranscriptBodyPresentation[],
  base: TranscriptBodyWindow | null,
  previousPath: BranchPathDescriptor<MessageHeaderRow> | null,
): TranscriptBodyTransition {
  const leaf = path.leaf
  if (!leaf) return Object.freeze({ kind: 'cold' })
  const incomingById = new Map<MessageId, TranscriptBodyPresentation>()
  for (const presentation of presentations) {
    incomingById.set(presentation.header.id, presentation)
  }
  if (base) {
    const rebased = rebaseTranscriptBodyWindow(path, base, incomingById)
    if (rebased) return Object.freeze({ kind: 'exact', window: rebased })
  }
  const candidateLimit = Math.min(
    path.length,
    incomingById.size + (base?.chatId === leaf.chatId ? base.rowCount : 0),
  )
  let terminalFallback: TranscriptBodyWindow | null = null
  if (candidateLimit > 0) {
    const tail = path.backwardWindow({ endingAt: leaf.id, limit: candidateLimit })
    const suffixHeaders: MessageHeaderRow[] = []
    const suffixMessages: Message[] = []
    for (let index = tail.nodes.length - 1; index >= 0; index -= 1) {
      const header = tail.nodes[index] as MessageHeaderRow
      let message: Message | undefined
      const retained = base ? transcriptBodyWindowFindRow(base, header.id) : undefined
      if (
        retained?.bodyExact &&
        retained.message.chatId === leaf.chatId &&
        retained.bodyVersion === header.bodyVersion
      ) {
        message = rebaseHydratedMessageHeader(retained.message, header)
      }
      const presentation = incomingById.get(header.id)
      if (
        presentation &&
        presentation.header.nodeVersion === header.nodeVersion &&
        presentation.header.bodyVersion === header.bodyVersion &&
        sameMessageHeaderStructure(presentation.header, header)
      ) {
        message = rebaseHydratedMessageHeader(presentation.message, header)
      }
      if (!message) break
      suffixHeaders.push(header)
      suffixMessages.push(message)
    }
    if (suffixMessages.length > 0) {
      suffixHeaders.reverse()
      suffixMessages.reverse()
      const offset = tail.offset + tail.nodes.length - suffixHeaders.length
      for (let index = 0; index < suffixHeaders.length; index += TRANSCRIPT_BODY_READ_BATCH_ROWS) {
        const page: TranscriptBodyPage = Object.freeze({
          chatId: leaf.chatId,
          leafId: leaf.id,
          branchLength: path.length,
          offset: offset + index,
          headers: Object.freeze(
            suffixHeaders.slice(index, index + TRANSCRIPT_BODY_READ_BATCH_ROWS),
          ),
          messages: Object.freeze(
            suffixMessages.slice(index, index + TRANSCRIPT_BODY_READ_BATCH_ROWS),
          ),
        })
        terminalFallback = terminalFallback
          ? appendTranscriptBodyPage(terminalFallback, page)
          : transcriptBodyWindowFromPage(page, path)
      }
    }
  }
  if (base && previousPath && transcriptBodyWindowMatchesPath(base, previousPath)) {
    const divergence = path.divergenceFrom(previousPath)
    const commonPrefix = retainTranscriptBodyPrefix(
      path,
      base,
      divergence.commonPrefixLength,
      previousPath,
    )
    if (commonPrefix) {
      if (commonPrefix.offset + commonPrefix.rowCount === path.length) {
        return Object.freeze({ kind: 'exact', window: commonPrefix })
      }
      if (terminalFallback && terminalFallback.offset <= commonPrefix.offset) {
        return Object.freeze({ kind: 'exact', window: terminalFallback })
      }
      if (
        terminalFallback &&
        terminalFallback.offset <= commonPrefix.offset + commonPrefix.rowCount
      ) {
        const joinPrefix =
          terminalFallback.offset < commonPrefix.offset + commonPrefix.rowCount
            ? retainTranscriptBodyPrefix(path, commonPrefix, terminalFallback.offset)
            : commonPrefix
        const joined = joinPrefix
          ? appendExactTranscriptBodyWindow(joinPrefix, terminalFallback)
          : null
        if (joined) return Object.freeze({ kind: 'exact', window: joined })
      }
      return Object.freeze({
        kind: 'divergent',
        commonPrefix,
        terminalFallback,
        suffix: Object.freeze({
          branchLength: divergence.branchLength,
          offset: divergence.offset,
          limit: divergence.limit,
          boundaryParentId: divergence.boundaryParentId,
        }),
      })
    }
  }
  return terminalFallback
    ? Object.freeze({ kind: 'terminal', window: terminalFallback })
    : Object.freeze({ kind: 'cold' })
}

function appendExactTranscriptBodyWindow(
  prefix: TranscriptBodyWindow,
  suffix: TranscriptBodyWindow,
): TranscriptBodyWindow | null {
  if (
    prefix.chatId !== suffix.chatId ||
    prefix.pathIdentity !== suffix.pathIdentity ||
    prefix.leafId !== suffix.leafId ||
    prefix.branchLength !== suffix.branchLength ||
    prefix.offset + prefix.rowCount !== suffix.offset
  ) {
    return null
  }
  let joined = prefix
  for (const page of transcriptBodyWindowPages(suffix)) {
    if (page.page.bodyExact.some((exact) => !exact)) return null
    joined = appendTranscriptBodyPage(
      joined,
      Object.freeze({
        chatId: suffix.chatId,
        leafId: suffix.leafId,
        branchLength: suffix.branchLength,
        offset: page.offset,
        headers: page.page.headers,
        messages: page.page.messages,
      }),
    )
  }
  return joined
}

export function retainTranscriptBodyPrefix(
  path: BranchPathDescriptor<MessageHeaderRow>,
  base: TranscriptBodyWindow,
  commonPrefixLength: number,
  previousPath?: BranchPathDescriptor<MessageHeaderRow>,
): TranscriptBodyWindow | null {
  if (
    base.chatId !== path.leaf?.chatId ||
    !Number.isSafeInteger(commonPrefixLength) ||
    commonPrefixLength < 0 ||
    commonPrefixLength > path.length
  ) {
    return null
  }
  const end = Math.min(commonPrefixLength, base.offset + base.rowCount)
  if (end <= base.offset) return null
  const retained = reidentifyTranscriptBodyWindow(truncateTranscriptBodyWindow(base, end), path)
  if (
    previousPath &&
    transcriptBodyWindowMatchesPath(base, previousPath) &&
    path.sharesNodeValuesThrough(previousPath, end)
  ) {
    return retained
  }
  const revisions: TranscriptBodyRevision[] = []
  for (const row of transcriptBodyWindowRows(retained)) {
    const header = path.get(row.header.id)
    if (
      !header ||
      path.indexOf(header.id) !== row.pathIndex ||
      !sameMessageHeaderStructure(header, row.header)
    ) {
      return null
    }
    revisions.push(Object.freeze({ header }))
  }
  return withTranscriptBodyRevisions(retained, revisions)
}

export function rebaseTranscriptBodyWindow(
  path: BranchPathDescriptor<MessageHeaderRow>,
  base: TranscriptBodyWindow,
  incomingById: ReadonlyMap<MessageId, TranscriptBodyPresentation>,
  changedIds: readonly MessageId[] = [],
): TranscriptBodyWindow | null {
  if (
    base.chatId !== path.leaf?.chatId ||
    base.offset < 0 ||
    base.offset + base.rowCount > path.length
  ) {
    return null
  }
  const samePath = base.pathIdentity === path.identity
  const extendsPath =
    base.leafId !== null &&
    base.branchLength <= path.length &&
    path.indexOf(base.leafId) === base.branchLength - 1
  if (!samePath && !extendsPath) return null
  const revisions: TranscriptBodyRevision[] = []
  for (const messageId of new Set([...changedIds, ...incomingById.keys()])) {
    const row = transcriptBodyWindowFindRow(base, messageId)
    if (!row) continue
    const expected = path.get(messageId)
    if (!expected || path.indexOf(messageId) !== row.pathIndex) return null
    if (!sameMessageHeaderStructure(expected, row.header)) return null
    const incoming = incomingById.get(expected.id)
    revisions.push({
      header: expected,
      ...(incoming &&
      incoming.bodyVersion === expected.bodyVersion &&
      sameMessageHeaderValue(incoming.header, expected)
        ? { presentation: incoming }
        : {}),
    })
  }

  let next = withTranscriptBodyRevisions(reidentifyTranscriptBodyWindow(base, path), revisions)
  const appendOffset = base.offset + base.rowCount
  if (appendOffset === path.length) return next
  for (let offset = appendOffset; offset < path.length; offset += TRANSCRIPT_BODY_READ_BATCH_ROWS) {
    const appendWindow = path.window({
      offset,
      limit: Math.min(TRANSCRIPT_BODY_READ_BATCH_ROWS, path.length - offset),
    })
    const messages: Message[] = []
    for (const header of appendWindow.nodes) {
      const incoming = incomingById.get(header.id)
      if (!incoming || incoming.bodyVersion !== header.bodyVersion) return null
      messages.push(rebaseHydratedMessageHeader(incoming.message, header))
    }
    if (messages.length === 0) return null
    next = appendTranscriptBodyPage(
      next,
      Object.freeze({
        chatId: base.chatId,
        leafId: path.leaf.id,
        branchLength: path.length,
        offset: appendWindow.offset,
        headers: Object.freeze([...appendWindow.nodes]),
        messages: Object.freeze(messages),
      }),
    )
  }
  return next
}

export function withTranscriptBodyRevisions(
  window: TranscriptBodyWindow,
  revisions: readonly TranscriptBodyRevision[],
): TranscriptBodyWindow {
  if (!window.pages || revisions.length === 0) return window
  const grouped = new Map<number, TranscriptBodyRevision[]>()
  for (const revision of revisions) {
    const locator = window.rowLocatorsById.get(revision.header.id)
    if (!locator) continue
    const group = grouped.get(locator.pageOffset)
    if (group) group.push(revision)
    else grouped.set(locator.pageOffset, [revision])
  }
  let pages = window.pages
  for (const [pageOffset, updates] of grouped) {
    const currentPage = findPageLeaf(pages, pageOffset)
    if (!currentPage) continue
    let headers: MessageHeaderRow[] | null = null
    let messages: Message[] | null = null
    let bodyVersions: number[] | null = null
    let bodyExact: boolean[] | null = null
    for (const revision of updates) {
      const locator = window.rowLocatorsById.get(revision.header.id)
      if (!locator || locator.pageOffset !== pageOffset) continue
      const stored = storedRowFromPage(currentPage.page, locator.rowIndex)
      if (!stored) continue
      const header = revision.header
      if (
        header.chatId !== window.chatId ||
        header.id !== stored.header.id ||
        !sameMessageHeaderStructure(header, stored.header)
      ) {
        continue
      }
      const presentation = revision.presentation
      const presentationExact = Boolean(
        presentation &&
          presentation.message.chatId === window.chatId &&
          presentation.message.id === header.id &&
          presentation.bodyVersion === header.bodyVersion &&
          sameMessageHeaderValue(presentation.header, header),
      )
      const nextMessage = presentationExact
        ? rebaseHydratedMessageHeader((presentation as TranscriptBodyPresentation).message, header)
        : stored.bodyExact && stored.bodyVersion === header.bodyVersion
          ? rebaseHydratedMessageHeader(stored.message, header)
          : stored.message
      const nextBodyVersion = presentationExact ? header.bodyVersion : stored.bodyVersion
      const nextBodyExact =
        presentationExact || (stored.bodyExact && stored.bodyVersion === header.bodyVersion)
      if (
        sameMessageHeaderValue(stored.header, header) &&
        stored.message === nextMessage &&
        stored.bodyVersion === nextBodyVersion &&
        stored.bodyExact === nextBodyExact
      ) {
        continue
      }
      headers ??= [...currentPage.page.headers]
      messages ??= [...currentPage.page.messages]
      bodyVersions ??= [...currentPage.page.bodyVersions]
      bodyExact ??= [...currentPage.page.bodyExact]
      headers[locator.rowIndex] = header
      messages[locator.rowIndex] = nextMessage
      bodyVersions[locator.rowIndex] = nextBodyVersion
      bodyExact[locator.rowIndex] = nextBodyExact
    }
    if (!headers || !messages || !bodyVersions || !bodyExact) continue
    const chunk: TranscriptBodyPageChunk = Object.freeze({
      offset: currentPage.page.offset,
      headers: Object.freeze(headers),
      messages: Object.freeze(messages),
      bodyVersions: Object.freeze(bodyVersions),
      bodyExact: Object.freeze(bodyExact),
    })
    pages = replacePageLeaf(pages, pageOffset, () => pageLeaf(chunk))
  }
  return pages === window.pages
    ? window
    : Object.freeze({
        ...window,
        staleBodyCount: pages.staleBodyCount,
        pages,
      })
}

export function invalidateTranscriptBodyRows(
  window: TranscriptBodyWindow,
  messageIds: true | readonly MessageId[],
): TranscriptBodyWindow {
  if (!window.pages || window.rowCount === 0) return window
  const grouped = new Map<number, number[]>()
  if (messageIds === true) {
    for (const page of transcriptBodyWindowPages(window)) {
      grouped.set(
        page.offset,
        page.page.bodyExact.flatMap((exact, index) => (exact ? [index] : [])),
      )
    }
  } else {
    for (const messageId of messageIds) {
      const locator = window.rowLocatorsById.get(messageId)
      if (!locator) continue
      const indices = grouped.get(locator.pageOffset)
      if (indices) indices.push(locator.rowIndex)
      else grouped.set(locator.pageOffset, [locator.rowIndex])
    }
  }
  let pages = window.pages
  for (const [pageOffset, indices] of grouped) {
    if (indices.length === 0) continue
    const currentPage = findPageLeaf(pages, pageOffset)
    if (!currentPage) continue
    const bodyExact = [...currentPage.page.bodyExact]
    let changed = false
    for (const index of indices) {
      if (!bodyExact[index]) continue
      bodyExact[index] = false
      changed = true
    }
    if (!changed) continue
    pages = replacePageLeaf(pages, pageOffset, () =>
      pageLeaf(
        Object.freeze({
          ...currentPage.page,
          bodyExact: Object.freeze(bodyExact),
        }),
      ),
    )
  }
  return pages === window.pages
    ? window
    : Object.freeze({ ...window, staleBodyCount: pages.staleBodyCount, pages })
}

export function transcriptBodyWindowNextStaleSpan(
  window: TranscriptBodyWindow,
  maxRows: number,
): TranscriptBodyStaleSpan | null {
  if (!window.pages || window.staleBodyCount === 0 || maxRows <= 0) return null
  const page = newestStalePageLeaf(window.pages)
  if (!page) return null
  let end = page.page.bodyExact.length - 1
  while (end >= 0 && page.page.bodyExact[end]) end -= 1
  if (end < 0) return null
  let start = end
  while (start > 0 && !page.page.bodyExact[start - 1] && end - start + 1 < maxRows) {
    start -= 1
  }
  return Object.freeze({
    offset: page.offset + start,
    limit: Math.min(maxRows, end - start + 1),
  })
}

export function reidentifyTranscriptBodyWindow(
  window: TranscriptBodyWindow,
  path: BranchPathDescriptor<MessageHeaderRow>,
): TranscriptBodyWindow {
  const leafId = path.leaf?.id ?? null
  if (
    window.pathIdentity === path.identity &&
    window.leafId === leafId &&
    window.branchLength === path.length
  ) {
    return window
  }
  return Object.freeze({
    ...window,
    pathIdentity: path.identity,
    leafId,
    branchLength: path.length,
  })
}

export function retainTranscriptBodyWindowSpan(
  path: BranchPathDescriptor<MessageHeaderRow>,
  window: TranscriptBodyWindow,
  span: BranchPathSpan,
): TranscriptBodyWindow | null {
  if (
    !transcriptBodyWindowMatchesPath(window, path) ||
    span.branchLength !== path.length ||
    !Number.isSafeInteger(span.offset) ||
    !Number.isSafeInteger(span.limit) ||
    span.offset < window.offset ||
    span.limit < 0 ||
    span.offset + span.limit > window.offset + window.rowCount
  ) {
    return null
  }
  if (span.offset === window.offset && span.limit === window.rowCount) return window
  if (span.limit === 0) {
    return path.length === 0 ? emptyTranscriptBodyWindow(window.chatId, path) : null
  }
  const expected = path.window({ offset: span.offset, limit: span.limit })
  if (
    expected.branchLength !== span.branchLength ||
    expected.offset !== span.offset ||
    expected.limit !== span.limit ||
    expected.boundaryParentId !== span.boundaryParentId
  ) {
    return null
  }
  let pages: TranscriptBodyPageBranch | null = null
  let rowLocatorsById = PersistentStringMap.empty<TranscriptBodyRowLocator>()
  for (let offset = 0; offset < expected.nodes.length; offset += TRANSCRIPT_BODY_READ_BATCH_ROWS) {
    const headers: MessageHeaderRow[] = []
    const messages: Message[] = []
    const bodyVersions: number[] = []
    const bodyExact: boolean[] = []
    const nodes = expected.nodes.slice(offset, offset + TRANSCRIPT_BODY_READ_BATCH_ROWS)
    for (let index = 0; index < nodes.length; index += 1) {
      const expectedHeader = nodes[index]
      if (!expectedHeader) return null
      const row = transcriptBodyWindowFindRow(window, expectedHeader.id)
      if (
        !row ||
        row.pathIndex !== expected.offset + offset + index ||
        !sameMessageHeaderStructure(row.header, expectedHeader)
      ) {
        return null
      }
      headers.push(expectedHeader)
      messages.push(
        sameMessageHeaderValue(row.header, expectedHeader)
          ? row.message
          : rebaseHydratedMessageHeader(row.message, expectedHeader),
      )
      bodyVersions.push(row.bodyVersion)
      bodyExact.push(row.bodyExact && row.bodyVersion === expectedHeader.bodyVersion)
    }
    const chunk: TranscriptBodyPageChunk = Object.freeze({
      offset: expected.offset + offset,
      headers: Object.freeze(headers),
      messages: Object.freeze(messages),
      bodyVersions: Object.freeze(bodyVersions),
      bodyExact: Object.freeze(bodyExact),
    })
    const leaf = pageLeaf(chunk)
    pages = insertPageLeaf(pages, leaf)
    for (const [messageId, locator] of pageRowLocatorEntries(chunk)) {
      rowLocatorsById = rowLocatorsById.set(messageId, locator)
    }
  }
  return Object.freeze({
    ...window,
    offset: expected.offset,
    rowCount: expected.nodes.length,
    staleBodyCount: pages?.staleBodyCount ?? 0,
    pages,
    rowLocatorsById,
  })
}

function truncateTranscriptBodyWindow(
  window: TranscriptBodyWindow,
  endOffset: number,
): TranscriptBodyWindow {
  const currentEnd = window.offset + window.rowCount
  if (!Number.isSafeInteger(endOffset) || endOffset <= window.offset || endOffset > currentEnd) {
    throw new Error('TranscriptBodyTruncateInvalid')
  }
  if (endOffset === currentEnd) return window
  let pages = window.pages
  let rowLocatorsById = window.rowLocatorsById
  while (pages) {
    const last = edgePageLeaf(pages, 'last')
    const pageEnd = last.offset + last.rowCount
    if (pageEnd <= endOffset) break
    const keepCount = Math.max(0, endOffset - last.offset)
    for (let index = keepCount; index < last.rowCount; index += 1) {
      const messageId = last.page.headers[index]?.id
      if (messageId) rowLocatorsById = rowLocatorsById.delete(messageId)
    }
    if (keepCount === 0) {
      pages = removePageLeaf(pages, last.offset)
      continue
    }
    const prefix = pageLeaf(
      Object.freeze({
        offset: last.page.offset,
        headers: Object.freeze(last.page.headers.slice(0, keepCount)),
        messages: Object.freeze(last.page.messages.slice(0, keepCount)),
        bodyVersions: Object.freeze(last.page.bodyVersions.slice(0, keepCount)),
        bodyExact: Object.freeze(last.page.bodyExact.slice(0, keepCount)),
      }),
    )
    pages = replacePageLeaf(pages, last.offset, () => prefix)
    break
  }
  return Object.freeze({
    ...window,
    rowCount: endOffset - window.offset,
    staleBodyCount: pages?.staleBodyCount ?? 0,
    pages,
    rowLocatorsById,
  })
}

export function* transcriptBodyWindowPages(
  window: TranscriptBodyWindow,
): Generator<TranscriptBodyPageLeaf> {
  if (!window.pages) return
  const stack: TranscriptBodyPageTree[] = [window.pages]
  while (stack.length > 0) {
    const node = stack.pop() as TranscriptBodyPageTree
    if (node.kind === 'page') {
      yield node
      continue
    }
    for (let index = node.slots.length - 1; index >= 0; index -= 1) {
      const slot = node.slots[index]
      if (slot) stack.push(slot.child)
    }
  }
}

export function* transcriptBodyPageRows(
  page: TranscriptBodyPageLeaf,
): Generator<TranscriptBodyWindowRow> {
  for (let index = 0; index < page.page.headers.length; index += 1) {
    const stored = storedRowFromPage(page.page, index)
    if (stored) yield stored
  }
}

export function* transcriptBodyWindowRows(
  window: TranscriptBodyWindow,
): Generator<TranscriptBodyWindowRow> {
  for (const page of transcriptBodyWindowPages(window)) {
    yield* transcriptBodyPageRows(page)
  }
}

export function transcriptBodyWindowFindRow(
  window: TranscriptBodyWindow,
  messageId: MessageId,
): TranscriptBodyWindowRow | undefined {
  const locator = window.rowLocatorsById.get(messageId)
  if (!locator || !window.pages) return undefined
  const page = findPageLeaf(window.pages, locator.pageOffset)
  const stored = page ? storedRowFromPage(page.page, locator.rowIndex) : undefined
  return stored
}

export function transcriptBodyWindowFirstRow(
  window: TranscriptBodyWindow,
): TranscriptBodyWindowRow | undefined {
  if (!window.pages) return undefined
  const page = edgePageLeaf(window.pages, 'first')
  const stored = storedRowFromPage(page.page, 0)
  return stored
}

export function transcriptBodyWindowLastRow(
  window: TranscriptBodyWindow,
): TranscriptBodyWindowRow | undefined {
  if (!window.pages) return undefined
  const page = edgePageLeaf(window.pages, 'last')
  const stored = storedRowFromPage(page.page, page.page.headers.length - 1)
  return stored
}

export function transcriptBodyWindowMatchesPath(
  window: TranscriptBodyWindow,
  path: BranchPathDescriptor<MessageHeaderRow>,
): boolean {
  if (path.length === 0) {
    return (
      window.pathIdentity === path.identity &&
      window.leafId === null &&
      window.branchLength === 0 &&
      window.offset === 0 &&
      window.rowCount === 0
    )
  }
  const leaf = path.leaf
  if (!leaf) return false
  return (
    window.pathIdentity === path.identity &&
    window.chatId === leaf.chatId &&
    window.leafId === leaf.id &&
    window.branchLength === path.length &&
    window.offset >= 0 &&
    window.offset + window.rowCount <= path.length
  )
}

function pageLeaf(page: TranscriptBodyPageChunk): TranscriptBodyPageLeaf {
  return Object.freeze({
    kind: 'page',
    offset: page.offset,
    page,
    rowCount: page.headers.length,
    staleBodyCount: page.bodyExact.reduce((count, exact) => count + (exact ? 0 : 1), 0),
    pageCount: 1,
  })
}

function emptyPageBranch(level: number): TranscriptBodyPageBranch {
  return Object.freeze({
    kind: 'branch',
    level,
    slots: Object.freeze([]),
    rowCount: 0,
    staleBodyCount: 0,
    pageCount: 0,
  })
}

function insertPageLeaf(
  root: TranscriptBodyPageBranch | null,
  leaf: TranscriptBodyPageLeaf,
): TranscriptBodyPageBranch {
  return insertPageLeafAt(root ?? emptyPageBranch(PAGE_TREE_ROOT_LEVEL), leaf)
}

function insertPageLeafAt(
  branch: TranscriptBodyPageBranch,
  leaf: TranscriptBodyPageLeaf,
): TranscriptBodyPageBranch {
  const index = radixSlot(leaf.offset, branch.level)
  const position = slotPosition(branch.slots, index)
  const existing = branch.slots[position]
  if (existing?.index === index && branch.level === 0) {
    throw new Error('TranscriptBodyPageOffsetDuplicate')
  }
  const child =
    branch.level === 0
      ? leaf
      : insertPageLeafAt(
          existing?.index === index
            ? requirePageBranch(existing.child, branch.level - 1)
            : emptyPageBranch(branch.level - 1),
          leaf,
        )
  const nextSlot = Object.freeze({ index, child })
  const slots = [...branch.slots]
  if (existing?.index === index) slots[position] = nextSlot
  else slots.splice(position, 0, nextSlot)
  return Object.freeze({
    kind: 'branch',
    level: branch.level,
    slots: Object.freeze(slots),
    rowCount: branch.rowCount + leaf.rowCount,
    staleBodyCount: branch.staleBodyCount + leaf.staleBodyCount,
    pageCount: branch.pageCount + 1,
  })
}

function replacePageLeaf(
  root: TranscriptBodyPageBranch,
  offset: number,
  replace: (page: TranscriptBodyPageLeaf) => TranscriptBodyPageLeaf,
): TranscriptBodyPageBranch {
  const next = replacePageLeafAt(root, offset, replace)
  if (!next) throw new Error('TranscriptBodyPageOffsetMissing')
  return next
}

function replacePageLeafAt(
  branch: TranscriptBodyPageBranch,
  offset: number,
  replace: (page: TranscriptBodyPageLeaf) => TranscriptBodyPageLeaf,
): TranscriptBodyPageBranch | null {
  const index = radixSlot(offset, branch.level)
  const position = slotPosition(branch.slots, index)
  const existing = branch.slots[position]
  if (existing?.index !== index) return null
  const child =
    branch.level === 0
      ? existing.child.kind === 'page'
        ? replace(existing.child)
        : null
      : existing.child.kind === 'branch'
        ? replacePageLeafAt(existing.child, offset, replace)
        : null
  if (!child) return null
  if (child === existing.child) return branch
  const slots = [...branch.slots]
  slots[position] = Object.freeze({ index, child })
  return Object.freeze({
    ...branch,
    slots: Object.freeze(slots),
    rowCount: branch.rowCount - existing.child.rowCount + child.rowCount,
    staleBodyCount: branch.staleBodyCount - existing.child.staleBodyCount + child.staleBodyCount,
    pageCount: branch.pageCount - existing.child.pageCount + child.pageCount,
  })
}

function removePageLeaf(
  root: TranscriptBodyPageBranch,
  offset: number,
): TranscriptBodyPageBranch | null {
  const next = removePageLeafAt(root, offset)
  if (next === undefined) throw new Error('TranscriptBodyPageOffsetMissing')
  return next
}

function removePageLeafAt(
  branch: TranscriptBodyPageBranch,
  offset: number,
): TranscriptBodyPageBranch | null | undefined {
  const index = radixSlot(offset, branch.level)
  const position = slotPosition(branch.slots, index)
  const existing = branch.slots[position]
  if (existing?.index !== index) return undefined
  const child =
    branch.level === 0
      ? existing.child.kind === 'page'
        ? null
        : undefined
      : existing.child.kind === 'branch'
        ? removePageLeafAt(existing.child, offset)
        : undefined
  if (child === undefined) return undefined
  const slots = [...branch.slots]
  if (child === null) slots.splice(position, 1)
  else slots[position] = Object.freeze({ index, child })
  if (slots.length === 0) return null
  return Object.freeze({
    ...branch,
    slots: Object.freeze(slots),
    rowCount: branch.rowCount - existing.child.rowCount + (child?.rowCount ?? 0),
    staleBodyCount:
      branch.staleBodyCount - existing.child.staleBodyCount + (child?.staleBodyCount ?? 0),
    pageCount: branch.pageCount - existing.child.pageCount + (child?.pageCount ?? 0),
  })
}

function findPageLeaf(
  root: TranscriptBodyPageBranch,
  offset: number,
): TranscriptBodyPageLeaf | undefined {
  let branch = root
  for (;;) {
    const index = radixSlot(offset, branch.level)
    const position = slotPosition(branch.slots, index)
    const slot = branch.slots[position]
    if (slot?.index !== index) return undefined
    if (branch.level === 0) return slot.child.kind === 'page' ? slot.child : undefined
    if (slot.child.kind !== 'branch') return undefined
    branch = slot.child
  }
}

function edgePageLeaf(
  root: TranscriptBodyPageBranch,
  edge: 'first' | 'last',
): TranscriptBodyPageLeaf {
  let current: TranscriptBodyPageTree = root
  while (current.kind === 'branch') {
    const slot: TranscriptBodyPageSlot | undefined =
      edge === 'first' ? current.slots[0] : current.slots.at(-1)
    if (!slot) throw new Error('TranscriptBodyPageTreeEmpty')
    current = slot.child
  }
  return current
}

function newestStalePageLeaf(root: TranscriptBodyPageBranch): TranscriptBodyPageLeaf | undefined {
  let current: TranscriptBodyPageTree = root
  while (current.kind === 'branch') {
    let next: TranscriptBodyPageTree | undefined
    for (let index = current.slots.length - 1; index >= 0; index -= 1) {
      const child = current.slots[index]?.child
      if (child && child.staleBodyCount > 0) {
        next = child
        break
      }
    }
    if (!next) return undefined
    current = next
  }
  return current.staleBodyCount > 0 ? current : undefined
}

function requirePageBranch(node: TranscriptBodyPageTree, level: number): TranscriptBodyPageBranch {
  if (node.kind !== 'branch' || node.level !== level) {
    throw new Error('TranscriptBodyPageTreeInvalid')
  }
  return node
}

function radixSlot(offset: number, level: number): number {
  return Math.floor(offset / PAGE_TREE_RADIX ** level) % PAGE_TREE_RADIX
}

function slotPosition(slots: readonly TranscriptBodyPageSlot[], index: number): number {
  let low = 0
  let high = slots.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((slots[middle] as TranscriptBodyPageSlot).index < index) low = middle + 1
    else high = middle
  }
  return low
}

function pageChunk(page: TranscriptBodyPage): TranscriptBodyPageChunk {
  return Object.freeze({
    offset: page.offset,
    headers: page.headers,
    messages: Object.freeze(
      page.messages.map((message, index) =>
        rebaseHydratedMessageHeader(message, page.headers[index] as MessageHeaderRow),
      ),
    ),
    bodyVersions: Object.freeze(page.headers.map((header) => header.bodyVersion)),
    bodyExact: Object.freeze(page.headers.map(() => true)),
  })
}

function indexPageRows(
  page: Pick<TranscriptBodyPageChunk, 'offset' | 'headers'>,
): PersistentStringMap<TranscriptBodyRowLocator> {
  return PersistentStringMap.from(pageRowLocatorEntries(page))
}

function* pageRowLocatorEntries(
  page: Pick<TranscriptBodyPageChunk, 'offset' | 'headers'>,
): Generator<readonly [string, TranscriptBodyRowLocator]> {
  for (let rowIndex = 0; rowIndex < page.headers.length; rowIndex += 1) {
    const header = page.headers[rowIndex]
    if (!header) continue
    yield [
      header.id,
      Object.freeze({
        pathIndex: page.offset + rowIndex,
        pageOffset: page.offset,
        rowIndex,
      }),
    ]
  }
}

function storedRowFromPage(
  page: TranscriptBodyPageChunk,
  index: number,
): TranscriptBodyWindowRow | undefined {
  const header = page.headers[index]
  const message = page.messages[index]
  const bodyVersion = page.bodyVersions[index]
  const bodyExact = page.bodyExact[index]
  return header && message && bodyVersion !== undefined && bodyExact !== undefined
    ? { pathIndex: page.offset + index, header, message, bodyVersion, bodyExact }
    : undefined
}

function validateTranscriptBodyPageIdentity(
  page: TranscriptBodyPage,
  path: BranchPathDescriptor<MessageHeaderRow>,
): void {
  const leaf = path.leaf
  if (
    !leaf ||
    page.chatId !== leaf.chatId ||
    page.leafId !== leaf.id ||
    page.branchLength !== path.length
  ) {
    throw new Error('TranscriptBodyPagePathMismatch')
  }
}

function validateTranscriptBodyPage(page: TranscriptBodyPage): void {
  if (
    !Number.isSafeInteger(page.offset) ||
    !Number.isSafeInteger(page.branchLength) ||
    page.offset < 0 ||
    page.branchLength < 0 ||
    page.offset + page.headers.length > page.branchLength ||
    page.headers.length !== page.messages.length
  ) {
    throw new Error('TranscriptBodyPageInvalid')
  }
  for (let index = 0; index < page.headers.length; index += 1) {
    const header = page.headers[index]
    const message = page.messages[index]
    if (
      !header ||
      !message ||
      header.chatId !== page.chatId ||
      message.chatId !== page.chatId ||
      header.id !== message.id
    ) {
      throw new Error('TranscriptBodyPageRowInvalid')
    }
  }
}
