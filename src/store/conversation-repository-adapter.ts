import {
  type ConversationDestinationHeaderPoint,
  type ConversationDestinationPoint,
  type ConversationProvedSelection,
  sealConversationSelection,
} from '../core/messages'
import type { Chat, ChatId, MessageId } from '../core/types'
import { assertNever } from '../lib/assert'
import {
  type ConversationCommittedEffect,
  type ConversationController,
  type ConversationMessageRevisionObservation,
  type ConversationProjectionRefresh,
  type ConversationProjectionSource,
  type ConversationReadEnvelope,
  type ConversationTranscriptPage,
  type ConversationTranscriptPageResult,
  type MessageTextPreview,
  TREE_PREVIEW_MAX_CHARS,
} from './conversation-controller'
import type { MessagePresentation } from './message-storage'
import {
  committedConversationResult,
  joinKnownBranchPageMaterial,
  type KnownBranchPageStructuralResult,
  type WorkspaceCommittedResult,
  type WorkspaceFence,
} from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  CommitEnvelope,
  WorkspaceDelta,
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceRepository,
} from './workspace-protocol'
import { runWorkspaceRead } from './workspace-runtime'

export interface ConversationRepositoryAdapter {
  readonly projectionSource: ConversationProjectionSource
  attach(fence: WorkspaceFence): void
  dispose(): void
}

export function createConversationRepositoryAdapter(input: {
  repository: WorkspaceRepository
  controller: ConversationController
}): ConversationRepositoryAdapter {
  return new RepositoryConversationAdapter(input.repository, input.controller)
}

class RepositoryConversationAdapter implements ConversationRepositoryAdapter {
  readonly projectionSource: ConversationProjectionSource
  private readonly repository: WorkspaceRepository
  private readonly controller: ConversationController

  private unsubscribeEffects: (() => void) | null = null
  private disposed = false

  constructor(repository: WorkspaceRepository, controller: ConversationController) {
    this.repository = repository
    this.controller = controller
    this.projectionSource = this.createProjectionSource()
  }

  attach(fence: WorkspaceFence): void {
    if (this.disposed) throw new Error('ConversationRepositoryAdapterDisposed')
    if (this.unsubscribeEffects) return
    this.controller.reconcileWorkspace(fence)
    this.controller.setProjectionSource(this.projectionSource)
    this.unsubscribeEffects = subscribeWorkspaceEffects({
      owner: 'conversation-repository-adapter',
      group: 'conversation',
      factKinds: ['chat-deleted', 'conversation-created', 'message-revision'],
      residualKinds: [
        'workspace',
        'chat',
        'message-header',
        'message-body',
        'message-preview',
        'child-slot',
      ],
      replacements: false,
      apply: (effect) => this.receiveEffect(effect),
      recover: (_error, effect) => {
        this.recoverEffect(effect)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeEffects?.()
    this.unsubscribeEffects = null
    this.controller.setProjectionSource(null)
  }

  private createProjectionSource(): ConversationProjectionSource {
    return {
      loadChat: async (chatId, signal) => {
        const envelope = await this.read({ kind: 'chat.get', chatId }, signal)
        return conversationEnvelope(envelope, envelope.value)
      },
      openSelection: async (chatId, target, onPoint, signal) => {
        const publishPoint = (
          stage: ConversationReadEnvelope<ConversationDestinationHeaderPoint>,
        ) => {
          if (!onPoint) return
          if (stage.value.kind === 'empty-point') {
            onPoint(
              Object.freeze({
                workspaceId: stage.workspaceId,
                replacementEpoch: stage.replacementEpoch,
                value: stage.value,
              }),
            )
            return
          }
          const header = stage.value.header
          void this.controller
            .readSharedMessageMaterial(
              stage,
              [header],
              async (headers, sharedSignal) => {
                const read = await this.read(
                  {
                    kind: 'message.presentations',
                    messageIds: headers.map((candidate) => candidate.id),
                  },
                  sharedSignal,
                )
                return {
                  workspaceId: read.workspaceId,
                  replacementEpoch: read.replacementEpoch,
                  material: read.value,
                }
              },
              signal,
            )
            .then(([presentation]) => {
              if (!presentation || signal.aborted) return
              const point: ConversationDestinationPoint = Object.freeze({
                kind: 'tip-point',
                chat: stage.value.chat,
                target: stage.value.target,
                structuralVersion: stage.value.structuralVersion,
                presentation,
              })
              onPoint(
                Object.freeze({
                  workspaceId: stage.workspaceId,
                  replacementEpoch: stage.replacementEpoch,
                  value: point,
                }),
              )
            })
            .catch(() => undefined)
        }
        const envelope = await runWorkspaceRead(
          'repository-query',
          (permit) =>
            this.repository.query(
              permit,
              { kind: 'branch.open', chatId, target, bodyDemand: 'terminal' },
              onPoint
                ? {
                    signal: permit.signal,
                    onStage: (stage) => publishPoint(conversationEnvelope(stage, stage.value)),
                  }
                : { signal: permit.signal },
            ),
          { signal },
        )
        const value = envelope.value
        return conversationEnvelope(
          envelope,
          value.kind === 'ready' ? sealConversationSelection(value) : value,
        )
      },
      loadForks: async (chatId, structuralVersion, targets, signal) => {
        const envelope = await this.read(
          { kind: 'branch.forks', chatId, structuralVersion, targets },
          signal,
        )
        return conversationEnvelope(envelope, envelope.value)
      },
      loadChildAtPosition: async (chatId, parentId, position, signal) => {
        const envelope = await this.read(
          { kind: 'branch.child-at-position', chatId, parentId, position },
          signal,
        )
        return conversationEnvelope(envelope, envelope.value)
      },
      loadTopology: async (chatId, signal) => {
        const envelope = await this.read({ kind: 'message.headers-by-chat', chatId }, signal)
        return conversationEnvelope(envelope, envelope.value)
      },
      loadTranscriptPage: async (chatId, leafId, structuralVersion, window, material, signal) => {
        const joinedAbort = new AbortController()
        const abortJoined = () => joinedAbort.abort(signal.reason)
        if (signal.aborted) abortJoined()
        else signal.addEventListener('abort', abortJoined, { once: true })
        let envelope: {
          workspaceId: string
          replacementEpoch: number
          value: KnownBranchPageStructuralResult
        }
        let materialRows: readonly (MessagePresentation | undefined)[]
        try {
          ;[envelope, materialRows] = await Promise.all([
            this.read(
              {
                kind: 'branch.page-structure',
                chatId,
                resolvedTipId: leafId,
                structuralVersion,
                window,
              },
              joinedAbort.signal,
            ),
            material.read(
              material,
              window.nodes,
              async (headers, sharedSignal) => {
                const read = await this.read(
                  {
                    kind: 'message.presentations',
                    messageIds: headers.map((header) => header.id),
                  },
                  sharedSignal,
                )
                return {
                  workspaceId: read.workspaceId,
                  replacementEpoch: read.replacementEpoch,
                  material: read.value,
                }
              },
              joinedAbort.signal,
            ),
          ])
        } catch (error) {
          joinedAbort.abort(error)
          throw error
        } finally {
          signal.removeEventListener('abort', abortJoined)
        }
        if (
          envelope.workspaceId !== material.workspaceId ||
          envelope.replacementEpoch !== material.replacementEpoch
        ) {
          throw new Error('ConversationTranscriptPageWorkspaceMismatch')
        }
        const value = joinKnownBranchPageMaterial(envelope.value, materialRows)
        if (value.kind !== 'ready') {
          if (value.reason === 'structural-version-mismatch' || value.reason === 'chat-missing') {
            return conversationEnvelope<ConversationTranscriptPageResult>(envelope, {
              kind: 'stale-selection',
              material: value.material,
            })
          }
          throw new Error(`ConversationTranscriptPageInvalid:${value.reason}`)
        }
        const snapshot = value.snapshot
        const frame: ConversationTranscriptPage = Object.freeze({
          chatId,
          leafId,
          branchLength: snapshot.branchLength,
          offset: snapshot.pageOffset,
          headers: snapshot.pageHeaders,
          messages: snapshot.pageMessages,
        })
        return conversationEnvelope<ConversationTranscriptPageResult>(envelope, {
          kind: 'ready',
          structuralVersion,
          page: frame,
          material: value.material,
        })
      },
      loadInspector: async (chatId, messageId, signal) => {
        const envelope = await this.read({ kind: 'message.presentation', messageId }, signal)
        const presentation = envelope.value
        return conversationEnvelope(
          envelope,
          presentation?.header.chatId === chatId ? presentation : null,
        )
      },
      loadPreviews: async (_chatId, targets, signal) => {
        const envelope = await this.read(
          {
            kind: 'message.preview-window',
            targets,
            maxChars: TREE_PREVIEW_MAX_CHARS,
          },
          signal,
        )
        const previews = envelope.value.filter(
          (preview): preview is MessageTextPreview => preview !== undefined,
        )
        return conversationEnvelope(envelope, Object.freeze(previews))
      },
    }
  }

  private read<Q extends WorkspaceQuery>(
    query: Q,
    signal: AbortSignal,
  ): Promise<{
    workspaceId: string
    replacementEpoch: number
    value: WorkspaceQueryResult<Q>
  }> {
    return runWorkspaceRead(
      'repository-query',
      (permit) => this.repository.query(permit, query, { signal: permit.signal }),
      { signal },
    )
  }

  private receiveEffect(effect: WorkspaceEffect): void {
    if (this.disposed) return
    const snapshot = this.controller.getSnapshot()
    if (
      effect.workspaceId !== snapshot.workspaceId ||
      effect.replacementEpoch !== snapshot.workspaceEpoch
    ) {
      this.controller.reconcileWorkspace(effect)
    }
    if (effect.kind === 'replace') return
    this.controller.applyCommittedEffects(
      conversationCommittedEffectsForDelta(
        effect,
        {
          facts: effect.facts,
          invalidations:
            effect.residual === 'all'
              ? Object.freeze([{ kind: 'workspace' as const }])
              : effect.residual,
        },
        this.controller.observedCommitChatIds(),
        effect.cause === 'invalidation' ? 'invalidation' : effect.source,
        effect.receipt,
      ),
    )
  }

  private recoverEffect(effect: WorkspaceEffect): void {
    if (this.disposed) return
    const snapshot = this.controller.getSnapshot()
    if (
      snapshot.workspaceId !== effect.workspaceId ||
      snapshot.workspaceEpoch !== effect.replacementEpoch
    ) {
      this.controller.reconcileWorkspace(effect)
    }
    this.controller.applyCommittedEffects(
      this.controller.observedCommitChatIds().map((chatId) => ({
        workspaceId: effect.workspaceId,
        replacementEpoch: effect.replacementEpoch,
        chatId,
        source: 'invalidation',
        kind: 'changed',
        structural: Object.freeze({ kind: 'incomplete', toVersion: null, scope: true }),
        refresh: Object.freeze({
          chat: true,
          headers: true,
          bodies: true,
          previews: true,
          forkParentIds: true,
        }),
      })),
    )
  }
}

function conversationEnvelope<T>(
  envelope: { workspaceId: string; replacementEpoch: number },
  value: T,
): ConversationReadEnvelope<T> {
  return {
    workspaceId: envelope.workspaceId,
    replacementEpoch: envelope.replacementEpoch,
    value,
  }
}

function conversationCommittedEffectForCommitIfAddressed<T>(
  commit: CommitEnvelope<T>,
  chatId: ChatId | null,
  source: 'local',
): ConversationCommittedEffect | null {
  return (
    conversationCommittedEffectsForDelta(
      commit,
      commit.delta,
      chatId ? [chatId] : [],
      source,
      commit.receipt,
    )[0] ?? null
  )
}

export function conversationCommittedEffectForCommit<T>(
  commit: CommitEnvelope<T>,
  chatId: ChatId,
): ConversationCommittedEffect {
  return (
    conversationCommittedEffectForCommitIfAddressed(commit, chatId, 'local') ??
    Object.freeze({
      workspaceId: commit.workspaceId,
      replacementEpoch: commit.replacementEpoch,
      chatId,
      source: 'local' as const,
      kind: 'changed' as const,
      structural: Object.freeze({ kind: 'none' as const }),
    })
  )
}

function conversationCommittedEffectsForDelta(
  stamp: { readonly workspaceId: string; readonly replacementEpoch: number },
  delta: WorkspaceDelta,
  chatIds: readonly ChatId[],
  source: 'local' | 'remote' | 'invalidation',
  receipt?: CommitEnvelope<unknown>['receipt'],
): readonly ConversationCommittedEffect[] {
  const demanded = new Map<ChatId, ConversationEffectAccumulator>()
  for (const chatId of chatIds) {
    if (!demanded.has(chatId)) demanded.set(chatId, new ConversationEffectAccumulator(chatId))
  }
  if (demanded.size === 0) return Object.freeze([])

  if (source === 'local') {
    for (const revision of receipt?.messageRevisions ?? []) {
      const accumulator = demanded.get(revision.header.chatId)
      accumulator?.observations.set(revision.header.id, {
        header: revision.header,
        structuralVersion: revision.structuralVersion,
        ...(revision.presentation ? { presentation: revision.presentation } : {}),
      })
      if (revision.changed.structure) accumulator?.structurallyChangedIds.add(revision.header.id)
    }
    for (const evidence of receipt?.childSlots ?? []) {
      demanded.get(evidence.state.chatId)?.childSlots.push(evidence)
    }
    for (const chat of receipt?.chats ?? []) admitReceiptChat(demanded, chat, false)
    for (const chat of receipt?.constructions ?? []) admitReceiptChat(demanded, chat, true)
  }

  for (const fact of delta.facts) {
    switch (fact.kind) {
      case 'chat-deleted':
        if (demanded.has(fact.chatId)) demanded.get(fact.chatId)!.deleted = true
        break
      case 'message-revision':
        if (!demanded.has(fact.chatId)) break
        if (source !== 'local') {
          const accumulator = demanded.get(fact.chatId) as ConversationEffectAccumulator
          accumulator.observations.set(fact.header.id, {
            header: fact.header,
            structuralVersion: fact.structuralVersion,
          })
          if (fact.changed.structure) accumulator.structurallyChangedIds.add(fact.header.id)
        }
        if (fact.changed.body && source === 'remote') {
          demanded.get(fact.chatId)!.bodies.add([fact.header.id])
          demanded.get(fact.chatId)!.previews.add([fact.header.id])
        }
        break
      case 'conversation-created':
        if (demanded.has(fact.chatId)) demanded.get(fact.chatId)!.construction = true
        break
      case 'attempt-target-committed':
      case 'attempt-stop-requested':
      case 'sidebar-row-changed':
      case 'sidebar-row-deleted':
      case 'attachment-row-changed':
      case 'attachment-row-deleted':
        break
      default:
        assertNever(fact)
    }
  }
  const globalInvalidation = new GlobalConversationInvalidation()
  for (const dependency of delta.invalidations) {
    switch (dependency.kind) {
      case 'workspace':
        globalInvalidation.invalidateAll()
        break
      case 'chat':
        if (!dependency.chatIds) globalInvalidation.chat = true
        else {
          forEachDemanded(demanded, dependency.chatIds, (accumulator) => {
            accumulator.chatRefresh = true
          })
        }
        break
      case 'message-header':
        if (dependency.chatId === undefined) {
          globalInvalidation.headers = true
          globalInvalidation.topology = true
        } else {
          const accumulator = demanded.get(dependency.chatId)
          accumulator?.headers.add(dependency.messageIds)
          accumulator?.topology.add(dependency.messageIds)
        }
        break
      case 'message-body':
        if (dependency.chatId === undefined) globalInvalidation.bodies = true
        else demanded.get(dependency.chatId)?.bodies.add(dependency.messageIds)
        break
      case 'message-preview':
        if (dependency.chatId === undefined) globalInvalidation.previews = true
        else demanded.get(dependency.chatId)?.previews.add(dependency.messageIds)
        break
      case 'child-slot':
        demanded.get(dependency.chatId)?.forks.add(dependency.parentIds)
        break
      case 'sidebar':
      case 'draft':
      case 'attachment':
      case 'attachment-job':
      case 'profile':
      case 'preset':
      case 'prompt-preset':
      case 'text-template':
      case 'folder':
      case 'tag':
      case 'key':
      case 'setting':
      case 'stream-lease':
      case 'stream-chunks':
      case 'model-resolution':
      case 'discovery-cache':
      case 'storage-maintenance':
        break
      default:
        assertNever(dependency)
    }
  }
  const effects: ConversationCommittedEffect[] = []
  for (const accumulator of demanded.values()) {
    globalInvalidation.apply(accumulator)
    const effect = accumulator.materialize(stamp, source)
    if (effect) effects.push(effect)
  }
  return Object.freeze(effects)
}

class GlobalConversationInvalidation {
  chat = false
  headers = false
  bodies = false
  previews = false
  topology = false
  forks = false

  invalidateAll(): void {
    this.chat = true
    this.headers = true
    this.bodies = true
    this.previews = true
    this.topology = true
    this.forks = true
  }

  apply(accumulator: ConversationEffectAccumulator): void {
    accumulator.chatRefresh ||= this.chat
    if (this.headers) accumulator.headers.add()
    if (this.bodies) accumulator.bodies.add()
    if (this.previews) accumulator.previews.add()
    if (this.topology) accumulator.topology.add()
    if (this.forks) accumulator.forks.add()
  }
}

class ConversationEffectAccumulator {
  readonly observations = new Map<MessageId, ConversationMessageRevisionObservation>()
  readonly structurallyChangedIds = new Set<MessageId>()
  readonly childSlots: NonNullable<CommitEnvelope<unknown>['receipt']>['childSlots'][number][] = []
  readonly headers = new ProjectionScopeBuilder<MessageId>()
  readonly bodies = new ProjectionScopeBuilder<MessageId>()
  readonly previews = new ProjectionScopeBuilder<MessageId>()
  readonly topology = new ProjectionScopeBuilder<MessageId>()
  readonly forks = new ProjectionScopeBuilder<MessageId | null>()
  readonly chatId: ChatId
  chat: Chat | undefined
  chatIsConstruction = false
  chatRefresh = false
  construction = false
  deleted = false

  constructor(chatId: ChatId) {
    this.chatId = chatId
  }

  invalidateAll(): void {
    this.chatRefresh = true
    this.headers.add()
    this.bodies.add()
    this.previews.add()
    this.topology.add()
    this.forks.add()
  }

  materialize(
    stamp: { readonly workspaceId: string; readonly replacementEpoch: number },
    source: 'local' | 'remote' | 'invalidation',
  ): ConversationCommittedEffect | null {
    if (this.deleted) {
      return Object.freeze({
        workspaceId: stamp.workspaceId,
        replacementEpoch: stamp.replacementEpoch,
        chatId: this.chatId,
        source,
        kind: 'deleted',
      })
    }
    const exactHeaderIds = [...this.observations.keys()]
    this.headers.cover(exactHeaderIds)
    this.topology.cover(exactHeaderIds)
    const exactPresentationIds = [...this.observations.values()].flatMap((revision) =>
      revision.presentation ? [revision.header.id] : [],
    )
    this.bodies.cover(exactPresentationIds)
    this.previews.cover(exactPresentationIds)
    for (const evidence of this.childSlots) this.forks.cover([evidence.state.parentId])
    if (source === 'local' && this.forks.value()) {
      throw new Error(`ConversationLocalChildSlotEvidenceMissing:${this.chatId}`)
    }
    if (this.construction && source === 'local' && !this.chatIsConstruction) {
      throw new Error(`ConversationLocalConstructionEvidenceMissing:${this.chatId}`)
    }
    if (this.chat) this.chatRefresh = false
    if (this.construction && source === 'remote') this.invalidateAll()
    const residualTopology = this.topology.value()
    const exactStructuralIds = [...this.structurallyChangedIds]
    const exactStructuralVersions = Object.freeze(
      [
        ...new Set(
          exactStructuralIds.map((messageId) => {
            const version = this.observations.get(messageId)?.structuralVersion
            if (version === undefined) {
              throw new Error(`ConversationStructuralObservationMissing:${messageId}`)
            }
            return version
          }),
        ),
      ].sort((left, right) => left - right),
    )
    const exactStructuralVersion = exactStructuralVersions.at(-1) ?? null
    const structural = residualTopology
      ? Object.freeze({
          kind: 'incomplete' as const,
          toVersion: this.chat?.structuralVersion ?? exactStructuralVersion,
          scope: residualTopology,
        })
      : exactStructuralVersion === null
        ? Object.freeze({ kind: 'none' as const })
        : Object.freeze({
            kind: 'exact-delta' as const,
            toVersion: exactStructuralVersion,
            structuralVersions: exactStructuralVersions,
            messageIds: Object.freeze(exactStructuralIds),
          })
    const refresh = projectionRefresh({
      chat: this.chatRefresh,
      headers: this.headers,
      bodies: this.bodies,
      previews: this.previews,
      forks: this.forks,
    })
    if (
      this.observations.size === 0 &&
      this.childSlots.length === 0 &&
      !this.chat &&
      structural.kind === 'none' &&
      !refresh
    ) {
      return null
    }
    return Object.freeze({
      workspaceId: stamp.workspaceId,
      replacementEpoch: stamp.replacementEpoch,
      chatId: this.chatId,
      source,
      kind: 'changed',
      structural,
      ...(this.observations.size > 0
        ? { revisions: Object.freeze([...this.observations.values()]) }
        : {}),
      ...(this.chat ? { chat: this.chat } : {}),
      ...(this.childSlots.length > 0 ? { childSlots: Object.freeze([...this.childSlots]) } : {}),
      ...(refresh ? { refresh } : {}),
    })
  }
}

function admitReceiptChat(
  demanded: ReadonlyMap<ChatId, ConversationEffectAccumulator>,
  chat: Chat,
  construction: boolean,
): void {
  const accumulator = demanded.get(chat.id)
  if (!accumulator) return
  if (accumulator.chat && accumulator.chatIsConstruction !== construction) {
    throw new Error(`ConversationLocalChatReceiptCollision:${chat.id}`)
  }
  accumulator.chat = chat
  accumulator.chatIsConstruction = construction
}

function forEachDemanded(
  demanded: ReadonlyMap<ChatId, ConversationEffectAccumulator>,
  chatIds: readonly ChatId[] | undefined,
  operation: (accumulator: ConversationEffectAccumulator) => void,
): void {
  if (!chatIds) {
    for (const accumulator of demanded.values()) operation(accumulator)
    return
  }
  for (const chatId of chatIds) {
    const accumulator = demanded.get(chatId)
    if (accumulator) operation(accumulator)
  }
}

export type ConversationCommittedResult<
  T extends { readonly destination: ConversationProvedSelection },
> = WorkspaceCommittedResult<T> & {
  readonly committedEffect: ConversationCommittedEffect
}

export function conversationCommittedResult<
  T extends { readonly destination: ConversationProvedSelection },
>(commit: CommitEnvelope<T>, chatId: ChatId): ConversationCommittedResult<T> {
  return Object.freeze({
    ...committedConversationResult(commit.value, commit),
    committedEffect: conversationCommittedEffectForCommit(commit, chatId),
  })
}

class ProjectionScopeBuilder<Id> {
  private all = false
  private readonly ids = new Set<Id>()

  add(ids?: readonly Id[]): void {
    if (ids === undefined) {
      this.all = true
      this.ids.clear()
      return
    }
    if (this.all) return
    for (const id of ids) this.ids.add(id)
  }

  cover(ids: readonly Id[]): void {
    if (this.all) return
    for (const id of ids) this.ids.delete(id)
  }

  value(): true | readonly Id[] | undefined {
    if (this.all) return true
    return this.ids.size > 0 ? Object.freeze([...this.ids]) : undefined
  }
}

function projectionRefresh(input: {
  readonly chat: boolean
  readonly headers: ProjectionScopeBuilder<MessageId>
  readonly bodies: ProjectionScopeBuilder<MessageId>
  readonly previews: ProjectionScopeBuilder<MessageId>
  readonly forks: ProjectionScopeBuilder<MessageId | null>
}): ConversationProjectionRefresh | null {
  const headers = input.headers.value()
  const bodies = input.bodies.value()
  const previews = input.previews.value()
  const forkParentIds = input.forks.value()
  if (!input.chat && !headers && !bodies && !previews && !forkParentIds) return null
  return Object.freeze({
    ...(input.chat ? { chat: true } : {}),
    ...(headers ? { headers } : {}),
    ...(bodies ? { bodies } : {}),
    ...(previews ? { previews } : {}),
    ...(forkParentIds ? { forkParentIds } : {}),
  })
}
