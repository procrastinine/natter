// Paste this entire file into the app's DevTools console while the affected chat is open.
// It reads only topology/metadata stores and removes content-bearing fields before export.
void (async () => {
  const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
  const databaseNames = new Set(databases.flatMap((entry) => (entry.name ? [entry.name] : [])))

  const openExisting = (name) =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onupgradeneeded = () => {
        request.transaction?.abort()
        reject(new Error(`ChatStructureDatabaseMissing:${name}`))
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error(`ChatStructureDatabaseBlocked:${name}`))
    })

  const requestValue = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  const activeDatabaseName = async () => {
    if (!databaseNames.has('natter-control')) return 'natter'
    const control = await openExisting('natter-control')
    try {
      if (!control.objectStoreNames.contains('manifests')) return 'natter'
      const manifest = await requestValue(
        control.transaction('manifests', 'readonly').objectStore('manifests').get('workspace'),
      )
      return typeof manifest?.activeDatabaseName === 'string'
        ? manifest.activeDatabaseName
        : 'natter'
    } finally {
      control.close()
    }
  }

  const routeChatId = decodeURIComponent(
    window.location.hash.match(/^#\/chat\/([^/]+)/u)?.[1] ?? '',
  )
  const chatId = routeChatId || window.prompt('Chat ID to inspect:')?.trim()
  if (!chatId) throw new Error('ChatStructureChatIdMissing')

  const databaseName = await activeDatabaseName()
  const database = await openExisting(databaseName)
  const hasStore = (name) => database.objectStoreNames.contains(name)
  const rowsForChat = (storeName) => {
    if (!hasStore(storeName)) return Promise.resolve([])
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const rows = []
      let request
      if (store.indexNames.contains('chatId')) {
        request = store.index('chatId').openCursor(IDBKeyRange.only(chatId))
      } else {
        request = store.openCursor()
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const row = cursor.value
        if (row && typeof row === 'object' && row.chatId === chatId) rows.push(row)
        cursor.continue()
      }
      transaction.oncomplete = () => resolve(rows)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  }

  const pick = (row, keys) =>
    Object.fromEntries(keys.flatMap((key) => (key in row ? [[key, row[key]]] : [])))
  const arrayLength = (value) => (Array.isArray(value) ? value.length : 0)
  const contentTypes = (value) =>
    Array.isArray(value)
      ? value.map((item) =>
          item && typeof item === 'object' && typeof item.type === 'string' ? item.type : 'unknown',
        )
      : []

  try {
    const [chat, rawMessages, rawChildLists, rawChildMembers] = await Promise.all([
      hasStore('chats')
        ? requestValue(database.transaction('chats', 'readonly').objectStore('chats').get(chatId))
        : undefined,
      rowsForChat('messages'),
      rowsForChat('childLists'),
      rowsForChat('childSlotMembers'),
    ])
    if (!chat) throw new Error(`ChatStructureChatMissing:${chatId}`)

    const messages = rawMessages
      .map((row) => ({
        ...pick(row, [
          'id',
          'chatId',
          'parentId',
          'siblingIndex',
          'turnId',
          'turnIndex',
          'createdAt',
          'role',
          'origin',
          'nodeVersion',
          'bodyVersion',
          'deleted',
          'deletedAt',
          'hiddenFromContext',
        ]),
        payloadShape: {
          contentTypes: contentTypes(row.content),
          attachmentCount: arrayLength(row.attachmentRefs),
          reasoningDetailCount: arrayLength(row.reasoningDetails),
          reasoningVisibleCount: arrayLength(row.reasoningEnvelope?.visible),
          reasoningCarrierCount: arrayLength(row.reasoningEnvelope?.carriers),
          providerOutputCount: arrayLength(row.providerOutputItems),
          toolCallCount: arrayLength(row.toolCalls),
          continuationAttemptCount: arrayLength(row.continuationAttempts),
          generationStatus: row.generation?.status ?? null,
          generationFinished: typeof row.generation?.finishedAt === 'number',
        },
      }))
      .sort(
        (left, right) =>
          (left.createdAt ?? 0) - (right.createdAt ?? 0) ||
          String(left.id).localeCompare(String(right.id)),
      )

    const childLists = rawChildLists
      .map((row) =>
        pick(row, [
          'id',
          'chatId',
          'parentId',
          'version',
          'updatedAt',
          'liveCount',
          'firstLiveChildId',
          'lastLiveChildId',
          'nextSiblingIndex',
        ]),
      )
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    const childSlotMembers = rawChildMembers
      .map((row) =>
        pick(row, [
          'id',
          'chatId',
          'parentId',
          'parentKey',
          'position',
          'previousMessageId',
          'nextMessageId',
        ]),
      )
      .sort(
        (left, right) =>
          String(left.parentKey).localeCompare(String(right.parentKey)) ||
          (left.position ?? 0) - (right.position ?? 0),
      )

    const byId = new Map(messages.map((row) => [row.id, row]))
    const roots = messages.filter((row) => row.parentId === null)
    const missingParents = messages
      .filter((row) => row.parentId !== null && !byId.has(row.parentId))
      .map((row) => ({ id: row.id, parentId: row.parentId }))
    const duplicateSiblingSlots = []
    const slotOwners = new Map()
    for (const row of messages) {
      const key = `${row.parentId ?? '__root__'}:${row.siblingIndex}`
      const owners = slotOwners.get(key) ?? []
      owners.push(row.id)
      slotOwners.set(key, owners)
    }
    for (const [slot, ids] of slotOwners) {
      if (ids.length > 1) duplicateSiblingSlots.push({ slot, ids })
    }
    const cyclicIds = new Set()
    const depths = new Map()
    const recordDepth = (id) => {
      const path = []
      const positions = new Map()
      let cursor = id
      let parentDepth
      for (;;) {
        const knownDepth = depths.get(cursor)
        if (knownDepth !== undefined) {
          parentDepth = knownDepth
          break
        }
        const cycleStart = positions.get(cursor)
        if (cycleStart !== undefined) {
          for (const member of path.slice(cycleStart)) cyclicIds.add(member)
          return
        }
        const row = byId.get(cursor)
        if (!row) return
        positions.set(cursor, path.length)
        path.push(cursor)
        if (row.parentId === null) {
          parentDepth = -1
          break
        }
        cursor = row.parentId
      }
      for (let index = path.length - 1; index >= 0; index -= 1) {
        parentDepth += 1
        depths.set(path[index], parentDepth)
      }
    }
    for (const row of messages) recordDepth(row.id)

    const roleCounts = {}
    for (const row of messages) roleCounts[row.role] = (roleCounts[row.role] ?? 0) + 1
    let maximumDepth = -1
    for (const depth of depths.values()) maximumDepth = Math.max(maximumDepth, depth)
    const report = {
      format: 'natter-chat-structure-v1',
      exportedAt: new Date().toISOString(),
      database: {
        name: databaseName,
        version: database.version,
        stores: [...database.objectStoreNames],
      },
      chat: pick(chat, [
        'id',
        'createdAt',
        'updatedAt',
        'lastViewedAt',
        'titleStatus',
        'metaVersion',
        'summaryVersion',
        'structuralVersion',
        'lastUpdatedLeafId',
        'lastBranchUpdatedAt',
        'archived',
        'pinned',
        'folderId',
        'presetId',
      ]),
      summary: {
        messageCount: messages.length,
        liveMessageCount: messages.filter((row) => row.deleted !== true).length,
        deletedMessageCount: messages.filter((row) => row.deleted === true).length,
        rootCount: roots.length,
        maximumDepth,
        roleCounts,
        childListCount: childLists.length,
        childSlotMemberCount: childSlotMembers.length,
      },
      diagnostics: {
        missingParents,
        duplicateSiblingSlots,
        cyclicMessageIds: [...cyclicIds].sort(),
        selfParentMessageIds: messages
          .filter((row) => row.id === row.parentId)
          .map((row) => row.id),
        lastUpdatedLeafPresent: chat.lastUpdatedLeafId === null || byId.has(chat.lastUpdatedLeafId),
      },
      messages,
      childLists,
      childSlotMembers,
    }

    const json = JSON.stringify(report, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `natter-chat-structure-${chatId.replace(/[^a-zA-Z0-9_-]/gu, '_')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    console.info('Downloaded content-free chat structure', report.summary, report.diagnostics)
    return report
  } finally {
    database.close()
  }
})()
