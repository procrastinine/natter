import { messageRenderableTextSegments } from '../core/branch-flatten'
import {
  compileSearchText,
  IncrementalSearchTextScanner,
  type MessageCorpusSearchExcerpt,
  type MessageCorpusSearchRequest,
  type MessageCorpusSearchResult,
  sliceTextSegments,
} from '../core/search-query'
import type { MessageId } from '../core/types'
import type { NatterDb } from './db'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import type { MessageBodyRow, MessageHeaderRow } from './message-storage'

const BODY_PAGE_SIZE = 16
const EXCERPT_BEFORE = 60
const EXCERPT_AFTER = 120

export function searchMessageCorpusInBrowser(
  db: NatterDb,
  request: MessageCorpusSearchRequest,
  signal?: AbortSignal,
): Promise<MessageCorpusSearchResult> {
  throwIfAborted(signal)
  const compiled = compileSearchText(request.clauses)
  return search()

  async function search(): Promise<MessageCorpusSearchResult> {
    const corpus = new IncrementalSearchTextScanner(compiled)
    let corpusFieldCount = 0
    let messageFieldCount = 0
    for (const field of request.prefixFields ?? []) {
      if (corpusFieldCount > 0) corpus.push('\n', signal)
      corpus.push(field.text, signal)
      corpusFieldCount += 1
    }

    const matchingMessageIds: MessageId[] = []
    let newestMatchingHeader: MessageHeaderRow | undefined
    let newestPositiveHeader: MessageHeaderRow | undefined
    let firstPositiveExcerpt: MessageCorpusSearchExcerpt | undefined
    const messageScanner = new IncrementalSearchTextScanner(compiled)
    const prefixRange = exactCompoundPrefixBetween([request.chatId])
    let after: readonly [number, MessageId] | undefined

    for (;;) {
      throwIfAborted(signal)
      const [pageHeaders, bodiesById] = await db.transaction(
        'r',
        db.messages,
        db.messageBodies,
        async () => {
          const lower = after ? [request.chatId, after[0], after[1]] : prefixRange[0]
          const headers = await db.messages
            .where('[chatId+createdAt+id]')
            .between(lower, prefixRange[1], after === undefined, false)
            .limit(BODY_PAGE_SIZE)
            .toArray()
          const liveIds = headers.flatMap((header) => (header.deleted ? [] : [header.id]))
          const bodies = await db.messageBodies.bulkGet(liveIds)
          return [
            headers,
            new Map(
              liveIds.flatMap((messageId, index) => {
                const body = bodies[index]
                return body ? [[messageId, body] as const] : []
              }),
            ),
          ] as const
        },
      )
      if (pageHeaders.length === 0) break
      const lastHeader = pageHeaders.at(-1) as MessageHeaderRow
      after = [lastHeader.createdAt, lastHeader.id]
      for (let index = 0; index < pageHeaders.length; index += 1) {
        throwIfAborted(signal)
        const header = pageHeaders[index]
        if (!header || header.deleted) continue
        const body = bodiesById.get(header.id)
        if (header.chatId !== request.chatId) {
          throw new Error(`MessageSearchChatMismatch:${header.id}`)
        }
        if (!body) throw new Error(`MessageBodyMissing:${header.id}`)
        if (body.bodyVersion !== header.bodyVersion) {
          throw new Error(`MessageBodyVersionMismatch:${header.id}`)
        }
        const parts = [...messageSearchSegments(header, body)]
        messageScanner.reset()
        if (parts.length > 0 && corpusFieldCount > 0) {
          corpus.push(messageFieldCount === 0 ? '\n' : '\n\n', signal)
        }
        let partCount = 0
        for (const part of parts) {
          if (partCount > 0) {
            messageScanner.push('\n', signal)
            corpus.push('\n', signal)
          }
          messageScanner.push(part, signal)
          corpus.push(part, signal)
          partCount += 1
        }
        if (parts.length > 0) {
          corpusFieldCount += 1
          messageFieldCount += 1
        }
        const messageScan = messageScanner.summary()
        if (parts.length > 0 && request.collectMatchingMessageIds && messageScan.matches) {
          matchingMessageIds.push(header.id)
        }
        if (
          parts.length > 0 &&
          messageScan.matches &&
          isNewerHeader(header, newestMatchingHeader)
        ) {
          newestMatchingHeader = header
        }
        if (messageScan.firstPositive && isNewerHeader(header, newestPositiveHeader)) {
          newestPositiveHeader = header
        }
        if (!firstPositiveExcerpt && messageScan.firstPositive) {
          firstPositiveExcerpt = excerptFor(
            header.id,
            () => parts,
            messageScan.firstPositive,
            messageScan.length,
          )
        }
      }
      if (pageHeaders.length < BODY_PAGE_SIZE) break
    }

    return {
      clauseHits: corpus.snapshot().clauseHits,
      matchingMessageIds,
      ...(newestMatchingHeader ? { newestMatchingMessageId: newestMatchingHeader.id } : {}),
      ...(newestPositiveHeader ? { newestPositiveMessageId: newestPositiveHeader.id } : {}),
      ...(firstPositiveExcerpt ? { firstPositiveExcerpt } : {}),
    }
  }
}

function* messageSearchSegments(header: MessageHeaderRow, body: MessageBodyRow): Generator<string> {
  yield* messageRenderableTextSegments({
    content: body.content,
    ...(header.attachmentRefs ? { attachmentRefs: header.attachmentRefs } : {}),
    ...(body.toolCalls ? { toolCalls: body.toolCalls } : {}),
    ...(body.continuationAttempts ? { continuationAttempts: body.continuationAttempts } : {}),
  })
}

function excerptFor(
  messageId: MessageId,
  segments: () => Iterable<string>,
  match: { index: number; length: number },
  totalLength: number,
): MessageCorpusSearchExcerpt {
  const start = Math.max(0, match.index - EXCERPT_BEFORE)
  const end = Math.min(totalLength, match.index + match.length + EXCERPT_AFTER)
  return {
    messageId,
    text: sliceTextSegments(segments(), start, end),
    matchIndex: match.index - start,
    matchLength: match.length,
    messageMatchIndex: match.index,
    prefixTruncated: start > 0,
    suffixTruncated: end < totalLength,
  }
}

function isNewerHeader(
  candidate: MessageHeaderRow,
  current: MessageHeaderRow | undefined,
): boolean {
  return (
    current === undefined ||
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Search aborted', 'AbortError')
}
