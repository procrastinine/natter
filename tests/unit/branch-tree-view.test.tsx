import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ActiveBranchForkSlot,
  createActiveBranchSpineFromPath,
} from '../../src/core/active-branch-spine'
import type { MessageTreeProjection } from '../../src/core/active-path'
import { createBranchPath } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { AVAILABLE_GENERATION_CAPABILITY } from '../../src/core/interaction-capability'
import { createMessageTopologyIndex } from '../../src/core/message-topology'
import { messageTreeIndexFields } from '../../src/core/message-tree-index'
import {
  type ConversationSelectionProofTarget,
  sealConversationSelection,
} from '../../src/core/messages'
import { EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS } from '../../src/core/reasoning'
import type { Chat, Message, MessageId, MessageRole } from '../../src/core/types'
import { useAttemptExecutionsForChat } from '../../src/store/attempt-controller'
import { postWorkspaceChange, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import {
  type ConversationCommittedEffect,
  type ConversationController,
  type ConversationMessagePresentation,
  type ConversationNavigationPort,
  type ConversationPresentationResourcePort,
  type ConversationProjectionSource,
  type ConversationRouteArrival,
  type ConversationTreeSurface,
  createConversationController,
  TREE_PREVIEW_MAX_CHARS,
} from '../../src/store/conversation-controller'
import type { GenerationCapabilityFrame } from '../../src/store/generation-admission-controller'
import type { GenerationStartResult } from '../../src/store/generation-engine'
import { type MessageHeaderRow, sameMessageHeaderValue } from '../../src/store/message-storage'
import {
  attachMountedRepositoryProjections,
  resetMountedRepositoryProjectionsForTests,
} from '../../src/store/mounted-projection-lifecycle'
import type { AttachmentCatalogRow } from '../../src/store/presentation-contracts'
import type { WorkspaceFence } from '../../src/store/repository'
import { reconcileWorkspaceTabSessionStorage } from '../../src/store/workspace-tab-session'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { observeBranchTreeInspectorComputations } from '../../src/ui/chat/BranchTreeInspector'
import {
  type BranchTreeRepository,
  BranchTreeView as BranchTreeViewComponent,
  type BranchTreeViewProps,
  observeBranchTreeComputations,
} from '../../src/ui/chat/BranchTreeView'
import {
  observeTestAttempt,
  publishTestLiveProjection,
  removeTestAttempt,
  resetAttemptControllerForTests,
} from '../helpers/attempt-controller'
import {
  createInteractionSettlementHarness,
  succeededInteractionSettlement,
} from '../helpers/presentation-interactions'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

const attachmentCatalogState = vi.hoisted(() => ({
  rowsById: new Map<string, AttachmentCatalogRow>(),
  workspaceFence: { workspaceId: 'tree-test-workspace', replacementEpoch: 0 },
}))

vi.mock('../../src/ui/attachments/useAttachmentCatalogRows', () => ({
  useAttachmentCatalogRows: () => ({
    revision: 1,
    status: 'ready',
    interactive: true,
    attachmentIds: [...attachmentCatalogState.rowsById.keys()],
    rowsById: attachmentCatalogState.rowsById,
    errorsById: new Map(),
    workspaceFence: attachmentCatalogState.workspaceFence,
  }),
}))

vi.mock('../../src/ui/attachments/useAttachmentMedia', () => ({
  useAttachmentMedia: () => ({ status: 'idle', media: null, workspaceFence: null }),
}))

vi.mock('../../src/ui/attachments/useAttachmentObjectUrl', () => ({
  useAttachmentObjectUrl: () => undefined,
}))

type CursorMap = Readonly<Record<string, MessageId>>

const READY_GENERATION_CAPABILITY_FRAME: GenerationCapabilityFrame = Object.freeze({
  capability: () => AVAILABLE_GENERATION_CAPABILITY,
})

const TEST_STRUCTURAL_VERSION = 1
const EMPTY_TREE_PREVIEWS: ConversationTreeSurface['previews'] = new Map()
let testWorkspaceFence: WorkspaceFence = {
  workspaceId: 'tree-test-workspace',
  replacementEpoch: 0,
}

function sameTreeStructure(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    left.id === right.id &&
    left.parentId === right.parentId &&
    left.siblingIndex === right.siblingIndex &&
    left.deleted === right.deleted
  )
}

interface LiveLeafScore {
  readonly createdAt: number
  readonly id: MessageId
}

function compareLeafScore(left: LiveLeafScore, right: LiveLeafScore): number {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function activePathForCursor<T extends MessageHeaderRow>(
  projection: MessageTreeProjection<T>,
  cursor: CursorMap,
): T[] {
  const scores = new Map<MessageId, LiveLeafScore>()
  const remainingChildren = new Map<MessageId, number>()
  const ready: T[] = []
  for (const message of projection.byId.values()) {
    if (message.deleted) continue
    const childCount = projection.liveByParent.get(message.id)?.length ?? 0
    remainingChildren.set(message.id, childCount)
    if (childCount === 0) {
      scores.set(message.id, { createdAt: message.createdAt, id: message.id })
      ready.push(message)
    }
  }
  for (let index = 0; index < ready.length; index += 1) {
    const message = ready[index] as T
    if (message.parentId === null) continue
    const parent = projection.byId.get(message.parentId)
    if (!parent || parent.deleted) continue
    const childScore = scores.get(message.id)
    const parentScore = scores.get(parent.id)
    if (childScore && (!parentScore || compareLeafScore(childScore, parentScore) > 0)) {
      scores.set(parent.id, childScore)
    }
    const remaining = (remainingChildren.get(parent.id) ?? 1) - 1
    remainingChildren.set(parent.id, remaining)
    if (remaining === 0) ready.push(parent)
  }

  const path: T[] = []
  let parentId: MessageId | null = null
  for (;;) {
    const children = projection.liveByParent.get(parentId) ?? []
    if (children.length === 0) return path
    const pinnedId: MessageId | undefined = cursor[parentId ?? '__root__']
    const pinned: T | undefined = pinnedId
      ? children.find((candidate) => candidate.id === pinnedId)
      : undefined
    let chosen: T = pinned ?? (children[0] as T)
    if (!pinned) {
      for (let index = 1; index < children.length; index += 1) {
        const candidate = children[index] as T
        const candidateScore = scores.get(candidate.id)
        const chosenScore = scores.get(chosen.id)
        const scoreOrder = candidateScore
          ? chosenScore
            ? compareLeafScore(candidateScore, chosenScore)
            : 1
          : chosenScore
            ? -1
            : 0
        if (
          scoreOrder > 0 ||
          (scoreOrder === 0 &&
            (candidate.siblingIndex > chosen.siblingIndex ||
              (candidate.siblingIndex === chosen.siblingIndex && candidate.id > chosen.id)))
        ) {
          chosen = candidate
        }
      }
    }
    path.push(chosen)
    parentId = chosen.id
  }
}

function newestDescendantId(
  projection: MessageTreeProjection<MessageHeaderRow>,
  messageId: MessageId,
): MessageId | null {
  const root = projection.byId.get(messageId)
  if (!root || root.deleted) return null
  const stack = [root]
  let newest: MessageHeaderRow | null = null
  while (stack.length > 0) {
    const current = stack.pop() as MessageHeaderRow
    const children = projection.liveByParent.get(current.id) ?? []
    if (children.length > 0) {
      for (const child of children) stack.push(child)
      continue
    }
    if (
      !newest ||
      compareLeafScore(
        { createdAt: current.createdAt, id: current.id },
        { createdAt: newest.createdAt, id: newest.id },
      ) > 0
    ) {
      newest = current
    }
  }
  return newest?.id ?? root.id
}

function pathToMessage(
  projection: MessageTreeProjection<MessageHeaderRow>,
  messageId: MessageId | null,
): MessageHeaderRow[] {
  if (messageId === null) return []
  const reversePath: MessageHeaderRow[] = []
  const seen = new Set<MessageId>()
  let current = projection.byId.get(messageId)
  while (current && !current.deleted && !seen.has(current.id)) {
    seen.add(current.id)
    reversePath.push(current)
    current = current.parentId ? projection.byId.get(current.parentId) : undefined
  }
  return reversePath.reverse()
}

function resolveSelectionPath(
  headers: readonly MessageHeaderRow[],
  target: ConversationSelectionProofTarget,
): MessageHeaderRow[] {
  const projection = createMessageTopologyIndex(headers, {
    sameStructure: sameTreeStructure,
  })
  let tipId: MessageId | null
  if (target.kind === 'fixed-empty') {
    tipId = null
  } else if (target.kind === 'fixed-tip') {
    tipId = target.messageId
  } else if (target.selection.kind === 'default') {
    tipId = activePathForCursor(projection, {}).at(-1)?.id ?? null
  } else if (target.selection.kind === 'tip') {
    tipId = target.selection.messageId
  } else if (target.selection.kind === 'message') {
    tipId =
      target.selection.observedTipId ?? newestDescendantId(projection, target.selection.messageId)
  } else {
    const selected = (projection.liveByParent.get(target.selection.parentId) ?? [])[
      target.selection.position
    ]
    tipId =
      target.selection.observedTipId ??
      (selected ? newestDescendantId(projection, selected.id) : null)
  }
  return pathToMessage(projection, tipId)
}

function newestLeafId(headers: readonly MessageHeaderRow[]): MessageId | null {
  const projection = createMessageTopologyIndex(headers, {
    sameStructure: sameTreeStructure,
  })
  return activePathForCursor(projection, {}).at(-1)?.id ?? null
}

function testChat(chatId: string, structuralVersion: number, leafId: MessageId | null): Chat {
  return {
    id: chatId,
    title: 'Tree test',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 1,
    summaryVersion: 1,
    structuralVersion,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: leafId,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function startedGenerationResult(messageId = 'generated'): GenerationStartResult {
  const prepared = Object.freeze({
    streamId: `stream-${messageId}`,
    chatId: 'chat-1',
    assistantMessageId: messageId,
  })
  return Object.freeze({
    kind: 'started' as const,
    handle: Object.freeze({
      streamId: prepared.streamId,
      chatId: prepared.chatId,
      prepared: Promise.resolve(prepared),
      completed: Promise.resolve({ ...prepared, outcome: 'done' as const }),
      abort: () => undefined,
    }),
  })
}

const BranchTreeView = Object.assign(
  function TestBranchTreeView(
    props: Omit<
      BranchTreeViewProps,
      | 'attempts'
      | 'binding'
      | 'conversationController'
      | 'generationCapabilityFrame'
      | 'viewportActive'
    > & {
      chatId: string
      cursor: CursorMap
      generationCapabilityFrame?: GenerationCapabilityFrame
      headers: readonly MessageHeaderRow[]
      latestHeaders?: readonly MessageHeaderRow[]
      localPresentations?: ReadonlyMap<
        MessageId,
        { readonly message: Message; readonly bodyVersion: number }
      >
      testController?: ConversationController
      viewportActive?: boolean
      bindingCurrency?: ConversationTreeSurface['currency']
    },
  ) {
    const {
      cursor,
      headers,
      latestHeaders,
      localPresentations,
      testController,
      viewportActive = true,
      bindingCurrency = 'current',
      generationCapabilityFrame = READY_GENERATION_CAPABILITY_FRAME,
      ...viewProps
    } = props
    const structuralHeaders = headers
    const exactHeaders = latestHeaders ?? structuralHeaders
    const structuralSignature = structuralHeaders
      .map((row) => `${row.id}:${row.parentId ?? ''}:${row.siblingIndex}:${Number(row.deleted)}`)
      .join('|')
    const projectionCache = useRef<
      | {
          signature: string
          projection: MessageTreeProjection<MessageHeaderRow>
        }
      | undefined
    >(undefined)
    if (!projectionCache.current || projectionCache.current.signature !== structuralSignature) {
      projectionCache.current = {
        signature: structuralSignature,
        projection: createMessageTopologyIndex(structuralHeaders, {
          sameStructure: sameTreeStructure,
        }),
      }
    }
    const projection = projectionCache.current.projection
    const selectedHeaders = activePathForCursor(projection, cursor)
    const selectedPathSignature = selectedHeaders
      .map((row) => `${row.id}:${row.nodeVersion}:${row.parentId ?? ''}:${row.siblingIndex}`)
      .join('|')
    const acceptedPathCache = useRef<{
      signature: string
      path: ReturnType<typeof createBranchPath<MessageHeaderRow>>
      revision: number
    } | null>(null)
    if (
      !acceptedPathCache.current ||
      acceptedPathCache.current.signature !== selectedPathSignature
    ) {
      acceptedPathCache.current = {
        signature: selectedPathSignature,
        path: createBranchPath(selectedHeaders),
        revision: (acceptedPathCache.current?.revision ?? 0) + 1,
      }
    }
    const acceptedPath = acceptedPathCache.current.path
    const selectionRevision = acceptedPathCache.current.revision
    const requestedHeaderById = useMemo(
      () => new Map(exactHeaders.map((header) => [header.id, header] as const)),
      [exactHeaders],
    )
    const ownedController = useMemo(() => createConversationController(), [])
    const controller = testController ?? ownedController
    const controllerSnapshot = useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    )
    const currentRef = useRef({
      headers: exactHeaders,
      acceptedPath,
      repository: props.repository as TestBranchTreeRepository | undefined,
      structuralVersion: TEST_STRUCTURAL_VERSION,
    })
    const topologyVersionRef = useRef({
      signature: structuralSignature,
      version: TEST_STRUCTURAL_VERSION,
    })
    if (topologyVersionRef.current.signature !== structuralSignature) {
      topologyVersionRef.current = {
        signature: structuralSignature,
        version: topologyVersionRef.current.version + 1,
      }
    }
    currentRef.current = {
      headers: exactHeaders,
      acceptedPath,
      repository: props.repository as TestBranchTreeRepository | undefined,
      structuralVersion: topologyVersionRef.current.version,
    }
    const fenceRef = useRef<WorkspaceFence>(testWorkspaceFence)
    const projectionReadCountsRef = useRef(new Map<string, number>())
    const deliveredWorkspaceRef = useRef('')
    const deliveredPresentationsRef = useRef(
      new Map<MessageId, { readonly bodyVersion: number; readonly message: Message }>(),
    )
    const navigation = useMemo(() => new TestNavigationPort(), [])
    const presentationResources = useMemo<ConversationPresentationResourcePort>(
      () => ({
        get: () => Object.freeze({ kind: 'ready' as const }),
        request: () => undefined,
        subscribe: () => () => undefined,
      }),
      [],
    )
    const source = useMemo<ConversationProjectionSource>(() => {
      const countProjectionRead = (kind: string) => {
        const count = (projectionReadCountsRef.current.get(kind) ?? 0) + 1
        projectionReadCountsRef.current.set(kind, count)
        if (count > 100) throw new Error(`TreeTestProjectionReadLoop:${kind}`)
      }
      return {
        openSelection: async (chatId, target) => {
          countProjectionRead('selection')
          const path = createBranchPath(resolveSelectionPath(currentRef.current.headers, target))
          const structuralVersion = currentRef.current.structuralVersion
          const chat = testChat(chatId, structuralVersion, newestLeafId(currentRef.current.headers))
          return envelope(
            fenceRef.current,
            sealConversationSelection(
              {
                kind: 'ready',
                chat,
                target,
                proof: {
                  chatId,
                  structuralVersion,
                  tipId: path.leaf?.id ?? null,
                },
                presentations: [],
                forks: path
                  .materializeNodes()
                  .map((header) => forkForHeader(header, currentRef.current.headers)),
              },
              path,
            ),
          )
        },
        loadChat: async (chatId) => {
          countProjectionRead('chat')
          return envelope(
            fenceRef.current,
            testChat(
              chatId,
              currentRef.current.structuralVersion,
              newestLeafId(currentRef.current.headers),
            ),
          )
        },
        loadForks: async (_chatId, structuralVersion, targets) => {
          countProjectionRead('forks')
          return envelope(fenceRef.current, {
            kind: 'ready' as const,
            structuralVersion,
            forks: targets.flatMap((target) => {
              const selected = currentRef.current.headers.find(
                (header) => header.id === target.selectedMessageId,
              )
              return selected ? [forkForHeader(selected, currentRef.current.headers)] : []
            }),
          })
        },
        loadChildAtPosition: async (_chatId, parentId, position) =>
          envelope(
            fenceRef.current,
            liveChildren(currentRef.current.headers, parentId)[position]?.id ?? null,
          ),
        loadTopology: async (chatId) => {
          countProjectionRead('topology')
          const headers = currentRef.current.headers.filter((header) => header.chatId === chatId)
          const structuralVersion = currentRef.current.structuralVersion
          return envelope(fenceRef.current, {
            kind: 'ready' as const,
            chat: testChat(chatId, structuralVersion, newestLeafId(currentRef.current.headers)),
            structuralVersion,
            headers,
          })
        },
        loadTranscriptPage: async () =>
          envelope(fenceRef.current, {
            kind: 'stale-selection' as const,
            material: Object.freeze([]),
          }),
        loadInspector: async (chatId, messageId, signal) => {
          countProjectionRead('inspector')
          const testRepository = currentRef.current.repository
          const snapshot = testRepository
            ? await testRepository.getMessagePresentationSnapshot(messageId, { signal })
            : undefined
          const header = currentRef.current.headers.find(
            (candidate) => candidate.id === messageId && candidate.chatId === chatId,
          )
          const presentation: ConversationMessagePresentation | null =
            snapshot && header
              ? {
                  header,
                  message: snapshot.message,
                  bodyVersion: snapshot.bodyVersion,
                }
              : null
          return envelope(fenceRef.current, presentation)
        },
        loadPreviews: async (_chatId, targets, signal) => {
          countProjectionRead('previews')
          const testRepository = currentRef.current.repository
          const previews = testRepository
            ? await testRepository.getMessageTextPreviewWindow(targets, {
                maxChars: TREE_PREVIEW_MAX_CHARS,
                signal,
              })
            : []
          return envelope(
            fenceRef.current,
            previews.filter((preview) => preview !== undefined),
          )
        },
      }
    }, [])
    useLayoutEffect(() => {
      controller.reconcileWorkspace(fenceRef.current)
      controller.setProjectionSource(source)
      const uninstallPresentationResources =
        controller.installPresentationResourcePort(presentationResources)
      controller.setNavigationPort(navigation)
      controller.requestPresentation({ chatId: props.chatId, surface: 'tree' })
      const acceptedLeaf = currentRef.current.acceptedPath.leaf
      navigation.arrive(props.chatId, acceptedLeaf === null ? undefined : acceptedLeaf.id)
      return () => {
        controller.setNavigationPort(null)
        uninstallPresentationResources()
        controller.setProjectionSource(null)
      }
    }, [controller, navigation, presentationResources, props.chatId, source])
    useLayoutEffect(() => {
      const workspaceKey = `${controllerSnapshot.workspaceId ?? ''}:${controllerSnapshot.workspaceEpoch}`
      if (deliveredWorkspaceRef.current !== workspaceKey) {
        deliveredWorkspaceRef.current = workspaceKey
        deliveredPresentationsRef.current.clear()
      }
      const active = controllerSnapshot.active
      if (
        active?.chatId !== props.chatId ||
        active.destination.kind !== 'ready' ||
        !active.topologyLoaded
      ) {
        return
      }

      const effects: ConversationCommittedEffect[] = []
      const structuralTransition =
        active.chat?.structuralVersion === currentRef.current.structuralVersion
          ? ({ kind: 'none' } as const)
          : ({
              kind: 'incomplete',
              toVersion: currentRef.current.structuralVersion,
              scope: true,
            } as const)
      const localIds = new Set(localPresentations?.keys() ?? [])
      if (localPresentations && localPresentations.size > 0) {
        const revisions = []
        for (const [messageId, snapshot] of localPresentations) {
          const nextHeader = requestedHeaderById.get(messageId)
          if (!nextHeader) continue
          const priorHeader = active.headerFacts.get(messageId)
          const priorPresentation = deliveredPresentationsRef.current.get(messageId)
          const headerChanged = !priorHeader || !sameMessageHeaderValue(nextHeader, priorHeader)
          const presentationChanged =
            !priorPresentation ||
            priorPresentation.bodyVersion !== snapshot.bodyVersion ||
            priorPresentation.message !== snapshot.message
          if (!headerChanged && !presentationChanged) continue
          deliveredPresentationsRef.current.set(messageId, snapshot)
          revisions.push({
            header: nextHeader,
            structuralVersion: currentRef.current.structuralVersion,
            presentation: { header: nextHeader, ...snapshot },
          })
        }
        if (revisions.length > 0) {
          effects.push({
            ...fenceRef.current,
            chatId: props.chatId,
            source: 'local',
            kind: 'changed',
            structural: structuralTransition,
            revisions,
          })
        }
      }
      const remoteRevisions = exactHeaders.flatMap((nextHeader) => {
        if (localIds.has(nextHeader.id)) return []
        const priorHeader = active.headerFacts.get(nextHeader.id)
        if (priorHeader && sameMessageHeaderValue(nextHeader, priorHeader)) return []
        return [
          {
            header: nextHeader,
            structuralVersion: currentRef.current.structuralVersion,
          },
        ]
      })
      if (remoteRevisions.length > 0) {
        effects.push({
          ...fenceRef.current,
          chatId: props.chatId,
          source: 'remote',
          kind: 'changed',
          structural: structuralTransition,
          revisions: remoteRevisions,
        })
      }
      if (effects.length > 0) controller.applyCommittedEffects(effects)
    }, [
      controller,
      controllerSnapshot,
      exactHeaders,
      localPresentations,
      props.chatId,
      requestedHeaderById,
    ])
    useLayoutEffect(
      () =>
        subscribeWorkspaceChanges((event) => {
          if (event.kind !== 'replace') return
          fenceRef.current = {
            workspaceId: event.workspaceId,
            replacementEpoch: event.replacementEpoch,
          }
          controller.reconcileWorkspace(fenceRef.current)
          controller.requestPresentation({ chatId: props.chatId, surface: 'tree' })
          const acceptedLeaf = currentRef.current.acceptedPath.leaf
          navigation.arrive(props.chatId, acceptedLeaf === null ? undefined : acceptedLeaf.id)
        }),
      [controller, navigation, props.chatId],
    )
    const requestedHeaderLookup = useMemo(
      () => new Map(exactHeaders.map((requested) => [requested.id, requested] as const)),
      [exactHeaders],
    )
    const headerDeliveryRef = useRef<{
      headers: ReadonlyMap<MessageId, MessageHeaderRow>
      revision: number
      changedKeys: readonly MessageId[]
    }>({
      headers: requestedHeaderLookup,
      revision: 1,
      changedKeys: exactHeaders.map((header) => header.id),
    })
    const priorHeaderDelivery = headerDeliveryRef.current
    const changedHeaderKeys = exactHeaders
      .filter((header) => {
        const prior = priorHeaderDelivery.headers.get(header.id)
        return !prior || !sameMessageHeaderValue(prior, header)
      })
      .map((header) => header.id)
    for (const priorId of priorHeaderDelivery.headers.keys()) {
      if (!requestedHeaderLookup.has(priorId)) changedHeaderKeys.push(priorId)
    }
    if (changedHeaderKeys.length > 0) {
      headerDeliveryRef.current = {
        headers: requestedHeaderLookup,
        revision: priorHeaderDelivery.revision + 1,
        changedKeys: changedHeaderKeys,
      }
    }
    const headerDelivery = headerDeliveryRef.current
    const fallbackSpine = useMemo(
      () =>
        createActiveBranchSpineFromPath({
          chatId: props.chatId,
          structuralVersion: topologyVersionRef.current.version,
          resolvedLeafId: acceptedPath.leaf?.id ?? null,
          path: acceptedPath,
        }),
      [acceptedPath, props.chatId],
    )
    const controllerInspector = controllerSnapshot.active?.inspector
    const locallyPresentedInspector = (() => {
      const inspectedId =
        controllerInspector?.exact?.message.id ?? controllerInspector?.retained?.message.id
      const local = inspectedId ? localPresentations?.get(inspectedId) : undefined
      const header = inspectedId ? headerDelivery.headers.get(inspectedId) : undefined
      return local && header ? { header, ...local } : null
    })()
    const inspectorRef = useRef<ConversationTreeSurface['inspector'] | null>(null)
    const nextInspector = {
      exact: locallyPresentedInspector ?? controllerInspector?.exact ?? null,
      retained: locallyPresentedInspector === null ? (controllerInspector?.retained ?? null) : null,
      resolving: controllerInspector?.resolving ?? false,
    }
    const priorInspector = inspectorRef.current
    const inspector =
      priorInspector &&
      priorInspector.exact === nextInspector.exact &&
      priorInspector.retained === nextInspector.retained &&
      priorInspector.resolving === nextInspector.resolving
        ? priorInspector
        : Object.freeze(nextInspector)
    inspectorRef.current = inspector
    const previews = controllerSnapshot.active?.previews ?? EMPTY_TREE_PREVIEWS
    const workspaceId = fenceRef.current.workspaceId
    const replacementEpoch = fenceRef.current.replacementEpoch
    const seal = useMemo<ConversationTreeSurface['seal']>(
      () =>
        Object.freeze({
          workspaceId,
          replacementEpoch,
          chatId: props.chatId,
          selectionRevision,
          structuralVersion: topologyVersionRef.current.version,
          leafId: acceptedPath.leaf?.id ?? null,
        }),
      [acceptedPath, props.chatId, replacementEpoch, selectionRevision, workspaceId],
    )
    const binding = useMemo<ConversationTreeSurface>(() => {
      const payload = Object.freeze({
        surface: 'tree',
        seal,
        spine: fallbackSpine,
        headers: headerDelivery.headers,
        topology: projection,
        headerChangeRevision: headerDelivery.revision,
        changedHeaderKeys: headerDelivery.changedKeys,
        inspector,
        previews,
      } as const)
      return bindingCurrency === 'current'
        ? Object.freeze({ ...payload, currency: 'current' as const, reveal: null })
        : Object.freeze({ ...payload, currency: 'retained' as const, reveal: null })
    }, [fallbackSpine, headerDelivery, inspector, previews, projection, seal, bindingCurrency])
    const observedAttempts = useAttemptExecutionsForChat(props.chatId)
    const attempts = useMemo(
      () =>
        observedAttempts.filter(
          (attempt) =>
            attempt.workspaceId === binding.seal.workspaceId &&
            attempt.replacementEpoch === binding.seal.replacementEpoch &&
            binding.topology.byId.has(attempt.messageId),
        ),
      [binding, observedAttempts],
    )
    return (
      <BranchTreeViewComponent
        {...viewProps}
        binding={binding}
        attempts={attempts}
        viewportActive={viewportActive}
        conversationController={controller}
        generationCapabilityFrame={generationCapabilityFrame}
      />
    )
  },
  {
    __setComputationProbeForTests: observeBranchTreeComputations,
  },
)

function header(
  id: string,
  parentId: string | null,
  siblingIndex: number,
  role: MessageRole,
  createdAt = siblingIndex,
): MessageHeaderRow {
  return {
    id,
    chatId: 'chat-1',
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: createdAt,
    createdAt,
    role,
    origin: role === 'user' ? 'user' : 'generated',
    requestContextVersion: 1,
    bodyVersion: 1,
    bodyWordCount: 2,
    bodyTextCharCount: 8,
    bodyMediaCount: 0,
    bodyRenderCost: 1,
    contextRouteFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
    nodeVersion: 1,
    deleted: false,
    ...messageTreeIndexFields({ parentId, deleted: false }),
  }
}

type TestMessageReader = (
  messageId: MessageId,
  options?: { signal?: AbortSignal },
) => Promise<Message | undefined>

type TestRepositoryOverrides = Partial<BranchTreeRepository> & {
  getMessage?: TestMessageReader
  getMessagePresentationSnapshot?: TestBranchTreeRepository['getMessagePresentationSnapshot']
  getMessageTextPreview?: TestBranchTreeRepository['getMessageTextPreview']
  getMessageTextPreviewWindow?: TestBranchTreeRepository['getMessageTextPreviewWindow']
}

interface TestBranchTreeRepository extends BranchTreeRepository {
  getMessagePresentationSnapshot(
    messageId: MessageId,
    options?: { signal?: AbortSignal },
  ): Promise<{ message: Message; bodyVersion: number } | undefined>
  getMessageTextPreview(
    messageId: MessageId,
    options?: { maxChars?: number; signal?: AbortSignal },
  ): Promise<string | undefined>
  getMessageTextPreviewWindow(
    targets: readonly { messageId: MessageId; bodyVersion: number }[],
    options?: { maxChars?: number; signal?: AbortSignal },
  ): Promise<Array<{ messageId: MessageId; bodyVersion: number; text: string } | undefined>>
  searchChatMessageText(
    chatId: string,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly MessageId[]>
}

class TestNavigationPort implements ConversationNavigationPort {
  private arrival: ConversationRouteArrival = Object.freeze({ id: 'arrival-0', route: null })
  private readonly listeners = new Set<() => void>()
  private serial = 0

  getArrival = () => this.arrival

  subscribeArrival = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  replaceConversationUrl = () => undefined

  arrive(chatId: string, targetMessageId?: MessageId) {
    this.arrival = Object.freeze({
      id: `arrival-${++this.serial}`,
      route: { chatId, ...(targetMessageId ? { targetMessageId } : {}) },
    })
    for (const listener of this.listeners) listener()
  }
}

function repository(overrides: TestRepositoryOverrides = {}): TestBranchTreeRepository {
  const {
    getMessage,
    getMessagePresentationSnapshot: presentationOverride,
    getMessageTextPreview: previewOverride,
    getMessageTextPreviewWindow: previewWindowOverride,
    searchChatMessageText: searchOverride,
    evaluateMessageTexts: evaluateOverride,
  } = overrides
  const getMessageTextPreview =
    previewOverride ?? vi.fn(async (messageId: string) => `Preview ${messageId}`)
  const getMessageTextPreviewWindow =
    previewWindowOverride ??
    vi.fn(
      async (
        targets: readonly { messageId: MessageId; bodyVersion: number }[],
        options?: { maxChars?: number; signal?: AbortSignal },
      ) =>
        Promise.all(
          targets.map(async (target) => {
            const text = await getMessageTextPreview(target.messageId, options)
            return text === undefined
              ? undefined
              : {
                  messageId: target.messageId,
                  bodyVersion: target.bodyVersion,
                  text: text.slice(0, options?.maxChars ?? TREE_PREVIEW_MAX_CHARS),
                }
          }),
        ),
    )
  const result: TestBranchTreeRepository = {
    getMessagePresentationSnapshot:
      presentationOverride ??
      vi.fn(async (messageId: MessageId, options?: { signal?: AbortSignal }) => {
        const message = getMessage
          ? await getMessage(messageId, options)
          : fullMessageFor(messageId)
        const bodyVersion = (message as (Message & { bodyVersion?: number }) | undefined)
          ?.bodyVersion
        return message ? { message, bodyVersion: bodyVersion ?? 1 } : undefined
      }),
    getMessageTextPreview,
    getMessageTextPreviewWindow,
    searchChatMessageText: searchOverride ?? vi.fn(async () => []),
    evaluateMessageTexts:
      evaluateOverride ??
      vi.fn(async (_chatId: string, messageIds: readonly MessageId[]) =>
        messageIds.map((messageId) => ({
          messageId,
          nodeVersion: 1,
          bodyVersion: 1,
          present: true,
          pending: false,
          matches: false,
        })),
      ),
  }
  return result
}

function envelope<T>(fence: WorkspaceFence, value: T) {
  return { ...fence, value }
}

function liveChildren(
  headers: readonly MessageHeaderRow[],
  parentId: MessageId | null,
): MessageHeaderRow[] {
  return headers
    .filter((header) => !header.deleted && header.parentId === parentId)
    .sort((left, right) => left.siblingIndex - right.siblingIndex)
}

function forkForHeader(
  header: MessageHeaderRow,
  headers: readonly MessageHeaderRow[],
): ActiveBranchForkSlot {
  const siblings = liveChildren(headers, header.parentId)
  const position = siblings.findIndex((candidate) => candidate.id === header.id)
  if (position < 0) throw new Error(`MissingSelectedSibling:${header.id}`)
  return Object.freeze({
    parentId: header.parentId,
    selectedMessageId: header.id,
    slotVersion: siblings.reduce((sum, sibling) => sum + sibling.nodeVersion + 1, 0),
    position,
    liveCount: siblings.length,
    previousMessageId: siblings[position - 1]?.id ?? null,
    nextMessageId: siblings[position + 1]?.id ?? null,
    firstMessageId: siblings[0]?.id as MessageId,
    lastMessageId: siblings.at(-1)?.id as MessageId,
  })
}

const smallTree = [
  header('root', null, 0, 'user', 1),
  header('left', 'root', 0, 'assistant', 2),
  header('right', 'root', 1, 'assistant', 3),
]

beforeEach(() => {
  window.sessionStorage.clear()
  useToastStore.getState().reset()
  testWorkspaceFence = resetAttemptControllerForTests()
  reconcileWorkspaceTabSessionStorage(testWorkspaceFence)
  resetMountedRepositoryProjectionsForTests()
  attachMountedRepositoryProjections(testWorkspaceFence)
  attachmentCatalogState.workspaceFence = testWorkspaceFence
  attachmentCatalogState.rowsById = new Map([
    [
      'attachment-action',
      {
        id: 'attachment-action',
        kind: 'plaintext',
        mime: 'text/plain',
        filename: 'action.txt',
        sizeBytes: 7,
        origin: 'user-upload',
        createdAt: 1,
        updatedAt: 1,
        storage: { kind: 'remote-url', url: 'https://example.test/action.txt' },
        refCount: 1,
        messageRefCount: 1,
        draftRefCount: 0,
        visibleRefCount: 1,
        hiddenRefCount: 0,
        missingVisibleRefCount: 0,
        lastUsedAt: 1,
        processing: [],
      },
    ],
  ])
})

afterEach(() => {
  cleanup()
  useToastStore.getState().reset()
  resetAttemptControllerForTests()
  resetMountedRepositoryProjectionsForTests()
  BranchTreeView.__setComputationProbeForTests(undefined)
  observeBranchTreeInspectorComputations(undefined)
})

function fullMessageFor(messageId: string): Message | undefined {
  const row = smallTree.find((header) => header.id === messageId)
  return row ? { ...row, content: [{ type: 'text', text: `Full ${messageId}` }] } : undefined
}

async function waitForActiveTree(): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole('region', { name: 'Chat tree' })).not.toHaveAttribute(
      'aria-busy',
      'true',
    ),
  )
}

function streamingGeneration(): NonNullable<Message['generation']> {
  return {
    id: 'generation-streaming',
    model: 'vendor/tree-model',
    requestedModel: 'vendor/tree-model',
    apiUsed: 'chat',
    delivery: 'streaming',
    status: 'streaming',
    costSource: 'stream',
    startedAt: 4,
    reasoningCarryForward: 'none',
    reasoningVisibility: { disclosure: 'unknown' },
  }
}

function actionMessage(): Message {
  return {
    ...(fullMessageFor('right') as Message),
    attachmentRefs: [
      {
        refId: 'attachment-ref-action',
        attachmentId: 'attachment-action',
        includeInContext: true,
        presentation: { label: 'action.txt' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.text',
          text: 'Action settlement reasoning.',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    ),
    providerOutputItems: [
      {
        dialect: 'openai-responses',
        type: 'web_search_call',
        outputIndex: 0,
        item: {
          type: 'web_search_call',
          id: 'action-search',
          status: 'completed',
          action: { type: 'search', query: 'owner settlement' },
        },
      },
    ],
  }
}

const rejectedTreeActionCases = [
  { kind: 'activate', label: 'Open branch' },
  { kind: 'delete', label: 'Delete message' },
  { kind: 'fork', label: 'Fork chat' },
  { kind: 'toggle', label: 'Context visibility update' },
  { kind: 'attachment', label: 'Attachment update' },
  { kind: 'reasoning-visibility', label: 'Reasoning visibility update' },
  { kind: 'tool-visibility', label: 'Tool visibility update' },
  { kind: 'insert', label: 'Insert message' },
] as const

describe('BranchTreeView', () => {
  it('keeps bodies cold in compact mode and uses one shared hover preview', async () => {
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Preview ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    expect(getMessageTextPreview).not.toHaveBeenCalled()
    await waitForActiveTree()
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(
        'Preview root',
      ),
    )
    expect(getMessageTextPreview).toHaveBeenCalledTimes(1)

    const firstAssistant = screen.getAllByRole('link', { name: 'Assistant message' }).at(0)
    expect(firstAssistant).toBeDefined()
    if (!firstAssistant) throw new Error('Missing assistant node')
    fireEvent.pointerEnter(firstAssistant)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(
        /^Assistant/,
      ),
    )
    expect(document.querySelectorAll('[data-ui="branch-tree-preview"]')).toHaveLength(1)
  })

  it('cancels superseded compact preview batches and rejects version-stale results', async () => {
    const reads: Array<{
      messageId: string
      resolve: (text: string) => void
      signal: AbortSignal | undefined
    }> = []
    const getMessageTextPreview = vi.fn(
      (messageId: string, options?: { maxChars?: number; signal?: AbortSignal }) =>
        new Promise<string>((resolve) => {
          reads.push({
            messageId,
            signal: options?.signal,
            resolve,
          })
        }),
    )
    const treeRepository = repository({ getMessageTextPreview })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitForActiveTree()
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'Assistant message' }))
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))

    await waitFor(() => expect(getMessageTextPreview.mock.calls.length).toBeGreaterThanOrEqual(3))
    const currentRead = reads.at(-1)
    expect(currentRead?.messageId).toBe('root')
    for (const read of reads.slice(0, -1)) expect(read.signal?.aborted).toBe(true)

    await act(async () => {
      for (const read of reads.slice(0, -1)) read.resolve('Superseded preview')
      await Promise.resolve()
    })
    expect(document.querySelector('[data-ui="branch-tree-preview"]')).not.toHaveTextContent(
      'Superseded preview',
    )

    const updatedHeaders = smallTree.map((row) =>
      row.id === 'root' ? { ...row, bodyVersion: row.bodyVersion + 1 } : row,
    )
    const staleReadCount = reads.length
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={updatedHeaders}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    await waitFor(() => expect(currentRead?.signal?.aborted).toBe(true))
    await waitFor(() => expect(reads.length).toBeGreaterThan(staleReadCount))
    const freshRead = reads.at(-1)
    expect(freshRead?.messageId).toBe('root')
    await act(async () => {
      currentRead?.resolve('Stale root preview')
      await Promise.resolve()
    })
    expect(document.querySelector('[data-ui="branch-tree-preview"]')).not.toHaveTextContent(
      'Stale root preview',
    )

    await act(async () => {
      freshRead?.resolve('Current root preview')
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(
        'Current root preview',
      ),
    )
  })

  it('publishes completed expanded previews back into visible cards', async () => {
    let renderCount = 0
    BranchTreeView.__setComputationProbeForTests((operation) => {
      if (operation === 'render') renderCount += 1
    })
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Loaded ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalledTimes(3))
    expect(renderCount).toBeGreaterThan(1)
    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Loaded left'),
    )
  })

  it('updates one exact snapshot preview without reloading unaffected expanded previews', async () => {
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Loaded ${messageId}`)
    const treeRepository = repository({ getMessageTextPreview })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Loaded left'),
    )

    const nextHeaders = smallTree.map((row) =>
      row.id === 'left' ? { ...row, bodyVersion: row.bodyVersion + 1 } : row,
    )
    const left = fullMessageFor('left') as Message
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={nextHeaders}
        cursor={{ root: 'left' }}
        expanded
        repository={treeRepository}
        localPresentations={
          new Map([
            [
              'left',
              {
                bodyVersion: 2,
                message: {
                  ...left,
                  content: [{ type: 'output_text', text: 'Committed snapshot left' }],
                },
              },
            ],
          ])
        }
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Committed snapshot left'),
    )
    expect(
      document.querySelector('[data-message-id="root"] [data-ui="branch-tree-node-preview"]'),
    ).toHaveTextContent('Loaded root')
    expect(
      document.querySelector('[data-message-id="right"] [data-ui="branch-tree-node-preview"]'),
    ).toHaveTextContent('Loaded right')
    expect(getMessageTextPreview.mock.calls.filter(([id]) => id === 'root')).toHaveLength(1)
    expect(getMessageTextPreview.mock.calls.filter(([id]) => id === 'right')).toHaveLength(1)
  })

  it('keeps an inspected off-path disclosure mounted across an exact body-version update', async () => {
    const initialRight = {
      ...(fullMessageFor('right') as Message),
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [
          {
            type: 'reasoning.text',
            text: 'Off-path reasoning.',
            format: 'anthropic-claude-v1',
          },
        ],
        'anthropic-messages',
      ),
    } satisfies Message
    const getMessage = vi.fn(async (messageId: MessageId) =>
      messageId === 'right' ? initialRight : fullMessageFor(messageId),
    )
    const treeRepository = repository({ getMessage })
    const testController = createConversationController()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        testController={testController}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
    )
    const inspector = document.querySelector('[data-ui="branch-tree-inspector"]')
    const reasoning = document.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    if (!reasoning) throw new Error('Reasoning disclosure missing')
    fireEvent.click(reasoning.querySelector('summary') as HTMLElement)
    await waitFor(() => expect(reasoning).toHaveAttribute('data-pinned', 'true'))

    const updatedHeaders = smallTree.map((row) =>
      row.id === 'right' ? { ...row, nodeVersion: 2, bodyVersion: 2 } : row,
    )
    const updatedHeader = updatedHeaders.find((row) => row.id === 'right') as MessageHeaderRow
    const reasoningEnvelope = initialRight.reasoningEnvelope
    const updatedMessage: Message = {
      ...initialRight,
      nodeVersion: 2,
      reasoningEnvelope: {
        ...reasoningEnvelope,
        visible: reasoningEnvelope.visible.map((part) => ({ ...part, hidden: true })),
      },
    }
    const localPresentations = new Map([
      [
        'right',
        {
          bodyVersion: 2,
          message: updatedMessage,
        },
      ],
    ])
    act(() => {
      view.rerender(
        <BranchTreeView
          chatId="chat-1"
          headers={updatedHeaders}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={treeRepository}
          testController={testController}
          localPresentations={localPresentations}
          onActivateNode={() => undefined}
        />,
      )
    })

    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBe(inspector)
    const updatedReasoning = document.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
    expect(updatedReasoning).toBe(reasoning)
    expect(updatedReasoning?.open).toBe(true)
    expect(updatedReasoning).toHaveAttribute('data-pinned', 'true')
    expect(updatedHeader.bodyVersion).toBe(2)
    expect(getMessage).toHaveBeenCalledTimes(1)
  })

  it('does not reuse wrapped previews across repository identities', async () => {
    const first = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview: async (id) => `First ${id}` })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('First left'),
    )
    first.unmount()

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview: async (id) => `Second ${id}` })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('Second left'),
    )
  })

  it('keeps inspection distinct from branch activation while preserving real deep links', async () => {
    const activate = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )

    const root = screen.getByRole('link', { name: 'User message' })
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 137
    canvas.scrollTop = 91
    expect(root).toHaveAttribute('href', '#/chat/chat-1/message/right')
    expect(fireEvent.click(root, { metaKey: true })).toBe(true)
    expect(
      fireEvent(root, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })),
    ).toBe(true)
    expect(activate).not.toHaveBeenCalled()
    expect(root).not.toHaveAttribute('data-selected')
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
    fireEvent.click(root)
    expect(canvas.scrollLeft).toBe(137)
    expect(canvas.scrollTop).toBe(91)
    expect(activate).not.toHaveBeenCalled()
    expect(root).toHaveAttribute('data-selected', 'true')
    expect(root).not.toHaveAttribute('data-current-leaf')
    const activeLeaf = document.querySelector('[data-message-id="left"]')
    expect(activeLeaf).toHaveAttribute('data-current-leaf', 'true')
    expect(activeLeaf).not.toHaveAttribute('data-selected')
    await waitFor(
      () => expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
      { timeout: 5_000 },
    )
    fireEvent.doubleClick(root)
    expect(activate).toHaveBeenCalledWith('root', 'right')

    fireEvent.click(document.querySelector('[data-ui="branch-tree-scroll"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument(),
    )
  })

  it('marks context-hidden nodes without hydrating their bodies', async () => {
    const getMessage = vi.fn(async (messageId: string) => fullMessageFor(messageId))
    const treeRepository = repository({ getMessage })
    const hiddenHeaders = smallTree.map((row) =>
      row.id === 'root' ? { ...row, hiddenFromContext: true, nodeVersion: 2 } : row,
    )
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={hiddenHeaders}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitForActiveTree()
    const hiddenNode = screen.getByRole('link', {
      name: 'User message, hidden from context',
    })
    expect(hiddenNode).toHaveAttribute('data-hidden-from-context', 'true')
    expect(hiddenNode.querySelector('[data-ui="branch-tree-node-visibility"]')).toBeInTheDocument()
    expect(getMessage).not.toHaveBeenCalled()

    const visibleHeaders = hiddenHeaders.map((row) =>
      row.id === 'root' ? { ...row, hiddenFromContext: false, nodeVersion: 3 } : row,
    )
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={visibleHeaders}
        cursor={{ root: 'left' }}
        expanded
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitForActiveTree()
    const visibleNode = document.querySelector('[data-message-id="root"]') as Element
    expect(visibleNode).toBeInTheDocument()
    expect(visibleNode).not.toHaveAttribute('data-hidden-from-context')
    expect(
      visibleNode.querySelector('[data-ui="branch-tree-node-visibility"]'),
    ).not.toBeInTheDocument()
    expect(getMessage).not.toHaveBeenCalled()
  })

  it('follows a request-created active leaf into the inspector', async () => {
    const onSelectNode = vi.fn()
    const regenerate = vi.fn(() => startedGenerationResult('regenerated'))
    let headers = smallTree
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((header) => header.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Full ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
        onRegenerateMessage={regenerate}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate response' }))
    expect(regenerate).toHaveBeenCalledOnce()
    onSelectNode.mockClear()

    act(() => {
      observeTestAttempt({
        streamId: 'remote-tree-request',
        chatId: 'chat-1',
        messageId: 'left',
        local: false,
      })
    })
    await act(async () => Promise.resolve())
    expect(onSelectNode).not.toHaveBeenCalled()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'left',
    )

    headers = [...smallTree, header('regenerated', 'root', 2, 'assistant', 4)]
    act(() => {
      observeTestAttempt({
        streamId: 'new-tree-request',
        chatId: 'chat-1',
        messageId: 'regenerated',
      })
    })
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'regenerated' }}
        selectedNodeId="regenerated"
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
        onRegenerateMessage={regenerate}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="regenerated"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'regenerated',
      ),
    )
  })

  it('opens the current streaming leaf when tree view mounts mid-response', async () => {
    const getMessage = vi.fn(async (messageId: MessageId) => {
      const message = fullMessageFor(messageId)
      return messageId === 'left' && message ? { ...message, content: [] } : message
    })
    act(() => {
      observeTestAttempt({
        streamId: 'already-streaming',
        chatId: 'chat-1',
        messageId: 'left',
      })
    })

    render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={smallTree}
          cursor={{ root: 'left' }}
          selectedNodeId="left"
          expanded={false}
          repository={repository({ getMessage })}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'left',
      ),
    )
    act(() => {
      expect(
        publishTestLiveProjection({
          streamId: 'already-streaming',
          chatId: 'chat-1',
          messageId: 'left',
          content: [{ type: 'output_text', text: 'Already streaming in transcript mode.' }],
          textLength: 37,
          reasoningLength: 0,
          updatedAt: 5,
        }),
      ).toBe(true)
    })
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
      'Already streaming in transcript mode.',
    )
  })

  it('follows a selected stream once its target header becomes available', async () => {
    let headers = smallTree
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Full ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    act(() => {
      observeTestAttempt({
        streamId: 'waiting-for-target',
        chatId: 'chat-1',
        messageId: 'stream-leaf',
      })
    })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        selectedNodeId="stream-leaf"
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    headers = [...smallTree, header('stream-leaf', 'root', 2, 'assistant', 5)]
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'stream-leaf' }}
        selectedNodeId="stream-leaf"
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="stream-leaf"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'stream-leaf',
      ),
    )
    act(() => {
      expect(removeTestAttempt('waiting-for-target')).toBe(true)
    })
  })

  it('follows an existing stream that hydrates after the initial empty render', async () => {
    let headers: MessageHeaderRow[] = []
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: `Hydrated ${messageId}` }] }
        : undefined
    })
    const treeRepository = repository({ getMessage })
    const view = render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{}}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    act(() => {
      observeTestAttempt({
        streamId: 'late-hydrated-stream',
        chatId: 'chat-1',
        messageId: 'hydrated-leaf',
        local: false,
      })
    })
    headers = [
      header('hydrated-root', null, 0, 'user', 1),
      {
        ...header('hydrated-leaf', 'hydrated-root', 0, 'assistant', 2),
        generation: streamingGeneration(),
      },
    ]
    view.rerender(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ 'hydrated-root': 'hydrated-leaf' }}
          selectedNodeId="hydrated-leaf"
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="hydrated-leaf"]')).toHaveAttribute(
        'data-selected',
        'true',
      ),
    )
    await waitFor(() => expect(getMessage).toHaveBeenCalledWith('hydrated-leaf', expect.anything()))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'hydrated-leaf',
      ),
    )
  })

  it('does not steal focus for a stream that starts after opening an idle tree', async () => {
    let headers: MessageHeaderRow[] = smallTree
    const treeRepository = repository({
      getMessagePresentationSnapshot: vi.fn(async (messageId: string) => {
        const row = headers.find((candidate) => candidate.id === messageId)
        return row
          ? {
              message: {
                ...row,
                content: [{ type: 'text' as const, text: `Full ${messageId}` }],
              },
              bodyVersion: row.bodyVersion,
            }
          : undefined
      }),
    })
    const view = render(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()

    const startedAfterTreeOpened = Date.now() + 60_000
    act(() => {
      observeTestAttempt({
        streamId: 'future-stream',
        chatId: 'chat-1',
        messageId: 'left',
        local: false,
        admissionSequence: startedAfterTreeOpened,
      })
    })
    headers = headers.map((row) =>
      row.id === 'left'
        ? {
            ...row,
            generation: { ...streamingGeneration(), startedAt: startedAfterTreeOpened },
          }
        : row,
    )
    view.rerender(
      <StrictMode>
        <BranchTreeView
          chatId="chat-1"
          headers={headers}
          cursor={{ root: 'left' }}
          expanded={false}
          repository={treeRepository}
          onActivateNode={() => undefined}
        />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-streaming',
        'true',
      ),
    )
    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
  })

  it('ignores off-path and other-chat streams when choosing an initial inspector target', async () => {
    const requestStop = vi.fn()
    act(() => {
      observeTestAttempt({
        streamId: 'off-path',
        chatId: 'chat-1',
        messageId: 'right',
      })
      observeTestAttempt({
        streamId: 'other-chat',
        chatId: 'chat-elsewhere',
        messageId: 'left',
        local: false,
      })
    })

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onRequestStop={requestStop}
      />,
    )
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument()
    expect(requestStop).not.toHaveBeenCalled()
  })

  it('shows Stop after switching onto a streaming branch and aborts only that stream', async () => {
    const requestStop = vi.fn()
    act(() => {
      observeTestAttempt({
        streamId: 'right-stream',
        chatId: 'chat-1',
        messageId: 'right',
      })
    })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onRequestStop={requestStop}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument()
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'right' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onRequestStop={requestStop}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Stop generating' }))
    expect(requestStop).toHaveBeenCalledOnce()
    expect(requestStop.mock.calls[0]?.[0]).toMatchObject({
      kind: 'requestable',
      attempt: { streamId: 'right-stream' },
    })
  })

  it('chooses the inspected stream before the active-leaf stream', async () => {
    const requestStop = vi.fn()
    act(() => {
      observeTestAttempt({
        streamId: 'left-stream',
        chatId: 'chat-1',
        messageId: 'left',
      })
      observeTestAttempt({
        streamId: 'right-stream',
        chatId: 'chat-1',
        messageId: 'right',
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onRequestStop={requestStop}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(requestStop.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'requestable',
      attempt: { streamId: 'left-stream' },
    })

    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'right',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))
    expect(requestStop.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'requestable',
      attempt: { streamId: 'right-stream' },
    })
  })

  it('does not block inspector requests for an uninspected off-path stream', async () => {
    act(() => {
      observeTestAttempt({
        streamId: 'off-path-request',
        chatId: 'chat-1',
        messageId: 'right',
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onRegenerateMessage={() => startedGenerationResult()}
        onContinueMessage={() => startedGenerationResult()}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    expect(await screen.findByRole('button', { name: 'Regenerate response' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument()
  })

  it('inspects an off-path stream without activating its branch', async () => {
    const activate = vi.fn()
    act(() => {
      observeTestAttempt({
        streamId: 'inspect-off-path',
        chatId: 'chat-1',
        messageId: 'right',
      })
    })

    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)

    expect(document.querySelector('[data-message-id="right"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-current-leaf',
      'true',
    )
    expect(activate).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'right',
      ),
    )
    expect(
      document.querySelector('[data-ui="branch-tree-inspector-stream-status"]'),
    ).toHaveTextContent('Streaming on another branch. Open this branch to follow live output.')
    fireEvent.click(screen.getByRole('button', { name: 'Open this branch' }))
    expect(activate).toHaveBeenCalledOnce()
    expect(activate).toHaveBeenCalledWith('right', 'right')
  })

  it('does not let a late stream target replace an explicit manual selection', async () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'root',
      ),
    )

    act(() => {
      observeTestAttempt({
        streamId: 'late-manual-target',
        chatId: 'chat-1',
        messageId: 'left',
      })
    })
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-message-id="root"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )
  })

  it('keeps an explicitly closed streaming inspector closed', async () => {
    act(() => {
      observeTestAttempt({
        streamId: 'closed-stream',
        chatId: 'chat-1',
        messageId: 'left',
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    fireEvent.click(await screen.findByRole('button', { name: 'Close message inspector' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument(),
    )

    act(() => {
      observeTestAttempt({
        streamId: 'closed-stream',
        chatId: 'chat-1',
        messageId: 'left',
        revision: 2,
      })
    })
    await act(async () => Promise.resolve())

    expect(document.querySelector('[data-selected="true"]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument()
  })

  it('does not cache an empty preview while its message is streaming', async () => {
    let committed = false
    const getMessageTextPreview = vi.fn(async (messageId: string) => {
      if (messageId === 'left') return committed ? 'Committed streaming output' : ''
      return `Preview ${messageId}`
    })
    act(() => {
      observeTestAttempt({
        streamId: 'empty-preview-stream',
        chatId: 'chat-1',
        messageId: 'left',
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    const leftPreview = () =>
      document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]')
    await waitFor(() => expect(leftPreview()).not.toHaveTextContent('Loading preview…'))
    expect(leftPreview()).not.toHaveTextContent('No text content')
    const callsWhileStreaming = getMessageTextPreview.mock.calls.filter(
      ([messageId]) => messageId === 'left',
    ).length

    committed = true
    await act(() => removeTestAttempt('empty-preview-stream'))

    await waitFor(() =>
      expect(
        getMessageTextPreview.mock.calls.filter(([messageId]) => messageId === 'left'),
      ).toHaveLength(callsWhileStreaming + 1),
    )
    await waitFor(() => expect(leftPreview()).toHaveTextContent('Committed streaming output'))
  })

  it('bounds retained preview text even if a repository violates the preview-length contract', async () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessageTextPreview: async () => 'x'.repeat(10_000) })}
        onActivateNode={() => undefined}
      />,
    )

    await waitForActiveTree()
    fireEvent.pointerEnter(screen.getByRole('link', { name: 'User message' }))
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-preview"]')).toHaveTextContent(/…$/),
    )
    const tooltip = document.querySelector('[data-ui="branch-tree-preview"]')
    if (!tooltip) throw new Error('Missing preview')
    expect(tooltip.textContent.length).toBeLessThan(1_000)
  })

  it('sorts search hits by depth and horizontal position and cycles in both directions', async () => {
    const searchChatMessageText = vi.fn<BranchTreeRepository['searchChatMessageText']>(async () => [
      'right',
      'left',
      'root',
    ])
    const treeRepository = repository({ searchChatMessageText })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    const input = screen.getByRole('searchbox', { name: 'Search messages in this chat' })
    fireEvent.change(input, { target: { value: '  preview  ' } })
    expect(screen.getByText('Searching…')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeInTheDocument())
    const searchCall = searchChatMessageText.mock.calls.at(0)
    expect(searchCall?.[0]).toBe('chat-1')
    expect(searchCall?.[1]).toBe('preview')
    expect(searchCall?.[2]?.signal).toBeInstanceOf(AbortSignal)
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )
    expect(document.querySelector('[data-message-id="root"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector-slot"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next matching message' }))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'left',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Previous matching message' }))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'root',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Next matching message' }))
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root'
            ? { ...row, bodyVersion: row.bodyVersion + 1, nodeVersion: row.nodeVersion + 1 }
            : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    await waitFor(() => expect(treeRepository.evaluateMessageTexts).toHaveBeenCalledTimes(1))
    expect(searchChatMessageText).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'left',
    )
    expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
      'data-selected',
      'true',
    )

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(input).toHaveFocus()

    fireEvent.change(input, { target: { value: '   ' } })
    await waitFor(() => expect(screen.getByText('0 / 0')).toBeInTheDocument())
    expect(searchChatMessageText).toHaveBeenCalledTimes(1)
  })

  it('invalidates search from exact body deltas only after the stream is terminal', async () => {
    const retainedRoot = header('root', null, 0, 'user', 1)
    const streamingLeaf = {
      ...header('left', 'root', 0, 'assistant', 2),
      generation: streamingGeneration(),
    }
    const retainedHeaders = [retainedRoot, streamingLeaf]
    const searchChatMessageText = vi.fn<BranchTreeRepository['searchChatMessageText']>(
      async () => [],
    )
    const evaluateMessageTexts = vi.fn<BranchTreeRepository['evaluateMessageTexts']>(
      async (_chatId, messageIds) =>
        messageIds.map((messageId) => ({
          messageId,
          nodeVersion: 3,
          bodyVersion: 3,
          present: true,
          pending: false,
          matches: messageId === 'left',
        })),
    )
    let layoutBuilds = 0
    BranchTreeView.__setComputationProbeForTests((operation) => {
      if (operation === 'layout') layoutBuilds += 1
    })
    act(() => {
      observeTestAttempt({
        streamId: 'search-finalization-stream',
        chatId: 'chat-1',
        messageId: 'left',
        local: false,
      })
    })
    const treeRepository = repository({ searchChatMessageText, evaluateMessageTexts })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={retainedHeaders}
        latestHeaders={retainedHeaders}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search messages in this chat' }), {
      target: { value: 'final text' },
    })
    await waitFor(() => expect(searchChatMessageText).toHaveBeenCalledTimes(1))
    const baselineLayoutBuilds = layoutBuilds

    const streamedHeader = { ...streamingLeaf, bodyVersion: 2, nodeVersion: 2 }
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={retainedHeaders}
        latestHeaders={[retainedRoot, streamedHeader]}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    await act(async () => Promise.resolve())
    expect(searchChatMessageText).toHaveBeenCalledTimes(1)

    await act(() => removeTestAttempt('search-finalization-stream'))
    await act(async () => Promise.resolve())
    expect(searchChatMessageText).toHaveBeenCalledTimes(1)

    const finalHeader = {
      ...streamedHeader,
      bodyVersion: 3,
      nodeVersion: 3,
      generation: { ...streamingGeneration(), status: 'done' as const, finishedAt: 8 },
    }
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={retainedHeaders}
        latestHeaders={[retainedRoot, finalHeader]}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(evaluateMessageTexts).toHaveBeenCalledTimes(1))
    expect(searchChatMessageText).toHaveBeenCalledTimes(1)
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(layoutBuilds).toBe(baselineLayoutBuilds)
  })

  it('aborts superseded searches and ignores their late results', async () => {
    const pending = new Map<string, (ids: string[]) => void>()
    const signals = new Map<string, AbortSignal | undefined>()
    const searchChatMessageText = vi.fn<BranchTreeRepository['searchChatMessageText']>(
      async (_chatId, query, options) => {
        signals.set(query, options?.signal)
        return new Promise<string[]>((resolve) => pending.set(query, resolve))
      },
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ searchChatMessageText })}
        onActivateNode={() => undefined}
      />,
    )
    const input = screen.getByRole('searchbox', { name: 'Search messages in this chat' })
    fireEvent.change(input, { target: { value: 'first' } })
    await waitFor(() => expect(pending.has('first')).toBe(true))
    fireEvent.change(input, { target: { value: 'second' } })
    await waitFor(() => expect(pending.has('second')).toBe(true))
    expect(signals.get('first')?.aborted).toBe(true)

    await act(async () => pending.get('second')?.(['right']))
    await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
    await act(async () => pending.get('first')?.(['left']))
    expect(document.querySelector('[data-current-match="true"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
  })

  it('aborts rapid superseded inspector reads and publishes only the latest selection', async () => {
    const signals = new Map<string, AbortSignal | undefined>()
    const getMessage = vi.fn(async (messageId: string, options?: { signal?: AbortSignal }) => {
      signals.set(messageId, options?.signal)
      return messageId === 'right'
        ? fullMessageFor(messageId)
        : new Promise<Message | undefined>(() => undefined)
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() => expect(signals.has('root')).toBe(true))
    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    await waitFor(() => expect(signals.has('left')).toBe(true))
    expect(signals.get('root')?.aborted).toBe(true)
    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-message-id',
        'right',
      ),
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'right',
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Full right',
      ),
    )
    expect(signals.get('left')?.aborted).toBe(true)
    expect(signals.has('right')).toBe(true)
    expect(getMessage).toHaveBeenCalledTimes(3)
  })

  it('reloads previews and the inspector from a replaced workspace with reused row identities', async () => {
    let workspace: 'old' | 'new' = 'old'
    const pendingOldPreviews = new Map<string, (text: string | undefined) => void>()
    let resolveOldMessage: ((message: Message | undefined) => void) | undefined
    const getMessageTextPreview = vi.fn(async (messageId: string) =>
      workspace === 'old'
        ? new Promise<string | undefined>((resolve) => pendingOldPreviews.set(messageId, resolve))
        : `New preview ${messageId}`,
    )
    const getMessage = vi.fn(async (messageId: string) =>
      workspace === 'old'
        ? new Promise<Message | undefined>((resolve) => {
            resolveOldMessage = resolve
          })
        : {
            ...(fullMessageFor(messageId) as Message),
            content: [{ type: 'text' as const, text: `New body ${messageId}` }],
          },
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded
        repository={repository({ getMessage, getMessageTextPreview })}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalledTimes(3))
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() => expect(getMessage).toHaveBeenCalledTimes(1))

    workspace = 'new'
    act(() =>
      postWorkspaceChange({
        kind: 'replace',
        workspaceId: 'tree-test-workspace-replaced-1',
        replacementEpoch: 1,
      }),
    )

    await waitFor(() =>
      expect(
        document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
      ).toHaveTextContent('New preview left'),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'New body root',
      ),
    )

    await act(async () => {
      for (const [messageId, resolve] of pendingOldPreviews) resolve(`Old preview ${messageId}`)
      resolveOldMessage?.({
        ...(fullMessageFor('root') as Message),
        content: [{ type: 'text', text: 'Old body root' }],
      })
      await Promise.resolve()
    })

    expect(
      document.querySelector('[data-message-id="left"] [data-ui="branch-tree-node-preview"]'),
    ).toHaveTextContent('New preview left')
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
      'New body root',
    )
  })

  it('never paints a retained inspector body from a replaced workspace', async () => {
    let workspace: 'old' | 'new' = 'old'
    let resolveNewBody:
      | ((
          snapshot: Awaited<ReturnType<TestBranchTreeRepository['getMessagePresentationSnapshot']>>,
        ) => void)
      | undefined
    const getMessagePresentationSnapshot = vi.fn(async (messageId: MessageId) => {
      const base = fullMessageFor(messageId) as Message
      if (workspace === 'old') {
        return {
          bodyVersion: 1,
          message: { ...base, content: [{ type: 'text' as const, text: 'Old workspace body' }] },
        }
      }
      return new Promise<
        Awaited<ReturnType<TestBranchTreeRepository['getMessagePresentationSnapshot']>>
      >((resolve) => {
        resolveNewBody = resolve
      })
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessagePresentationSnapshot })}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Old workspace body',
      ),
    )
    act(() => {
      observeTestAttempt({
        streamId: 'old-workspace-stream',
        chatId: 'chat-1',
        messageId: 'left',
        local: false,
      })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-streaming',
        'true',
      ),
    )

    workspace = 'new'
    act(() =>
      postWorkspaceChange({
        kind: 'replace',
        workspaceId: 'tree-test-workspace-replaced-2',
        replacementEpoch: 2,
      }),
    )
    await waitFor(() => expect(getMessagePresentationSnapshot).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelector('[data-message-id="left"]')).not.toHaveAttribute(
        'data-streaming',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).not.toBeInTheDocument(),
    )
    expect(document.querySelector('[data-ui="branch-tree-inspector-status"]')).toHaveTextContent(
      'Loading message…',
    )

    await act(async () => {
      resolveNewBody?.({
        bodyVersion: 1,
        message: {
          ...(fullMessageFor('root') as Message),
          content: [{ type: 'text', text: 'New workspace body' }],
        },
      })
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'New workspace body',
      ),
    )
  })

  it('does not recenter a direct click when selection is parent-controlled', () => {
    const onSelectNode = vi.fn()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        selectedNodeId={null}
        repository={repository()}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 137
    canvas.scrollTop = 91
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    expect(onSelectNode).toHaveBeenCalledWith('root')

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        selectedNodeId="root"
        repository={repository()}
        onActivateNode={() => undefined}
        onSelectNode={onSelectNode}
      />,
    )
    expect(canvas.scrollLeft).toBe(137)
    expect(canvas.scrollTop).toBe(91)
  })

  it('refreshes an inspected body only when its body version changes', async () => {
    let bodyText = 'Body version one'
    let bodyVersion = 1
    const getMessagePresentationSnapshot = vi.fn(async (messageId: string) => {
      const row = smallTree.find((header) => header.id === messageId)
      return row
        ? {
            bodyVersion,
            message: {
              ...row,
              content: [{ type: 'text' as const, text: bodyText }],
            },
          }
        : undefined
    })
    const treeRepository = repository({ getMessagePresentationSnapshot })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body version one',
      ),
    )

    bodyText = 'Body version two'
    bodyVersion = 2
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root' ? { ...row, nodeVersion: row.nodeVersion + 1 } : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    await act(async () => Promise.resolve())
    expect(getMessagePresentationSnapshot).toHaveBeenCalledTimes(1)

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root'
            ? { ...row, bodyVersion: row.bodyVersion + 1, nodeVersion: row.nodeVersion + 2 }
            : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessagePresentationSnapshot).toHaveBeenCalledTimes(2))
    await expect(getMessagePresentationSnapshot.mock.results[1]?.value).resolves.toMatchObject({
      bodyVersion: 2,
      message: { content: [{ text: 'Body version two' }] },
    })
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
        'data-body-ready',
        'true',
      ),
    )
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body version two',
      ),
    )
  })

  it('never paints a retained body after the selected header advances past its version', async () => {
    let bodyVersion = 1
    let bodyText = 'Body before edit'
    let releaseFreshRead: (() => void) | undefined
    const freshReadGate = new Promise<void>((resolve) => {
      releaseFreshRead = resolve
    })
    const getMessagePresentationSnapshot = vi.fn(async (messageId: string) => {
      if (bodyVersion === 2) await freshReadGate
      const row = smallTree.find((header) => header.id === messageId)
      return row
        ? {
            bodyVersion,
            message: {
              ...row,
              content: [{ type: 'text' as const, text: bodyText }],
            },
          }
        : undefined
    })
    const treeRepository = repository({ getMessagePresentationSnapshot })
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body before edit',
      ),
    )

    bodyVersion = 2
    bodyText = 'Body after edit'
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'root' ? { ...row, bodyVersion: 2, nodeVersion: 2 } : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessagePresentationSnapshot).toHaveBeenCalledTimes(2))
    expect(document.body).not.toHaveTextContent('Body before edit')

    releaseFreshRead?.()
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toHaveTextContent(
        'Body after edit',
      ),
    )
  })

  it('exposes distinct shared-trunk and per-child insertion targets', () => {
    const insertShared = vi.fn()
    const insertChild = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={insertShared}
        onInsertAtChildLeg={insertChild}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Insert after this parent before all of its children',
      }),
    )
    expect(insertShared).toHaveBeenCalledWith('root')

    const childLegs = screen.getAllByRole('button', { name: 'Insert before this child only' })
    expect(childLegs).toHaveLength(2)
    const rightLeg = childLegs.at(1)
    if (!rightLeg) throw new Error('Missing right child connector')
    fireEvent.click(rightLeg)
    expect(insertChild).toHaveBeenCalledWith('right')
    expect(document.querySelectorAll('[data-ui="branch-tree-connector-add"]')).toHaveLength(3)
  })

  it('exposes a keyboard-operable append target after every leaf', () => {
    const insertAfterLeaf = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={insertAfterLeaf}
      />,
    )

    const leafTargets = screen.getAllByRole('button', { name: 'Add message after this leaf' })
    expect(leafTargets).toHaveLength(2)
    expect(leafTargets[0]).toHaveAttribute('data-parent-id', 'left')
    expect(leafTargets[1]).toHaveAttribute('data-parent-id', 'right')
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]')).toHaveLength(2)

    fireEvent.click(leafTargets[0] as Element)
    fireEvent.keyDown(leafTargets[1] as Element, { key: 'Enter' })
    expect(insertAfterLeaf).toHaveBeenNthCalledWith(1, 'left')
    expect(insertAfterLeaf).toHaveBeenNthCalledWith(2, 'right')
  })

  it('treats deleted-only children as leaves and disables append while that leaf streams', () => {
    const insertAfterLeaf = vi.fn()
    observeTestAttempt({
      streamId: 'root-stream',
      chatId: 'chat-1',
      messageId: 'root',
      local: false,
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[
          header('root', null, 0, 'user', 1),
          { ...header('deleted-child', 'root', 0, 'assistant', 2), deleted: true },
        ]}
        cursor={{}}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={insertAfterLeaf}
      />,
    )

    const leafTarget = screen.getByRole('button', { name: 'Add message after this leaf' })
    expect(leafTarget).toHaveAttribute('data-parent-id', 'root')
    expect(leafTarget).toHaveAttribute('aria-disabled', 'true')
    expect(leafTarget).toHaveAttribute('tabindex', '-1')
    fireEvent.click(leafTarget)
    expect(insertAfterLeaf).not.toHaveBeenCalled()
  })

  it('never treats a historical streaming header as live without an execution lease', async () => {
    const streamingLeaf = {
      ...header('left', 'root', 0, 'assistant', 2),
      generation: streamingGeneration(),
    }
    const headers = [header('root', null, 0, 'user', 1), streamingLeaf]
    const getMessage = vi.fn(async (messageId: string): Promise<Message | undefined> => {
      const row = headers.find((candidate) => candidate.id === messageId)
      return row
        ? { ...row, content: [{ type: 'output_text', text: 'Persisted prefix.' }] }
        : undefined
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository({ getMessage })}
        onActivateNode={() => undefined}
        onInsertAfterLeaf={() => undefined}
        onEditMessage={succeededInteractionSettlement}
        onDeleteNode={succeededInteractionSettlement}
        onContinueMessage={() => startedGenerationResult('left')}
      />,
    )

    const append = screen.getByRole('button', { name: 'Add message after this leaf' })
    expect(append).toHaveAttribute('data-parent-id', 'left')
    expect(append).not.toHaveAttribute('aria-disabled')

    fireEvent.click(document.querySelector('[data-message-id="left"]') as Element)
    await screen.findByRole('button', { name: 'Edit message' })
    expect(document.querySelector('[data-ui="branch-tree-inspector-stream-status"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete message' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
  })

  it('uses one centered insertion target for a parent with only one child', () => {
    const insertShared = vi.fn()
    const insertChild = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[header('root', null, 0, 'user', 1), header('only', 'root', 0, 'assistant', 2)]}
        cursor={{ root: 'only' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={insertShared}
        onInsertAtChildLeg={insertChild}
      />,
    )

    const target = screen.getByRole('button', {
      name: 'Insert after this parent before all of its children',
    })
    expect(target).toHaveAttribute('data-parent-id', 'root')
    expect(screen.queryByRole('button', { name: 'Insert before this child only' })).toBeNull()
    expect(document.querySelectorAll('[data-ui="branch-tree-connector-add"]')).toHaveLength(1)
    fireEvent.click(target)
    expect(insertShared).toHaveBeenCalledWith('root')
    expect(insertChild).not.toHaveBeenCalled()
  })

  it('matches compact selection outlines to each node shape', () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={[
          header('user', null, 0, 'user', 1),
          header('assistant', null, 1, 'assistant', 2),
          header('tool', null, 2, 'tool', 3),
        ]}
        cursor={{ __root__: 'user' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )

    const userOutline = document.querySelector(
      '[data-message-id="user"] [data-ui="branch-tree-node-selection-ring"]',
    )
    const assistantOutline = document.querySelector(
      '[data-message-id="assistant"] [data-ui="branch-tree-node-selection-ring"]',
    )
    const toolOutline = document.querySelector(
      '[data-message-id="tool"] [data-ui="branch-tree-node-selection-ring"]',
    )
    expect(userOutline?.tagName).toBe('rect')
    expect(userOutline).toHaveAttribute('data-shape', 'rounded-square')
    expect(userOutline).toHaveAttribute('rx', '11')
    expect(assistantOutline?.tagName).toBe('circle')
    expect(assistantOutline).toHaveAttribute('data-shape', 'circle')
    expect(assistantOutline).toHaveAttribute('r', '21')
    expect(toolOutline?.tagName).toBe('polygon')
    expect(toolOutline).toHaveAttribute('data-shape', 'hexagon')
  })

  it('exposes selected-node deletion in the inspector separately from connector insertion', async () => {
    const deleteNode = vi.fn(() => succeededInteractionSettlement())
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onDeleteNode={deleteNode}
      />,
    )

    expect(
      screen.queryByRole('button', {
        name: 'Insert after this parent before all of its children',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Insert before this child only' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'User message' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete message' }))
    expect(deleteNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'root' }))
  })

  it.each(
    rejectedTreeActionCases,
  )('owns and surfaces rejected $kind actions without closing or applying them', async ({
    kind,
    label,
  }) => {
    const rejected = vi.fn(async () => {
      throw new Error(`${kind} rejected`)
    })
    const settlements = createInteractionSettlementHarness()
    const rejectedMutation = vi.fn(() => settlements.fail(new Error(`${kind} rejected`)))
    const treeRepository = repository({
      getMessage: async (messageId) =>
        messageId === 'right' ? actionMessage() : fullMessageFor(messageId),
    })
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={kind === 'activate' ? rejected : () => undefined}
        {...(kind === 'delete' ? { onDeleteNode: rejectedMutation } : {})}
        {...(kind === 'fork' ? { onForkMessage: rejectedMutation } : {})}
        {...(kind === 'toggle' ? { onToggleMessageContextVisibility: rejectedMutation } : {})}
        {...(kind === 'attachment' ? { onMutateMessageAttachmentRef: rejected } : {})}
        {...(kind === 'reasoning-visibility'
          ? { onToggleReasoningDetailHidden: rejectedMutation }
          : {})}
        {...(kind === 'tool-visibility'
          ? { onToggleProviderOutputItemHidden: rejectedMutation }
          : {})}
        {...(kind === 'insert' ? { onInsertAfterLeaf: rejected } : {})}
      />,
    )

    fireEvent.click(document.querySelector('[data-message-id="right"]') as Element)
    const inspector = await waitFor(() => {
      const current = document.querySelector('[data-ui="branch-tree-inspector"]')
      expect(current).toHaveAttribute('data-message-id', 'right')
      return current as HTMLElement
    })

    if (kind === 'activate') {
      fireEvent.click(screen.getByRole('button', { name: 'Open this branch' }))
    } else if (kind === 'delete') {
      fireEvent.click(screen.getByRole('button', { name: 'Delete message' }))
    } else if (kind === 'fork') {
      fireEvent.click(screen.getByRole('button', { name: 'Branch this chat from here' }))
    } else if (kind === 'toggle') {
      fireEvent.click(
        screen.getByRole('button', { name: 'Hide from context (never send to model)' }),
      )
    } else if (kind === 'attachment') {
      fireEvent.click(screen.getByRole('button', { name: 'Hide attachment from context' }))
    } else if (kind === 'reasoning-visibility') {
      const reasoning = document.querySelector<HTMLDetailsElement>('[data-ui="reasoning"]')
      if (!reasoning) throw new Error('Reasoning disclosure missing')
      reasoning.open = true
      fireEvent(reasoning, new Event('toggle'))
      fireEvent.click(screen.getByRole('button', { name: 'Hide this reasoning block' }))
    } else if (kind === 'tool-visibility') {
      const toolEvidence = document.querySelector<HTMLDetailsElement>('[data-ui="tool-evidence"]')
      if (!toolEvidence) throw new Error('Tool evidence disclosure missing')
      toolEvidence.open = true
      fireEvent(toolEvidence, new Event('toggle'))
      fireEvent.click(screen.getByRole('button', { name: 'Hide tool call' }))
    } else {
      const append = document.querySelector<HTMLElement>(
        '[data-connector-hit="leaf-append"][data-parent-id="right"]',
      )
      if (!append) throw new Error('Leaf insertion target missing')
      fireEvent.click(append)
    }

    const mutationOwned = [
      'delete',
      'fork',
      'toggle',
      'reasoning-visibility',
      'tool-visibility',
    ].includes(kind)
    if (mutationOwned) {
      await waitFor(() => expect(settlements.presented).toHaveLength(1))
      expect(settlements.presented[0]?.message).toContain(`${kind} rejected`)
    } else if (kind === 'attachment') {
      const expectedToast = {
        level: 'danger',
        text: `${label} failed: ${kind} rejected`,
      }
      await waitFor(() =>
        expect(
          useToastStore
            .getState()
            .toasts.filter(
              (toast) => toast.level === expectedToast.level && toast.text === expectedToast.text,
            ),
        ).toHaveLength(1),
      )
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent(
        `${label} failed: ${kind} rejected`,
      )
    }
    if (mutationOwned) expect(rejectedMutation).toHaveBeenCalledOnce()
    else expect(rejected).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBe(inspector)
    expect(document.querySelector('[data-message-id="right"]')).toHaveAttribute(
      'data-selected',
      'true',
    )
    if (kind === 'activate') {
      expect(document.querySelector('[data-message-id="left"]')).toHaveAttribute(
        'data-current-leaf',
        'true',
      )
    } else if (kind === 'toggle') {
      expect(
        screen.getByRole('button', { name: 'Hide from context (never send to model)' }),
      ).toHaveAttribute('aria-pressed', 'false')
    } else if (kind === 'attachment') {
      expect(document.querySelector('[data-ui="attachment-chip"]')).toHaveAttribute(
        'data-context',
        'included',
      )
    } else if (kind === 'reasoning-visibility') {
      expect(screen.getByRole('button', { name: 'Hide this reasoning block' })).toBeInTheDocument()
    } else if (kind === 'tool-visibility') {
      expect(screen.getByRole('button', { name: 'Hide tool call' })).toBeInTheDocument()
    }
  })

  it('renders viewport-sized DOM for a very wide tree and only previews visible expanded cards', async () => {
    const headers: MessageHeaderRow[] = [header('root', null, 0, 'user', 1)]
    for (let index = 0; index < 2_000; index += 1) {
      headers.push(header(`child-${index}`, 'root', index, 'assistant', index + 2))
    }
    const getMessageTextPreview = vi.fn(async (messageId: string) => `Preview ${messageId}`)
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'child-1999' }}
        expanded
        repository={repository({ getMessageTextPreview })}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={() => undefined}
        onInsertAtChildLeg={() => undefined}
        onInsertAfterLeaf={() => undefined}
      />,
    )

    await waitFor(() => expect(getMessageTextPreview).toHaveBeenCalled())
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-node-preview"]')).not.toHaveTextContent(
        'Loading preview…',
      ),
    )
    const renderedNodes = document.querySelectorAll('[data-ui="branch-tree-node"]').length
    expect(renderedNodes).toBeLessThan(50)
    expect(getMessageTextPreview.mock.calls.length).toBeLessThan(50)
    expect(document.querySelectorAll('[data-ui="branch-tree-connector"]').length).toBeLessThan(100)
    expect(document.querySelectorAll('[data-connector-hit]').length).toBeLessThan(100)
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]').length).toBeLessThan(50)
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).not.toHaveLength(
      headers.length,
    )
  })

  it('keeps deep-tree nodes, connectors, and leaf controls bounded to the viewport', async () => {
    const headers: MessageHeaderRow[] = []
    for (let index = 0; index < 2_000; index += 1) {
      headers.push(
        header(
          `node-${index}`,
          index === 0 ? null : `node-${index - 1}`,
          0,
          index % 2 === 0 ? 'user' : 'assistant',
          index + 1,
        ),
      )
    }
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={Object.fromEntries(
          headers.slice(0, -1).map((row, index) => [row.id, `node-${index + 1}`]),
        )}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
        onInsertAtSharedTrunk={() => undefined}
        onInsertAfterLeaf={() => undefined}
      />,
    )

    await waitForActiveTree()
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]').length).toBeLessThan(30)
    expect(document.querySelectorAll('[data-ui="branch-tree-connector"]').length).toBeLessThan(60)
    expect(document.querySelectorAll('[data-connector-hit]').length).toBeLessThan(30)
    expect(document.querySelectorAll('[data-ui="branch-tree-leaf-add"]')).toHaveLength(1)
  })

  it('batches each visible preview window and aborts superseded panning reads', async () => {
    const headers: MessageHeaderRow[] = [header('root', null, 0, 'user', 1)]
    for (let index = 0; index < 600; index += 1) {
      headers.push(header(`child-${index}`, 'root', index, 'assistant', index + 2))
    }
    let inFlight = 0
    let maxInFlight = 0
    const pending: Array<() => void> = []
    const signals: AbortSignal[] = []
    const getMessageTextPreviewWindow = vi.fn(
      async (
        targets: readonly { messageId: MessageId; bodyVersion: number }[],
        options?: { signal?: AbortSignal },
      ) =>
        new Promise<Array<{ messageId: MessageId; bodyVersion: number; text: string }>>(
          (resolve, reject) => {
            let settled = false
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            if (options?.signal) signals.push(options.signal)
            options?.signal?.addEventListener(
              'abort',
              () => {
                if (settled) return
                settled = true
                inFlight -= 1
                reject(new DOMException('Aborted', 'AbortError'))
              },
              { once: true },
            )
            pending.push(() => {
              if (settled) return
              settled = true
              inFlight -= 1
              resolve(
                targets.map((target) => ({
                  ...target,
                  text: `Preview ${target.messageId}`,
                })),
              )
            })
          },
        ),
    )
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={headers}
        cursor={{ root: 'child-0' }}
        expanded
        repository={repository({ getMessageTextPreviewWindow })}
        onActivateNode={() => undefined}
      />,
    )
    await waitFor(() => expect(getMessageTextPreviewWindow).toHaveBeenCalled())
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')

    for (const left of [10_000, 20_000, 30_000, 40_000]) {
      canvas.scrollLeft = left
      fireEvent.scroll(canvas)
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
    }

    expect(getMessageTextPreviewWindow.mock.calls.length).toBeLessThanOrEqual(6)
    for (const [targets] of getMessageTextPreviewWindow.mock.calls) {
      expect(targets.length).toBeLessThan(50)
    }
    for (const signal of signals.slice(0, -1)) expect(signal.aborted).toBe(true)
    expect(maxInFlight).toBe(1)
    for (let pass = 0; pass < 3 && inFlight > 0; pass += 1) {
      await act(async () => {
        for (const resolve of pending.splice(0)) resolve()
        await Promise.resolve()
      })
    }
    await waitFor(() => expect(inFlight).toBe(0))
  })

  it('keeps topology work and the inspector isolated from non-structural activity', async () => {
    const treeComputations: string[] = []
    const inspectorComputations: string[] = []
    BranchTreeView.__setComputationProbeForTests((operation) => treeComputations.push(operation))
    observeBranchTreeInspectorComputations((operation) => inspectorComputations.push(operation))
    const treeRepository = repository()
    const activate = vi.fn()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={activate}
      />,
    )
    fireEvent.click(document.querySelector('[data-message-id="root"]') as Element)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
    )
    const initialLayouts = treeComputations.filter((entry) => entry === 'layout').length
    const initialIndexes = treeComputations.filter((entry) => entry === 'connector-index').length
    const initialInspectorRenders = inspectorComputations.filter(
      (entry) => entry === 'render',
    ).length
    const initialTreeRenders = treeComputations.filter((entry) => entry === 'render').length

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree.map((row) =>
          row.id === 'right'
            ? { ...row, hiddenFromContext: true, nodeVersion: row.nodeVersion + 1 }
            : row,
        )}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={activate}
      />,
    )
    const treeRendersAfterHeaderChange = treeComputations.filter(
      (entry) => entry === 'render',
    ).length
    act(() => {
      observeTestAttempt({
        streamId: 'unrelated',
        chatId: 'chat-elsewhere',
        messageId: 'other-message',
        local: false,
      })
      publishTestLiveProjection({
        streamId: 'unrelated',
        chatId: 'chat-elsewhere',
        messageId: 'other-message',
        content: [{ type: 'output_text', text: 'Elsewhere' }],
        textLength: 9,
        reasoningLength: 0,
        updatedAt: 2,
      })
    })
    expect(treeComputations.filter((entry) => entry === 'render')).toHaveLength(
      treeRendersAfterHeaderChange,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    canvas.scrollLeft = 12
    fireEvent.scroll(canvas)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))

    expect(treeComputations.filter((entry) => entry === 'layout')).toHaveLength(initialLayouts)
    expect(treeComputations.filter((entry) => entry === 'connector-index')).toHaveLength(
      initialIndexes,
    )
    expect(inspectorComputations.filter((entry) => entry === 'render')).toHaveLength(
      initialInspectorRenders,
    )
    expect(treeComputations.filter((entry) => entry === 'render').length).toBeGreaterThan(
      initialTreeRenders,
    )
  })

  it('retains the tree workspace while releasing hidden viewport geometry', async () => {
    const computations: string[] = []
    BranchTreeView.__setComputationProbeForTests((operation) => computations.push(operation))
    const treeRepository = repository()
    const view = render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    const workspace = document.querySelector<HTMLElement>('[data-ui="branch-tree-view"]')
    if (!workspace) throw new Error('Missing tree workspace')
    workspace.dataset.retainedIdentity = 'true'
    const activeLayouts = computations.filter((entry) => entry === 'layout').length
    const activeIndexes = computations.filter((entry) => entry === 'connector-index').length
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).toHaveLength(3)

    const changedTree = [...smallTree, header('right-child', 'right', 0, 'assistant', 4)]
    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={changedTree}
        cursor={{ root: 'left' }}
        expanded={false}
        viewportActive={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )

    expect(document.querySelector('[data-ui="branch-tree-view"]')).toBe(workspace)
    expect(workspace.dataset.retainedIdentity).toBe('true')
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).toHaveLength(0)
    expect(computations.filter((entry) => entry === 'layout')).toHaveLength(activeLayouts)
    expect(computations.filter((entry) => entry === 'connector-index')).toHaveLength(activeIndexes)

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={changedTree}
        cursor={{ root: 'left' }}
        expanded={false}
        bindingCurrency="retained"
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    expect(document.querySelector('[data-ui="branch-tree-view"]')).toBe(workspace)
    expect(workspace).toHaveAttribute('inert')
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).toHaveLength(0)
    expect(computations.filter((entry) => entry === 'layout')).toHaveLength(activeLayouts)
    expect(computations.filter((entry) => entry === 'connector-index')).toHaveLength(activeIndexes)

    view.rerender(
      <BranchTreeView
        chatId="chat-1"
        headers={changedTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={treeRepository}
        onActivateNode={() => undefined}
      />,
    )
    expect(document.querySelector('[data-ui="branch-tree-view"]')).toBe(workspace)
    expect(document.querySelectorAll('[data-ui="branch-tree-node"]')).toHaveLength(4)
    expect(computations.filter((entry) => entry === 'layout')).toHaveLength(activeLayouts + 1)
    expect(computations.filter((entry) => entry === 'connector-index')).toHaveLength(
      activeIndexes + 1,
    )
  })

  it('pans the empty canvas without activating a node or clearing the inspector', async () => {
    const activate = vi.fn()
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={activate}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    fireEvent.click(document.querySelector('[data-message-id="root"]') as HTMLElement)
    await waitFor(() =>
      expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument(),
    )
    canvas.scrollLeft = 120
    canvas.scrollTop = 90
    canvas.setPointerCapture = vi.fn()
    canvas.hasPointerCapture = vi.fn(() => true)
    canvas.releasePointerCapture = vi.fn()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 7, clientX: 200, clientY: 180 })
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 150, clientY: 140 })
    expect(canvas).toHaveAttribute('data-panning', 'true')
    expect(canvas.scrollLeft).toBe(170)
    expect(canvas.scrollTop).toBe(130)
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 150, clientY: 140 })
    expect(canvas).not.toHaveAttribute('data-panning')
    fireEvent.click(canvas)
    expect(document.querySelector('[data-ui="branch-tree-inspector"]')).toBeInTheDocument()
    expect(activate).not.toHaveBeenCalled()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 8, clientX: 200, clientY: 180 })
    expect(canvas).toHaveAttribute('data-panning', 'true')
    fireEvent.lostPointerCapture(canvas, { pointerId: 8 })
    expect(canvas).not.toHaveAttribute('data-panning')
  })

  it('leaves native scrollbar gutters available for scrollbar dragging', () => {
    render(
      <BranchTreeView
        chatId="chat-1"
        headers={smallTree}
        cursor={{ root: 'left' }}
        expanded={false}
        repository={repository()}
        onActivateNode={() => undefined}
      />,
    )
    const canvas = document.querySelector<HTMLElement>('[data-ui="branch-tree-scroll"]')
    if (!canvas) throw new Error('Missing tree canvas')
    Object.defineProperties(canvas, {
      offsetWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 184 },
      offsetHeight: { configurable: true, value: 160 },
      clientHeight: { configurable: true, value: 144 },
    })
    canvas.getBoundingClientRect = vi.fn(
      () => ({ left: 0, top: 0, right: 200, bottom: 160, width: 200, height: 160 }) as DOMRect,
    )
    canvas.setPointerCapture = vi.fn()

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 8, clientX: 195, clientY: 80 })
    expect(canvas.setPointerCapture).not.toHaveBeenCalled()
    expect(canvas).not.toHaveAttribute('data-panning')

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientX: 80, clientY: 155 })
    expect(canvas.setPointerCapture).not.toHaveBeenCalled()
    expect(canvas).not.toHaveAttribute('data-panning')
  })
})
