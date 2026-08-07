import Dexie, { type Collection, type Table } from 'dexie'
import {
  type SidebarSortField,
  sidebarSortDirection,
  sidebarSortField,
  sidebarTitleSortKey,
} from '../core/sidebar-sort'
import type {
  AttachmentArtifact,
  AttachmentId,
  AttachmentJob,
  ChatFolder,
  ChatId,
  ChatTag,
  FolderId,
} from '../core/types'
import {
  ATTACHMENT_CATALOG_AGGREGATE_ID,
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  publicAttachmentCatalogRow,
} from './attachment-catalog-projection'
import {
  CHAT_SIDEBAR_AGGREGATE_ID,
  type ChatSidebarFolderAggregateRow,
  type ChatSidebarProjectionRow,
  type ChatSidebarWorkspaceAggregateRow,
  chatSidebarFolderKey,
  isValidChatSidebarFolderAggregateRow,
  isValidChatSidebarProjectionRow,
  isValidChatSidebarWorkspaceAggregateRow,
  publicChatSidebarRow,
} from './chat-sidebar-projection'
import type { NatterDb } from './db'
import type {
  AttachmentArtifactSummary,
  AttachmentCatalogAggregate,
  AttachmentCatalogPage,
  AttachmentCatalogRow,
  AttachmentCatalogSearchRequest,
  AttachmentJobSummary,
  AttachmentSearchMeasurement,
  ChatSidebarAggregate,
  ChatSidebarCatalogPage,
  ChatSidebarCatalogRequest,
  FolderCatalogPage,
  OrganizationCatalogPageRequest,
  SidebarPresentationPage,
  SidebarPresentationRequest,
  SidebarPresentationRow,
  TagCatalogPage,
} from './repository'

const SIDEBAR_CURSOR_PREFIX = 'natter-sidebar-catalog:v1:'
const SIDEBAR_PRESENTATION_CURSOR_PREFIX = 'natter-sidebar-presentation:v3:'
const ATTACHMENT_CURSOR_PREFIX = 'natter-attachment-catalog:v1:'
const FOLDER_CATALOG_CURSOR_PREFIX = 'natter-folder-catalog:v1:'
const TAG_CATALOG_CURSOR_PREFIX = 'natter-tag-catalog:v1:'
const CATALOG_ABORT_CHECK_ROWS = 128

interface CatalogCursor {
  fingerprint: string
  value: number | string
  id: string
  pinnedKey?: 0 | 1
  titleSortKey?: string
}

interface FolderCatalogCursor {
  readonly sortIndex: number
  readonly titleSortKey: string
  readonly folderKey: string
}

interface SidebarPresentationCursor {
  readonly fingerprint: string
  readonly flatCursor?: string
  readonly folderCursor?: CatalogCursor
  readonly rootRowsEmitted: number
  readonly rootCursors: Readonly<Record<string, CatalogCursor>>
  readonly activeFolder?: {
    readonly folderId: FolderId
    readonly empty: boolean
    readonly childCursor?: CatalogCursor
    readonly lastTimeGroup?: string
    readonly timeGroupSequence: number
  }
}

type SidebarActiveFolderCursor = NonNullable<SidebarPresentationCursor['activeFolder']>

interface SidebarPresentationFolderEntry {
  readonly folder: ChatFolder
  readonly exactChatCount: number
  readonly pinned: boolean
  readonly primary: number | string
  readonly titleKey: string
}

interface SidebarRootSource {
  readonly folderKey: string
  cursor?: CatalogCursor
  rows: ChatSidebarProjectionRow[]
  index: number
  complete: boolean
}

interface SidebarFilterContext {
  readonly archived: 'exclude' | 'include' | 'only'
  readonly folderId: string | undefined
  readonly includeFolderIds: ReadonlySet<string>
  readonly excludeFolderIds: ReadonlySet<string>
  readonly includeTagIds: ReadonlySet<string>
  readonly excludeTagIds: ReadonlySet<string>
  readonly excludeEmptyDrafts: boolean
}

export async function readSidebarRowsById(
  db: NatterDb,
  chatIds: readonly ChatId[],
  signal?: AbortSignal,
) {
  throwIfAborted(signal)
  const rows = await db.chatSidebarRows.bulkGet([...chatIds])
  throwIfAborted(signal)
  return rows.map((row) => {
    if (!row) return undefined
    assertSidebarProjection(row)
    return publicChatSidebarRow(row)
  })
}

export async function readFolderCatalogPage(
  db: NatterDb,
  request: OrganizationCatalogPageRequest,
  signal?: AbortSignal,
): Promise<FolderCatalogPage> {
  throwIfAborted(signal)
  const limit = boundedLimit(request.limit, 100)
  const cursor = request.cursor ? decodeFolderCatalogCursor(request.cursor) : undefined
  const index = '[folderSortIndex+folderTitleSortKey+folderKey]'
  const collection = cursor
    ? db.chatSidebarAggregates
        .where(index)
        .above([cursor.sortIndex, cursor.titleSortKey, cursor.folderKey])
    : db.chatSidebarAggregates.orderBy(index)
  const rows = await collection.limit(limit + 1).toArray()
  throwIfAborted(signal)
  for (const row of rows) {
    if (!isValidChatSidebarFolderAggregateRow(row)) {
      throw new Error('ChatSidebarFolderAggregateInvalid')
    }
  }
  const pageRows = rows.slice(0, limit) as ChatSidebarFolderAggregateRow[]
  const last = pageRows.at(-1)
  return {
    rows: pageRows.map((row) => ({ ...row.folder })),
    ...(rows.length > limit && last
      ? {
          nextCursor: encodeFolderCatalogCursor({
            sortIndex: last.folderSortIndex,
            titleSortKey: last.folderTitleSortKey,
            folderKey: last.folderKey,
          }),
        }
      : {}),
  }
}

export async function readTagCatalogPage(
  db: NatterDb,
  request: OrganizationCatalogPageRequest,
  signal?: AbortSignal,
): Promise<TagCatalogPage> {
  throwIfAborted(signal)
  const limit = boundedLimit(request.limit, 100)
  const cursor = request.cursor ? decodeTagCatalogCursor(request.cursor) : undefined
  const collection = cursor
    ? db.tags.where('nameLower').above(cursor)
    : db.tags.orderBy('nameLower')
  const rows = await collection.limit(limit + 1).toArray()
  throwIfAborted(signal)
  const pageRows = rows.slice(0, limit)
  const last = pageRows.at(-1)
  return {
    rows: pageRows.map((row) => ({ ...row })),
    ...(rows.length > limit && last ? { nextCursor: encodeTagCatalogCursor(last.nameLower) } : {}),
  }
}

export async function readSidebarCatalogPage(
  db: NatterDb,
  request: ChatSidebarCatalogRequest,
  signal?: AbortSignal,
): Promise<ChatSidebarCatalogPage> {
  if (request.pinnedFirst === true) {
    return readPinnedFirstSidebarCatalogPage(db, request, signal)
  }
  const orderBy = request.orderBy ?? 'updatedAt'
  const displayDirection = request.direction ?? 'desc'
  const navigation = request.pageDirection ?? 'forward'
  const displayAscending = displayDirection === 'asc'
  const scanAscending = navigation === 'forward' ? displayAscending : !displayAscending
  const fingerprint = sidebarFingerprint(request, orderBy, displayDirection)
  const cursor = request.cursor
    ? decodeCursor(request.cursor, SIDEBAR_CURSOR_PREFIX, fingerprint, orderBy === 'title', true)
    : undefined
  const filterContext = sidebarFilterContext(request)
  const limit = boundedLimit(request.limit, 100)
  const rows: ChatSidebarProjectionRow[] = []
  let firstInspected: ChatSidebarProjectionRow | undefined
  let lastInspected: ChatSidebarProjectionRow | undefined
  let scanCursor = cursor
  let complete = false
  while (rows.length < limit) {
    throwIfAborted(signal)
    const batchLimit = Math.max(1, limit - rows.length)
    const batch = await sidebarScanCollection(
      db.chatSidebarRows,
      orderBy,
      scanAscending,
      request.archived ?? 'exclude',
      scanCursor,
    )
      .limit(batchLimit)
      .toArray()
    throwIfAborted(signal)
    if (batch.length === 0) {
      complete = true
      break
    }
    firstInspected ??= batch[0]
    lastInspected = batch.at(-1)
    for (const row of batch) {
      assertSidebarProjection(row)
      if (sidebarRowMatches(row, filterContext)) rows.push(row)
    }
    scanCursor = lastInspected
      ? {
          fingerprint,
          value: sidebarSortValue(lastInspected, orderBy),
          id: lastInspected.id,
          titleSortKey: lastInspected.titleSortKey,
        }
      : scanCursor
    if (batch.length < batchLimit) {
      complete = true
      break
    }
  }
  const displayRows = navigation === 'backward' ? [...rows].reverse() : rows
  const displayFirst = navigation === 'backward' ? lastInspected : firstInspected
  const displayLast = navigation === 'backward' ? firstInspected : lastInspected
  const previousCursor =
    displayFirst && (navigation === 'backward' ? !complete : request.cursor !== undefined)
      ? encodeSidebarCursor(displayFirst, orderBy, fingerprint)
      : undefined
  const nextCursor =
    displayLast && (navigation === 'forward' ? !complete : request.cursor !== undefined)
      ? encodeSidebarCursor(displayLast, orderBy, fingerprint)
      : undefined
  return {
    rows: displayRows.map(publicChatSidebarRow),
    ...(previousCursor ? { previousCursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    ...(request.countMode === 'omit'
      ? {}
      : { exactCount: await countSidebarRows(db, request, filterContext) }),
  }
}

export async function readSidebarPresentationPage(
  db: NatterDb,
  request: SidebarPresentationRequest,
  signal?: AbortSignal,
): Promise<SidebarPresentationPage> {
  const limit = boundedLimit(request.limit, 100)
  const fingerprint = sidebarPresentationFingerprint(request)
  const decoded = request.cursor
    ? decodeSidebarPresentationCursor(request.cursor, fingerprint)
    : undefined
  return db.transaction(
    'r',
    [db.chatSidebarRows, db.chatSidebarAggregates, db.folders, db.tags],
    async () => {
      throwIfAborted(signal)
      let resumedRows: SidebarPresentationRow[] = []
      let resumedActiveFolder = decoded?.activeFolder
      let resumedChildRowsRead = 0
      let resumedCompletionProbeQueries = 0
      let resumedCompletionProbeKeysRead = 0
      if (request.mode === 'expanded' && request.countMode === 'omit' && decoded?.activeFolder) {
        const activePage = await readActiveSidebarFolderPage(
          db.chatSidebarRows,
          request,
          decoded.activeFolder,
          limit,
          signal,
        )
        resumedRows = activePage.rows
        resumedActiveFolder = activePage.activeFolder
        resumedChildRowsRead = activePage.rowsRead
        resumedCompletionProbeQueries = activePage.completionProbeQueries
        resumedCompletionProbeKeysRead = activePage.completionProbeKeysRead
        if (resumedActiveFolder) {
          const metadata = await readSidebarPresentationMetadata(db, resumedRows, signal)
          return {
            rows: resumedRows,
            nextCursor: encodeSidebarPresentationCursor({
              fingerprint,
              ...(decoded.folderCursor ? { folderCursor: decoded.folderCursor } : {}),
              rootRowsEmitted: decoded.rootRowsEmitted,
              rootCursors: decoded.rootCursors,
              activeFolder: resumedActiveFolder,
            }),
            folders: metadata.folders,
            tags: metadata.tags,
            measurement: {
              rootChatRowsRead: 0,
              folderChildRowsRead: resumedChildRowsRead,
              folderCatalogRowsRead: 0,
              tagCatalogRowsRead: metadata.tags.length,
              completionProbeQueries: resumedCompletionProbeQueries,
              completionProbeKeysRead: resumedCompletionProbeKeysRead,
              createdAtGroupProbeQueries: 0,
              createdAtGroupProbeKeysRead: 0,
            },
          }
        }
      }
      const aggregate = await db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID)
      if (!isValidChatSidebarWorkspaceAggregateRow(aggregate)) {
        throw new Error('ChatSidebarAggregateInvalid')
      }
      throwIfAborted(signal)
      if (request.mode === 'collapsed') {
        const catalog = await readPinnedFirstSidebarCatalogPage(
          db,
          {
            orderBy: sidebarSortField(request.sort),
            direction: sidebarSortDirection(request.sort),
            archived: 'exclude',
            excludeEmptyDrafts: true,
            pinnedFirst: true,
            limit,
            ...(decoded?.flatCursor ? { cursor: decoded.flatCursor } : {}),
            countMode: 'omit',
          },
          signal,
        )
        const rows: SidebarPresentationRow[] = catalog.rows.map((chat) => ({
          kind: 'chat',
          key: `entry:chat:${chat.id}`,
          chat,
          depth: 'root',
        }))
        const nextCursor = catalog.nextCursor
          ? encodeSidebarPresentationCursor({
              fingerprint,
              flatCursor: catalog.nextCursor,
              rootRowsEmitted: 0,
              rootCursors: {},
            })
          : undefined
        const metadata = await readSidebarPresentationMetadata(db, rows, signal)
        return {
          rows,
          ...(nextCursor ? { nextCursor } : {}),
          folders: metadata.folders,
          tags: metadata.tags,
          ...(request.countMode === 'omit'
            ? {}
            : {
                exactVisibleChats: aggregate.visibleCount,
                aggregate: publicWorkspaceSidebarAggregate(aggregate),
              }),
          measurement: {
            rootChatRowsRead: catalog.rows.length,
            folderChildRowsRead: 0,
            folderCatalogRowsRead: metadata.folders.length,
            tagCatalogRowsRead: metadata.tags.length,
            completionProbeQueries: 0,
            completionProbeKeysRead: 0,
            createdAtGroupProbeQueries: 0,
            createdAtGroupProbeKeysRead: 0,
          },
        }
      }

      const rootFolderKeys = [chatSidebarFolderKey(null)]
      const rootCursors: Record<string, CatalogCursor> = {
        ...(decoded?.rootCursors ?? {}),
      }
      const sourceBatchSize = Math.max(2, Math.ceil((limit + 1) / rootFolderKeys.length))
      const sources: SidebarRootSource[] = rootFolderKeys.map((folderKey) => ({
        folderKey,
        ...(rootCursors[folderKey] ? { cursor: rootCursors[folderKey] } : {}),
        rows: [],
        index: 0,
        complete: false,
      }))
      const folderBatch = await readSidebarFolderPresentationBatch(
        db.chatSidebarAggregates,
        request.sort,
        decoded?.folderCursor,
        limit + 1,
      )
      let folderIndex = 0
      let folderCursor = decoded?.folderCursor
      let rootRowsEmitted = decoded?.rootRowsEmitted ?? 0
      let activeFolder = resumedActiveFolder ? { ...resumedActiveFolder } : undefined
      const rows: SidebarPresentationRow[] = [...resumedRows]
      let rootChatRowsRead = 0
      let folderChildRowsRead = resumedChildRowsRead
      let completionProbeQueries = resumedCompletionProbeQueries
      let completionProbeKeysRead = resumedCompletionProbeKeysRead
      const collapsedFolders = new Set(request.collapsedFolderIds)

      const fillSource = (source: SidebarRootSource) => {
        if (source.index < source.rows.length || source.complete) {
          return Dexie.Promise.resolve()
        }
        return readVisibleFolderChatBatch(
          db.chatSidebarRows,
          source.folderKey,
          request.sort,
          source.cursor,
          sourceBatchSize,
        ).then((page) => {
          source.rows = page.rows
          source.index = 0
          source.complete = page.complete
          rootChatRowsRead += page.rows.length
          completionProbeQueries += page.completionProbeQueries
          completionProbeKeysRead += page.completionProbeKeysRead
          throwIfAborted(signal)
        })
      }
      while (rows.length < limit) {
        throwIfAborted(signal)
        if (activeFolder) {
          const childPage = await readActiveSidebarFolderPage(
            db.chatSidebarRows,
            request,
            activeFolder,
            limit - rows.length,
            signal,
          )
          rows.push(...childPage.rows)
          folderChildRowsRead += childPage.rowsRead
          completionProbeQueries += childPage.completionProbeQueries
          completionProbeKeysRead += childPage.completionProbeKeysRead
          activeFolder = childPage.activeFolder
          if (rows.length >= limit) break
          continue
        }

        for (const source of sources) await fillSource(source)
        const folderRow = folderBatch[folderIndex]
        const folderEntry = folderRow
          ? sidebarPresentationFolderEntry(folderRow, request.sort)
          : undefined
        const source = bestSidebarRootSource(sources, request.sort)
        const rootChat = source?.rows[source.index]
        if (!folderEntry && !rootChat) break
        if (
          folderEntry &&
          (!rootChat || compareSidebarRootFolderToChat(folderEntry, rootChat, request.sort) <= 0)
        ) {
          rows.push({
            kind: 'folder',
            key: `entry:folder:${folderEntry.folder.id}`,
            folder: { ...folderEntry.folder },
            exactChatCount: folderEntry.exactChatCount,
          })
          folderIndex += 1
          folderCursor = folderCatalogCursor(
            folderRow as ChatSidebarFolderAggregateRow,
            request.sort,
          )
          if (!collapsedFolders.has(folderEntry.folder.id)) {
            activeFolder = {
              folderId: folderEntry.folder.id,
              empty: folderEntry.exactChatCount === 0,
              timeGroupSequence: 0,
            }
          }
          continue
        }
        if (!source || !rootChat) break
        rows.push({
          kind: 'chat',
          key: `entry:chat:${rootChat.id}`,
          chat: publicChatSidebarRow(rootChat),
          depth: 'root',
        })
        const position = catalogCursorForPresentationRow(rootChat, request.sort)
        source.cursor = position
        rootCursors[source.folderKey] = position
        rootRowsEmitted += 1
        source.index += 1
      }

      const complete =
        !activeFolder &&
        folderIndex >= folderBatch.length &&
        folderBatch.length < limit + 1 &&
        rootRowsEmitted >= aggregate.rootVisibleCount
      if (!complete && rows.length === 0) throw new Error('SidebarPresentationCursorDidNotAdvance')
      const nextCursor = complete
        ? undefined
        : encodeSidebarPresentationCursor({
            fingerprint,
            ...(folderCursor ? { folderCursor } : {}),
            rootRowsEmitted,
            rootCursors,
            ...(activeFolder ? { activeFolder } : {}),
          })
      const metadata = await readSidebarPresentationMetadata(db, rows, signal)
      return {
        rows,
        ...(nextCursor ? { nextCursor } : {}),
        folders: metadata.folders,
        tags: metadata.tags,
        ...(request.countMode === 'omit'
          ? {}
          : {
              exactVisibleChats: aggregate.visibleCount,
              aggregate: publicWorkspaceSidebarAggregate(aggregate),
            }),
        measurement: {
          rootChatRowsRead,
          folderChildRowsRead,
          folderCatalogRowsRead: folderBatch.length,
          tagCatalogRowsRead: metadata.tags.length,
          completionProbeQueries,
          completionProbeKeysRead,
          createdAtGroupProbeQueries: 0,
          createdAtGroupProbeKeysRead: 0,
        },
      }
    },
  )
}

function readActiveSidebarFolderPage(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  request: SidebarPresentationRequest,
  initial: SidebarActiveFolderCursor,
  limit: number,
  signal?: AbortSignal,
): Promise<{
  rows: SidebarPresentationRow[]
  activeFolder?: SidebarActiveFolderCursor
  rowsRead: number
  completionProbeQueries: number
  completionProbeKeysRead: number
}> {
  if (initial.empty) {
    return Dexie.Promise.resolve({
      rows: [
        {
          kind: 'folder-empty',
          key: `entry:folder:${initial.folderId}:empty`,
          depth: 'folder',
        },
      ],
      rowsRead: 0,
      completionProbeQueries: 0,
      completionProbeKeysRead: 0,
    })
  }
  let activeFolder = { ...initial }
  return readVisibleFolderChatBatch(
    table,
    chatSidebarFolderKey(activeFolder.folderId),
    request.sort,
    activeFolder.childCursor,
    Math.max(1, limit),
  ).then((page) => {
    throwIfAborted(signal)
    const rows: SidebarPresentationRow[] = []
    for (const child of page.rows) {
      if (sidebarSortField(request.sort) === 'createdAt') {
        if (
          activeFolder.childCursor?.pinnedKey !== undefined &&
          activeFolder.childCursor.pinnedKey !== child.pinnedKey
        ) {
          const { lastTimeGroup: _lastTimeGroup, ...nextFolder } = activeFolder
          activeFolder = nextFolder
        }
        const group = sidebarCreatedAtGroup(child, request.createdAtGroupBoundaries)
        if (group.key !== activeFolder.lastTimeGroup) {
          const sequence = activeFolder.timeGroupSequence + 1
          rows.push({
            kind: 'time-group',
            key: `entry:folder:${activeFolder.folderId}:time:${sequence}:${group.key}`,
            label: group.label,
            depth: 'folder',
          })
          activeFolder = {
            ...activeFolder,
            lastTimeGroup: group.key,
            timeGroupSequence: sequence,
          }
        }
      }
      rows.push({
        kind: 'chat',
        key: `entry:folder:${activeFolder.folderId}:chat:${child.id}`,
        chat: publicChatSidebarRow(child),
        depth: 'folder',
      })
      activeFolder = {
        ...activeFolder,
        childCursor: catalogCursorForPresentationRow(child, request.sort),
      }
    }
    return {
      rows,
      ...(page.complete ? {} : { activeFolder }),
      rowsRead: page.rows.length,
      completionProbeQueries: page.completionProbeQueries,
      completionProbeKeysRead: page.completionProbeKeysRead,
    }
  })
}

function sidebarPresentationFolderEntry(
  row: ChatSidebarFolderAggregateRow,
  sort: SidebarPresentationRequest['sort'],
): SidebarPresentationFolderEntry {
  const direction = sidebarSortDirection(sort)
  const field = sidebarSortField(sort)
  const suffix = direction === 'asc' ? 'Asc' : 'Desc'
  const primary = row[`${field}${suffix}` as keyof ChatSidebarFolderAggregateRow]
  if (typeof primary !== 'number' && typeof primary !== 'string') {
    throw new Error('ChatSidebarFolderPresentationPrimaryInvalid')
  }
  return {
    folder: { ...row.folder },
    exactChatCount: row.visibleCount,
    pinned: row.visiblePinnedCount > 0,
    primary,
    titleKey: row.folderTitleSortKey,
  }
}

function readSidebarFolderPresentationBatch(
  table: Table<ChatSidebarWorkspaceAggregateRow | ChatSidebarFolderAggregateRow, string>,
  sort: SidebarPresentationRequest['sort'],
  cursor: CatalogCursor | undefined,
  limit: number,
): Promise<ChatSidebarFolderAggregateRow[]> {
  const direction = sidebarSortDirection(sort)
  const field = sidebarSortField(sort)
  const suffix = direction === 'asc' ? 'Asc' : 'Desc'
  const pinnedField = `presentationPinned${suffix}`
  const primaryField = `${field}${suffix}`
  const index = `[kind+${pinnedField}+${primaryField}+folderTitleSortKey+folderKey]`
  const lower: unknown[] = ['folder']
  const upper: unknown[] = ['folder', []]
  const cursorKey = cursor
    ? ['folder', cursor.pinnedKey, cursor.value, cursor.titleSortKey ?? '', cursor.id]
    : undefined
  const collection = cursorKey
    ? direction === 'asc'
      ? table.where(index).between(cursorKey, upper, false, false)
      : table.where(index).between(lower, cursorKey, true, false)
    : table.where(index).between(lower, upper, true, false)
  return (direction === 'asc' ? collection : collection.reverse())
    .limit(limit)
    .toArray()
    .then((rows) => {
      for (const row of rows) {
        if (!isValidChatSidebarFolderAggregateRow(row)) {
          throw new Error('ChatSidebarFolderAggregateInvalid')
        }
      }
      return rows as ChatSidebarFolderAggregateRow[]
    })
}

function folderCatalogCursor(
  row: ChatSidebarFolderAggregateRow,
  sort: SidebarPresentationRequest['sort'],
): CatalogCursor {
  const direction = sidebarSortDirection(sort)
  const field = sidebarSortField(sort)
  const suffix = direction === 'asc' ? 'Asc' : 'Desc'
  const primary = row[`${field}${suffix}` as keyof ChatSidebarFolderAggregateRow]
  if (typeof primary !== 'number' && typeof primary !== 'string') {
    throw new Error('ChatSidebarFolderPresentationPrimaryInvalid')
  }
  return {
    fingerprint: '',
    value: primary,
    id: row.folderKey,
    pinnedKey: direction === 'asc' ? row.presentationPinnedAsc : row.presentationPinnedDesc,
    titleSortKey: row.folderTitleSortKey,
  }
}

async function readSidebarPresentationMetadata(
  db: NatterDb,
  rows: readonly SidebarPresentationRow[],
  signal?: AbortSignal,
): Promise<{ folders: ChatFolder[]; tags: ChatTag[] }> {
  const folders = new Map<FolderId, ChatFolder>()
  const folderIds = new Set<FolderId>()
  const tagIds = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'folder') folders.set(row.folder.id, { ...row.folder })
    if (row.kind === 'chat') {
      if (row.chat.folderId) folderIds.add(row.chat.folderId)
      for (const tagId of row.chat.tags) tagIds.add(tagId)
    }
  }
  for (const folderId of folders.keys()) folderIds.delete(folderId)
  throwIfAborted(signal)
  const [storedFolders, storedTags] = await Dexie.Promise.all([
    folderIds.size > 0 ? db.folders.bulkGet([...folderIds]) : Dexie.Promise.resolve([]),
    tagIds.size > 0 ? db.tags.bulkGet([...tagIds]) : Dexie.Promise.resolve([]),
  ])
  throwIfAborted(signal)
  for (const folder of storedFolders) {
    if (folder) folders.set(folder.id, { ...folder })
  }
  return {
    folders: sortSidebarFolders([...folders.values()]),
    tags: sortSidebarTags(storedTags.filter((tag): tag is ChatTag => tag !== undefined)),
  }
}

function publicWorkspaceSidebarAggregate(
  aggregate: ChatSidebarWorkspaceAggregateRow,
): ChatSidebarAggregate {
  return {
    totalCount: aggregate.totalCount,
    activeCount: aggregate.activeCount,
    archivedCount: aggregate.archivedCount,
    pinnedCount: aggregate.pinnedCount,
    visibleCount: aggregate.visibleCount,
    visiblePinnedCount: aggregate.visiblePinnedCount,
    folderCounts: {},
    folderAggregates: {},
    rootCount: aggregate.rootCount,
    rootVisibleCount: aggregate.rootVisibleCount,
    rootVisiblePinnedCount: aggregate.rootVisiblePinnedCount,
  }
}

function compareSidebarRootFolderToChat(
  folder: SidebarPresentationFolderEntry,
  chat: ChatSidebarProjectionRow,
  sort: SidebarPresentationRequest['sort'],
): number {
  const pinned = Number(chat.pinnedKey) - Number(folder.pinned)
  if (pinned !== 0) return pinned
  const primary = compareSidebarPresentationValue(
    folder.primary,
    sidebarPresentationChatPrimary(chat, sort),
    sort,
  )
  if (primary !== 0) return primary
  return -1
}

function bestSidebarRootSource(
  sources: readonly SidebarRootSource[],
  sort: SidebarPresentationRequest['sort'],
): SidebarRootSource | undefined {
  let best: SidebarRootSource | undefined
  for (const source of sources) {
    const row = source.rows[source.index]
    if (!row) continue
    const current = best?.rows[best.index]
    if (!current || compareSidebarPresentationChats(row, current, sort) < 0) best = source
  }
  return best
}

function compareSidebarPresentationChats(
  left: ChatSidebarProjectionRow,
  right: ChatSidebarProjectionRow,
  sort: SidebarPresentationRequest['sort'],
): number {
  const pinned = right.pinnedKey - left.pinnedKey
  if (pinned !== 0) return pinned
  const primary = compareSidebarPresentationValue(
    sidebarPresentationChatPrimary(left, sort),
    sidebarPresentationChatPrimary(right, sort),
    sort,
  )
  if (primary !== 0) return primary
  const title = compareSidebarPresentationText(left.titleSortKey, right.titleSortKey, sort)
  if (title !== 0) return title
  return compareSidebarPresentationText(left.id, right.id, sort)
}

function compareSidebarPresentationValue(
  left: number | string,
  right: number | string,
  sort: SidebarPresentationRequest['sort'],
): number {
  const direction = sidebarSortDirection(sort) === 'asc' ? 1 : -1
  const compared =
    typeof left === 'string' || typeof right === 'string'
      ? compareCodeUnits(String(left), String(right))
      : left - right
  return compared * direction
}

function compareSidebarPresentationText(
  left: string,
  right: string,
  sort: SidebarPresentationRequest['sort'],
): number {
  const compared = compareCodeUnits(left, right)
  return sidebarSortDirection(sort) === 'asc' ? compared : -compared
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sidebarPresentationChatPrimary(
  row: ChatSidebarProjectionRow,
  sort: SidebarPresentationRequest['sort'],
): number | string {
  const field = sidebarSortField(sort)
  return field === 'title' ? row.titleSortKey : row[field]
}

function readVisibleFolderChatBatch(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  folderKey: string,
  sort: SidebarPresentationRequest['sort'],
  cursor: CatalogCursor | undefined,
  limit: number,
): Promise<{
  rows: ChatSidebarProjectionRow[]
  complete: boolean
  completionProbeQueries: number
  completionProbeKeysRead: number
}> {
  const field = sidebarSortField(sort)
  const ascending = sidebarSortDirection(sort) === 'asc'
  const rows: ChatSidebarProjectionRow[] = []
  const target = Math.max(1, Math.min(500, limit))
  let bucket: 0 | 1 = cursor?.pinnedKey ?? 1
  let bucketCursor = cursor
  let exhausted = false
  const readNext = (): Dexie.Promise<void> => {
    if (rows.length >= target || exhausted) return Dexie.Promise.resolve()
    const remaining = target - rows.length
    return folderSidebarScanCollection(table, folderKey, field, ascending, bucket, bucketCursor)
      .limit(remaining)
      .toArray()
      .then((batch) => {
        for (const row of batch) assertSidebarProjection(row)
        rows.push(...batch)
        if (batch.length === remaining) return
        if (bucket === 1) {
          bucket = 0
          bucketCursor = undefined
        } else {
          exhausted = true
        }
        return readNext()
      })
  }
  return readNext().then(() => {
    if (exhausted || rows.length === 0) {
      return {
        rows,
        complete: exhausted,
        completionProbeQueries: 0,
        completionProbeKeysRead: 0,
      }
    }
    return probeVisibleFolderChatAfter(
      table,
      folderKey,
      sort,
      catalogCursorForPresentationRow(rows.at(-1) as ChatSidebarProjectionRow, sort),
    ).then((completion) => ({
      rows,
      complete: !completion.hasNext,
      completionProbeQueries: completion.queries,
      completionProbeKeysRead: completion.keysRead,
    }))
  })
}

function probeVisibleFolderChatAfter(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  folderKey: string,
  sort: SidebarPresentationRequest['sort'],
  cursor: CatalogCursor,
): Promise<{ hasNext: boolean; queries: number; keysRead: number }> {
  const field = sidebarSortField(sort)
  const ascending = sidebarSortDirection(sort) === 'asc'
  let queries = 0
  let keysRead = 0
  const pinnedKeys = cursor.pinnedKey === 1 ? ([1, 0] as const) : ([0] as const)
  const probe = (
    index: number,
  ): Dexie.Promise<{ hasNext: boolean; queries: number; keysRead: number }> => {
    const pinnedKey = pinnedKeys[index]
    if (pinnedKey === undefined) {
      return Dexie.Promise.resolve({ hasNext: false, queries, keysRead })
    }
    return folderSidebarScanCollection(
      table,
      folderKey,
      field,
      ascending,
      pinnedKey,
      pinnedKey === cursor.pinnedKey ? cursor : undefined,
    )
      .limit(1)
      .primaryKeys()
      .then((keys) => {
        queries += 1
        keysRead += keys.length
        if (keys.length > 0) return { hasNext: true, queries, keysRead }
        return probe(index + 1)
      })
  }
  return probe(0)
}

function folderSidebarScanCollection(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  folderKey: string,
  field: SidebarSortField,
  ascending: boolean,
  pinnedKey: 0 | 1,
  cursor: CatalogCursor | undefined,
): Collection<ChatSidebarProjectionRow, ChatId> {
  const index =
    field === 'title'
      ? '[folderKey+visibleKey+pinnedKey+titleSortKey+id]'
      : `[folderKey+visibleKey+pinnedKey+${field}+titleSortKey+id]`
  const lower = [folderKey, 1, pinnedKey]
  const upper = [folderKey, 1, pinnedKey, []]
  const cursorKey = cursor
    ? field === 'title'
      ? [folderKey, 1, pinnedKey, cursor.value, cursor.id]
      : [folderKey, 1, pinnedKey, cursor.value, cursor.titleSortKey ?? '', cursor.id]
    : undefined
  const collection = cursorKey
    ? ascending
      ? table.where(index).between(cursorKey, upper, false, false)
      : table.where(index).between(lower, cursorKey, true, false)
    : table.where(index).between(lower, upper, true, false)
  return ascending ? collection : collection.reverse()
}

function catalogCursorForPresentationRow(
  row: ChatSidebarProjectionRow,
  sort: SidebarPresentationRequest['sort'],
): CatalogCursor {
  return {
    fingerprint: '',
    value: sidebarPresentationChatPrimary(row, sort),
    id: row.id,
    pinnedKey: row.pinnedKey as 0 | 1,
    titleSortKey: row.titleSortKey,
  }
}

function sidebarCreatedAtGroup(
  row: ChatSidebarProjectionRow,
  boundaries: SidebarPresentationRequest['createdAtGroupBoundaries'],
): { key: string; label: string } {
  const [today, yesterday, previous7Days, previous30Days] = boundaries
  if (row.createdAt >= today) return { key: 'today', label: 'Today' }
  if (row.createdAt >= yesterday) return { key: 'yesterday', label: 'Yesterday' }
  if (row.createdAt >= previous7Days) {
    return { key: 'previous-7-days', label: 'Previous 7 days' }
  }
  if (row.createdAt >= previous30Days) {
    return { key: 'previous-30-days', label: 'Previous 30 days' }
  }
  return { key: 'older', label: 'Older' }
}

function sortSidebarFolders(folders: readonly ChatFolder[]): ChatFolder[] {
  return [...folders]
    .sort(
      (left, right) =>
        left.sortIndex - right.sortIndex ||
        compareCodeUnits(sidebarTitleSortKey(left.name), sidebarTitleSortKey(right.name)) ||
        compareCodeUnits(left.id, right.id),
    )
    .map((folder) => ({ ...folder }))
}

function sortSidebarTags(tags: readonly ChatTag[]): ChatTag[] {
  return [...tags]
    .sort(
      (left, right) =>
        compareCodeUnits(left.nameLower, right.nameLower) || compareCodeUnits(left.id, right.id),
    )
    .map((tag) => ({ ...tag }))
}

function sidebarPresentationFingerprint(request: SidebarPresentationRequest): string {
  return JSON.stringify([
    request.mode,
    request.sort,
    [...request.collapsedFolderIds].sort(),
    request.createdAtGroupBoundaries,
  ])
}

function encodeSidebarPresentationCursor(cursor: SidebarPresentationCursor): string {
  return `${SIDEBAR_PRESENTATION_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify(cursor))}`
}

function encodeFolderCatalogCursor(cursor: FolderCatalogCursor): string {
  return `${FOLDER_CATALOG_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify(cursor))}`
}

function decodeFolderCatalogCursor(encoded: string): FolderCatalogCursor {
  if (!encoded.startsWith(FOLDER_CATALOG_CURSOR_PREFIX)) {
    throw new Error('FolderCatalogCursorVersionUnsupported')
  }
  try {
    const value = JSON.parse(
      decodeURIComponent(encoded.slice(FOLDER_CATALOG_CURSOR_PREFIX.length)),
    ) as Partial<FolderCatalogCursor>
    if (
      !Number.isFinite(value.sortIndex) ||
      typeof value.titleSortKey !== 'string' ||
      typeof value.folderKey !== 'string'
    ) {
      throw new Error('shape')
    }
    return value as FolderCatalogCursor
  } catch {
    throw new Error('FolderCatalogCursorInvalid')
  }
}

function encodeTagCatalogCursor(nameLower: string): string {
  return `${TAG_CATALOG_CURSOR_PREFIX}${encodeURIComponent(nameLower)}`
}

function decodeTagCatalogCursor(encoded: string): string {
  if (!encoded.startsWith(TAG_CATALOG_CURSOR_PREFIX)) {
    throw new Error('TagCatalogCursorVersionUnsupported')
  }
  const value = decodeURIComponent(encoded.slice(TAG_CATALOG_CURSOR_PREFIX.length))
  if (value.length === 0) throw new Error('TagCatalogCursorInvalid')
  return value
}

function decodeSidebarPresentationCursor(
  encoded: string,
  fingerprint: string,
): SidebarPresentationCursor {
  if (!encoded.startsWith(SIDEBAR_PRESENTATION_CURSOR_PREFIX)) {
    throw new Error('SidebarPresentationCursorVersionUnsupported')
  }
  try {
    const value = JSON.parse(
      decodeURIComponent(encoded.slice(SIDEBAR_PRESENTATION_CURSOR_PREFIX.length)),
    ) as Partial<SidebarPresentationCursor>
    if (
      value.fingerprint !== fingerprint ||
      !Number.isSafeInteger(value.rootRowsEmitted) ||
      (value.rootRowsEmitted as number) < 0 ||
      !value.rootCursors ||
      typeof value.rootCursors !== 'object' ||
      (value.flatCursor !== undefined && typeof value.flatCursor !== 'string')
    ) {
      throw new Error('shape')
    }
    for (const cursor of Object.values(value.rootCursors)) assertPresentationCatalogCursor(cursor)
    if (value.folderCursor) assertPresentationCatalogCursor(value.folderCursor)
    if (value.activeFolder) {
      if (
        typeof value.activeFolder.folderId !== 'string' ||
        typeof value.activeFolder.empty !== 'boolean' ||
        !Number.isSafeInteger(value.activeFolder.timeGroupSequence) ||
        value.activeFolder.timeGroupSequence < 0 ||
        (value.activeFolder.lastTimeGroup !== undefined &&
          typeof value.activeFolder.lastTimeGroup !== 'string')
      ) {
        throw new Error('shape')
      }
      if (value.activeFolder.childCursor) {
        assertPresentationCatalogCursor(value.activeFolder.childCursor)
      }
    }
    return value as SidebarPresentationCursor
  } catch {
    throw new Error('SidebarPresentationCursorInvalid')
  }
}

function assertPresentationCatalogCursor(value: unknown): asserts value is CatalogCursor {
  if (!value || typeof value !== 'object') throw new Error('shape')
  const cursor = value as Partial<CatalogCursor>
  if (
    (typeof cursor.value !== 'number' && typeof cursor.value !== 'string') ||
    typeof cursor.id !== 'string' ||
    (cursor.pinnedKey !== 0 && cursor.pinnedKey !== 1) ||
    typeof cursor.titleSortKey !== 'string'
  ) {
    throw new Error('shape')
  }
}

async function readPinnedFirstSidebarCatalogPage(
  db: NatterDb,
  request: ChatSidebarCatalogRequest,
  signal?: AbortSignal,
): Promise<ChatSidebarCatalogPage> {
  if (request.pageDirection === 'backward') {
    throw new Error('PinnedSidebarCatalogBackwardPagingUnsupported')
  }
  const orderBy = request.orderBy ?? 'updatedAt'
  const direction = request.direction ?? 'desc'
  const ascending = direction === 'asc'
  const fingerprint = sidebarFingerprint(request, orderBy, direction)
  const cursor = request.cursor
    ? decodeCursor(request.cursor, SIDEBAR_CURSOR_PREFIX, fingerprint, orderBy === 'title', true)
    : undefined
  if (cursor && cursor.pinnedKey !== 0 && cursor.pinnedKey !== 1) {
    throw new Error('CatalogCursorInvalid')
  }
  const filterContext = sidebarFilterContext(request)
  const limit = boundedLimit(request.limit, 100)
  const rows: ChatSidebarProjectionRow[] = []
  let bucket: 0 | 1 = cursor?.pinnedKey ?? 1
  let bucketCursor = cursor
  let lastInspected: ChatSidebarProjectionRow | undefined
  let lastInspectedBucket: 0 | 1 = bucket
  let exhausted = false

  while (rows.length < limit && !exhausted) {
    throwIfAborted(signal)
    const batchLimit = Math.max(1, limit - rows.length)
    const batch = await pinnedSidebarScanCollection(
      db.chatSidebarRows,
      orderBy,
      ascending,
      bucket,
      bucketCursor,
    )
      .limit(batchLimit)
      .toArray()
    throwIfAborted(signal)
    if (batch.length === 0) {
      if (bucket === 1) {
        bucket = 0
        bucketCursor = undefined
        continue
      }
      exhausted = true
      break
    }
    lastInspected = batch.at(-1)
    lastInspectedBucket = bucket
    for (const row of batch) {
      assertSidebarProjection(row)
      if (sidebarRowMatches(row, filterContext)) rows.push(row)
    }
    bucketCursor = lastInspected
      ? sidebarCursorFor(lastInspected, orderBy, fingerprint, bucket)
      : bucketCursor
    if (batch.length < batchLimit) {
      if (bucket === 1) {
        bucket = 0
        bucketCursor = undefined
      } else {
        exhausted = true
      }
    }
  }

  const nextCursor =
    !exhausted && lastInspected
      ? encodeCursor(
          SIDEBAR_CURSOR_PREFIX,
          sidebarCursorFor(lastInspected, orderBy, fingerprint, lastInspectedBucket),
        )
      : undefined
  return {
    rows: rows.map(publicChatSidebarRow),
    ...(nextCursor ? { nextCursor } : {}),
    ...(request.countMode === 'omit'
      ? {}
      : { exactCount: await countSidebarRows(db, request, filterContext) }),
  }
}

export function readSidebarAggregate(db: NatterDb): Promise<ChatSidebarAggregate> {
  return db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID).then((aggregate) => {
    if (!isValidChatSidebarWorkspaceAggregateRow(aggregate)) {
      throw new Error('ChatSidebarAggregateInvalid')
    }
    return publicWorkspaceSidebarAggregate(aggregate)
  })
}

export async function readAttachmentCatalogRows(
  db: NatterDb,
  attachmentIds: readonly AttachmentId[],
  signal?: AbortSignal,
): Promise<Array<AttachmentCatalogRow | undefined>> {
  throwIfAborted(signal)
  const rows = await db.attachmentCatalogRows.bulkGet([...attachmentIds])
  throwIfAborted(signal)
  return rows.map((row) => (row ? publicAttachmentCatalogRow(row) : undefined))
}

export async function readAttachmentCatalogAggregate(
  db: NatterDb,
): Promise<AttachmentCatalogAggregate> {
  const row = await db.attachmentCatalogAggregate.get('workspace')
  if (!row) throw new Error('AttachmentCatalogAggregateMissing')
  const {
    id: _id,
    projectionRevision: _projectionRevision,
    integrityPending: _integrityPending,
    ...aggregate
  } = row
  return aggregate
}

export async function readAttachmentCatalogPage(
  db: NatterDb,
  request: AttachmentCatalogSearchRequest,
  signal?: AbortSignal,
): Promise<AttachmentCatalogPage> {
  return db.transaction(
    'r',
    [db.attachmentCatalogAggregate, db.attachmentCatalogRows, db.attachmentArtifacts],
    async () => {
      const aggregate = await db.attachmentCatalogAggregate.get(ATTACHMENT_CATALOG_AGGREGATE_ID)
      if (!aggregate) throw new Error('AttachmentCatalogAggregateMissing')
      return readAttachmentCatalogPageAtRevision(db, request, aggregate, signal)
    },
  )
}

async function readAttachmentCatalogPageAtRevision(
  db: NatterDb,
  request: AttachmentCatalogSearchRequest,
  aggregate: AttachmentCatalogAggregateRow,
  signal?: AbortSignal,
): Promise<AttachmentCatalogPage> {
  const sort = request.sort ?? 'created-desc'
  const navigation = request.direction ?? 'forward'
  const displayAscending = sort === 'created-asc' || sort === 'size-asc'
  const scanAscending = navigation === 'forward' ? displayAscending : !displayAscending
  const fingerprint = attachmentFingerprint(request, sort)
  const cursor = request.cursor
    ? decodeCursor(request.cursor, ATTACHMENT_CURSOR_PREFIX, fingerprint, false, false)
    : undefined
  const limit = boundedLimit(request.limit, 100)
  const measurement = emptyAttachmentCatalogMeasurement(sort)
  const rows: AttachmentCatalogProjectionRow[] = []
  let firstInspected: AttachmentCatalogProjectionRow | undefined
  let lastInspected: AttachmentCatalogProjectionRow | undefined
  let scanCursor = cursor
  let complete = false
  while (rows.length < limit) {
    throwIfAborted(signal)
    const batchLimit = Math.max(1, limit - rows.length)
    const batch = await attachmentScanCollection(
      db.attachmentCatalogRows,
      sort,
      scanAscending,
      scanCursor,
    )
      .limit(batchLimit)
      .toArray()
    throwIfAborted(signal)
    if (batch.length === 0) {
      complete = true
      break
    }
    measurement.metadataRowsRead += batch.length
    firstInspected ??= batch[0]
    lastInspected = batch.at(-1)
    const matchedRows = await evaluateAttachmentRows(db, batch, request, measurement, signal)
    rows.push(...matchedRows)
    scanCursor = lastInspected
      ? {
          fingerprint,
          value: attachmentSortValue(lastInspected, sort),
          id: lastInspected.id,
        }
      : scanCursor
    if (batch.length < batchLimit) {
      complete = true
      break
    }
  }
  const displayRows = navigation === 'backward' ? [...rows].reverse() : rows
  const displayFirst = navigation === 'backward' ? lastInspected : firstInspected
  const displayLast = navigation === 'backward' ? firstInspected : lastInspected
  const previousCursor =
    displayFirst && (navigation === 'backward' ? !complete : request.cursor !== undefined)
      ? encodeAttachmentCursor(displayFirst, sort, fingerprint)
      : undefined
  const nextCursor =
    displayLast && (navigation === 'forward' ? !complete : request.cursor !== undefined)
      ? encodeAttachmentCursor(displayLast, sort, fingerprint)
      : undefined
  measurement.matchedRows = displayRows.length
  measurement.returnedRows = displayRows.length
  return {
    rows: displayRows.map(publicAttachmentCatalogRow),
    catalogRevision: aggregate.projectionRevision,
    catalogTotalCount: aggregate.totalCount,
    ...(previousCursor ? { previousCursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    ...(navigation === 'forward' && request.cursor === undefined && complete
      ? { matchedCount: displayRows.length }
      : {}),
    complete,
    measurement,
  }
}

export async function evaluateAttachmentCatalogRows(
  db: NatterDb,
  request: AttachmentCatalogSearchRequest,
  attachmentIds: readonly AttachmentId[],
  signal?: AbortSignal,
): Promise<Array<AttachmentCatalogRow | undefined>> {
  const stored = await db.attachmentCatalogRows.bulkGet([...attachmentIds])
  const rows = stored.filter((row): row is AttachmentCatalogProjectionRow => row !== undefined)
  const measurement = emptyAttachmentCatalogMeasurement(request.sort ?? 'created-desc')
  measurement.metadataRowsRead = rows.length
  const matched = new Set(
    (await evaluateAttachmentRows(db, rows, request, measurement, signal)).map((row) => row.id),
  )
  return stored.map((row) =>
    row && matched.has(row.id) ? publicAttachmentCatalogRow(row) : undefined,
  )
}

export async function readAttachmentManagerCore(db: NatterDb, attachmentId: AttachmentId) {
  return db.transaction(
    'r',
    [db.attachmentCatalogRows, db.attachmentArtifacts, db.attachmentJobs],
    async () => {
      const [row, artifacts, jobs] = await Dexie.Promise.all([
        db.attachmentCatalogRows.get(attachmentId),
        db.attachmentArtifacts.where('attachmentId').equals(attachmentId).toArray(),
        db.attachmentJobs.where('attachmentId').equals(attachmentId).toArray(),
      ])
      if (!row) return undefined
      return {
        row: publicAttachmentCatalogRow(row),
        artifacts: artifacts.map(attachmentArtifactSummary),
        jobs: jobs.map(attachmentJobSummary),
      }
    },
  )
}

async function evaluateAttachmentRows(
  db: NatterDb,
  rows: readonly AttachmentCatalogProjectionRow[],
  request: AttachmentCatalogSearchRequest,
  measurement: AttachmentSearchMeasurement,
  signal?: AbortSignal,
): Promise<AttachmentCatalogProjectionRow[]> {
  const metadataCandidates = rows.filter((row) => attachmentMatchesFilters(row, request))
  measurement.metadataCandidates += metadataCandidates.length
  const terms = searchTerms(request.query)
  if (terms.length === 0) return metadataCandidates
  const artifactCandidateIds = metadataCandidates
    .filter((row) => !terms.every((term) => row.searchMetadata.includes(term)))
    .map((row) => row.id)
  measurement.artifactCandidateAttachments += artifactCandidateIds.length
  const artifacts = await loadAttachmentArtifacts(db, artifactCandidateIds, signal)
  measurement.artifactRowsRead += artifacts.length
  const artifactText = new Map<AttachmentId, string[]>()
  for (const [index, artifact] of artifacts.entries()) {
    if (index % CATALOG_ABORT_CHECK_ROWS === 0) throwIfAborted(signal)
    const values = artifactText.get(artifact.attachmentId) ?? []
    values.push(searchableArtifactText(artifact))
    artifactText.set(artifact.attachmentId, values)
  }
  return metadataCandidates.filter((row) => {
    if (terms.every((term) => row.searchMetadata.includes(term))) return true
    const haystack = `${row.searchMetadata}\n${(artifactText.get(row.id) ?? []).join('\n')}`
    return terms.every((term) => haystack.includes(term))
  })
}

async function loadAttachmentArtifacts(
  db: NatterDb,
  attachmentIds: readonly AttachmentId[],
  signal?: AbortSignal,
): Promise<AttachmentArtifact[]> {
  if (attachmentIds.length === 0) return []
  throwIfAborted(signal)
  const rows = await db.attachmentArtifacts.where('attachmentId').anyOf(attachmentIds).toArray()
  throwIfAborted(signal)
  return rows
}

function sidebarScanCollection(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
  ascending: boolean,
  archived: NonNullable<ChatSidebarCatalogRequest['archived']>,
  cursor: CatalogCursor | undefined,
): Collection<ChatSidebarProjectionRow, ChatId> {
  const sortField = sidebarSortIndex(orderBy)
  if (archived !== 'include') {
    const archivedKey = archived === 'only' ? 1 : 0
    const index =
      orderBy === 'title'
        ? '[archivedKey+titleSortKey+id]'
        : `[archivedKey+${sortField}+titleSortKey+id]`
    const lower = [archivedKey]
    const upper = [archivedKey, []]
    const cursorKey = cursor
      ? orderBy === 'title'
        ? [archivedKey, cursor.value, cursor.id]
        : [archivedKey, cursor.value, cursor.titleSortKey ?? '', cursor.id]
      : undefined
    const collection = cursorKey
      ? ascending
        ? table.where(index).between(cursorKey, upper, false, false)
        : table.where(index).between(lower, cursorKey, true, false)
      : table.where(index).between(lower, upper, true, false)
    return ascending ? collection : collection.reverse()
  }
  const index = orderBy === 'title' ? '[titleSortKey+id]' : `[${sortField}+titleSortKey+id]`
  const cursorKey = cursor
    ? orderBy === 'title'
      ? [cursor.value, cursor.id]
      : [cursor.value, cursor.titleSortKey ?? '', cursor.id]
    : undefined
  const collection = cursor
    ? ascending
      ? table.where(index).above(cursorKey)
      : table.where(index).below(cursorKey)
    : table.orderBy(index)
  return ascending ? collection : collection.reverse()
}

function pinnedSidebarScanCollection(
  table: Table<ChatSidebarProjectionRow, ChatId>,
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
  ascending: boolean,
  pinnedKey: 0 | 1,
  cursor: CatalogCursor | undefined,
): Collection<ChatSidebarProjectionRow, ChatId> {
  const sortField = sidebarSortIndex(orderBy)
  const index =
    orderBy === 'title'
      ? '[visibleKey+pinnedKey+titleSortKey+id]'
      : `[visibleKey+pinnedKey+${sortField}+titleSortKey+id]`
  const lower = [1, pinnedKey]
  const upper = [1, pinnedKey, []]
  const cursorKey = cursor
    ? orderBy === 'title'
      ? [1, pinnedKey, cursor.value, cursor.id]
      : [1, pinnedKey, cursor.value, cursor.titleSortKey ?? '', cursor.id]
    : undefined
  const collection = cursorKey
    ? ascending
      ? table.where(index).between(cursorKey, upper, false, false)
      : table.where(index).between(lower, cursorKey, true, false)
    : table.where(index).between(lower, upper, true, false)
  return ascending ? collection : collection.reverse()
}

function attachmentScanCollection(
  table: Table<AttachmentCatalogProjectionRow, AttachmentId>,
  sort: NonNullable<AttachmentCatalogSearchRequest['sort']>,
  ascending: boolean,
  cursor: CatalogCursor | undefined,
): Collection<AttachmentCatalogProjectionRow, AttachmentId> {
  const field =
    sort === 'updated-desc' ? 'updatedAt' : sort.startsWith('size-') ? 'sizeBytes' : 'createdAt'
  const index = `[${field}+id]`
  const collection = cursor
    ? ascending
      ? table.where(index).above([cursor.value, cursor.id])
      : table.where(index).below([cursor.value, cursor.id])
    : table.orderBy(index)
  return ascending ? collection : collection.reverse()
}

async function countSidebarRows(
  db: NatterDb,
  request: ChatSidebarCatalogRequest,
  context: SidebarFilterContext,
): Promise<number> {
  const ordinaryVisibleCount = await countOrdinaryVisibleSidebarRows(db, request)
  if (ordinaryVisibleCount !== undefined) return ordinaryVisibleCount
  const table = db.chatSidebarRows
  if (hasAdvancedSidebarFilters(request)) {
    return table.filter((row) => sidebarRowMatches(row, context)).count()
  }
  const archived = request.archived ?? 'exclude'
  const archivedKey = archived === 'include' ? undefined : archived === 'only' ? 1 : 0
  if (request.folderId !== undefined && archivedKey !== undefined) {
    return table
      .where('[folderKey+archivedKey]')
      .equals([chatSidebarFolderKey(request.folderId), archivedKey])
      .count()
  }
  if (request.folderId !== undefined) {
    return table.where('folderKey').equals(chatSidebarFolderKey(request.folderId)).count()
  }
  if (archivedKey !== undefined) return table.where('archivedKey').equals(archivedKey).count()
  return table.count()
}

async function countOrdinaryVisibleSidebarRows(
  db: NatterDb,
  request: ChatSidebarCatalogRequest,
): Promise<number | undefined> {
  const ordinaryBrowse =
    (request.archived ?? 'exclude') === 'exclude' &&
    request.excludeEmptyDrafts === true &&
    request.folderId === undefined &&
    (request.includeFolderIds?.length ?? 0) === 0 &&
    (request.includeTagIds?.length ?? 0) === 0 &&
    (request.excludeTagIds?.length ?? 0) === 0
  if (!ordinaryBrowse) return undefined
  const aggregate = await db.chatSidebarAggregates.get(CHAT_SIDEBAR_AGGREGATE_ID)
  if (!isValidChatSidebarWorkspaceAggregateRow(aggregate)) {
    throw new Error('ChatSidebarAggregateInvalid')
  }
  const excluded = [...new Set(request.excludeFolderIds ?? [])]
  if (excluded.length === 0) return aggregate.visibleCount
  const folderRows = await db.chatSidebarAggregates.bulkGet(
    excluded.map((folderId) => `folder:${chatSidebarFolderKey(folderId)}`),
  )
  let count = aggregate.visibleCount
  for (const value of folderRows) {
    if (value === undefined) continue
    if (!isValidChatSidebarFolderAggregateRow(value)) {
      throw new Error('ChatSidebarFolderAggregateInvalid')
    }
    count -= value.visibleCount
  }
  return Math.max(0, count)
}

function sidebarRowMatches(row: ChatSidebarProjectionRow, context: SidebarFilterContext): boolean {
  const archived = context.archived
  if (archived === 'exclude' && row.archived) return false
  if (archived === 'only' && !row.archived) return false
  if (context.excludeEmptyDrafts && (row.previewText === undefined || row.previewText === '')) {
    return false
  }
  if (context.folderId !== undefined && row.folderKey !== context.folderId) return false
  const folderId = row.folderId ?? ''
  if (context.includeFolderIds.size > 0 && !context.includeFolderIds.has(folderId)) return false
  if (context.excludeFolderIds.has(folderId)) return false
  if (
    context.includeTagIds.size > 0 &&
    !row.tags.some((tagId) => context.includeTagIds.has(tagId))
  ) {
    return false
  }
  return !row.tags.some((tagId) => context.excludeTagIds.has(tagId))
}

function sidebarFilterContext(request: ChatSidebarCatalogRequest): SidebarFilterContext {
  return {
    archived: request.archived ?? 'exclude',
    folderId: request.folderId === undefined ? undefined : chatSidebarFolderKey(request.folderId),
    includeFolderIds: new Set(request.includeFolderIds ?? []),
    excludeFolderIds: new Set(request.excludeFolderIds ?? []),
    includeTagIds: new Set(request.includeTagIds ?? []),
    excludeTagIds: new Set(request.excludeTagIds ?? []),
    excludeEmptyDrafts: request.excludeEmptyDrafts === true,
  }
}

function hasAdvancedSidebarFilters(request: ChatSidebarCatalogRequest): boolean {
  return (
    request.excludeEmptyDrafts === true ||
    (request.includeFolderIds?.length ?? 0) > 0 ||
    (request.excludeFolderIds?.length ?? 0) > 0 ||
    (request.includeTagIds?.length ?? 0) > 0 ||
    (request.excludeTagIds?.length ?? 0) > 0
  )
}

function attachmentMatchesFilters(
  row: AttachmentCatalogProjectionRow,
  request: AttachmentCatalogSearchRequest,
): boolean {
  const filters = request.filters
  if (filters?.kind && row.kind !== filters.kind) return false
  if (filters?.mime && row.mime !== filters.mime) return false
  if (filters?.origin && row.origin !== filters.origin) return false
  if (filters?.storageKind && row.storageKind !== filters.storageKind) return false
  if (filters?.minSizeBytes !== undefined && row.sizeBytes < filters.minSizeBytes) return false
  if (filters?.maxSizeBytes !== undefined && row.sizeBytes > filters.maxSizeBytes) return false
  if (filters?.minRefCount !== undefined && row.refCount < filters.minRefCount) return false
  if (filters?.maxRefCount !== undefined && row.refCount > filters.maxRefCount) return false
  return true
}

function sidebarSortValue(
  row: ChatSidebarProjectionRow,
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
): number | string {
  return orderBy === 'title' ? row.titleSortKey : row[orderBy]
}

function sidebarSortIndex(
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
): keyof ChatSidebarProjectionRow {
  return orderBy === 'title' ? 'titleSortKey' : orderBy
}

function attachmentSortValue(
  row: AttachmentCatalogProjectionRow,
  sort: NonNullable<AttachmentCatalogSearchRequest['sort']>,
): number {
  if (sort === 'updated-desc') return row.updatedAt
  if (sort === 'size-desc' || sort === 'size-asc') return row.sizeBytes
  return row.createdAt
}

function sidebarFingerprint(
  request: ChatSidebarCatalogRequest,
  orderBy: string,
  displayDirection: string,
): string {
  return JSON.stringify([
    orderBy,
    displayDirection,
    request.archived ?? 'exclude',
    request.folderId === undefined ? '__all__' : request.folderId,
    [...(request.includeFolderIds ?? [])].sort(),
    [...(request.excludeFolderIds ?? [])].sort(),
    [...(request.includeTagIds ?? [])].sort(),
    [...(request.excludeTagIds ?? [])].sort(),
    request.excludeEmptyDrafts === true,
    request.pinnedFirst === true,
  ])
}

function attachmentFingerprint(request: AttachmentCatalogSearchRequest, sort: string): string {
  const filters = request.filters
  return JSON.stringify([
    searchTerms(request.query),
    filters
      ? [
          filters.kind ?? null,
          filters.mime ?? null,
          filters.origin ?? null,
          filters.storageKind ?? null,
          filters.minSizeBytes ?? null,
          filters.maxSizeBytes ?? null,
          filters.minRefCount ?? null,
          filters.maxRefCount ?? null,
        ]
      : null,
    sort,
  ])
}

function encodeSidebarCursor(
  row: ChatSidebarProjectionRow,
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
  fingerprint: string,
): string {
  return encodeCursor(SIDEBAR_CURSOR_PREFIX, {
    fingerprint,
    value: sidebarSortValue(row, orderBy),
    id: row.id,
    titleSortKey: row.titleSortKey,
  })
}

function sidebarCursorFor(
  row: ChatSidebarProjectionRow,
  orderBy: NonNullable<ChatSidebarCatalogRequest['orderBy']>,
  fingerprint: string,
  pinnedKey: 0 | 1,
): CatalogCursor {
  return {
    fingerprint,
    value: sidebarSortValue(row, orderBy),
    id: row.id,
    pinnedKey,
    titleSortKey: row.titleSortKey,
  }
}

function encodeAttachmentCursor(
  row: AttachmentCatalogProjectionRow,
  sort: NonNullable<AttachmentCatalogSearchRequest['sort']>,
  fingerprint: string,
): string {
  return encodeCursor(ATTACHMENT_CURSOR_PREFIX, {
    fingerprint,
    value: attachmentSortValue(row, sort),
    id: row.id,
  })
}

function encodeCursor(prefix: string, cursor: CatalogCursor): string {
  return `${prefix}${encodeURIComponent(JSON.stringify(cursor))}`
}

function decodeCursor(
  cursor: string,
  prefix: string,
  fingerprint: string,
  stringValue: boolean,
  requireTitleSortKey: boolean,
): CatalogCursor {
  if (!cursor.startsWith(prefix)) throw new Error('CatalogCursorVersionUnsupported')
  try {
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(prefix.length)),
    ) as Partial<CatalogCursor>
    if (
      parsed.fingerprint !== fingerprint ||
      (stringValue
        ? typeof parsed.value !== 'string'
        : typeof parsed.value !== 'number' || !Number.isFinite(parsed.value)) ||
      typeof parsed.id !== 'string' ||
      (requireTitleSortKey && typeof parsed.titleSortKey !== 'string')
    ) {
      throw new Error('shape')
    }
    return parsed as CatalogCursor
  } catch {
    throw new Error('CatalogCursorInvalid')
  }
}

function searchTerms(query: string | undefined): string[] {
  return query?.trim().toLowerCase().split(/\s+/u).filter(Boolean) ?? []
}

function searchableArtifactText(artifact: AttachmentArtifact): string {
  return [
    artifact.artifactId,
    artifact.kind,
    artifact.processorId,
    artifact.kind === 'text' ? artifact.text : undefined,
    artifact.kind === 'json' ? JSON.stringify(artifact.value) : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase()
}

function attachmentArtifactSummary(artifact: AttachmentArtifact): AttachmentArtifactSummary {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    processorId: artifact.processorId,
    createdAt: artifact.createdAt,
    ...(artifact.kind === 'text'
      ? { charCount: artifact.charCount, textPreview: artifact.text.slice(0, 6_000) }
      : {}),
    ...(artifact.kind === 'blob' ? { blobId: artifact.blobId } : {}),
  }
}

function attachmentJobSummary(job: AttachmentJob): AttachmentJobSummary {
  return {
    id: job.id,
    processorId: job.processorId,
    status: job.status,
    ...(job.startedAt === undefined ? {} : { startedAt: job.startedAt }),
    ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
    ...(job.error ? { error: { ...job.error } } : {}),
    outputArtifactIds: [...job.outputArtifactIds],
    updatedAt: job.updatedAt,
  }
}

function emptyAttachmentCatalogMeasurement(
  sort: NonNullable<AttachmentCatalogSearchRequest['sort']>,
): AttachmentSearchMeasurement {
  return {
    selectedIndex:
      sort === 'updated-desc'
        ? 'updatedAt'
        : sort === 'created-desc' || sort === 'created-asc'
          ? 'createdAt'
          : 'primary',
    indexCounts: {},
    metadataRowsRead: 0,
    metadataCandidates: 0,
    embeddedArtifactRowsRead: 0,
    artifactCandidateAttachments: 0,
    artifactRowsRead: 0,
    attachmentBlobRowsRead: 0,
    matchedRows: 0,
    returnedRows: 0,
  }
}

function assertSidebarProjection(row: ChatSidebarProjectionRow): void {
  if (!isValidChatSidebarProjectionRow(row)) {
    throw new Error(`ChatSidebarProjectionIntegrityError:${row.id}`)
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) return fallback
  return Math.min(value, 500)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Catalog query aborted', 'AbortError')
}
