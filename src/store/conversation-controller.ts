import type {
  ActiveBranchForkSlot,
  ActiveBranchForkTarget,
  ActiveBranchSelection,
  ActiveBranchTargetUnavailableReason,
  VersionedActiveBranchSpine,
} from '../core/active-branch-spine'
import { createActiveBranchSpine } from '../core/active-branch-spine'
import type { MessageTreeProjection } from '../core/active-path'
import {
  type BranchPathDescriptor,
  type BranchPathSpan,
  type BranchPathWindow,
  createBranchPath,
  emptyBranchPath,
} from '../core/branch-session'
import type { GenerationCapabilityTarget } from '../core/interaction-capability'
import {
  createMessageTopologyIndex,
  type MessageTopologyIndex,
  type MessageTopologyOptions,
} from '../core/message-topology'
import {
  type ConversationAppendSelectionTransition,
  type ConversationDestinationPoint,
  type ConversationPathProofIdentity,
  type ConversationProvedSelection,
  type ConversationSelectionProofTarget,
  fixedConversationSelectionTarget,
  resolvingConversationSelectionTarget,
  type SealedConversationSelection,
  sealConversationSelection,
} from '../core/messages'
import {
  DEFAULT_TRANSCRIPT_INITIAL_ROW_COUNT,
  growTranscriptWorkBudget,
  TRANSCRIPT_BODY_READ_BATCH_ROWS,
  type TranscriptWorkBudget,
  transcriptRowFloorBudget,
  transcriptTailSpan,
} from '../core/transcript-work-budget'
import type { Chat, ChatId, Message, MessageId } from '../core/types'
import { browserSessionStorage } from '../lib/browser-storage'
import { PersistentStringMap } from '../lib/persistent-string-map'
import { newId } from '../lib/ulid'
import {
  attemptController,
  type ExactTargetPresentationReceipt,
  type TargetPresentationInterest,
} from './attempt-controller'
import type { ConversationRouteOwner } from './conversation-route-owner'
import {
  createWorkspaceMessageMaterialCoordinator,
  type GenerationPromptMaterialLease,
  type WorkspaceMessageMaterialCoordinator,
} from './generation-prompt-material'
import {
  classifyMessageHeaderRevision,
  differingMessageHeaderFields,
  type MessageHeaderRow,
  type MessagePresentation,
  previewTextFromContent,
  rebaseHydratedMessageHeader,
  type StructuralMessageHeader,
  sameMessageHeaderValue,
  sameMessageHeaderStructure as sameStructuralHeader,
  splitMessageForStorage,
  toStructuralMessageHeader,
} from './message-storage'
import type {
  CommittedConversationDestination,
  CommittedConversationTransition,
  WorkspaceFence,
} from './repository'
import {
  appendTranscriptBodyPage,
  emptyTranscriptBodyWindow,
  invalidateTranscriptBodyRows,
  prependTranscriptBodyPage,
  rebaseTranscriptBodyWindow,
  reidentifyTranscriptBodyWindow,
  retainTranscriptBodyWindowSpan,
  type TranscriptBodyPage,
  type TranscriptBodyPresentation,
  type TranscriptBodyWindow,
  transcriptBodyPointWindow,
  transcriptBodyWindowFindRow,
  transcriptBodyWindowFirstRow,
  transcriptBodyWindowFromPage,
  transcriptBodyWindowMatchesPath,
  transcriptBodyWindowNextStaleSpan,
  transcriptBodyWindowRows,
  transitionTranscriptBodyWindow,
  withTranscriptBodyRevisions,
} from './transcript-window'
import { WorkspaceLocalChildSlotAccumulator } from './workspace-local-evidence'
import type {
  ConversationForksResult,
  ConversationOpenResult,
  ConversationTopologyResult,
  GenerationPromptPathClaim,
  GenerationPromptPathRequirement,
  WorkspaceLocalChildSlotEvidence,
} from './workspace-protocol'
import { CONVERSATION_SESSION_PREFIX } from './workspace-tab-session'

type ConversationSelectionRecovery = 'retain' | 'canonicalize-default'

interface ConversationSelectionIntent {
  readonly selection: ActiveBranchSelection
  readonly unavailable: ConversationSelectionRecovery
}

interface ConversationSelectionAttemptBase {
  readonly id: string
  readonly chatId: ChatId
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly selectionRevision: number
  readonly intent: ConversationSelectionIntent
  readonly key: string
  readonly proofTarget: ConversationSelectionProofTarget
}

type ConversationSelectionAttempt = ConversationSelectionAttemptBase

interface ConversationOperationClaimBase {
  readonly id: string
  readonly chatId: ChatId
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly selectionRevision: number
}

interface SelectingConversationOperationClaimBase extends ConversationOperationClaimBase {
  readonly steering: 'select-result'
  readonly steeringRevision: number
}

export interface SessionSelectingConversationOperationClaim
  extends SelectingConversationOperationClaimBase {
  readonly selectionDelivery: 'session'
}

export interface RouteSelectingConversationOperationClaim
  extends SelectingConversationOperationClaimBase {
  readonly selectionDelivery: 'route-handoff'
  readonly routeOwner: ConversationRouteOwner
}

export type SelectingConversationOperationClaim =
  | SessionSelectingConversationOperationClaim
  | RouteSelectingConversationOperationClaim

export interface PreservingConversationOperationClaim extends ConversationOperationClaimBase {
  readonly steering: 'preserve'
}

export type ConversationOperationClaim =
  | SelectingConversationOperationClaim
  | PreservingConversationOperationClaim

export type ClaimedConversationDestination =
  | { readonly kind: 'pending' }
  | { readonly kind: 'ready'; readonly expectedLeafId: MessageId | null }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'superseded' }

export type ClaimedSelectedConversationPromptPath =
  | Exclude<ClaimedConversationDestination, { readonly kind: 'ready' }>
  | {
      readonly kind: 'ready'
      readonly expectedLeafId: MessageId | null
      readonly promptPath: ConversationPromptPathFrame
    }

const SELECTED_CONVERSATION_DESTINATION_CLAIM = Symbol('selected-conversation-destination-claim')

export interface SelectedConversationDestinationClaim {
  readonly [SELECTED_CONVERSATION_DESTINATION_CLAIM]: true
  readonly steering: SessionSelectingConversationOperationClaim
  readonly captured: Extract<
    ClaimedSelectedConversationPromptPath,
    { readonly kind: 'ready' }
  > | null
}

export type ConversationLocalResultEffect =
  | {
      readonly kind: 'preserve'
      readonly revealTargetMessageId?: MessageId
      readonly committedEffect?: ConversationCommittedEffect
    }
  | {
      readonly kind: 'select-committed'
      readonly receipt: CommittedConversationDestination
      readonly revealTargetMessageId?: MessageId
      readonly committedEffect: ConversationCommittedEffect
    }
  | {
      readonly kind: 'select-transition'
      readonly receipt: CommittedConversationTransition
      readonly revealTargetMessageId?: MessageId
      readonly committedEffect: ConversationCommittedEffect
    }

type SelectingLocalResultEffect = Exclude<
  ConversationLocalResultEffect,
  { readonly kind: 'preserve' }
>
export type PreservingLocalResultEffect = Extract<
  ConversationLocalResultEffect,
  { readonly kind: 'preserve' }
>

export type ConversationSurface = 'transcript' | 'tree'

export interface ConversationRevealEffect {
  readonly id: string
  readonly chatId: ChatId
  readonly targetMessageId: MessageId
  readonly selectionRevision: number
}

export interface ConversationPresentationSeal extends WorkspaceFence {
  readonly chatId: ChatId
  readonly selectionRevision: number
  readonly structuralVersion: number
  readonly leafId: MessageId | null
}

interface ConversationTranscriptBindingPayload {
  readonly surface: 'transcript'
  readonly seal: ConversationPresentationSeal
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
  readonly window: ConversationTranscriptFrame
  readonly selectionEpoch: number
  readonly viewportRevision: number
  readonly intentPresentations: readonly ConversationMessagePresentation[]
}

interface ConversationTreeBindingPayload {
  readonly surface: 'tree'
  readonly seal: ConversationPresentationSeal
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
  readonly headers: ConversationMessageHeaderLookup
  readonly topology: MessageTreeProjection<StructuralMessageHeader>
  readonly headerChangeRevision: number
  readonly changedHeaderKeys: readonly string[]
  readonly inspector: {
    readonly exact: ConversationMessagePresentation | null
    readonly retained: ConversationMessagePresentation | null
    readonly resolving: boolean
  }
  readonly previews: ReadonlyMap<MessageId, MessageTextPreview>
}

interface CurrentConversationBinding {
  readonly currency: 'current'
  readonly reveal: ConversationRevealEffect | null
}

interface RetainedConversationBinding {
  readonly currency: 'retained'
  readonly reveal: null
}

export type ConversationTranscriptSurface =
  | (ConversationTranscriptBindingPayload & CurrentConversationBinding)
  | (ConversationTranscriptBindingPayload & RetainedConversationBinding)
export type ConversationTreeSurface =
  | (ConversationTreeBindingPayload & CurrentConversationBinding)
  | (ConversationTreeBindingPayload & RetainedConversationBinding)
export type ConversationVisibleSurfaceBinding =
  | ConversationTranscriptSurface
  | ConversationTreeSurface
export type ConversationCurrentSurfaceBinding = Extract<
  ConversationVisibleSurfaceBinding,
  { readonly currency: 'current' }
>
export interface ConversationPaintedFrame {
  readonly chat: Chat
  readonly binding: ConversationVisibleSurfaceBinding
}
export interface ConversationResidentSurfaces {
  readonly transcript: ConversationTranscriptSurface | null
  readonly tree: ConversationTreeSurface | null
}
export type ConversationPresentationBlocker = 'module' | 'destination' | 'transcript' | 'topology'

export type ConversationPresentationTarget =
  | {
      readonly kind: 'pending'
      readonly surface: ConversationSurface
      readonly blocker: ConversationPresentationBlocker
    }
  | {
      readonly kind: 'failed'
      readonly surface: ConversationSurface
      readonly blocker: ConversationPresentationBlocker
      readonly message: string
    }
  | {
      readonly kind: 'ready'
      readonly binding: ConversationCurrentSurfaceBinding
    }

export interface ConversationPresentationFrame {
  readonly request: {
    readonly revision: number
    readonly surface: ConversationSurface
  }
  readonly visibleReady: boolean
  readonly painted: ConversationPaintedFrame | null
  readonly residents: ConversationResidentSurfaces
  readonly target: ConversationPresentationTarget
  readonly mounted: Readonly<Record<ConversationSurface, boolean>>
}

export type ConversationPresentationResourceState =
  | { readonly kind: 'idle' | 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'failed'; readonly message: string }

export interface ConversationPresentationResourcePort {
  get(surface: ConversationSurface): ConversationPresentationResourceState
  request(surface: ConversationSurface): void
  subscribe(listener: () => void): () => void
}

export type ConversationMessagePresentation = TranscriptBodyPresentation

export type ConversationTranscriptPage = TranscriptBodyPage
export type ConversationTranscriptFrame = TranscriptBodyWindow
export type ConversationTranscriptPageResult =
  | {
      readonly kind: 'ready'
      readonly structuralVersion: number
      readonly page: ConversationTranscriptPage
      readonly material: readonly MessagePresentation[]
    }
  | {
      readonly kind: 'stale-selection'
      readonly material: readonly MessagePresentation[]
    }

interface TranscriptPresentationPlan {
  readonly selectionRevision: number
  readonly selectionEpoch: number
  readonly pathIdentity: object
  readonly demandBudget: TranscriptWorkBudget
  readonly budget: TranscriptWorkBudget
  readonly span: BranchPathSpan
  readonly residentFloorOffset: number | null
  readonly lastExpansionBoundaryOffset: number | null
}

interface TranscriptFillFence {
  readonly selectionEpoch: number
  readonly pathIdentity: object
}

type TranscriptFill =
  | (TranscriptFillFence & {
      readonly kind: 'choose'
      readonly commonPrefix: ConversationTranscriptFrame
      readonly terminalFallback: ConversationTranscriptFrame | null
    })
  | (TranscriptFillFence & {
      readonly kind: 'append' | 'prepend'
      readonly window: ConversationTranscriptFrame
    })

type ActiveTranscriptState =
  | { readonly kind: 'absent'; readonly selectionEpoch: number }
  | {
      readonly kind: 'point'
      readonly selectionEpoch: number
      readonly attemptId: string
      readonly tipId: MessageId
      readonly window: ConversationTranscriptFrame
    }
  | {
      readonly kind: 'retained'
      readonly selectionEpoch: number
      readonly window: ConversationTranscriptFrame
    }
  | {
      readonly kind: 'ready'
      readonly selectionEpoch: number
      readonly window: ConversationTranscriptFrame
    }

export type ConversationTranscriptProjection =
  | { readonly kind: 'absent'; readonly selectionEpoch: number; readonly resolving: boolean }
  | {
      readonly kind: 'point'
      readonly selectionEpoch: number
      readonly window: ConversationTranscriptFrame
      readonly resolving: boolean
    }
  | {
      readonly kind: 'retained'
      readonly selectionEpoch: number
      readonly window: ConversationTranscriptFrame
      readonly resolving: boolean
    }
  | {
      readonly kind: 'ready'
      readonly selectionEpoch: number
      readonly window: ConversationTranscriptFrame
      readonly filling: boolean
    }

export interface TranscriptDemand {
  readonly chatId: ChatId
  readonly selectionRevision: number
  readonly selectionEpoch: number
  readonly budget: TranscriptWorkBudget
}

interface TranscriptDemandPlan extends TranscriptDemand {
  readonly residency: 'monotonic' | 'settled'
}

interface TranscriptRetention {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly selectionRevision: number
  readonly selectionEpoch: number
  readonly precedingRowCount: number
}

export interface ConversationTranscriptRetentionClaim {
  readonly kind: 'conversation-transcript-retention'
  readonly chatId: ChatId
  readonly messageId: MessageId
  release(): void
}

interface InspectorDemand {
  readonly chatId: ChatId
  readonly messageId: MessageId
}

export const TREE_PREVIEW_MAX_CHARS = 960

export interface TreePreviewTarget {
  readonly messageId: MessageId
  readonly bodyVersion: number
}

interface TreePreviewDemand {
  readonly chatId: ChatId
  readonly targets: readonly TreePreviewTarget[]
}

export interface MessageTextPreview {
  readonly messageId: MessageId
  readonly bodyVersion: number
  readonly text: string
}

export interface ConversationReadEnvelope<T> extends WorkspaceFence {
  readonly value: T
}

export interface ConversationProjectionSource {
  loadChat(chatId: ChatId, signal: AbortSignal): Promise<ConversationReadEnvelope<Chat | undefined>>
  openSelection(
    chatId: ChatId,
    target: ConversationSelectionProofTarget,
    onPoint: ((point: ConversationReadEnvelope<ConversationDestinationPoint>) => void) | undefined,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationProjectionOpenResult>>
  loadForks(
    chatId: ChatId,
    structuralVersion: number,
    targets: readonly ActiveBranchForkTarget[],
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationForksResult>>
  loadChildAtPosition(
    chatId: ChatId,
    parentId: MessageId | null,
    position: number,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<MessageId | null>>
  loadTopology(
    chatId: ChatId,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationTopologyResult>>
  loadTranscriptPage(
    chatId: ChatId,
    leafId: MessageId,
    structuralVersion: number,
    window: BranchPathWindow<MessageHeaderRow>,
    material: WorkspaceMessageMaterialCoordinator,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationTranscriptPageResult>>
  loadInspector(
    chatId: ChatId,
    messageId: MessageId,
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<ConversationMessagePresentation | null>>
  loadPreviews(
    chatId: ChatId,
    targets: readonly TreePreviewTarget[],
    signal: AbortSignal,
  ): Promise<ConversationReadEnvelope<readonly MessageTextPreview[]>>
}

export type ConversationProjectionOpenResult =
  | Exclude<ConversationOpenResult, ConversationProvedSelection>
  | SealedConversationSelection

export interface ConversationMessageRevisionObservation {
  readonly header: MessageHeaderRow
  readonly structuralVersion: number
  readonly presentation?: ConversationMessagePresentation
}

export type ConversationProjectionScope<Id> = true | readonly Id[]

export interface ConversationProjectionRefresh {
  readonly chat?: boolean
  readonly headers?: ConversationProjectionScope<MessageId>
  readonly bodies?: ConversationProjectionScope<MessageId>
  readonly previews?: ConversationProjectionScope<MessageId>
  readonly forkParentIds?: ConversationProjectionScope<MessageId | null>
}

export type ConversationStructuralTransition =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'exact-delta'
      readonly toVersion: number
      readonly structuralVersions: readonly number[]
      readonly messageIds: readonly MessageId[]
    }
  | {
      readonly kind: 'incomplete'
      readonly toVersion: number | null
      readonly scope: ConversationProjectionScope<MessageId>
    }

interface ConversationCommittedEffectBase extends WorkspaceFence {
  readonly chatId: ChatId
  readonly source: 'local' | 'remote' | 'invalidation'
}

export type ConversationCommittedEffect =
  | (ConversationCommittedEffectBase & { readonly kind: 'deleted' })
  | (ConversationCommittedEffectBase & {
      readonly kind: 'changed'
      readonly structural: ConversationStructuralTransition
      readonly chat?: Chat
      readonly revisions?: readonly ConversationMessageRevisionObservation[]
      readonly childSlots?: readonly WorkspaceLocalChildSlotEvidence[]
      readonly refresh?: ConversationProjectionRefresh
    })

type ConversationChangedCommittedEffect = Extract<
  ConversationCommittedEffect,
  { readonly kind: 'changed' }
>

type ConversationReadKind =
  | 'chat'
  | 'selection'
  | 'sibling-navigation'
  | 'sibling-position'
  | 'forks'
  | 'topology'
  | 'transcript'
  | 'inspector'
  | 'previews'

type ConversationCommittedEffectPhaseResult = 'ignored' | 'applied' | 'failed' | 'recovered'

export interface ConversationProjectionFailure {
  readonly kind: ConversationReadKind
  readonly code: 'read-failed' | 'source-invariant'
  readonly key: string
  readonly observationRevision: number
  readonly message: string
}

interface ConversationDestinationReadyProjection {
  readonly kind: 'ready'
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
}

export type ConversationDestinationProjection =
  | {
      readonly kind: 'unresolved'
      readonly retained: ConversationDestinationReadyProjection | null
    }
  | {
      readonly kind: 'resolving'
      readonly key: string
      readonly retained: ConversationDestinationReadyProjection | null
    }
  | ConversationDestinationReadyProjection
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'unavailable'
      readonly selection: ActiveBranchSelection
      readonly reason: ActiveBranchTargetUnavailableReason
      readonly retained: ConversationDestinationReadyProjection | null
    }
  | {
      readonly kind: 'failed'
      readonly failure: ConversationProjectionFailure
      readonly retained: ConversationDestinationReadyProjection | null
    }

export interface ConversationChatSnapshot {
  readonly chatId: ChatId
  readonly chat: Chat | null
  readonly selectionRevision: number
  readonly transcriptSelectionEpoch: number
  readonly viewportRevision: number
  readonly selectionTargetId: MessageId | null
  readonly destination: ConversationDestinationProjection
  readonly headerFacts: ConversationMessageHeaderLookup
  readonly structuralTopology: MessageTreeProjection<StructuralMessageHeader>
  readonly headerChangeRevision: number
  readonly changedHeaderKeys: readonly string[]
  readonly topologyLoaded: boolean
  readonly transcript: ConversationTranscriptProjection
  readonly inspector: {
    readonly exact: ConversationMessagePresentation | null
    readonly retained: ConversationMessagePresentation | null
    readonly resolving: boolean
  }
  readonly previews: ReadonlyMap<MessageId, MessageTextPreview>
  readonly failure: ConversationProjectionFailure | null
  readonly presentation: ConversationPresentationFrame
}

export interface ConversationMessageHeaderLookup {
  get(messageId: MessageId): MessageHeaderRow | undefined
  has(messageId: MessageId): boolean
}

export interface ConversationSnapshot {
  readonly workspaceId: string | null
  readonly workspaceEpoch: number
  readonly activeChatId: ChatId | null
  readonly active: ConversationChatSnapshot | null
}

export interface ConversationRouteHandoff extends WorkspaceFence {
  readonly id: string
  readonly chatId: ChatId
  cancel(): void
}

interface PendingConversationRouteHandoff {
  readonly handoff: ConversationRouteHandoff
  readonly seed: SealedConversationSelection
  readonly revealTargetMessageId?: MessageId
  readonly releaseOwnerAbort: () => void
  reducer: PendingConversationHandoffReducer
}

type ConversationCommittedEffectSource = ConversationCommittedEffect['source']

interface PendingConversationRevisionFact {
  readonly observation: ConversationMessageRevisionObservation
  readonly headerSequence: number
  readonly headerSource: ConversationCommittedEffectSource
  readonly presentationSequence: number | null
}

interface PendingConversationChatFact {
  readonly chat: Chat
  readonly sequence: number
}

interface PendingConversationChildSlotFact {
  readonly evidence: WorkspaceLocalChildSlotEvidence
  readonly sequence: number
}

interface PendingConversationStructuralSummary {
  readonly maxToVersion: number | null
  readonly exactToVersion: number | null
  readonly structuralVersions: readonly number[]
  readonly messageIds: readonly MessageId[]
}

interface PendingConversationInvalidationScope<Id> {
  readonly globalSequence: number | null
  readonly sequencesById: ReadonlyMap<Id, number>
}

interface PendingConversationHandoffReduction {
  readonly kind: 'changed' | 'deleted'
  readonly chat: PendingConversationChatFact | null
  readonly revisions: readonly PendingConversationRevisionFact[]
  readonly childSlots: readonly PendingConversationChildSlotFact[]
  readonly structural: PendingConversationStructuralSummary
  readonly refresh: {
    readonly chatSequence: number | null
    readonly headers: PendingConversationInvalidationScope<MessageId>
    readonly bodies: PendingConversationInvalidationScope<MessageId>
    readonly previews: PendingConversationInvalidationScope<MessageId>
    readonly topology: PendingConversationInvalidationScope<MessageId>
    readonly forkParentIds: PendingConversationInvalidationScope<MessageId | null>
  }
}

interface PendingConversationHandoffReadPlan {
  readonly chat: boolean
  readonly destination: boolean
  readonly topology: boolean
  readonly forkParentIds: ConversationProjectionScope<MessageId | null> | undefined
}

const EMPTY_PENDING_HANDOFF_READ_PLAN_WITH_DESTINATION: PendingConversationHandoffReadPlan =
  Object.freeze({
    chat: false,
    destination: true,
    topology: false,
    forkParentIds: undefined,
  })

export type ConversationSessionResultReceipt =
  | { readonly accepted: false }
  | { readonly accepted: true }

export type ConversationRouteResultReceipt =
  | { readonly accepted: false }
  | { readonly accepted: true; readonly routeDelivery: ConversationRouteDelivery }

export type ConversationRouteDelivery =
  | { readonly kind: 'handoff'; readonly handoff: ConversationRouteHandoff }
  | { readonly kind: 'superseded' }

export type ConversationLocalResultReceipt =
  | ConversationSessionResultReceipt
  | ConversationRouteResultReceipt

export interface ConversationRouteArrival {
  readonly id: string
  readonly route: {
    readonly chatId: ChatId
    readonly targetMessageId?: MessageId
    readonly handoff?: ConversationRouteHandoff
  } | null
}

export interface ConversationNavigationPort {
  getArrival(): ConversationRouteArrival
  subscribeArrival(listener: () => void): () => void
  replaceConversationUrl(chatId: ChatId, targetMessageId?: MessageId): void
}

export interface ConversationViewportTransition {
  readonly workspaceEpoch: number
  readonly chatId: ChatId
  readonly revision: number
  readonly fromSelectionKey: MessageId | null
  readonly toSelectionKey: MessageId | null
  readonly kind: 'prepend' | 'content' | 'reveal'
  readonly revealTargetMessageId?: MessageId
}

export type ConversationViewportPreparation =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'unavailable' }

export interface ConversationViewportPort {
  readonly chatId: ChatId
  prepare(transition: ConversationViewportTransition): ConversationViewportPreparation
}

interface ChatSessionBase {
  selectionRevision: number
  steeringRevision: number
  presentationRequest: {
    revision: number
    surface: ConversationSurface
  }
  intent: ConversationSelectionIntent
  cursor: TabBranchCursor
  pendingRevealTargetId?: MessageId
}

type ChatSession = ChatSessionBase

type SelectedBranchStep =
  | { readonly kind: 'child'; readonly messageId: MessageId }
  | { readonly kind: 'terminal' }

const TERMINAL_BRANCH_STEP: SelectedBranchStep = Object.freeze({ kind: 'terminal' })

class TabBranchCursor {
  private readonly steps: PersistentStringMap<SelectedBranchStep>

  private constructor(steps: PersistentStringMap<SelectedBranchStep>) {
    this.steps = steps
  }

  static empty(): TabBranchCursor {
    return new TabBranchCursor(PersistentStringMap.empty())
  }

  rememberTerminal(targetId: MessageId): MessageId | undefined {
    const seen = new Set<MessageId>()
    let current = targetId
    for (;;) {
      if (seen.has(current)) return undefined
      seen.add(current)
      const step = this.steps.get(current)
      if (!step) return undefined
      if (step.kind === 'terminal') return current
      current = step.messageId
    }
  }

  accept(
    path: BranchPathDescriptor<MessageHeaderRow>,
    previousPath: BranchPathDescriptor<MessageHeaderRow> | null,
  ): TabBranchCursor {
    if (path.length === 0) return this
    const sharedPrefixLength = previousPath
      ? path.divergenceFrom(previousPath).commonPrefixLength
      : 0
    const patchOffset = Math.max(0, sharedPrefixLength - 1)
    const messageIds = path
      .window({ offset: patchOffset, limit: path.length - patchOffset })
      .nodes.map((header) => header.id)
    let steps = this.steps
    for (let index = 0; index < messageIds.length - 1; index += 1) {
      const messageId = messageIds[index] as MessageId
      const childId = messageIds[index + 1] as MessageId
      const current = steps.get(messageId)
      if (current?.kind === 'child' && current.messageId === childId) continue
      steps = steps.set(messageId, Object.freeze({ kind: 'child', messageId: childId }))
    }
    const terminalId = messageIds.at(-1) as MessageId
    if (steps.get(terminalId)?.kind !== 'terminal') {
      steps = steps.set(terminalId, TERMINAL_BRANCH_STEP)
    }
    return steps === this.steps ? this : new TabBranchCursor(steps)
  }
}

type ActiveTopologyState =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'exact'
      readonly structuralVersion: number
      readonly index: MessageTopologyIndex<StructuralMessageHeader>
      readonly projection: MessageTreeProjection<StructuralMessageHeader>
      readonly headerById: ReadonlyMap<MessageId, MessageHeaderRow>
      readonly headers: ConversationMessageHeaderLookup
      readonly provedPathIdentity: object | null
    }

interface ActiveProjection {
  chatId: ChatId
  chat: Chat | null
  selectionAttempt: ConversationSelectionAttempt | null
  destination: ConversationDestinationProjection
  headers: PersistentStringMap<MessageHeaderRow>
  headerFacts: ConversationMessageHeaderLookup
  headerFactsHeaders: PersistentStringMap<MessageHeaderRow>
  headerFactsPath: BranchPathDescriptor<MessageHeaderRow> | null
  treeHeaderFacts: ConversationMessageHeaderLookup
  treeHeaderFactsSource: ConversationMessageHeaderLookup
  treeHeaderFactsTopology: MessageTreeProjection<StructuralMessageHeader> | null
  treeChangedHeaderKeys: readonly string[]
  treeChangedHeaderKeysSource: readonly string[]
  treeChangedHeaderKeysTopology: MessageTreeProjection<StructuralMessageHeader> | null
  compactableHeaderIds: Set<MessageId>
  forks: PersistentStringMap<ActiveBranchForkSlot>
  topology: ActiveTopologyState
  headerChangeRevision: number
  changedHeaderKeys: readonly string[]
  transcript: ActiveTranscriptState
  transcriptFill: TranscriptFill | null
  transcriptPlan: TranscriptPresentationPlan | null
  inspector: {
    exact: ConversationMessagePresentation | null
    retained: ConversationMessagePresentation | null
    resolvingKey: string | null
  }
  previews: Map<MessageId, MessageTextPreview>
  previewSnapshot: ReadonlyMap<MessageId, MessageTextPreview>
  failure: ConversationProjectionFailure | null
  presentationResidents: {
    transcript: ConversationTranscriptSurface | null
    tree: ConversationTreeSurface | null
  }
  presentationSeal: ConversationPresentationSeal | null
  reveal: ConversationRevealEffect | null
}

interface AppliedHeaderObservations {
  readonly changedIds: readonly MessageId[]
  readonly structurallyChangedIds: ReadonlySet<MessageId>
  readonly byId: ReadonlyMap<MessageId, MessageHeaderRow | undefined>
}

interface ClassifiedHeaderObservation {
  readonly header: MessageHeaderRow
  readonly structureChanged: boolean
}

type HeaderAdmissionContext =
  | {
      readonly kind: 'committed'
      readonly structural: ConversationStructuralTransition
      readonly fallback: 'defer-to-sealed-replacement' | 'resolve-if-invalidated'
      readonly paintedTranscript?: ConversationTranscriptFrame | null
    }
  | { readonly kind: 'topology-snapshot' }
  | { readonly kind: 'body-snapshot' }

type PathReduction =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'compatible'; readonly replacements: readonly MessageHeaderRow[] }
  | { readonly kind: 'structurally-invalidated' }

type SelectionAdmissionResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'structural-conflict'; readonly observationRevision: number }

type ReadKind = ConversationReadKind

interface PendingRead {
  key: string
  observationRevision: number
  controller: AbortController
}

interface BlockedRead {
  readonly key: string
  readonly observationRevision: number
}

const TOPOLOGY_OPTIONS: MessageTopologyOptions<StructuralMessageHeader> = {
  sameStructure: sameStructuralHeader,
  sameValue: sameStructuralHeader,
}

const EMPTY_TOPOLOGY = createMessageTopologyIndex<StructuralMessageHeader>([], TOPOLOGY_OPTIONS)
const EMPTY_STRUCTURAL_TOPOLOGY = structuralTopologyView(EMPTY_TOPOLOGY)
const EMPTY_CONVERSATION_MESSAGE_PRESENTATIONS = Object.freeze(
  [],
) as readonly ConversationMessagePresentation[]
const ABSENT_TOPOLOGY: ActiveTopologyState = Object.freeze({ kind: 'absent' })
const FULL_PROJECTION_REFRESH: ConversationProjectionRefresh = Object.freeze({
  chat: true,
  headers: true,
  bodies: true,
  previews: true,
})
const FULL_STRUCTURAL_REFRESH: ConversationStructuralTransition = Object.freeze({
  kind: 'incomplete',
  toVersion: null,
  scope: true,
})
export interface ConversationController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ConversationSnapshot
  setProjectionSource(source: ConversationProjectionSource | null): void
  setNavigationPort(port: ConversationNavigationPort | null): void
  installPresentationResourcePort(port: ConversationPresentationResourcePort | null): () => void
  installViewportPort(port: ConversationViewportPort): () => void
  navigate(
    input:
      | {
          chatId: ChatId
          kind: 'message'
          messageId: MessageId
          observedTipId?: MessageId
        }
      | {
          chatId: ChatId
          kind: 'sibling-position'
          parentId: MessageId | null
          position: number
        },
  ): void
  resolveSiblingPosition(
    chatId: ChatId,
    parentId: MessageId | null,
    position: number,
  ): Promise<MessageId | null>
  capturePromptPathFrame(workspaceFence: WorkspaceFence): ConversationPromptPathFrame
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
  }): SessionSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
    selectionDelivery: 'session'
  }): SessionSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
    selectionDelivery: 'route-handoff'
    routeOwner: ConversationRouteOwner
  }): RouteSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'preserve'
  }): PreservingConversationOperationClaim
  resolveOperationDestination(
    claim: SessionSelectingConversationOperationClaim,
  ): ClaimedConversationDestination
  presentGenerationIntent(
    claim: SessionSelectingConversationOperationClaim,
    input: {
      readonly baseLeafId: MessageId | null
      readonly messages: readonly Message[]
    },
  ): void
  claimSelectedDestination(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
  }): SelectedConversationDestinationClaim
  resolveSelectedDestination(
    claim: SelectedConversationDestinationClaim,
  ): ClaimedConversationDestination
  resolveSelectedPromptPath(
    claim: SelectedConversationDestinationClaim,
  ): ClaimedSelectedConversationPromptPath
  cancelSelectedDestination(claim: SelectedConversationDestinationClaim): void
  acceptLocalResult(
    claim: SessionSelectingConversationOperationClaim,
    effect: SelectingLocalResultEffect,
  ): ConversationSessionResultReceipt
  acceptLocalResult(
    claim: RouteSelectingConversationOperationClaim,
    effect: SelectingLocalResultEffect,
  ): ConversationRouteResultReceipt
  acceptLocalResult(
    claim: PreservingConversationOperationClaim,
    effect: PreservingLocalResultEffect,
  ): ConversationSessionResultReceipt
  acceptLocalResult(
    claim: ConversationOperationClaim,
    effect: ConversationLocalResultEffect,
  ): ConversationLocalResultReceipt
  cancelOperation(claim: ConversationOperationClaim): void
  applyCommittedEffect(effect: ConversationCommittedEffect): void
  applyCommittedEffects(effects: readonly ConversationCommittedEffect[]): void
  admitExactPresentation(
    fence: WorkspaceFence,
    presentation: ConversationMessagePresentation,
  ): boolean
  observedCommitChatIds(): readonly ChatId[]
  reconcileWorkspace(fence: WorkspaceFence): void
  claimTranscriptRetention(input: {
    chatId: ChatId
    messageId: MessageId
  }): ConversationTranscriptRetentionClaim
  setTranscriptDemand(owner: object, demand: TranscriptDemand | null): void
  setSettledTranscriptWorkScale(minimumRowCount: number): void
  expandTranscriptDemand(input: {
    chatId: ChatId
    selectionRevision: number
    selectionEpoch: number
    boundaryOffset: number
  }): void
  retryTranscriptDemand(input: {
    chatId: ChatId
    selectionRevision: number
    selectionEpoch: number
  }): void
  setInspectorDemand(owner: object, demand: InspectorDemand | null): void
  setTreePreviewDemand(owner: object, demand: TreePreviewDemand | null): void
  requestPresentation(input: {
    chatId: ChatId
    surface: ConversationSurface
    revealTargetMessageId?: MessageId
  }): void
  consumePresentationReveal(effectId: string, surface: ConversationSurface): void
}

export interface ConversationTargetPresentationPort {
  targetPresentationInterests(chatId: ChatId): readonly TargetPresentationInterest[]
  publishExactTargetPresentations(receipts: readonly ExactTargetPresentationReceipt[]): void
}

export type ConversationPromptPathCapability = 'pending' | 'available' | 'unavailable' | 'error'

export interface ConversationPromptPathFrame {
  readonly workspaceId: string | null
  readonly replacementEpoch: number | null
  readonly chatId: ChatId | null
  capability(target: GenerationCapabilityTarget): ConversationPromptPathCapability
  capture(
    requirement: Extract<GenerationPromptPathRequirement, { readonly surface: 'chat' }>,
  ): ConversationPromptPathCapture | null
}

export interface ConversationPromptPathCapture {
  readonly claim: GenerationPromptPathClaim
  readonly material: GenerationPromptMaterialLease
}

class TabConversationController implements ConversationController {
  private readonly listeners = new Set<() => void>()
  private readonly targetPresentationPort: ConversationTargetPresentationPort | null
  private readonly sessions = new Map<ChatId, ChatSession>()
  private readonly operationClaims = new Map<string, ConversationOperationClaim>()
  private readonly operationClaimCountsByChat = new Map<ChatId, number>()
  private readonly generationIntentPresentations = new Map<
    string,
    {
      readonly claim: SessionSelectingConversationOperationClaim
      readonly baseLeafId: MessageId | null
      readonly presentations: readonly ConversationMessagePresentation[]
    }
  >()
  private readonly pendingRouteHandoffsByOwnerId = new Map<
    string,
    PendingConversationRouteHandoff
  >()
  private readonly transcriptDemands = new Map<object, TranscriptDemand>()
  private readonly transcriptRetentions = new Map<object, TranscriptRetention>()
  private readonly inspectorDemands = new Map<object, InspectorDemand>()
  private readonly previewDemands = new Map<object, TreePreviewDemand>()
  private readonly reads = new Map<ReadKind, PendingRead>()
  private readonly blockedReads = new Map<ReadKind, BlockedRead>()
  private readonly pendingForkParentIds = new Set<MessageId | null>()
  private settledTranscriptBudget = transcriptRowFloorBudget(DEFAULT_TRANSCRIPT_INITIAL_ROW_COUNT)
  private pendingForkChatId: ChatId | null = null
  private pendingForkSelectionRevision: number | null = null
  private source: ConversationProjectionSource | null = null
  private navigationPort: ConversationNavigationPort | null = null
  private presentationResourcePort: ConversationPresentationResourcePort | null = null
  private unsubscribePresentationResources: (() => void) | null = null
  private viewportPort: ConversationViewportPort | null = null
  private viewportTransitionRevision = 0
  private lastNavigationPort: ConversationNavigationPort | null = null
  private unsubscribeNavigation: (() => void) | null = null
  private lastRouteArrivalId: string | null = null
  private lastProjectedRouteKey: string | null = null
  private workspaceId: string | null = null
  private workspaceEpoch = 0
  private materialCoordinator: WorkspaceMessageMaterialCoordinator | null = null
  private observationRevision = 0
  private promptPathRevision = 0
  private activeChatId: ChatId | null = null
  private active: ActiveProjection | null = null
  private paintedFrame: ConversationPaintedFrame | null = null
  private promptPathFrameCache: {
    readonly workspaceId: string
    readonly replacementEpoch: number
    readonly chatId: ChatId
    readonly destination: ConversationDestinationProjection
    readonly topology: ActiveTopologyState
    readonly topologyFailed: boolean
    readonly promptPathRevision: number
    readonly frame: ConversationPromptPathFrame
  } | null = null
  private snapshot: ConversationSnapshot = Object.freeze({
    workspaceId: null,
    workspaceEpoch: 0,
    activeChatId: null,
    active: null,
  })

  constructor(targetPresentationPort: ConversationTargetPresentationPort | null = null) {
    this.targetPresentationPort = targetPresentationPort
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ConversationSnapshot => this.snapshot

  setProjectionSource(source: ConversationProjectionSource | null): void {
    if (this.source === source) return
    this.cancelAllReads()
    this.observationRevision += 1
    this.source = source
    if (!source) {
      this.materialCoordinator?.release()
      this.materialCoordinator = null
      this.publish()
      return
    }
    if (!this.activeChatId) return
    this.applyCommittedEffect({
      workspaceId: this.workspaceId as string,
      replacementEpoch: this.workspaceEpoch,
      chatId: this.activeChatId,
      source: 'invalidation',
      kind: 'changed',
      structural: FULL_STRUCTURAL_REFRESH,
      refresh: FULL_PROJECTION_REFRESH,
    })
  }

  setNavigationPort(port: ConversationNavigationPort | null): void {
    if (this.navigationPort === port) return
    this.unsubscribeNavigation?.()
    this.unsubscribeNavigation = null
    this.navigationPort = port
    if (!port) return
    if (this.lastNavigationPort !== port) {
      this.lastRouteArrivalId = null
      this.lastProjectedRouteKey = null
      this.lastNavigationPort = port
    }
    this.unsubscribeNavigation = port.subscribeArrival(() => this.consumeRouteArrival())
    this.consumeRouteArrival()
  }

  installPresentationResourcePort(port: ConversationPresentationResourcePort | null): () => void {
    if (this.presentationResourcePort === port) return () => undefined
    this.unsubscribePresentationResources?.()
    this.unsubscribePresentationResources = null
    this.presentationResourcePort = port
    if (port) {
      this.unsubscribePresentationResources = port.subscribe(() => {
        if (this.presentationResourcePort !== port) return
        this.publish()
        this.refreshPresentationDemands()
      })
      const session = this.activeSession()
      if (session) port.request(session.presentationRequest.surface)
    }
    this.publish()
    this.refreshPresentationDemands()
    return () => {
      if (this.presentationResourcePort !== port) return
      this.unsubscribePresentationResources?.()
      this.unsubscribePresentationResources = null
      this.presentationResourcePort = null
      this.publish()
      this.refreshPresentationDemands()
    }
  }

  installViewportPort(port: ConversationViewportPort): () => void {
    this.viewportPort = port
    this.publish()
    return () => {
      if (this.viewportPort !== port) return
      this.viewportPort = null
      this.publish()
    }
  }

  private consumeRouteArrival(): boolean {
    const arrival = this.navigationPort?.getArrival()
    if (!arrival || arrival.id === this.lastRouteArrivalId || this.workspaceId === null) {
      return false
    }
    try {
      this.lastProjectedRouteKey = null
      let published = false
      if (arrival.route) {
        this.openRoute(arrival.route)
        published = true
      } else if (this.activeChatId !== null) {
        this.leaveActiveRoute()
        published = true
      }
      this.lastRouteArrivalId = arrival.id
      return published
    } catch (error) {
      arrival.route?.handoff?.cancel()
      throw error
    }
  }

  private openRoute(route: {
    chatId: ChatId
    targetMessageId?: MessageId
    handoff?: ConversationRouteHandoff
  }): void {
    let handoffReadPlan: PendingConversationHandoffReadPlan | null = null
    const changedChat = this.activeChatId !== route.chatId
    const previousChatId = changedChat ? this.activeChatId : null
    if (previousChatId) this.compactSession(previousChatId)
    const session = this.activateSession(route.chatId)
    this.presentationResourcePort?.request(session.presentationRequest.surface)
    this.activeChatId = route.chatId
    if (changedChat) {
      this.cancelAllReads()
      this.active = newActiveProjection(route.chatId)
    }
    const active = this.active as ActiveProjection
    if (route.targetMessageId !== undefined) {
      route.handoff?.cancel()
      const alreadySelected =
        !changedChat && this.activeSpine()?.resolvedLeafId === route.targetMessageId
      if (!alreadySelected) {
        const preservesTabTip =
          session.intent.selection.kind === 'tip' &&
          session.intent.selection.messageId === route.targetMessageId
        session.selectionRevision += 1
        session.intent = conversationSelectionIntent(
          preservesTabTip
            ? session.intent.selection
            : this.messageSelection(session, route.targetMessageId),
          'canonicalize-default',
        )
        this.beginSelectionResolution()
      }
      this.clearReveals(route.chatId, session)
      this.installReveal(route.chatId, session, route.targetMessageId)
    } else if (
      route.handoff &&
      this.matchesWorkspace(route.handoff) &&
      route.handoff.chatId === route.chatId
    ) {
      const pending = this.pendingRouteHandoffsByOwnerId.get(route.handoff.id)
      if (
        pending?.handoff === route.handoff &&
        pending.seed.chat.id === route.chatId &&
        pending.seed.proof.chatId === route.chatId
      ) {
        this.deletePendingRouteHandoff(route.handoff.id)
        const seed = pending.seed
        const reduction = pending.reducer.reduce(seed)
        if (reduction.kind === 'deleted') {
          this.deleteChatState(route.chatId)
          this.publish()
          return
        }
        session.selectionRevision += 1
        session.intent = conversationSelectionIntent(seed.target.selection)
        const admission = this.admitSealedSelection(session, seed)
        if (admission.kind === 'structural-conflict') {
          this.beginSelectionResolution(false)
          handoffReadPlan = EMPTY_PENDING_HANDOFF_READ_PLAN_WITH_DESTINATION
        } else {
          handoffReadPlan = this.applyPendingRouteHandoffReduction(seed, reduction)
        }
        if (pending.revealTargetMessageId) {
          this.installReveal(route.chatId, session, pending.revealTargetMessageId)
        }
      } else {
        route.handoff.cancel()
        if (!this.activeSpine()) this.beginSelectionResolution()
      }
    } else {
      route.handoff?.cancel()
      if (!this.activeSpine()) {
        this.beginSelectionResolution()
      }
    }
    if (session.pendingRevealTargetId) {
      this.installReveal(route.chatId, session, session.pendingRevealTargetId)
      delete session.pendingRevealTargetId
    }
    if (previousChatId) this.persistSession(previousChatId)
    this.persistSession(route.chatId)
    this.publish()
    if (handoffReadPlan) this.executePendingRouteHandoffReads(handoffReadPlan)
    if (active.chat === null || !this.activeSpine()) {
      this.requestDestination(route.chatId)
    }
    this.requestTopology()
    this.refreshBodyDemands()
  }

  private leaveActiveRoute(): void {
    const chatId = this.activeChatId
    if (!chatId) return
    this.cancelAllReads()
    this.compactSession(chatId)
    this.activeChatId = null
    this.active = null
    this.paintedFrame = null
    this.persistSession(chatId)
    this.publish()
  }

  navigate(
    input:
      | {
          chatId: ChatId
          kind: 'message'
          messageId: MessageId
          observedTipId?: MessageId
        }
      | {
          chatId: ChatId
          kind: 'sibling-position'
          parentId: MessageId | null
          position: number
        },
  ): void {
    const current = this.getOrCreateSession(input.chatId)
    const selection: ActiveBranchSelection =
      input.kind === 'sibling-position'
        ? { kind: 'sibling-position', parentId: input.parentId, position: input.position }
        : this.messageSelection(current, input.messageId, input.observedTipId)
    if (this.activeChatId !== input.chatId) {
      current.selectionRevision += 1
      this.clearReveals(input.chatId, current)
      this.compactSession(input.chatId, conversationSelectionIntent(selection))
      this.persistSession(input.chatId)
      this.publish()
      return
    }
    const session = this.activateSession(input.chatId)
    session.selectionRevision += 1
    this.clearReveals(input.chatId, session)
    session.intent = conversationSelectionIntent(selection)
    this.beginSelectionResolution()
    this.persistSession(input.chatId)
    this.publish()
    if (input.kind === 'sibling-position') {
      this.requestSiblingNavigation(session, input.parentId, input.position)
    } else {
      this.requestDestination(input.chatId)
    }
  }

  private requestSiblingNavigation(
    session: ChatSession,
    parentId: MessageId | null,
    position: number,
    expected?: {
      readonly intent: ConversationSelectionIntent
      readonly selectionRevision: number
    },
  ): void {
    const source = this.source
    const active = this.active
    if (!source || !active || this.workspaceId === null) return
    const intent = expected?.intent ?? session.intent
    const selectionRevision = expected?.selectionRevision ?? session.selectionRevision
    if (
      this.activeSession() !== session ||
      session.intent !== intent ||
      session.selectionRevision !== selectionRevision
    ) {
      return
    }
    const chatId = active.chatId
    const key = `${this.workspaceKey()}:${chatId}:${selectionRevision}:sibling:${parentId ?? '__root__'}:${position}`
    const read = this.startRead('sibling-navigation', key)
    void source.loadChildAtPosition(chatId, parentId, position, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('sibling-navigation', read)) return
        const currentSession = this.activeSession()
        if (
          !this.matchesWorkspace(envelope) ||
          this.active?.chatId !== chatId ||
          currentSession !== session ||
          currentSession.intent !== intent ||
          currentSession.selectionRevision !== selectionRevision
        ) {
          this.reconcileReadConflict(
            'sibling-navigation',
            read,
            key,
            new Error('ConversationSiblingNavigationStateMismatch'),
            () =>
              this.requestSiblingNavigation(session, parentId, position, {
                intent,
                selectionRevision,
              }),
          )
          return
        }
        this.finishRead('sibling-navigation', read)
        const targetId = envelope.value
        if (!targetId) {
          this.settleSelectionDestination(
            Object.freeze({
              kind: 'unavailable',
              selection: intent.selection,
              reason: 'sibling-position-unavailable',
              retained: retainedReadyDestination(this.active.destination),
            }),
          )
          this.publish()
          return
        }
        currentSession.intent = conversationSelectionIntent(
          this.messageSelection(currentSession, targetId),
        )
        this.beginSelectionResolution(false)
        this.persistSession(chatId)
        this.publish()
        this.requestDestination(chatId)
      },
      (error) => this.failRead('sibling-navigation', read, key, error),
    )
  }

  async resolveSiblingPosition(
    chatId: ChatId,
    parentId: MessageId | null,
    position: number,
  ): Promise<MessageId | null> {
    const source = this.source
    if (!source || this.workspaceId === null) return null
    const key = `${chatId}\u0000${parentId ?? ''}\u0000${position}`
    const read = this.startRead('sibling-position', key)
    try {
      const envelope = await source.loadChildAtPosition(
        chatId,
        parentId,
        position,
        read.controller.signal,
      )
      return this.readIsCurrent('sibling-position', read) && this.matchesWorkspace(envelope)
        ? envelope.value
        : null
    } catch (error) {
      if (!this.readIsCurrent('sibling-position', read) || read.controller.signal.aborted)
        return null
      throw error
    } finally {
      this.finishRead('sibling-position', read)
    }
  }

  capturePromptPathFrame(workspaceFence: WorkspaceFence): ConversationPromptPathFrame {
    const active = this.active
    if (!this.matchesWorkspace(workspaceFence) || !active || this.activeChatId !== active.chatId) {
      return PENDING_CONVERSATION_PROMPT_PATH_FRAME
    }
    const topologyFailed = active.failure?.kind === 'topology'
    const cached = this.promptPathFrameCache
    if (
      cached?.workspaceId === workspaceFence.workspaceId &&
      cached.replacementEpoch === workspaceFence.replacementEpoch &&
      cached.chatId === active.chatId &&
      cached.destination === active.destination &&
      cached.topology === active.topology &&
      cached.topologyFailed === topologyFailed &&
      cached.promptPathRevision === this.promptPathRevision
    ) {
      return cached.frame
    }
    const frame = this.createPromptPathFrame(workspaceFence, active, active.destination)
    this.promptPathFrameCache = {
      workspaceId: workspaceFence.workspaceId,
      replacementEpoch: workspaceFence.replacementEpoch,
      chatId: active.chatId,
      destination: active.destination,
      topology: active.topology,
      topologyFailed,
      promptPathRevision: this.promptPathRevision,
      frame,
    }
    return frame
  }

  private capturePromptMaterial(
    workspaceFence: WorkspaceFence,
    chatId: ChatId,
    headers: readonly MessageHeaderRow[],
  ): GenerationPromptMaterialLease {
    const coordinator = this.materialCoordinator
    if (!coordinator || !this.matchesWorkspace(workspaceFence)) {
      throw new Error('ConversationPromptMaterialCoordinatorMissing')
    }
    const lease = coordinator.acquirePrompt(chatId, headers)
    const requestedIds = new Set(headers.map((header) => header.id))
    const transcript =
      this.active?.chatId === chatId ? presentedTranscriptWindow(this.active.transcript) : null
    if (transcript) {
      lease.seed(
        workspaceFence,
        [...transcriptBodyWindowRows(transcript)].flatMap((row) =>
          row.bodyExact && requestedIds.has(row.header.id)
            ? [
                Object.freeze({
                  header: row.header,
                  message: row.message,
                  bodyVersion: row.bodyVersion,
                }),
              ]
            : [],
        ),
      )
    }
    return lease
  }

  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
  }): SessionSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
    selectionDelivery: 'session'
  }): SessionSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'select-result'
    selectionDelivery: 'route-handoff'
  }): RouteSelectingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: 'preserve'
  }): PreservingConversationOperationClaim
  claimOperation(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: ConversationOperationClaim['steering']
    selectionDelivery?: SelectingConversationOperationClaim['selectionDelivery']
    routeOwner?: ConversationRouteOwner
  }): ConversationOperationClaim {
    return this.createOperationClaim(input)
  }

  resolveOperationDestination(
    claim: SessionSelectingConversationOperationClaim,
  ): ClaimedConversationDestination {
    if (!this.operationClaimIsCurrent(claim)) {
      return Object.freeze({ kind: 'superseded' })
    }
    const active = this.active
    const session = this.sessions.get(claim.chatId)
    if (
      this.activeChatId !== claim.chatId ||
      active?.chatId !== claim.chatId ||
      session?.selectionRevision !== claim.selectionRevision
    ) {
      return Object.freeze({ kind: 'superseded' })
    }
    switch (active.destination.kind) {
      case 'unresolved':
      case 'resolving':
        return Object.freeze({ kind: 'pending' })
      case 'ready':
        return Object.freeze({
          kind: 'ready',
          expectedLeafId: active.destination.spine.resolvedLeafId,
        })
      case 'missing':
      case 'unavailable':
        return Object.freeze({ kind: 'unavailable' })
      case 'failed':
        return Object.freeze({ kind: 'failed' })
    }
  }

  presentGenerationIntent(
    claim: SessionSelectingConversationOperationClaim,
    input: {
      readonly baseLeafId: MessageId | null
      readonly messages: readonly Message[]
    },
  ): void {
    const active = this.active
    if (
      !this.operationClaimIsCurrent(claim) ||
      this.activeChatId !== claim.chatId ||
      active?.chatId !== claim.chatId ||
      active.destination.kind !== 'ready' ||
      active.destination.spine.resolvedLeafId !== input.baseLeafId
    ) {
      return
    }
    const presentations = Object.freeze(
      input.messages.map((message) => {
        if (message.chatId !== claim.chatId) {
          throw new Error(`GenerationIntentPresentationChatMismatch:${message.id}`)
        }
        const { header } = splitMessageForStorage(message)
        return Object.freeze({
          header,
          message: structuredClone(message),
          bodyVersion: header.bodyVersion,
        })
      }),
    )
    if (presentations.length === 0) return
    this.generationIntentPresentations.set(
      claim.id,
      Object.freeze({ claim, baseLeafId: input.baseLeafId, presentations }),
    )
    this.publish()
  }

  claimSelectedDestination(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
  }): SelectedConversationDestinationClaim {
    const steering = this.createOperationClaim({
      ...input,
      steering: 'select-result',
      selectionDelivery: 'session',
    }) as SessionSelectingConversationOperationClaim
    const destination = this.captureSelectedPromptPath(steering)
    return Object.freeze({
      [SELECTED_CONVERSATION_DESTINATION_CLAIM]: true as const,
      steering,
      captured: destination.kind === 'ready' ? destination : null,
    })
  }

  resolveSelectedDestination(
    claim: SelectedConversationDestinationClaim,
  ): ClaimedConversationDestination {
    const destination = this.resolveSelectedPromptPath(claim)
    return destination.kind === 'ready'
      ? Object.freeze({
          kind: 'ready' as const,
          expectedLeafId: destination.expectedLeafId,
        })
      : destination
  }

  resolveSelectedPromptPath(
    claim: SelectedConversationDestinationClaim,
  ): ClaimedSelectedConversationPromptPath {
    if (!this.operationClaimIsRetained(claim.steering)) {
      return Object.freeze({ kind: 'superseded' })
    }
    return claim.captured ?? this.captureSelectedPromptPath(claim.steering)
  }

  cancelSelectedDestination(claim: SelectedConversationDestinationClaim): void {
    this.cancelOperation(claim.steering)
  }

  acceptLocalResult(
    claim: SessionSelectingConversationOperationClaim,
    effect: SelectingLocalResultEffect,
  ): ConversationSessionResultReceipt
  acceptLocalResult(
    claim: RouteSelectingConversationOperationClaim,
    effect: SelectingLocalResultEffect,
  ): ConversationRouteResultReceipt
  acceptLocalResult(
    claim: PreservingConversationOperationClaim,
    effect: PreservingLocalResultEffect,
  ): ConversationSessionResultReceipt
  acceptLocalResult(
    claim: ConversationOperationClaim,
    effect: ConversationLocalResultEffect,
  ): ConversationLocalResultReceipt {
    const steeringAllowed =
      this.operationClaimIsCurrent(claim) &&
      !(
        (claim.steering === 'preserve' && effect.kind !== 'preserve') ||
        (claim.steering === 'select-result' && effect.kind === 'preserve')
      )
    const validated = steeringAllowed ? this.validateLocalResult(claim.chatId, effect) : null
    const preparedSelection = validated ? this.prepareAcceptedLocalSelection(validated) : null
    const committedFacts = this.applyLocalCommittedFacts(
      effect.committedEffect,
      validated && (validated.kind === 'select-committed' || validated.kind === 'select-transition')
        ? 'defer-to-sealed-replacement'
        : 'resolve-if-invalidated',
    )
    if (!validated) {
      const committedRefresh =
        committedFacts === 'failed'
          ? this.recoverCommittedEffectState(effect.committedEffect)
            ? 'recovered'
            : 'failed'
          : this.applyLocalCommittedRefresh(effect.committedEffect)
      const releasedClaim = this.releaseOperationClaim(claim, committedRefresh !== 'recovered')
      if (committedFacts !== 'ignored' || committedRefresh !== 'ignored' || releasedClaim) {
        this.publish()
        this.refreshBodyDemands()
      }
      return Object.freeze({ accepted: false })
    }
    let receipt: ConversationLocalResultReceipt
    let projectionFailed = committedFacts === 'failed'
    try {
      receipt = this.applyAcceptedLocalResult(claim, validated, preparedSelection)
    } catch {
      projectionFailed = true
      receipt = this.committedResultFallback(claim, validated, preparedSelection)
    }
    if (projectionFailed) {
      this.recoverCommittedEffectState(validated.committedEffect)
    } else {
      this.applyLocalCommittedRefresh(validated.committedEffect)
    }
    this.releaseOperationClaim(claim, false)
    if (
      receipt.accepted &&
      'routeDelivery' in receipt &&
      receipt.routeDelivery.kind === 'handoff'
    ) {
      return receipt
    }
    this.persistSession(claim.chatId)
    this.publish()
    this.refreshBodyDemands()
    return receipt
  }

  cancelOperation(claim: ConversationOperationClaim): void {
    if (!this.releaseOperationClaim(claim)) return
    this.publish()
    this.refreshBodyDemands()
  }

  applyCommittedEffect(effect: ConversationCommittedEffect): void {
    this.applyCommittedEffects([effect])
  }

  applyCommittedEffects(effects: readonly ConversationCommittedEffect[]): void {
    let changed = false
    for (const effect of effects) {
      if (effect.kind === 'deleted') {
        if (this.matchesWorkspace(effect)) changed = this.deleteChatState(effect.chatId) || changed
        continue
      }
      this.foldPendingRouteHandoffs(effect)
      changed = this.applyCommittedEffectOrRecover(effect) || changed
    }
    if (!changed) return
    this.publish()
    this.refreshBodyDemands()
  }

  admitExactPresentation(
    fence: WorkspaceFence,
    presentation: ConversationMessagePresentation,
  ): boolean {
    const active = this.active
    if (
      !this.matchesWorkspace(fence) ||
      !active ||
      active.chatId !== presentation.header.chatId ||
      presentation.message.chatId !== active.chatId
    ) {
      return false
    }
    const structuralVersion = Math.max(
      active.chat?.structuralVersion ?? 0,
      this.presentedSpine()?.structuralVersion ?? 0,
      active.topology.kind === 'exact' ? active.topology.structuralVersion : 0,
    )
    this.observationRevision += 1
    this.admitMessageRevisions(
      [
        Object.freeze({
          header: presentation.header,
          presentation,
          structuralVersion,
        }),
      ],
      { kind: 'body-snapshot' },
    )
    this.publish()
    this.refreshBodyDemands()
    return true
  }

  observedCommitChatIds(): readonly ChatId[] {
    const chatIds = new Set<ChatId>()
    if (this.activeChatId) chatIds.add(this.activeChatId)
    for (const pending of this.pendingRouteHandoffsByOwnerId.values()) {
      chatIds.add(pending.seed.chat.id)
    }
    return Object.freeze([...chatIds])
  }

  private committedEffectAddressesActive(change: ConversationCommittedEffect): boolean {
    return Boolean(
      this.matchesWorkspace(change) && this.active && this.active.chatId === change.chatId,
    )
  }

  private applyCommittedEffectFacts(
    change: ConversationChangedCommittedEffect,
    fallback: 'defer-to-sealed-replacement' | 'resolve-if-invalidated' = 'resolve-if-invalidated',
  ): boolean {
    if (!this.committedEffectAddressesActive(change) || !this.active) {
      return false
    }
    this.observationRevision += 1
    const paintedTranscript =
      change.source === 'local' ? presentedTranscriptWindow(this.active.transcript) : null
    if (
      change.chat?.id === this.active.chatId &&
      (!this.active.chat || chatMetadataReceiptDominates(change.chat, this.active.chat))
    ) {
      this.active.chat = structuredClone(change.chat)
    }
    this.admitMessageRevisions(change.revisions ?? [], {
      kind: 'committed',
      structural: change.structural,
      fallback,
      paintedTranscript,
    })
    this.admitChildSlots(change.childSlots ?? [])
    return true
  }

  private admitChildSlots(evidenceRows: readonly WorkspaceLocalChildSlotEvidence[]): void {
    const active = this.active
    const spine = this.presentedSpine()
    if (!active || !spine || evidenceRows.length === 0) return
    const updates: ActiveBranchForkSlot[] = []
    for (const evidence of evidenceRows) {
      const { state } = evidence
      if (state.chatId !== active.chatId) continue
      const selected = spine.path.childOf(state.parentId)
      if (!selected) continue
      if (evidence.removedMessageIds.includes(selected.id)) continue
      const suppliedMember = evidence.upserts.find((member) => member.id === selected.id)
      if (evidence.mode === 'replace' && !suppliedMember) continue
      const current = spine.forkFor(selected.id)
      if (!suppliedMember && !current) continue
      const member =
        suppliedMember ??
        Object.freeze({
          id: selected.id,
          chatId: state.chatId,
          parentId: state.parentId,
          parentKey: state.id,
          position: current!.position,
          previousMessageId: current!.previousMessageId,
          nextMessageId: current!.nextMessageId,
        })
      if (
        state.liveCount < 1 ||
        state.firstLiveChildId === null ||
        state.lastLiveChildId === null ||
        member.chatId !== state.chatId ||
        member.parentId !== state.parentId ||
        member.parentKey !== state.id
      ) {
        throw new Error(`ConversationChildSlotEvidenceInvalid:${state.id}`)
      }
      updates.push(
        Object.freeze({
          parentId: state.parentId,
          selectedMessageId: selected.id,
          slotVersion: state.version,
          position: member.position,
          liveCount: state.liveCount,
          previousMessageId: member.previousMessageId,
          nextMessageId: member.nextMessageId,
          firstMessageId: state.firstLiveChildId,
          lastMessageId: state.lastLiveChildId,
        }),
      )
    }
    if (updates.length === 0) return
    let forkFacts = active.forks
    for (const update of updates) forkFacts = forkFacts.set(update.selectedMessageId, update)
    active.forks = forkFacts
    const nextSpine = spine.replaceForks(updates)
    if (nextSpine !== spine) {
      active.destination = replacePresentedDestinationSpine(active.destination, nextSpine)
    }
  }

  private applyCommittedEffectRefresh(change: ConversationChangedCommittedEffect): boolean {
    if (!this.committedEffectAddressesActive(change) || !this.active) return false
    const refresh = change.refresh
    if (!refresh) return true
    const refreshesDestination = projectionScopeTouchesSpine(refresh.headers, this.presentedSpine())
    if (refresh.chat && !refreshesDestination) this.requestChat(this.active.chatId)
    if (refresh.bodies) this.invalidateLoadedBodyRows(refresh.bodies)
    if (refresh.previews === true) {
      this.cancelRead('previews')
      this.active.previews.clear()
      this.active.previewSnapshot = new Map()
    } else if (refresh.previews) {
      this.cancelRead('previews')
      let changed = false
      for (const messageId of refresh.previews) {
        changed = this.active.previews.delete(messageId) || changed
      }
      if (changed) this.active.previewSnapshot = new Map(this.active.previews)
    }
    if (refresh.forkParentIds && !refreshesDestination) {
      this.requestForkUpdates(refresh.forkParentIds, 'workspace-change')
    }
    if (refreshesDestination) {
      const interruptedAttempt = this.active.selectionAttempt
      const interruptedProofTarget = interruptedAttempt?.proofTarget ?? null
      const session = this.activeSession()
      this.beginSelectionResolution(false)
      if (interruptedProofTarget && session) {
        const retry = this.installSelectionAttempt(
          this.active.chatId,
          session,
          interruptedProofTarget,
        )
        if (retry) this.requestSelection(retry)
      } else {
        this.requestDestination(this.active.chatId)
      }
    }
    return true
  }

  private applyCommittedEffectOrRecover(effect: ConversationChangedCommittedEffect): boolean {
    try {
      if (!this.applyCommittedEffectFacts(effect)) return false
      return this.applyCommittedEffectRefresh(effect)
    } catch {
      return this.recoverCommittedEffectState(effect)
    }
  }

  private recoverCommittedEffectState(effect: ConversationCommittedEffect | undefined): boolean {
    if (
      !effect ||
      !this.matchesWorkspace(effect) ||
      !this.active ||
      this.active.chatId !== effect.chatId
    ) {
      return false
    }
    this.observationRevision += 1
    this.cancelAllReads()
    this.active.failure = null
    this.beginSelectionResolution(false)
    this.requestDestination(effect.chatId)
    return true
  }

  private applyLocalCommittedFacts(
    change: ConversationCommittedEffect | undefined,
    fallback: 'defer-to-sealed-replacement' | 'resolve-if-invalidated',
  ): ConversationCommittedEffectPhaseResult {
    if (change?.source !== 'local') return 'ignored'
    if (change.kind === 'deleted') {
      return this.matchesWorkspace(change) && this.deleteChatState(change.chatId)
        ? 'applied'
        : 'ignored'
    }
    try {
      return this.applyCommittedEffectFacts(change, fallback) ? 'applied' : 'ignored'
    } catch {
      return 'failed'
    }
  }

  private applyLocalCommittedRefresh(
    change: ConversationCommittedEffect | undefined,
  ): ConversationCommittedEffectPhaseResult {
    if (change?.source !== 'local') return 'ignored'
    if (change.kind === 'deleted') return 'ignored'
    try {
      return this.applyCommittedEffectRefresh(change) ? 'applied' : 'ignored'
    } catch {
      return this.recoverCommittedEffectState(change) ? 'recovered' : 'ignored'
    }
  }

  private deleteChatState(chatId: ChatId): boolean {
    this.sessions.delete(chatId)
    deletePersistedSession(chatId)
    for (const [claimId, claim] of this.operationClaims) {
      if (claim.chatId === chatId) this.operationClaims.delete(claimId)
    }
    this.operationClaimCountsByChat.delete(chatId)
    for (const [claimId, presentation] of this.generationIntentPresentations) {
      if (presentation.claim.chatId === chatId) this.generationIntentPresentations.delete(claimId)
    }
    for (const [ownerId, pending] of this.pendingRouteHandoffsByOwnerId) {
      if (pending.seed.chat.id === chatId) this.deletePendingRouteHandoff(ownerId)
    }
    if (this.paintedFrame?.chat.id === chatId) this.paintedFrame = null
    if (this.activeChatId !== chatId) return false
    this.cancelAllReads()
    this.activeChatId = null
    this.active = null
    return true
  }

  reconcileWorkspace(fence: WorkspaceFence): void {
    if (this.matchesWorkspace(fence) && this.materialCoordinator) return
    const initial = this.workspaceId === null
    const sameLogicalWorkspace = this.workspaceId === fence.workspaceId
    const retainedPaintedFrame =
      sameLogicalWorkspace && this.paintedFrame
        ? Object.freeze({
            chat: this.paintedFrame.chat,
            binding: retainConversationBinding(this.paintedFrame.binding),
          })
        : null
    this.materialCoordinator?.release()
    this.workspaceId = fence.workspaceId
    this.workspaceEpoch = fence.replacementEpoch
    this.materialCoordinator = createWorkspaceMessageMaterialCoordinator(fence)
    this.observationRevision += 1
    this.cancelAllReads()
    if (!sameLogicalWorkspace) this.sessions.clear()
    this.operationClaims.clear()
    this.operationClaimCountsByChat.clear()
    this.generationIntentPresentations.clear()
    this.transcriptRetentions.clear()
    this.clearPendingRouteHandoffs()
    this.activeChatId = null
    this.active = null
    this.paintedFrame = retainedPaintedFrame
    this.lastRouteArrivalId = null
    this.lastProjectedRouteKey = null
    if (!initial && !sameLogicalWorkspace) clearPersistedSessions()
    if (!this.consumeRouteArrival()) this.publish()
  }

  claimTranscriptRetention(input: {
    chatId: ChatId
    messageId: MessageId
  }): ConversationTranscriptRetentionClaim {
    const workspaceId = this.workspaceId
    const active = this.active
    const session = this.activeSession()
    const path = this.activeSpine()?.path
    const window = active ? readyTranscriptWindow(active.transcript) : null
    if (
      workspaceId === null ||
      !active ||
      !session ||
      !path ||
      !window ||
      active.chatId !== input.chatId ||
      transcriptBodyWindowFindRow(window, input.messageId) === undefined
    ) {
      throw new Error('ConversationTranscriptRetentionTargetUnavailable')
    }
    const owner = {}
    const messageIndex = path.indexOf(input.messageId)
    this.transcriptRetentions.set(owner, {
      workspaceId,
      replacementEpoch: this.workspaceEpoch,
      chatId: input.chatId,
      messageId: input.messageId,
      selectionRevision: session.selectionRevision,
      selectionEpoch: active.transcript.selectionEpoch,
      precedingRowCount: messageIndex - window.offset,
    })
    this.requestTranscript()
    let released = false
    return Object.freeze({
      kind: 'conversation-transcript-retention' as const,
      chatId: input.chatId,
      messageId: input.messageId,
      release: () => {
        if (released) return
        released = true
        this.transcriptRetentions.delete(owner)
        this.requestTranscript()
      },
    })
  }

  setTranscriptDemand(owner: object, demand: TranscriptDemand | null): void {
    setDemand(this.transcriptDemands, owner, demand)
    this.requestTranscript()
  }

  setSettledTranscriptWorkScale(minimumRowCount: number): void {
    const next = transcriptRowFloorBudget(minimumRowCount)
    if (sameTranscriptWorkBudget(this.settledTranscriptBudget, next)) return
    this.settledTranscriptBudget = next
    this.requestTranscript()
  }

  expandTranscriptDemand(input: {
    chatId: ChatId
    selectionRevision: number
    selectionEpoch: number
    boundaryOffset: number
  }): void {
    const active = this.active
    const session = this.activeSession()
    const path = this.activeSpine()?.path
    const window = active ? readyTranscriptWindow(active.transcript) : null
    if (
      !active ||
      !session ||
      !path ||
      !window ||
      active.chatId !== input.chatId ||
      session.selectionRevision !== input.selectionRevision ||
      active.transcript.selectionEpoch !== input.selectionEpoch ||
      !Number.isSafeInteger(input.boundaryOffset) ||
      input.boundaryOffset < 0 ||
      input.boundaryOffset !== window.offset
    ) {
      return
    }
    const base = this.currentTranscriptDemand(active, session)
    if (!base) return
    const accepted = this.acceptTranscriptPlan(active, base, path)
    if (accepted.lastExpansionBoundaryOffset === input.boundaryOffset) return
    const budget = growTranscriptWorkBudget(accepted.budget)
    active.transcriptPlan = Object.freeze({
      ...accepted,
      budget,
      span: this.retainClaimedTranscriptSpan(
        active,
        session,
        path,
        transcriptTailSpan(path, budget),
      ),
      lastExpansionBoundaryOffset: input.boundaryOffset,
    })
    this.requestTranscript()
  }

  retryTranscriptDemand(input: {
    chatId: ChatId
    selectionRevision: number
    selectionEpoch: number
  }): void {
    const active = this.active
    const session = this.activeSession()
    const failure = active?.failure
    const blocked = this.blockedReads.get('transcript')
    if (
      !active ||
      !session ||
      active.chatId !== input.chatId ||
      session.selectionRevision !== input.selectionRevision ||
      active.transcript.selectionEpoch !== input.selectionEpoch ||
      failure?.kind !== 'transcript' ||
      failure.code !== 'read-failed' ||
      blocked?.key !== failure.key ||
      blocked.observationRevision !== failure.observationRevision
    ) {
      return
    }
    this.blockedReads.delete('transcript')
    active.failure = null
    this.requestTranscript()
  }

  setInspectorDemand(owner: object, demand: InspectorDemand | null): void {
    setDemand(this.inspectorDemands, owner, demand)
    this.requestInspector()
  }

  setTreePreviewDemand(owner: object, demand: TreePreviewDemand | null): void {
    setDemand(this.previewDemands, owner, demand)
    this.requestPreviews()
  }

  requestPresentation(input: {
    chatId: ChatId
    surface: ConversationSurface
    revealTargetMessageId?: MessageId
  }): void {
    const session = this.getOrCreateSession(input.chatId)
    session.presentationRequest = {
      revision: session.presentationRequest.revision + 1,
      surface: input.surface,
    }
    if (input.revealTargetMessageId) {
      this.installReveal(input.chatId, session, input.revealTargetMessageId)
    }
    this.presentationResourcePort?.request(input.surface)
    this.persistSession(input.chatId)
    this.publish()
    this.refreshPresentationDemands()
  }

  consumePresentationReveal(effectId: string, surface: ConversationSurface): void {
    const active = this.active
    const visible =
      active && this.paintedFrame?.chat.id === active.chatId ? this.paintedFrame.binding : null
    if (
      !active?.reveal ||
      active.reveal.id !== effectId ||
      visible?.currency !== 'current' ||
      visible.surface !== surface ||
      visible.reveal?.id !== effectId
    ) {
      return
    }
    active.reveal = null
    this.publish()
  }

  private installReveal(chatId: ChatId, session: ChatSession, targetMessageId: MessageId): void {
    if (this.activeChatId === chatId && this.active?.chatId === chatId) {
      this.active.reveal = Object.freeze({
        id: newId(),
        chatId,
        targetMessageId,
        selectionRevision: session.selectionRevision,
      })
      return
    }
    session.pendingRevealTargetId = targetMessageId
  }

  private clearReveals(chatId: ChatId, session: ChatSession): void {
    delete session.pendingRevealTargetId
    if (this.active?.chatId !== chatId) return
    this.active.reveal = null
  }

  private messageSelection(
    session: ChatSession,
    messageId: MessageId,
    observedTipId?: MessageId,
  ): ActiveBranchSelection {
    const rememberedTipId = observedTipId ?? session.cursor.rememberTerminal(messageId)
    return rememberedTipId
      ? { kind: 'message', messageId, observedTipId: rememberedTipId }
      : { kind: 'message', messageId }
  }

  private getOrCreateSession(chatId: ChatId): ChatSession {
    const existing = this.sessions.get(chatId)
    if (existing) return existing
    const persisted =
      this.workspaceId === null
        ? null
        : loadPersistedSession(chatId, {
            workspaceId: this.workspaceId,
            replacementEpoch: this.workspaceEpoch,
          })
    const restoredSelection = persisted?.selection ?? ({ kind: 'default' } as const)
    const session: ChatSession = {
      selectionRevision: 0,
      steeringRevision: 0,
      presentationRequest: {
        revision: 0,
        surface: persisted?.presentation ?? 'transcript',
      },
      cursor: TabBranchCursor.empty(),
      intent: conversationSelectionIntent(
        restoredSelection,
        persisted && restoredSelection.kind !== 'default' ? 'canonicalize-default' : 'retain',
      ),
      ...(persisted?.pendingRevealTargetId
        ? { pendingRevealTargetId: persisted.pendingRevealTargetId }
        : {}),
    }
    this.sessions.set(chatId, session)
    return session
  }

  private activateSession(chatId: ChatId): ChatSession {
    return this.getOrCreateSession(chatId)
  }

  private compactSession(
    chatId: ChatId,
    preferredIntent?: ConversationSelectionIntent,
  ): ChatSession {
    const current = this.getOrCreateSession(chatId)
    if (preferredIntent) current.intent = preferredIntent
    return current
  }

  private createOperationClaim(input: {
    chatId: ChatId
    workspaceFence?: WorkspaceFence
    steering: ConversationOperationClaim['steering']
    selectionDelivery?: SelectingConversationOperationClaim['selectionDelivery']
    routeOwner?: ConversationRouteOwner
  }): ConversationOperationClaim {
    if (input.workspaceFence && !this.matchesWorkspace(input.workspaceFence)) {
      throw new Error('ConversationOperationWorkspaceMismatch')
    }
    if (this.workspaceId === null) throw new Error('ConversationWorkspaceNotReconciled')
    if (input.steering === 'preserve' && (input.selectionDelivery || input.routeOwner)) {
      throw new Error('ConversationSelectionDeliveryUnexpected')
    }
    if (input.steering === 'select-result') {
      const delivery = input.selectionDelivery ?? 'session'
      if (delivery === 'route-handoff') {
        if (!input.routeOwner) throw new Error('ConversationRouteOwnerUnavailable')
      } else if (input.routeOwner) {
        throw new Error('ConversationRouteOwnerUnexpected')
      }
    }
    const session = this.getOrCreateSession(input.chatId)
    if (input.steering === 'select-result') session.steeringRevision += 1
    const claim: ConversationOperationClaim = Object.freeze({
      id: newId(),
      chatId: input.chatId,
      workspaceId: this.workspaceId,
      workspaceEpoch: this.workspaceEpoch,
      selectionRevision: session.selectionRevision,
      steering: input.steering,
      ...(input.steering === 'select-result'
        ? {
            steeringRevision: session.steeringRevision,
            selectionDelivery: input.selectionDelivery ?? 'session',
            ...(input.selectionDelivery === 'route-handoff'
              ? { routeOwner: input.routeOwner as ConversationRouteOwner }
              : {}),
          }
        : {}),
    }) as ConversationOperationClaim
    this.operationClaims.set(claim.id, claim)
    this.operationClaimCountsByChat.set(
      claim.chatId,
      (this.operationClaimCountsByChat.get(claim.chatId) ?? 0) + 1,
    )
    return claim
  }

  private operationClaimIsCurrent(claim: ConversationOperationClaim): boolean {
    return (
      this.operationClaimIsRetained(claim) &&
      this.sessions.get(claim.chatId)?.selectionRevision === claim.selectionRevision &&
      (claim.steering === 'preserve' ||
        this.sessions.get(claim.chatId)?.steeringRevision === claim.steeringRevision)
    )
  }

  private operationClaimIsRetained(claim: ConversationOperationClaim): boolean {
    return (
      this.operationClaims.get(claim.id) === claim &&
      claim.workspaceId === this.workspaceId &&
      claim.workspaceEpoch === this.workspaceEpoch
    )
  }

  private captureSelectedPromptPath(
    claim: SessionSelectingConversationOperationClaim,
  ): ClaimedSelectedConversationPromptPath {
    const resolved = this.resolveOperationDestination(claim)
    if (resolved.kind !== 'ready' && resolved.kind !== 'pending') return resolved
    const active = this.active
    const session = this.sessions.get(claim.chatId)
    if (
      !active ||
      active.chatId !== claim.chatId ||
      this.activeChatId !== claim.chatId ||
      session?.selectionRevision !== claim.selectionRevision
    ) {
      return Object.freeze({ kind: 'superseded' })
    }
    const destination =
      resolved.kind === 'ready'
        ? active.destination.kind === 'ready'
          ? active.destination
          : null
        : this.retainedSelectedDestination(active, claim)
    if (!destination) return Object.freeze({ kind: 'pending' })
    const expectedLeafId = destination.spine.resolvedLeafId
    const workspaceFence = {
      workspaceId: claim.workspaceId,
      replacementEpoch: claim.workspaceEpoch,
    }
    const promptPath =
      destination === active.destination
        ? this.capturePromptPathFrame(workspaceFence)
        : this.createPromptPathFrame(workspaceFence, active, destination)
    const capability = promptPath.capability({
      kind: 'send',
      chatId: claim.chatId,
      expectedLeafId,
    })
    switch (capability) {
      case 'available':
        return Object.freeze({
          kind: 'ready',
          expectedLeafId,
          promptPath,
        })
      case 'pending':
        return Object.freeze({ kind: 'pending' })
      case 'unavailable':
        return Object.freeze({ kind: 'unavailable' })
      case 'error':
        return Object.freeze({ kind: 'failed' })
    }
  }

  private retainedSelectedDestination(
    active: ActiveProjection,
    claim: SessionSelectingConversationOperationClaim,
  ): ConversationDestinationReadyProjection | null {
    if (!destinationRetainsObservedFacts(active.destination)) return null
    const retained = retainedReadyDestination(active.destination)
    const seal = active.presentationSeal
    if (
      !retained ||
      !seal ||
      seal.workspaceId !== claim.workspaceId ||
      seal.replacementEpoch !== claim.workspaceEpoch ||
      seal.chatId !== claim.chatId ||
      seal.selectionRevision !== claim.selectionRevision ||
      seal.structuralVersion !== retained.spine.structuralVersion ||
      seal.leafId !== retained.spine.resolvedLeafId
    ) {
      return null
    }
    return retained
  }

  private createPromptPathFrame(
    workspaceFence: WorkspaceFence,
    active: ActiveProjection,
    destination: ConversationDestinationProjection,
  ): ConversationPromptPathFrame {
    return createConversationPromptPathFrame({
      workspaceFence,
      chatId: active.chatId,
      destination,
      topology: active.topology.kind === 'exact' ? active.topology.index : null,
      topologyLoaded: active.topology.kind === 'exact',
      topologyFailed: active.failure?.kind === 'topology',
      headers: active.headers,
      captureMaterial: (headers) =>
        this.capturePromptMaterial(workspaceFence, active.chatId, headers),
    })
  }

  private releaseOperationClaim(claim: ConversationOperationClaim, recover = true): boolean {
    if (this.operationClaims.get(claim.id) !== claim) return false
    this.operationClaims.delete(claim.id)
    this.generationIntentPresentations.delete(claim.id)
    const remaining = (this.operationClaimCountsByChat.get(claim.chatId) ?? 1) - 1
    if (remaining === 0) this.operationClaimCountsByChat.delete(claim.chatId)
    else this.operationClaimCountsByChat.set(claim.chatId, remaining)
    if (
      recover &&
      claim.steering === 'select-result' &&
      this.activeChatId === claim.chatId &&
      !this.activeSpine()
    ) {
      this.beginSelectionResolution(false)
      this.requestDestination(claim.chatId)
    }
    this.compactExactHeaders()
    if (this.activeChatId !== claim.chatId && remaining === 0) this.persistSession(claim.chatId)
    return true
  }

  private beginAcceptedSelection(chatId: ChatId): void {
    const session = this.getOrCreateSession(chatId)
    session.selectionRevision += 1
    this.clearReveals(chatId, session)
    if (this.active?.chatId === chatId) this.beginSelectionResolution()
  }

  private applyAcceptedLocalResult(
    claim: ConversationOperationClaim,
    effect: ConversationLocalResultEffect,
    preparedSelection: SealedConversationSelection | null,
  ): ConversationLocalResultReceipt {
    const chatId = claim.chatId
    if (effect.kind === 'select-committed' || effect.kind === 'select-transition') {
      if (claim.steering !== 'select-result') {
        throw new Error(`ConversationSelectionClaimMismatch:${chatId}`)
      }
      if (!preparedSelection) throw new Error(`ConversationLocalSelectionMissing:${chatId}`)
      const destination = preparedSelection
      if (claim.selectionDelivery === 'route-handoff') {
        return this.acceptedRouteDelivery(
          destination,
          effect.committedEffect,
          claim.routeOwner,
          effect.revealTargetMessageId,
        )
      } else {
        this.beginAcceptedSelection(chatId)
        const session = this.getOrCreateSession(chatId)
        session.intent = conversationSelectionIntent(destination.target.selection)
        if (this.activeChatId === chatId) {
          const admission = this.admitSealedSelection(session, destination)
          if (admission.kind === 'structural-conflict') {
            this.beginSelectionResolution(false)
            this.requestDestination(chatId)
          }
        }
        if (effect.revealTargetMessageId) {
          this.installReveal(chatId, session, effect.revealTargetMessageId)
        }
      }
    } else if (effect.revealTargetMessageId) {
      const session = this.getOrCreateSession(chatId)
      this.installReveal(chatId, session, effect.revealTargetMessageId)
    }
    return Object.freeze({ accepted: true })
  }

  private sealAppendSelectionTransition(
    transition: ConversationAppendSelectionTransition,
  ): SealedConversationSelection {
    const { base, chat, fallback, forks, presentations, proof, suffixHeaders, target } = transition
    if (
      chat.id !== proof.chatId ||
      base.chatId !== proof.chatId ||
      chat.structuralVersion !== proof.structuralVersion ||
      base.structuralVersion > proof.structuralVersion ||
      suffixHeaders.length < 1 ||
      suffixHeaders.length > 2 ||
      forks.length !== suffixHeaders.length ||
      target.kind !== 'fixed-tip' ||
      target.messageId !== proof.tipId ||
      target.selection.kind !== 'tip' ||
      target.selection.messageId !== proof.tipId
    ) {
      throw new Error(`ConversationAppendSelectionInvalid:${chat.id}`)
    }
    let parentId = base.tipId
    for (let index = 0; index < suffixHeaders.length; index += 1) {
      const header = suffixHeaders[index] as MessageHeaderRow
      const fork = forks[index]
      if (
        header.chatId !== chat.id ||
        header.deleted ||
        header.parentId !== parentId ||
        fork?.selectedMessageId !== header.id ||
        fork.parentId !== header.parentId
      ) {
        throw new Error(`ConversationAppendSelectionSuffixInvalid:${header.id}`)
      }
      parentId = header.id
    }
    const finalSuffixHeader = suffixHeaders.at(-1) as MessageHeaderRow
    if (
      parentId !== proof.tipId ||
      fallback.finalHeader.id !== finalSuffixHeader.id ||
      !sameMessageHeaderValue(fallback.finalHeader, finalSuffixHeader)
    ) {
      throw new Error(`ConversationAppendSelectionTipInvalid:${chat.id}`)
    }

    const presented = this.presentedSpine()
    const resident =
      this.active?.chatId === chat.id &&
      presented !== null &&
      presented.structuralVersion === base.structuralVersion &&
      presented.resolvedLeafId === base.tipId
        ? presented
        : null
    let path = resident?.path ?? createBranchPath(fallback.prefixHeaders)
    if (!resident) path = path.append(fallback.finalHeader)
    else for (const header of suffixHeaders) path = path.append(header)

    return sealConversationSelection(
      Object.freeze({
        kind: 'ready' as const,
        chat,
        target,
        proof,
        presentations,
        forks,
      }),
      path,
      forks,
    )
  }

  private validateLocalResult(
    chatId: ChatId,
    effect: ConversationLocalResultEffect,
  ): ConversationLocalResultEffect | null {
    if (
      effect.committedEffect &&
      (effect.committedEffect.source !== 'local' || effect.committedEffect.chatId !== chatId)
    ) {
      return null
    }
    if (effect.kind !== 'select-committed' && effect.kind !== 'select-transition') return effect
    if (!this.matchesWorkspace(effect.receipt)) return null
    const selection =
      effect.kind === 'select-committed' ? effect.receipt.destination : effect.receipt.transition
    if (selection.proof.chatId !== chatId || selection.chat.id !== chatId) return null
    return effect
  }

  private prepareAcceptedLocalSelection(
    effect: ConversationLocalResultEffect,
  ): SealedConversationSelection | null {
    if (effect.kind === 'preserve') return null
    return effect.kind === 'select-committed'
      ? sealConversationSelection(effect.receipt.destination)
      : this.sealAppendSelectionTransition(effect.receipt.transition)
  }

  private committedResultFallback(
    claim: ConversationOperationClaim,
    effect: ConversationLocalResultEffect,
    preparedSelection: SealedConversationSelection | null,
  ): ConversationLocalResultReceipt {
    const chatId = claim.chatId
    if (effect.kind === 'preserve') return Object.freeze({ accepted: true })
    if (claim.steering !== 'select-result') {
      throw new Error(`ConversationSelectionClaimMismatch:${chatId}`)
    }
    if (!preparedSelection) throw new Error(`ConversationLocalSelectionMissing:${chatId}`)
    if (claim.selectionDelivery === 'route-handoff') {
      return this.acceptedRouteDelivery(
        preparedSelection,
        effect.committedEffect,
        claim.routeOwner,
        effect.revealTargetMessageId,
      )
    }
    const session = this.getOrCreateSession(chatId)
    session.selectionRevision += 1
    this.clearReveals(chatId, session)
    session.intent = conversationSelectionIntent(preparedSelection.target.selection)
    if (effect.revealTargetMessageId) {
      this.installReveal(chatId, session, effect.revealTargetMessageId)
    }
    return Object.freeze({ accepted: true })
  }

  private acceptedRouteDelivery(
    seed: SealedConversationSelection,
    effect: ConversationCommittedEffect,
    routeOwner: ConversationRouteOwner,
    revealTargetMessageId?: MessageId,
  ): Extract<ConversationRouteResultReceipt, { readonly accepted: true }> {
    if (routeOwner.signal.aborted) {
      return Object.freeze({
        accepted: true,
        routeDelivery: Object.freeze({ kind: 'superseded' }),
      })
    }
    return Object.freeze({
      accepted: true,
      routeDelivery: Object.freeze({
        kind: 'handoff',
        handoff: this.createRouteHandoff(seed, effect, routeOwner, revealTargetMessageId),
      }),
    })
  }

  private createRouteHandoff(
    seed: SealedConversationSelection,
    effect: ConversationCommittedEffect,
    routeOwner: ConversationRouteOwner,
    revealTargetMessageId?: MessageId,
  ): ConversationRouteHandoff {
    if (
      !this.matchesWorkspace(effect) ||
      effect.chatId !== seed.chat.id ||
      seed.proof.chatId !== seed.chat.id
    ) {
      throw new Error(`ConversationRouteHandoffInvalid:${seed.chat.id}`)
    }
    if (routeOwner.signal.aborted) throw new Error('ConversationRouteOwnerUnavailable')
    const chatId = seed.chat.id
    const id = routeOwner.id
    this.deletePendingRouteHandoff(id)
    const handoff: ConversationRouteHandoff = Object.freeze({
      id,
      workspaceId: effect.workspaceId,
      replacementEpoch: effect.replacementEpoch,
      chatId,
      cancel: () => {
        const pending = this.pendingRouteHandoffsByOwnerId.get(id)
        if (pending?.handoff.id === id) this.deletePendingRouteHandoff(id)
      },
    })
    const cancelOnOwnerAbort = () => handoff.cancel()
    routeOwner.signal.addEventListener('abort', cancelOnOwnerAbort, { once: true })
    this.pendingRouteHandoffsByOwnerId.set(id, {
      handoff,
      seed,
      reducer: new PendingConversationHandoffReducer(effect),
      releaseOwnerAbort: () => routeOwner.signal.removeEventListener('abort', cancelOnOwnerAbort),
      ...(revealTargetMessageId ? { revealTargetMessageId } : {}),
    })
    return handoff
  }

  private foldPendingRouteHandoffs(effect: ConversationChangedCommittedEffect): void {
    if (!this.matchesWorkspace(effect)) return
    for (const pending of this.pendingRouteHandoffsByOwnerId.values()) {
      if (pending.seed.chat.id === effect.chatId) pending.reducer.add(effect)
    }
  }

  private applyPendingRouteHandoffReduction(
    seed: SealedConversationSelection,
    reduction: PendingConversationHandoffReduction,
  ): PendingConversationHandoffReadPlan {
    const active = this.active
    if (!active || active.chatId !== seed.chat.id || reduction.kind !== 'changed') {
      throw new Error(`ConversationRouteHandoffReductionOwnerMismatch:${seed.chat.id}`)
    }
    if (
      reduction.chat &&
      (!active.chat || chatMetadataReceiptDominates(reduction.chat.chat, active.chat))
    ) {
      active.chat = structuredClone(reduction.chat.chat)
    }

    const paintedTranscript = presentedTranscriptWindow(active.transcript)
    const revisionById = new Map(
      reduction.revisions.map((fact) => [fact.observation.header.id, fact] as const),
    )
    const childSlotSequenceByParentId = new Map(
      reduction.childSlots.map((fact) => [fact.evidence.state.parentId, fact.sequence] as const),
    )
    const seedPresentationById = new Map(
      seed.presentations.map((presentation) => [presentation.header.id, presentation] as const),
    )
    const headerExactSequence = (messageId: MessageId): number | null =>
      revisionById.get(messageId)?.headerSequence ?? (seed.spine.path.has(messageId) ? 0 : null)
    const presentationExactSequence = (messageId: MessageId): number | null => {
      const fact = revisionById.get(messageId)
      if (fact?.presentationSequence !== null && fact?.presentationSequence !== undefined) {
        return fact.presentationSequence
      }
      const seedPresentation = seedPresentationById.get(messageId)
      const finalHeader = fact?.observation.header ?? seed.spine.path.get(messageId)
      return seedPresentation &&
        finalHeader &&
        seedPresentation.bodyVersion === finalHeader.bodyVersion &&
        sameMessageHeaderValue(seedPresentation.header, finalHeader)
        ? 0
        : null
    }
    const childSlotExactSequence = (parentId: MessageId | null): number | null => {
      const sequence = childSlotSequenceByParentId.get(parentId)
      if (sequence !== undefined) return sequence
      return seed.spine.path.childOf(parentId) ? 0 : null
    }
    const topologyResidual = pendingInvalidationResidualScope(
      reduction.refresh.topology,
      headerExactSequence,
    )
    const structural = reducePendingStructuralTransitions(reduction.structural, topologyResidual)
    if (reduction.revisions.length > 0 || reduction.childSlots.length > 0) {
      this.observationRevision += 1
    }
    this.admitMessageRevisions(
      reduction.revisions.map((fact) => fact.observation),
      {
        kind: 'committed',
        structural,
        fallback: 'resolve-if-invalidated',
        paintedTranscript,
      },
    )
    this.admitChildSlots(reduction.childSlots.map((fact) => fact.evidence))

    const invalidatedBodyIds = pendingInvalidatedTranscriptBodyIds(
      active.transcript,
      active.inspector.exact?.message.id,
      reduction.refresh.bodies,
      presentationExactSequence,
    )
    if (invalidatedBodyIds.length > 0) this.invalidateLoadedBodyRows(invalidatedBodyIds)

    if (active.previews.size > 0) {
      let previewsChanged = false
      for (const messageId of active.previews.keys()) {
        if (
          pendingInvalidationApplies(
            reduction.refresh.previews,
            messageId,
            presentationExactSequence(messageId),
          )
        ) {
          previewsChanged = active.previews.delete(messageId) || previewsChanged
        }
      }
      if (previewsChanged) active.previewSnapshot = new Map(active.previews)
    }

    const presentedSpine = this.presentedSpine()
    const refreshesDestination = Boolean(
      presentedSpine &&
        pendingInvalidationTouchesPath(
          reduction.refresh.headers,
          presentedSpine.path,
          headerExactSequence,
        ),
    )
    const structuralVersionMismatch = Boolean(
      active.chat &&
        presentedSpine &&
        active.chat.structuralVersion !== presentedSpine.structuralVersion,
    )
    const destination =
      active.destination.kind !== 'ready' || refreshesDestination || structuralVersionMismatch
    if (destination && active.destination.kind === 'ready') this.beginSelectionResolution(false)

    const chatExactSequence = reduction.chat?.sequence ?? 0
    const chat =
      reduction.refresh.chatSequence !== null && reduction.refresh.chatSequence > chatExactSequence
    const topology = topologyResidual !== undefined
    const forkParentIds =
      pendingForkRefreshScope(
        reduction.refresh.forkParentIds,
        presentedSpine?.path ?? null,
        childSlotExactSequence,
      ) ?? true
    return Object.freeze({ chat, destination, topology, forkParentIds })
  }

  private executePendingRouteHandoffReads(plan: PendingConversationHandoffReadPlan): void {
    const active = this.active
    if (!active) return
    if (plan.destination) this.requestDestination(active.chatId)
    else if (plan.chat) this.requestChat(active.chatId)
    if (plan.topology) this.requestTopology(true)
    if (!plan.destination && plan.forkParentIds) {
      this.requestForkUpdates(plan.forkParentIds, 'workspace-change')
    }
  }

  private deletePendingRouteHandoff(ownerId: string): void {
    const pending = this.pendingRouteHandoffsByOwnerId.get(ownerId)
    if (!pending) return
    this.pendingRouteHandoffsByOwnerId.delete(ownerId)
    pending.releaseOwnerAbort()
  }

  private clearPendingRouteHandoffs(): void {
    for (const ownerId of [...this.pendingRouteHandoffsByOwnerId.keys()]) {
      this.deletePendingRouteHandoff(ownerId)
    }
  }

  private beginSelectionResolution(advanceSelectionEpoch = true): void {
    const active = this.active
    if (!active) return
    active.destination = Object.freeze({
      kind: 'unresolved',
      retained: retainedReadyDestination(active.destination),
    })
    this.cancelRead('sibling-navigation')
    this.cancelSelectionAttempt()
    this.cancelForkWork()
    const selectionEpoch = active.transcript.selectionEpoch + (advanceSelectionEpoch ? 1 : 0)
    this.cancelRead('transcript')
    active.transcriptFill = null
    active.transcriptPlan = null
    active.transcript = retainTranscriptState(active.transcript, selectionEpoch)
  }

  private installCommittedSelection(
    session: ChatSession,
    proof: ConversationPathProofIdentity,
    presentations: readonly ConversationMessagePresentation[],
    spine: VersionedActiveBranchSpine<MessageHeaderRow>,
  ): void {
    const active = this.active
    if (!active || active.chatId !== proof.chatId) return
    this.cancelSelectionAttempt()
    if (proof.tipId === null) {
      this.acceptSelectedSpine(session, spine)
      const empty = emptyTranscriptBodyWindow(proof.chatId, spine.path)
      active.transcript = readyTranscriptState(active.transcript.selectionEpoch, empty)
    } else {
      const previousPath = this.presentedSpine()?.path ?? null
      const transition = transitionTranscriptBodyWindow(
        spine.path,
        presentations,
        presentedTranscriptWindow(active.transcript),
        previousPath,
      )
      active.transcript = retainTranscriptState(active.transcript)
      this.acceptSelectedSpine(session, spine)
      if (transition.kind === 'exact') {
        active.transcript = readyTranscriptState(
          active.transcript.selectionEpoch,
          transition.window,
        )
      } else if (transition.kind === 'divergent') {
        active.transcriptFill = Object.freeze({
          kind: 'choose',
          selectionEpoch: active.transcript.selectionEpoch,
          pathIdentity: spine.path.identity,
          commonPrefix: transition.commonPrefix,
          terminalFallback: transition.terminalFallback,
        })
      } else if (transition.kind === 'terminal') {
        if (previousPath) {
          active.transcriptFill = Object.freeze({
            kind: 'prepend',
            selectionEpoch: active.transcript.selectionEpoch,
            pathIdentity: spine.path.identity,
            window: transition.window,
          })
        } else {
          active.transcript = readyTranscriptState(
            active.transcript.selectionEpoch,
            transition.window,
          )
        }
      }
      this.stageTranscriptDrain()
    }
  }

  private acceptDestinationPoint(
    point: ConversationDestinationPoint,
    attempt: ConversationSelectionAttempt,
  ): void {
    const active = this.active
    if (
      !active ||
      active.chatId !== point.chat.id ||
      point.structuralVersion !== point.chat.structuralVersion ||
      active.destination.kind !== 'resolving' ||
      !this.selectionAttemptIsCurrent(attempt) ||
      (attempt.proofTarget.kind === 'fixed-empty' && point.kind !== 'empty-point') ||
      (attempt.proofTarget.kind === 'fixed-tip' &&
        (point.kind !== 'tip-point' ||
          attempt.proofTarget.messageId !== point.presentation.header.id))
    ) {
      return
    }
    const retained = retainedReadyDestination(active.destination)
    if (active.chat === null || chatMetadataReceiptDominates(point.chat, active.chat)) {
      active.chat = structuredClone(point.chat)
    }
    if (point.kind === 'empty-point') return
    const presentation = point.presentation
    const tipId = presentation.header.id
    if (
      presentation.message.id !== tipId ||
      presentation.header.chatId !== point.chat.id ||
      presentation.message.chatId !== point.chat.id ||
      presentation.header.bodyVersion !== presentation.bodyVersion
    ) {
      return
    }
    if (retained) return
    active.transcript = Object.freeze({
      kind: 'point',
      selectionEpoch: active.transcript.selectionEpoch,
      attemptId: attempt.id,
      tipId,
      window: transcriptBodyPointWindow(presentation),
    })
  }

  private admitSealedSelection(
    session: ChatSession,
    destinationInput: SealedConversationSelection,
  ): SelectionAdmissionResult {
    const admitted = this.admitSealedSelectionFrame(destinationInput)
    if (!admitted) {
      return Object.freeze({
        kind: 'structural-conflict',
        observationRevision: this.observationRevision,
      })
    }
    const spine = admitted.spine
    const active = this.active
    if (!active || active.chatId !== admitted.chat.id) {
      throw new Error(`ConversationSelectionAdmissionOwnerChanged:${admitted.chat.id}`)
    }
    if (active.chat === null || chatMetadataReceiptDominates(admitted.chat, active.chat)) {
      active.chat = structuredClone(admitted.chat)
    } else if (!chatMetadataReceiptDominates(active.chat, admitted.chat)) {
      throw new Error(`ConversationDestinationChatVersionDiverged:${admitted.chat.id}`)
    }
    this.installCommittedSelection(session, admitted.proof, admitted.presentations, spine)
    if (admitted.presentations.length > 0) {
      this.applyAdmittedMessageRevisions(
        admitted.presentations.map((presentation) => ({
          header: presentation.header,
          presentation,
        })),
      )
    }
    return Object.freeze({ kind: 'accepted' })
  }

  private admitSealedSelectionFrame(
    destination: SealedConversationSelection,
  ): SealedConversationSelection | null {
    const active = this.active
    if (!active || active.chatId !== destination.proof.chatId) return null
    const priorSpine = this.presentedSpine()
    const acceptedStructuralVersion = Math.max(
      priorSpine?.structuralVersion ?? 0,
      active.topology.kind === 'exact' ? active.topology.structuralVersion : 0,
      active.chat?.structuralVersion ?? 0,
    )
    if (destination.proof.structuralVersion < acceptedStructuralVersion) return null
    const replacements: MessageHeaderRow[] = []
    const releaseOverlayIds: MessageId[] = []
    for (const [messageId, current] of active.headers) {
      const sealed = destination.spine.path.get(messageId)
      if (!sealed) continue
      const relation = classifyMessageHeaderRevision(current, sealed)
      if (relation === 'invalid-regression' || relation === 'version-collision') {
        throw new Error(`ConversationSelectionHeaderInvariant:${messageId}:${relation}`)
      }
      if (relation === 'structural-newer') return null
      if (relation === 'compatible-newer') replacements.push(current)
      else releaseOverlayIds.push(messageId)
    }
    if (releaseOverlayIds.length > 0) {
      let headers = active.headers
      for (const messageId of releaseOverlayIds) headers = headers.delete(messageId)
      active.headers = headers
      this.recordHeaderChanges(releaseOverlayIds)
    }
    if (replacements.length === 0) return destination
    const acceptedSpine = destination.spine.replaceHeaders(replacements)
    const presentations = destination.presentations.filter((presentation) => {
      const header = acceptedSpine.path.get(presentation.header.id)
      return Boolean(
        header &&
          sameMessageHeaderValue(header, presentation.header) &&
          presentation.bodyVersion === header.bodyVersion,
      )
    })
    return sealConversationSelection(
      Object.freeze({ ...destination, presentations: Object.freeze(presentations) }),
      acceptedSpine.path,
    )
  }

  private admitMessageRevisions(
    revisions: readonly ConversationMessageRevisionObservation[],
    context: HeaderAdmissionContext,
  ): AppliedHeaderObservations {
    const active = this.active
    if (!active) {
      return {
        changedIds: Object.freeze([]),
        structurallyChangedIds: new Set(),
        byId: new Map(),
      }
    }
    const newestById = new Map<MessageId, ConversationMessageRevisionObservation>()
    for (const revision of revisions) {
      const { header, presentation } = revision
      if (
        header.chatId !== active.chatId ||
        !Number.isSafeInteger(revision.structuralVersion) ||
        revision.structuralVersion < 0
      ) {
        throw new Error(`ConversationMessageRevisionInvalid:${header.id}`)
      }
      if (
        presentation &&
        (presentation.header.id !== header.id ||
          presentation.message.id !== header.id ||
          presentation.header.chatId !== header.chatId ||
          presentation.message.chatId !== header.chatId ||
          presentation.header.nodeVersion !== header.nodeVersion ||
          presentation.header.bodyVersion !== header.bodyVersion ||
          presentation.bodyVersion !== header.bodyVersion)
      ) {
        throw new Error(`ConversationMessagePresentationRevisionInvalid:${header.id}`)
      }
      const prior = newestById.get(header.id)
      if (!prior) {
        newestById.set(header.id, revision)
        continue
      }
      const relation = classifyMessageHeaderRevision(header, prior.header)
      if (relation === 'invalid-regression' || relation === 'version-collision') {
        throw new Error(`ConversationMessageRevisionInvariant:${header.id}:${relation}`)
      }
      if (relation === 'compatible-newer' || relation === 'structural-newer') {
        newestById.set(header.id, revision)
      } else if (relation === 'identical' && presentation && !prior.presentation) {
        newestById.set(header.id, { ...prior, presentation })
      }
    }
    if (context.kind === 'committed') {
      validateStructuralTransition(context.structural, newestById)
    }
    const classified: ClassifiedHeaderObservation[] = []
    const projectionCandidates: ConversationMessageRevisionObservation[] = []
    const acceptedStructuralVersion = Math.max(
      this.presentedSpine()?.structuralVersion ?? 0,
      active.topology.kind === 'exact' ? active.topology.structuralVersion : 0,
    )
    for (const revision of newestById.values()) {
      const current = this.authoritativeHeader(revision.header.id)
      const relation = current
        ? classifyMessageHeaderRevision(revision.header, current)
        : 'structural-newer'
      if (relation === 'invalid-regression' || relation === 'version-collision') {
        throw new Error(
          `ConversationMessageRevisionInvariant:${revision.header.id}:${relation}:${differingMessageHeaderFields(revision.header, current!).join(',')}`,
        )
      }
      if (
        relation === 'older' ||
        (!current && revision.structuralVersion < acceptedStructuralVersion) ||
        (relation === 'structural-newer' && revision.structuralVersion < acceptedStructuralVersion)
      ) {
        continue
      }
      if (relation !== 'identical' || revision.presentation) {
        projectionCandidates.push(revision)
      }
      if (relation !== 'identical') {
        if (context.kind === 'body-snapshot' && relation === 'structural-newer') {
          throw new Error(`ConversationBodySnapshotStructuralConflict:${revision.header.id}`)
        }
        classified.push({
          header: revision.header,
          structureChanged: relation === 'structural-newer',
        })
      }
    }
    const applied = this.applyHeaderObservations(classified)
    if (context.kind === 'committed') {
      this.applyStructuralTransition(applied, context.structural, context.fallback)
    }
    const admittedProjectionRevisions = projectionCandidates.flatMap((revision) => {
      const header = this.authoritativeHeader(revision.header.id)
      if (!header || !sameMessageHeaderValue(header, revision.header)) return []
      const presentation = revision.presentation
      return [
        Object.freeze({
          header,
          ...(presentation && sameMessageHeaderValue(presentation.header, header)
            ? { presentation }
            : {}),
        }),
      ]
    })
    this.applyAdmittedMessageRevisions(
      admittedProjectionRevisions,
      context.kind === 'committed' ? context.paintedTranscript : undefined,
    )
    return applied
  }

  private applyHeaderObservations(
    observations: readonly ClassifiedHeaderObservation[],
  ): AppliedHeaderObservations {
    const active = this.active
    if (!active) {
      return {
        changedIds: Object.freeze([]),
        structurallyChangedIds: new Set(),
        byId: new Map(),
      }
    }
    const changedIds: MessageId[] = []
    const byId = new Map<MessageId, MessageHeaderRow | undefined>()
    const structurallyChangedIds = new Set<MessageId>()
    let headers = active.headers
    for (const observation of observations) {
      const header = observation.header
      if (header.chatId !== active.chatId) continue
      const current = this.authoritativeHeader(header.id)
      if (!headerSupersedes(header, current)) continue
      if (
        observation.structureChanged ||
        current?.requestContextVersion !== header.requestContextVersion
      ) {
        this.promptPathRevision += 1
      }
      changedIds.push(header.id)
      byId.set(header.id, header)
      if (observation.structureChanged) structurallyChangedIds.add(header.id)
      headers = headers.set(header.id, header)
    }
    active.headers = headers
    if (active.topology.kind === 'exact' && byId.size > 0) {
      const topologyHeaders = new Map(active.topology.headerById)
      for (const header of byId.values()) {
        if (header) topologyHeaders.set(header.id, header)
      }
      active.topology = withExactTopologyHeaders(active.topology, topologyHeaders)
    }
    const path = this.presentedSpine()?.path
    for (const messageId of changedIds) {
      if (path?.has(messageId)) active.compactableHeaderIds.delete(messageId)
      else active.compactableHeaderIds.add(messageId)
    }
    const recordedChangedIds = this.recordHeaderChanges(changedIds)
    return {
      changedIds: recordedChangedIds,
      structurallyChangedIds,
      byId,
    }
  }

  private applyStructuralTransition(
    observations: AppliedHeaderObservations,
    transition: ConversationStructuralTransition,
    fallback: 'defer-to-sealed-replacement' | 'resolve-if-invalidated',
  ): void {
    const active = this.active
    const priorSpine = this.presentedSpine()
    if (!active) return
    if (transition.kind === 'none' && observations.structurallyChangedIds.size > 0) {
      throw new Error('ConversationStructuralTransitionEvidenceMissing')
    }
    if (transition.kind === 'exact-delta') {
      const exactIds = new Set(transition.messageIds)
      for (const messageId of observations.structurallyChangedIds) {
        if (!exactIds.has(messageId)) {
          throw new Error(`ConversationStructuralTransitionCoverageMissing:${messageId}`)
        }
      }
    }

    const pathReduction = reduceAcceptedPath(priorSpine, observations)
    let nextSpine = priorSpine
    if (nextSpine && pathReduction.kind === 'compatible') {
      nextSpine = nextSpine.replaceHeaders(pathReduction.replacements)
    }
    let pathInvalidated = pathReduction.kind === 'structurally-invalidated'
    let nextStructuralVersion = nextSpine?.structuralVersion ?? null
    if (transition.kind === 'exact-delta' && nextSpine) {
      const advanced = exactStructuralTransitionVersion(nextSpine.structuralVersion, transition)
      if (advanced === null) pathInvalidated = true
      else nextStructuralVersion = advanced
      if (exactTransitionChangesPath(active, nextSpine, transition.messageIds)) {
        pathInvalidated = true
      }
    } else if (transition.kind === 'incomplete' && nextSpine) {
      if (
        transition.scope === true ||
        transition.scope.some((messageId) => nextSpine?.path.has(messageId))
      ) {
        pathInvalidated = true
      } else if (
        transition.toVersion !== null &&
        transition.toVersion >= nextSpine.structuralVersion
      ) {
        nextStructuralVersion = transition.toVersion
      }
    }
    if (
      nextSpine &&
      !pathInvalidated &&
      nextStructuralVersion !== null &&
      nextStructuralVersion > nextSpine.structuralVersion
    ) {
      nextSpine = nextSpine.withStructuralVersion(nextStructuralVersion)
    }

    let nextTopology = active.topology
    let refreshTopology = transition.kind === 'incomplete'
    if (transition.kind === 'exact-delta' && active.topology.kind === 'exact') {
      const advanced = exactStructuralTransitionVersion(
        active.topology.structuralVersion,
        transition,
      )
      if (advanced === null) {
        refreshTopology = true
      } else if (advanced > active.topology.structuralVersion) {
        const nextIndex = active.topology.index.applyDelta(
          transition.messageIds,
          transition.messageIds.map((messageId) => {
            const header = this.authoritativeHeader(messageId)
            if (!header) throw new Error(`ConversationStructuralDeltaHeaderMissing:${messageId}`)
            return toStructuralMessageHeader(header)
          }),
        )
        const carriedProof =
          priorSpine &&
          nextSpine &&
          !pathInvalidated &&
          active.topology.provedPathIdentity === priorSpine.path.identity &&
          nextSpine.structuralVersion === advanced
            ? nextSpine.path.identity
            : null
        nextTopology = exactTopologyState(
          advanced,
          nextIndex,
          active.topology.headerById,
          carriedProof,
        )
      }
    }

    if (priorSpine && nextSpine && nextSpine !== priorSpine && !pathInvalidated) {
      if (
        nextTopology.kind === 'exact' &&
        nextTopology.structuralVersion === nextSpine.structuralVersion &&
        nextTopology.provedPathIdentity === priorSpine.path.identity
      ) {
        nextTopology = reproveExactTopologyState(nextTopology, nextSpine.path.identity)
      }
      active.destination = replacePresentedDestinationSpine(active.destination, nextSpine)
    }
    active.topology = nextTopology

    let resolveDestination = false
    if (
      priorSpine &&
      pathInvalidated &&
      fallback === 'resolve-if-invalidated' &&
      active.destination.kind !== 'resolving'
    ) {
      active.transcript = retainTranscriptState(active.transcript)
      active.destination = Object.freeze({
        kind: 'unresolved',
        retained: Object.freeze({ kind: 'ready', spine: nextSpine ?? priorSpine }),
      })
      resolveDestination = true
    }
    if (resolveDestination) this.requestDestination(active.chatId)
    if (refreshTopology) this.requestTopology(true)
  }

  private recordHeaderChanges(changedIds: readonly MessageId[]): readonly MessageId[] {
    const active = this.active
    if (!active || changedIds.length === 0) return Object.freeze([])
    const unique = Object.freeze([...new Set(changedIds)])
    active.headerChangeRevision += 1
    active.changedHeaderKeys = unique
    return unique
  }

  private selectionAttemptIsCurrent(attempt: ConversationSelectionAttempt): boolean {
    const active = this.active
    const session = this.activeSession()
    return Boolean(
      active?.selectionAttempt === attempt &&
        active.chatId === attempt.chatId &&
        session?.intent === attempt.intent &&
        session.selectionRevision === attempt.selectionRevision &&
        attempt.workspaceId === this.workspaceId &&
        attempt.workspaceEpoch === this.workspaceEpoch,
    )
  }

  private restartSelectionAttempt(attempt: ConversationSelectionAttempt): void {
    if (!this.selectionAttemptIsCurrent(attempt)) return
    this.beginSelectionResolution(false)
    this.requestDestination(attempt.chatId)
    this.publish()
  }

  private retrySelectionAttempt(
    attempt: ConversationSelectionAttempt,
    proofTarget: ConversationSelectionProofTarget = attempt.proofTarget,
  ): void {
    if (!this.selectionAttemptIsCurrent(attempt)) return
    const session = this.activeSession()
    if (!session) return
    const provisionalPoint =
      this.active?.transcript.kind === 'point' &&
      proofTarget.kind === 'fixed-tip' &&
      this.active.transcript.tipId === proofTarget.messageId
        ? this.active.transcript
        : null
    this.beginSelectionResolution(false)
    const retry = this.installSelectionAttempt(attempt.chatId, session, proofTarget)
    if (!retry) return
    if (provisionalPoint && this.active?.chatId === attempt.chatId) {
      this.active.transcript = Object.freeze({
        ...provisionalPoint,
        attemptId: retry.id,
      })
    }
    this.requestSelection(retry)
    this.publish()
  }

  private reproveAcceptedSpine(): void {
    const active = this.active
    const session = this.activeSession()
    const spine = this.activeSpine()
    if (!active || !session || !spine || active.destination.kind !== 'ready') return
    this.beginSelectionResolution(false)
    const attempt = this.installSelectionAttempt(
      active.chatId,
      session,
      fixedConversationSelectionTarget(session.intent.selection, spine.resolvedLeafId),
    )
    if (!attempt) return
    this.requestSelection(attempt)
    this.publish()
  }

  private installSelectionAttempt(
    chatId: ChatId,
    session: ChatSession,
    proofTarget: ConversationSelectionProofTarget,
  ): ConversationSelectionAttempt | null {
    const active = this.active
    const workspaceId = this.workspaceId
    if (!active || active.chatId !== chatId || workspaceId === null) return null
    this.cancelSelectionAttempt()
    const attemptId = newId()
    const key = `${workspaceId}:${this.workspaceEpoch}:${chatId}:${session.selectionRevision}:${attemptId}`
    const attempt: ConversationSelectionAttempt = Object.freeze({
      id: attemptId,
      chatId,
      workspaceId,
      workspaceEpoch: this.workspaceEpoch,
      selectionRevision: session.selectionRevision,
      intent: session.intent,
      key,
      proofTarget,
    })
    active.selectionAttempt = attempt
    active.destination = Object.freeze({
      kind: 'resolving',
      key,
      retained: retainedReadyDestination(active.destination),
    })
    return attempt
  }

  private requestDestination(chatId: ChatId): void {
    const source = this.source
    const active = this.active
    const session = this.activeSession()
    if (!source || !active || !session || active.chatId !== chatId) return
    const existingAttempt = active.selectionAttempt
    if (
      existingAttempt &&
      existingAttempt.intent === session.intent &&
      existingAttempt.selectionRevision === session.selectionRevision &&
      active.destination.kind === 'resolving'
    ) {
      return
    }
    const selection = session.intent.selection
    const attempt = this.installSelectionAttempt(
      chatId,
      session,
      resolvingConversationSelectionTarget(selection),
    )
    if (!attempt) return
    this.requestSelection(attempt)
  }

  private requestChat(chatId: ChatId): void {
    const source = this.source
    const active = this.active
    if (!source || !active || active.chatId !== chatId) return
    const key = `${this.workspaceKey()}:${chatId}:chat`
    if (this.reads.get('chat')?.key === key) return
    if (this.readIsBlocked('chat', key)) return
    const read = this.startRead('chat', key)
    void source.loadChat(chatId, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('chat', read)) return
        const current = this.active
        if (!this.matchesWorkspace(envelope) || !current || current.chatId !== chatId) {
          this.reconcileReadConflict(
            'chat',
            read,
            key,
            new Error('ConversationChatStateMismatch'),
            () => this.requestChat(chatId),
          )
          return
        }
        this.finishRead('chat', read)
        if (!envelope.value) {
          current.chat = null
          this.settleSelectionDestination(Object.freeze({ kind: 'missing' }))
        } else if (
          current.chat === null ||
          chatMetadataReceiptDominates(envelope.value, current.chat)
        ) {
          current.chat = structuredClone(envelope.value)
        }
        this.publish()
        this.refreshBodyDemands()
      },
      (error) => this.failRead('chat', read, key, error),
    )
  }

  private requestSelection(attempt: ConversationSelectionAttempt): void {
    const source = this.source
    const active = this.active
    if (!source || !active || !this.selectionAttemptIsCurrent(attempt)) return
    const proofTarget = attempt.proofTarget
    const key = `${attempt.key}:selection:${proofTargetKey(proofTarget)}`
    if (this.reads.get('selection')?.key === key) return
    if (this.readIsBlocked('selection', key)) return
    const read = this.startRead('selection', key)
    void source
      .openSelection(
        attempt.chatId,
        proofTarget,
        (envelope) => this.receiveSelectionPoint(attempt, read, envelope),
        read.controller.signal,
      )
      .then(
        (envelope) => {
          if (!this.readIsCurrent('selection', read)) return
          const current = this.active
          const currentSession = this.activeSession()
          if (
            !this.matchesWorkspace(envelope) ||
            !current ||
            current.chatId !== attempt.chatId ||
            !currentSession ||
            !this.selectionAttemptIsCurrent(attempt)
          ) {
            this.reconcileReadConflict(
              'selection',
              read,
              key,
              new Error('ConversationOpenSelectionStateMismatch'),
              () => this.restartSelectionAttempt(attempt),
            )
            return
          }
          const destination = envelope.value
          if (!sameProofTarget(destination.target, proofTarget)) {
            this.reconcileReadConflict(
              'selection',
              read,
              key,
              new Error('ConversationOpenSelectionSelectionMismatch'),
              () => this.restartSelectionAttempt(attempt),
            )
            return
          }
          if (destination.kind === 'missing') {
            this.finishRead('selection', read)
            current.chat = null
            this.settleSelectionDestination(Object.freeze({ kind: 'missing' }))
            this.publish()
            return
          }
          if (destination.chat.id !== attempt.chatId) {
            this.reconcileReadConflict(
              'selection',
              read,
              key,
              new Error('ConversationOpenSelectionChatMismatch'),
              () => this.restartSelectionAttempt(attempt),
            )
            return
          }
          if (destination.kind === 'stale') {
            this.finishRead('selection', read)
            this.observationRevision += 1
            current.chat = destination.chat
            this.retrySelectionAttempt(attempt, destination.retryTarget)
            return
          }
          if (destination.kind === 'unavailable') {
            this.finishRead('selection', read)
            current.chat = destination.chat
            if (
              proofTarget.kind === 'resolve-selection' &&
              proofTarget.selection.kind === 'default'
            ) {
              this.blockRead(
                'selection',
                key,
                'source-invariant',
                new Error(`ConversationDefaultSelectionUnavailable:${destination.reason}`),
              )
              return
            }
            if (attempt.intent.unavailable === 'canonicalize-default') {
              currentSession.selectionRevision += 1
              currentSession.intent = conversationSelectionIntent({ kind: 'default' })
              this.clearReveals(attempt.chatId, currentSession)
              this.beginSelectionResolution()
              this.persistSession(attempt.chatId)
              this.publish()
              this.requestDestination(attempt.chatId)
              return
            }
            this.settleSelectionDestination(
              Object.freeze({
                kind: 'unavailable',
                selection: attempt.intent.selection,
                reason: destination.reason,
                retained: retainedReadyDestination(current.destination),
              }),
            )
            this.publish()
            return
          }
          if (destination.proof.chatId !== attempt.chatId) {
            this.reconcileReadConflict(
              'selection',
              read,
              key,
              new Error('ConversationOpenSelectionProofMismatch'),
              () => this.restartSelectionAttempt(attempt),
            )
            return
          }
          let admission: SelectionAdmissionResult
          try {
            admission = this.admitSealedSelection(currentSession, destination)
          } catch (error) {
            this.failInvariant('selection', key, projectionFailureError(error))
            return
          }
          if (admission.kind === 'structural-conflict') {
            this.finishRead('selection', read)
            if (read.observationRevision < admission.observationRevision) {
              this.retrySelectionAttempt(
                attempt,
                fixedConversationSelectionTarget(attempt.intent.selection, destination.proof.tipId),
              )
            } else {
              this.blockRead(
                'selection',
                key,
                'source-invariant',
                new Error('ConversationSelectionAdmissionConflictWithoutNewObservation'),
              )
            }
            return
          }
          this.finishRead('selection', read)
          this.observationRevision += 1
          this.persistSession(attempt.chatId)
          this.publish()
          this.refreshBodyDemands()
        },
        (error) => {
          this.failRead('selection', read, key, error)
        },
      )
  }

  private receiveSelectionPoint(
    attempt: ConversationSelectionAttempt,
    read: PendingRead,
    envelope: ConversationReadEnvelope<ConversationDestinationPoint>,
  ): void {
    if (!this.readIsCurrent('selection', read)) return
    const current = this.active
    if (
      !this.matchesWorkspace(envelope) ||
      !current ||
      current.chatId !== attempt.chatId ||
      !this.selectionAttemptIsCurrent(attempt)
    ) {
      return
    }
    const point = envelope.value
    if (
      !sameProofTarget(point.target, attempt.proofTarget) ||
      point.chat.id !== attempt.chatId ||
      point.structuralVersion !== point.chat.structuralVersion
    ) {
      return
    }
    this.acceptDestinationPoint(point, attempt)
    this.publish()
  }

  private requestForkUpdates(
    parentIds: true | readonly (MessageId | null)[],
    reason: 'visibility' | 'workspace-change' = 'visibility',
    acceptedWindow?: ConversationTranscriptFrame,
  ): void {
    const active = this.active
    const session = this.activeSession()
    if (!active || !session) {
      this.cancelForkWork()
      return
    }
    if (
      this.pendingForkChatId !== active.chatId ||
      this.pendingForkSelectionRevision !== session.selectionRevision
    ) {
      this.cancelRead('forks')
      this.pendingForkChatId = active.chatId
      this.pendingForkSelectionRevision = session.selectionRevision
      this.pendingForkParentIds.clear()
    }
    const demandedParentIds =
      parentIds === true
        ? this.presentedTranscriptForkParentIds(acceptedWindow)
        : this.relevantPresentedTranscriptForkParentIds(parentIds, acceptedWindow)
    if (demandedParentIds.length === 0) return
    for (const parentId of demandedParentIds) this.pendingForkParentIds.add(parentId)
    if (reason === 'workspace-change') this.cancelRead('forks')
    if (this.reads.has('forks')) return
    this.readPendingForkUpdates()
  }

  private presentedTranscriptForkParentIds(
    acceptedWindow?: ConversationTranscriptFrame,
  ): readonly (MessageId | null)[] {
    const active = this.active
    if (!active) return Object.freeze([])
    const window = acceptedWindow ?? presentedTranscriptWindow(active.transcript)
    if (window) {
      return Object.freeze([...transcriptBodyWindowRows(window)].map((row) => row.header.parentId))
    }
    const leaf = this.activeSpine()?.path.leaf
    return leaf ? Object.freeze([leaf.parentId]) : Object.freeze([])
  }

  private relevantPresentedTranscriptForkParentIds(
    parentIds: readonly (MessageId | null)[],
    acceptedWindow?: ConversationTranscriptFrame,
  ): readonly (MessageId | null)[] {
    const active = this.active
    const spine = this.activeSpine()
    if (!active || !spine) return Object.freeze([])
    const window = acceptedWindow ?? presentedTranscriptWindow(active.transcript)
    if (!window) {
      const leafParentId = spine.path.leaf?.parentId
      return leafParentId !== undefined && parentIds.includes(leafParentId)
        ? Object.freeze([leafParentId])
        : Object.freeze([])
    }
    return Object.freeze(
      parentIds.filter((parentId) => {
        const selected = spine.path.childOf(parentId)
        return selected ? transcriptBodyWindowFindRow(window, selected.id) !== undefined : false
      }),
    )
  }

  private readPendingForkUpdates(): void {
    const source = this.source
    const active = this.active
    const session = this.activeSession()
    const spine = this.activeSpine()
    if (
      !source ||
      !active ||
      !session ||
      this.pendingForkChatId !== active.chatId ||
      this.pendingForkSelectionRevision !== session.selectionRevision
    ) {
      this.cancelForkWork()
      return
    }
    if (!spine) {
      this.cancelForkWork()
      return
    }
    const parentIds = [...this.pendingForkParentIds]
    const targetsBySelectedId = new Map<MessageId, ActiveBranchForkTarget>()
    const selectedHeaders = parentIds.flatMap((parentId) => {
      const selected = spine.path.childOf(parentId)
      return selected ? [selected] : []
    })
    for (const selected of selectedHeaders) {
      targetsBySelectedId.set(selected.id, {
        parentId: selected.parentId,
        selectedMessageId: selected.id,
      })
    }
    const targets = [...targetsBySelectedId.values()].sort((left, right) =>
      left.selectedMessageId < right.selectedMessageId
        ? -1
        : left.selectedMessageId > right.selectedMessageId
          ? 1
          : 0,
    )
    if (targets.length === 0) {
      for (const parentId of parentIds) this.pendingForkParentIds.delete(parentId)
      this.cancelRead('forks')
      return
    }
    const revision = session.selectionRevision
    const structuralVersion = spine.structuralVersion
    const key = `${this.workspaceKey()}:${active.chatId}:${revision}:${structuralVersion}:${targets
      .map((target) => `${target.parentId ?? '__root__'}>${target.selectedMessageId}`)
      .join(',')}`
    if (this.reads.get('forks')?.key === key) return
    if (this.readIsBlocked('forks', key)) return
    const read = this.startRead('forks', key)
    void source.loadForks(active.chatId, structuralVersion, targets, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('forks', read)) return
        const currentSession = this.activeSession()
        const currentSpine = this.activeSpine()
        if (
          !this.matchesWorkspace(envelope) ||
          !currentSession ||
          !currentSpine ||
          currentSession.selectionRevision !== revision ||
          currentSpine.chatId !== active.chatId ||
          (envelope.value.kind === 'ready' &&
            envelope.value.forks.some((fork) => {
              const selected = currentSpine.path.get(fork.selectedMessageId)
              return !selected || selected.parentId !== fork.parentId
            }))
        ) {
          this.reconcileReadConflict(
            'forks',
            read,
            key,
            new Error('ConversationForkResultMismatch'),
            () => this.readPendingForkUpdates(),
          )
          return
        }
        this.finishRead('forks', read)
        if (
          envelope.value.kind === 'stale-selection' ||
          envelope.value.structuralVersion !== currentSpine.structuralVersion
        ) {
          for (const parentId of parentIds) this.pendingForkParentIds.delete(parentId)
          this.reproveAcceptedSpine()
          return
        }
        const nextSpine = currentSpine.replaceForks(envelope.value.forks)
        const changed = nextSpine !== currentSpine
        if (changed && this.active) {
          this.observationRevision += 1
          let forkFacts = this.active.forks
          for (const fork of envelope.value.forks) {
            forkFacts = forkFacts.set(fork.selectedMessageId, fork)
          }
          this.active.forks = forkFacts
          this.active.destination = Object.freeze({
            kind: 'ready',
            spine: nextSpine,
          })
        }
        for (const parentId of parentIds) this.pendingForkParentIds.delete(parentId)
        this.readPendingForkUpdates()
        if (changed) this.publish()
      },
      (error) => {
        this.failRead('forks', read, key, error)
      },
    )
  }

  private acceptSelectedSpine(
    session: ChatSession,
    spine: VersionedActiveBranchSpine<MessageHeaderRow>,
  ): void {
    const previousPath = this.presentedSpine()?.path ?? null
    this.cancelRead('transcript')
    if (this.active) this.active.transcriptFill = null
    if (this.active?.transcript.kind === 'ready') {
      this.active.transcript = readyTranscriptState(
        this.active.transcript.selectionEpoch,
        this.active.transcript.window,
      )
    }
    if (this.active?.chatId === spine.chatId) {
      let retainedForks = PersistentStringMap.empty<ActiveBranchForkSlot>()
      for (const fork of spine.forkSlots()) {
        retainedForks = retainedForks.set(fork.selectedMessageId, fork)
      }
      this.active.forks = retainedForks
      this.active.destination = Object.freeze({ kind: 'ready', spine })
      const releasedHeaderIds: MessageId[] = []
      let headers = this.active.headers
      for (const [messageId, header] of headers) {
        const selected = spine.path.get(messageId)
        if (!selected) continue
        const relation = classifyMessageHeaderRevision(header, selected)
        if (relation === 'invalid-regression' || relation === 'version-collision') {
          throw new Error(`ConversationSelectionHeaderInvariant:${messageId}:${relation}`)
        }
        if (relation === 'older' || relation === 'identical') {
          headers = headers.delete(messageId)
          releasedHeaderIds.push(messageId)
        }
      }
      if (headers !== this.active.headers) {
        this.active.headers = headers
        this.recordHeaderChanges(releasedHeaderIds)
      }
      for (const messageId of this.active.compactableHeaderIds) {
        if (spine.path.has(messageId)) this.active.compactableHeaderIds.delete(messageId)
      }
    }
    if (this.active) this.proveTopologyPath(this.active, spine)
    session.cursor = session.cursor.accept(spine.path, previousPath)
    session.intent = conversationSelectionIntent(
      spine.resolvedLeafId ? { kind: 'tip', messageId: spine.resolvedLeafId } : { kind: 'default' },
    )
    this.compactExactHeaders()
    this.rebaseTranscriptToSpine(spine)
  }

  private rebaseTranscriptToSpine(
    spine: VersionedActiveBranchSpine<MessageHeaderRow>,
    changedIds: readonly MessageId[] = [],
  ): void {
    const active = this.active
    if (!active) return
    const exact = readyTranscriptWindow(active.transcript)
    if (!exact) return
    const rebased = rebaseTranscriptBodyWindow(
      spine.path,
      exact,
      new Map<MessageId, ConversationMessagePresentation>(),
      changedIds,
    )
    if (!rebased) {
      active.transcript = retainTranscriptState(active.transcript)
      return
    }
    active.transcript = readyTranscriptState(active.transcript.selectionEpoch, rebased)
  }

  private applyAdmittedMessageRevisions(
    revisions: readonly {
      readonly header: MessageHeaderRow
      readonly presentation?: ConversationMessagePresentation
    }[],
    paintedTranscript: ConversationTranscriptFrame | null = null,
  ): void {
    const active = this.active
    if (!active || revisions.length === 0) return
    const presentations = revisions.flatMap((revision) =>
      revision.presentation ? [revision.presentation] : [],
    )
    const byId = new Map(
      presentations.map((presentation) => [presentation.message.id, presentation]),
    )
    if (presentations.length > 0) {
      for (const presentation of presentations) {
        if (presentation.header.chatId !== active.chatId || presentation.message.deleted) continue
        active.previews.set(presentation.message.id, {
          messageId: presentation.message.id,
          bodyVersion: presentation.bodyVersion,
          text: previewTextFromContent(presentation.message.content, TREE_PREVIEW_MAX_CHARS),
        })
      }
      const previewDemand = combinedPreviewDemand(this.previewDemands, active.chatId)
      trimPreviewCache(active.previews, previewDemand?.targets ?? [])
      active.previewSnapshot = new Map(active.previews)
    }
    const spine = this.presentedSpine()
    const reviseWindow = (
      window: ConversationTranscriptFrame,
    ): ConversationTranscriptFrame | null =>
      spine
        ? rebaseTranscriptBodyWindow(
            spine.path,
            window,
            byId,
            revisions.map((revision) => revision.header.id),
          )
        : withTranscriptBodyRevisions(window, revisions)
    const transcriptWindow = presentedTranscriptWindow(active.transcript) ?? paintedTranscript
    const nextTranscriptWindow = transcriptWindow ? reviseWindow(transcriptWindow) : null
    if (nextTranscriptWindow) {
      if (active.transcript.kind === 'ready') {
        active.transcript = readyTranscriptState(
          active.transcript.selectionEpoch,
          nextTranscriptWindow,
        )
      } else if (active.transcript.kind === 'retained') {
        active.transcript = Object.freeze({ ...active.transcript, window: nextTranscriptWindow })
      } else if (active.transcript.kind === 'point') {
        active.transcript = Object.freeze({ ...active.transcript, window: nextTranscriptWindow })
      }
    }
    const transcriptResident = active.presentationResidents.transcript
    if (transcriptResident && presentations.length > 0) {
      const residentWindow =
        transcriptResident.window === transcriptWindow
          ? nextTranscriptWindow
          : reviseWindow(transcriptResident.window)
      if (residentWindow && residentWindow !== transcriptResident.window) {
        const revisedResident = Object.freeze({
          ...transcriptResident,
          window: residentWindow,
        })
        active.presentationResidents.transcript = revisedResident
        if (
          this.paintedFrame?.chat.id === active.chatId &&
          this.paintedFrame.binding === transcriptResident
        ) {
          this.paintedFrame = Object.freeze({
            chat: this.paintedFrame.chat,
            binding: revisedResident,
          })
        }
      }
    }
    const inspectorDemand = latestInspectorDemand(this.inspectorDemands, active.chatId)
    if (inspectorDemand) {
      const presentation = byId.get(inspectorDemand.messageId)
      if (presentation) {
        active.inspector.exact = presentation
        active.inspector.retained = presentation
        active.inspector.resolvingKey = null
      } else {
        const revision = revisions.find(
          (candidate) => candidate.header.id === inspectorDemand.messageId,
        )
        const exact = active.inspector.exact
        if (revision && exact?.message.id === revision.header.id) {
          if (exact.bodyVersion === revision.header.bodyVersion) {
            const rebased = Object.freeze({
              header: revision.header,
              message: rebaseHydratedMessageHeader(exact.message, revision.header),
              bodyVersion: revision.header.bodyVersion,
            })
            active.inspector.exact = rebased
            active.inspector.retained = rebased
          } else {
            active.inspector.retained = exact
            active.inspector.exact = null
          }
        }
      }
    }
  }

  private invalidateLoadedBodyRows(messageIds: ConversationProjectionScope<MessageId>): void {
    const active = this.active
    if (!active) return
    if (active.transcript.kind !== 'absent') {
      const window = invalidateTranscriptBodyRows(active.transcript.window, messageIds)
      if (window !== active.transcript.window) {
        this.cancelRead('transcript')
        active.transcriptFill = null
        active.transcript = Object.freeze({ ...active.transcript, window })
      }
    }
    const inspectorMessageId = active.inspector.exact?.message.id
    if (inspectorMessageId && (messageIds === true || messageIds.includes(inspectorMessageId))) {
      this.cancelRead('inspector')
      active.inspector.retained = active.inspector.exact
      active.inspector.exact = null
    }
  }

  private requestTopology(force = false): void {
    const source = this.source
    const active = this.active
    if (!source || !active || !this.activeNeedsTopology(active)) return
    const requiredVersion =
      this.presentedSpine()?.structuralVersion ?? active.chat?.structuralVersion
    const key = `${this.workspaceKey()}:${active.chatId}:tree:${requiredVersion ?? 'unknown'}`
    if (
      !force &&
      active.topology.kind === 'exact' &&
      requiredVersion !== undefined &&
      active.topology.structuralVersion === requiredVersion
    ) {
      return
    }
    if (this.reads.get('topology')?.key === key) {
      if (!force) return
      this.cancelRead('topology')
    }
    if (this.readIsBlocked('topology', key)) return
    const read = this.startRead('topology', key)
    void source.loadTopology(active.chatId, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('topology', read)) return
        const current = this.active
        if (
          !this.matchesWorkspace(envelope) ||
          !current ||
          current.chatId !== active.chatId ||
          !this.activeNeedsTopology(current)
        ) {
          this.reconcileReadConflict(
            'topology',
            read,
            key,
            new Error('ConversationTopologyResultMismatch'),
            () => this.requestTopology(true),
          )
          return
        }
        const result = envelope.value
        if (result.kind === 'stale') {
          this.finishRead('topology', read)
          this.requestTopology(true)
          return
        }
        if (result.kind === 'missing') {
          this.finishRead('topology', read)
          this.observationRevision += 1
          const removedHeaderIds = [...current.headers.keys()]
          current.headers = PersistentStringMap.empty()
          current.compactableHeaderIds.clear()
          current.forks = PersistentStringMap.empty()
          current.topology = exactTopologyState(0, EMPTY_TOPOLOGY, new Map(), null)
          this.recordHeaderChanges(removedHeaderIds)
          this.beginSelectionResolution(false)
          this.requestDestination(current.chatId)
          this.publish()
          return
        }
        if (
          (current.chat && current.chat.structuralVersion > result.structuralVersion) ||
          result.chat.id !== current.chatId
        ) {
          this.finishRead('topology', read)
          this.requestTopology(true)
          return
        }
        const byId = new Map(result.headers.map((header) => [header.id, header] as const))
        let snapshotSuperseded = false
        for (const [messageId, header] of current.headers) {
          const loaded = byId.get(messageId)
          if (!loaded) {
            snapshotSuperseded = true
            break
          }
          const relation = classifyMessageHeaderRevision(header, loaded)
          if (relation === 'invalid-regression' || relation === 'version-collision') {
            throw new Error(`ConversationTopologyHeaderInvariant:${messageId}:${relation}`)
          }
          if (relation === 'structural-newer') {
            snapshotSuperseded = true
            break
          }
          if (relation === 'compatible-newer') byId.set(messageId, header)
        }
        if (snapshotSuperseded) {
          this.finishRead('topology', read)
          this.requestTopology(true)
          return
        }

        this.observationRevision += 1
        this.admitMessageRevisions(
          result.headers.map((header) =>
            Object.freeze({ header, structuralVersion: result.structuralVersion }),
          ),
          { kind: 'topology-snapshot' },
        )
        const headers = result.headers.map((header) => {
          const accepted = this.authoritativeHeader(header.id)
          if (!accepted || !sameStructuralHeader(accepted, header)) {
            throw new Error(`ConversationTopologyAdmissionMismatch:${header.id}`)
          }
          return accepted
        })
        const acceptedById = new Map(headers.map((header) => [header.id, header] as const))
        this.finishRead('topology', read)
        if (current.chat === null || chatMetadataReceiptDominates(result.chat, current.chat)) {
          current.chat = structuredClone(result.chat)
        }
        const acceptedSpine = this.presentedSpine()
        const nextTopology = createMessageTopologyIndex(
          headers.map(toStructuralMessageHeader),
          TOPOLOGY_OPTIONS,
        )
        if (acceptedSpine) {
          const topologySpine = activeBranchSpineFromTopology(
            acceptedSpine,
            result.structuralVersion,
            acceptedById,
          )
          if (topologySpine) {
            current.destination = replacePresentedDestinationSpine(
              current.destination,
              topologySpine,
            )
            current.topology = exactTopologyState(
              result.structuralVersion,
              nextTopology,
              acceptedById,
              topologySpine.path.identity,
            )
            this.rebaseTranscriptToSpine(
              topologySpine,
              presentedTranscriptMessageIds(current.transcript),
            )
          } else {
            current.topology = exactTopologyState(
              result.structuralVersion,
              nextTopology,
              acceptedById,
              null,
            )
            this.beginSelectionResolution(false)
            this.requestDestination(current.chatId)
          }
        } else {
          current.topology = exactTopologyState(
            result.structuralVersion,
            nextTopology,
            acceptedById,
            null,
          )
        }
        this.compactExactHeaders()
        this.publish()
        this.requestForkUpdates(true, 'workspace-change')
        this.refreshBodyDemands()
      },
      (error) => {
        this.failRead('topology', read, key, error)
      },
    )
  }

  private releaseTopology(): void {
    const active = this.active
    if (!active) return
    const previousHeaders = active.headers
    this.cancelRead('topology')
    this.blockedReads.delete('topology')
    const releasedLoadedTopology = active.topology.kind === 'exact'
    if (releasedLoadedTopology) active.topology = ABSENT_TOPOLOGY
    const recycledResident = this.recycleTreeResident(active)
    const releasedFailure = active.failure?.kind === 'topology'
    if (releasedFailure) active.failure = null
    this.compactExactHeaders()
    if (
      releasedLoadedTopology ||
      recycledResident ||
      releasedFailure ||
      active.headers !== previousHeaders
    ) {
      this.publish()
    }
  }

  private recycleTreeResident(active: ActiveProjection): boolean {
    const resident = active.presentationResidents.tree
    if (!resident || resident.topology === EMPTY_STRUCTURAL_TOPOLOGY) return false
    const path = resident.spine.path
    const retainedInspector = resident.inspector.exact ?? resident.inspector.retained
    const headers: ConversationMessageHeaderLookup = Object.freeze({
      get: (messageId: MessageId) =>
        retainedInspector?.header.id === messageId ? retainedInspector.header : path.get(messageId),
      has: (messageId: MessageId) =>
        retainedInspector?.header.id === messageId || path.has(messageId),
    })
    active.presentationResidents.tree = Object.freeze({
      ...resident,
      currency: 'retained',
      reveal: null,
      headers,
      topology: EMPTY_STRUCTURAL_TOPOLOGY,
      changedHeaderKeys: Object.freeze([]),
      inspector: Object.freeze({
        exact: null,
        retained: retainedInspector,
        resolving: false,
      }),
      previews: new Map(),
    })
    return true
  }

  private requestTranscript(): void {
    if (this.stageTranscriptDrain()) this.publish()
  }

  private stageTranscriptDrain(): boolean {
    const previousActive = this.active
    const previousTranscript = previousActive?.transcript
    const previousFailure = previousActive?.failure
    const previouslyFilling = this.reads.has('transcript')
    const projectionChanged = (): boolean =>
      this.active !== previousActive ||
      previousActive?.transcript !== previousTranscript ||
      previousActive?.failure !== previousFailure ||
      this.reads.has('transcript') !== previouslyFilling
    const source = this.source
    const active = this.active
    const session = this.activeSession()
    const baseDemand = active && session ? this.currentTranscriptDemand(active, session) : null
    const spine = this.activeSpine()
    const path = spine?.path
    if (
      !active ||
      !active.chat ||
      !baseDemand ||
      !spine ||
      !path ||
      active.destination.kind !== 'ready'
    ) {
      this.cancelRead('transcript')
      if (active) active.transcriptFill = null
      if (active && !baseDemand) {
        active.transcriptPlan = null
        if (path) this.recycleTranscriptResident(active, path)
      }
      return projectionChanged()
    }
    const plan = this.acceptTranscriptPlan(active, baseDemand, path)
    if (path.length === 0) {
      const empty = emptyTranscriptBodyWindow(active.chatId, path)
      active.transcript = readyTranscriptState(active.transcript.selectionEpoch, empty)
      active.transcriptFill = null
      this.cancelRead('transcript')
      return projectionChanged()
    }
    const desiredWindow = plan.span
    let fill =
      active.transcriptFill?.selectionEpoch === active.transcript.selectionEpoch &&
      active.transcriptFill.pathIdentity === path.identity
        ? active.transcriptFill
        : null
    if (active.transcriptFill && !fill) {
      active.transcriptFill = null
    }
    if (fill?.kind === 'choose') {
      const prefixEnd = fill.commonPrefix.offset + fill.commonPrefix.rowCount
      fill =
        prefixEnd > desiredWindow.offset
          ? Object.freeze({
              kind: prefixEnd < path.length ? 'append' : 'prepend',
              selectionEpoch: fill.selectionEpoch,
              pathIdentity: fill.pathIdentity,
              window: fill.commonPrefix,
            })
          : fill.terminalFallback
            ? Object.freeze({
                kind: 'prepend',
                selectionEpoch: fill.selectionEpoch,
                pathIdentity: fill.pathIdentity,
                window: fill.terminalFallback,
              })
            : null
      active.transcriptFill = fill
    }
    let reusableWindow = fill?.window ?? readyTranscriptWindow(active.transcript)
    let fillDirection = fill?.kind ?? 'prepend'
    if (
      reusableWindow &&
      (!transcriptBodyWindowMatchesPath(reusableWindow, path) ||
        (fillDirection === 'prepend' &&
          reusableWindow.offset + reusableWindow.rowCount !== path.length))
    ) {
      active.transcript = retainTranscriptState(active.transcript)
      active.transcriptFill = null
      fill = null
      reusableWindow = null
      fillDirection = 'prepend'
    }
    if (
      fill?.kind === 'append' &&
      reusableWindow &&
      reusableWindow.offset + reusableWindow.rowCount === path.length
    ) {
      fill = Object.freeze({
        kind: 'prepend',
        selectionEpoch: fill.selectionEpoch,
        pathIdentity: fill.pathIdentity,
        window: reusableWindow,
      })
      active.transcriptFill = fill
      fillDirection = 'prepend'
    }
    const staleSpan = reusableWindow
      ? transcriptBodyWindowNextStaleSpan(reusableWindow, TRANSCRIPT_BODY_READ_BATCH_ROWS)
      : null
    const refreshesStaleRows = staleSpan !== null
    const demandKey = `${this.workspaceKey()}:${active.chatId}:${active.transcript.selectionEpoch}:${path.leaf?.id ?? ''}:${desiredWindow.offset}:${fillDirection}:${staleSpan?.offset ?? reusableWindow?.offset ?? path.length}`
    if (this.readIsBlocked('transcript', demandKey)) return projectionChanged()
    if (
      !refreshesStaleRows &&
      reusableWindow &&
      frameCoversWindow(reusableWindow, path, desiredWindow)
    ) {
      const retained = retainTranscriptBodyWindowSpan(path, reusableWindow, desiredWindow)
      if (!retained) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptRetentionInvalid'),
        )
        return false
      }
      if (retained !== reusableWindow || (fill && reusableWindow === fill.window)) {
        active.transcript = readyTranscriptState(active.transcript.selectionEpoch, retained)
        active.transcriptFill = null
      }
      this.cancelRead('transcript')
      return projectionChanged()
    }
    if (!source) return projectionChanged()
    const nextOffset =
      fillDirection === 'append' && reusableWindow
        ? reusableWindow.offset + reusableWindow.rowCount
        : (reusableWindow?.offset ?? path.length)
    let readWindow: BranchPathWindow<MessageHeaderRow>
    if (staleSpan) {
      readWindow = path.window(staleSpan)
    } else if (fillDirection === 'append') {
      const readRows = Math.min(TRANSCRIPT_BODY_READ_BATCH_ROWS, path.length - nextOffset)
      if (readRows <= 0) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptAppendWindowInvalid'),
        )
        return false
      }
      readWindow = path.window({ offset: nextOffset, limit: readRows })
      if (readWindow.offset !== nextOffset || readWindow.nodes.length !== readRows) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptAppendBoundaryInvalid'),
        )
        return false
      }
    } else {
      const readRows = Math.min(TRANSCRIPT_BODY_READ_BATCH_ROWS, nextOffset - desiredWindow.offset)
      if (readRows <= 0) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptWindowInvalid'),
        )
        return false
      }
      const nextNewestMessageId = reusableWindow
        ? (transcriptBodyWindowFirstRow(reusableWindow)?.header.parentId ?? null)
        : (path.leaf?.id ?? null)
      if (nextNewestMessageId === null) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptBoundaryMissing'),
        )
        return false
      }
      readWindow = path.backwardWindow({ endingAt: nextNewestMessageId, limit: readRows })
      if (readWindow.offset !== nextOffset - readRows) {
        this.failInvariant(
          'transcript',
          demandKey,
          new Error('ConversationTranscriptBoundaryInvalid'),
        )
        return false
      }
    }
    const versionKey = readWindow.nodes
      .map((header) => `${header.id}:${header.nodeVersion}:${header.bodyVersion}`)
      .join(',')
    const selectionEpoch = active.transcript.selectionEpoch
    const pathIdentity = path.identity
    const key = `${this.workspaceKey()}:${active.chatId}:${selectionEpoch}:${path.leaf?.id ?? ''}:${fillDirection}:${readWindow.offset}:${versionKey}`
    if (this.reads.get('transcript')?.key === key) return projectionChanged()
    const materialCoordinator = this.materialCoordinator
    if (!materialCoordinator) {
      this.failInvariant(
        'transcript',
        demandKey,
        new Error('ConversationTranscriptMaterialCoordinatorMissing'),
      )
      return false
    }
    const read = this.startRead('transcript', key)
    const materialReservation = materialCoordinator.reserve(materialCoordinator, readWindow.nodes)
    const result = source.loadTranscriptPage(
      active.chatId,
      path.leaf?.id as MessageId,
      spine.structuralVersion,
      readWindow,
      materialCoordinator,
      read.controller.signal,
    )
    void result.then(
      () => materialReservation.release(),
      () => materialReservation.release(),
    )
    void result.then(
      (envelope) => {
        if (!this.readIsCurrent('transcript', read)) return
        const current = this.active
        const currentSpine = this.activeSpine()
        const currentPath = currentSpine?.path
        if (
          !this.matchesWorkspace(envelope) ||
          !current ||
          !currentSpine ||
          !currentPath ||
          current.transcript.selectionEpoch !== selectionEpoch ||
          currentPath.identity !== pathIdentity
        ) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptPageMismatch'),
            () => this.requestTranscript(),
          )
          return
        }
        if (!pathStructurallyMatchesWindow(currentPath, readWindow)) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptPathChanged'),
            () => this.reproveAcceptedSpine(),
          )
          return
        }
        if (envelope.value.kind === 'stale-selection') {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptSelectionStale'),
            () => this.reproveAcceptedSpine(),
          )
          return
        }
        const page = envelope.value.page
        const pageStructuralVersion = envelope.value.structuralVersion
        if (!frameStructurallyMatchesWindow(page, currentPath, readWindow)) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptFrameMismatch'),
            () => this.reproveAcceptedSpine(),
          )
          return
        }
        if (
          refreshesStaleRows
            ? page.offset !== readWindow.offset || page.headers.length !== readWindow.nodes.length
            : fillDirection === 'append'
              ? page.offset !== nextOffset
              : page.offset + page.headers.length !== nextOffset
        ) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptPageMismatch'),
            () => this.requestTranscript(),
          )
          return
        }
        const pageRevisions = page.headers.map((header, index) => {
          const message = page.messages[index] as Message
          return Object.freeze({
            header,
            presentation: Object.freeze({
              header,
              message,
              bodyVersion: header.bodyVersion,
            }),
          })
        })
        this.observationRevision += 1
        this.admitMessageRevisions(
          pageRevisions.map((revision) =>
            Object.freeze({ ...revision, structuralVersion: pageStructuralVersion }),
          ),
          { kind: 'body-snapshot' },
        )
        const admittedPath = this.activeSpine()?.path
        if (!admittedPath || !frameMatchesWindow(page, admittedPath, readWindow)) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptPageAdmissionMismatch'),
            () => this.requestTranscript(),
          )
          return
        }
        let currentFill =
          current.transcriptFill?.selectionEpoch === selectionEpoch &&
          current.transcriptFill.pathIdentity === admittedPath.identity &&
          current.transcriptFill.kind !== 'choose'
            ? current.transcriptFill
            : null
        if (refreshesStaleRows && currentFill) {
          currentFill = Object.freeze({
            ...currentFill,
            window: withTranscriptBodyRevisions(currentFill.window, pageRevisions),
          })
          current.transcriptFill = currentFill
        }
        const currentWindow = currentFill?.window ?? readyTranscriptWindow(current.transcript)
        const compatibleWindow =
          currentWindow &&
          transcriptBodyWindowMatchesPath(currentWindow, admittedPath) &&
          (refreshesStaleRows
            ? Boolean(
                reusableWindow &&
                  currentWindow.offset === reusableWindow.offset &&
                  currentWindow.rowCount === reusableWindow.rowCount,
              )
            : fillDirection === 'append'
              ? currentWindow.offset + currentWindow.rowCount === nextOffset
              : currentWindow.offset === nextOffset)
            ? currentWindow
            : null
        if (reusableWindow && !compatibleWindow) {
          this.reconcileReadConflict(
            'transcript',
            read,
            demandKey,
            new Error('ConversationTranscriptSuffixChanged'),
            () => this.requestTranscript(),
          )
          return
        }
        if (refreshesStaleRows) {
          const refreshed = compatibleWindow
          if (
            !refreshed ||
            page.headers.some((header) => {
              const row = transcriptBodyWindowFindRow(refreshed, header.id)
              return !row || !row.bodyExact || row.bodyVersion !== header.bodyVersion
            })
          ) {
            this.reconcileReadConflict(
              'transcript',
              read,
              demandKey,
              new Error('ConversationTranscriptBodyRefreshMismatch'),
              () => this.requestTranscript(),
            )
            return
          }
          this.finishRead('transcript', read)
          this.requestForkUpdates(
            page.headers.map((header) => header.parentId),
            'visibility',
            refreshed,
          )
          this.stageTranscriptDrain()
          this.publish()
          return
        }
        this.finishRead('transcript', read)
        const accepted = compatibleWindow
          ? fillDirection === 'append'
            ? appendTranscriptBodyPage(compatibleWindow, page)
            : prependTranscriptBodyPage(compatibleWindow, page)
          : transcriptBodyWindowFromPage(page, admittedPath)
        current.transcriptFill = Object.freeze({
          kind: fillDirection,
          selectionEpoch: current.transcript.selectionEpoch,
          pathIdentity: admittedPath.identity,
          window: accepted,
        })
        this.requestForkUpdates(
          page.headers.map((header) => header.parentId),
          'visibility',
          accepted,
        )
        if (this.stageTranscriptDrain()) this.publish()
      },
      (error) => {
        if (this.active?.transcript.selectionEpoch === selectionEpoch) {
          this.active.transcriptFill = null
        }
        this.failRead('transcript', read, demandKey, error)
      },
    )
    return projectionChanged()
  }

  private acceptTranscriptPlan(
    active: ActiveProjection,
    base: TranscriptDemandPlan,
    path: BranchPathDescriptor<MessageHeaderRow>,
  ): TranscriptPresentationPlan {
    const current = active.transcriptPlan
    if (
      current?.selectionRevision === base.selectionRevision &&
      current.selectionEpoch === base.selectionEpoch &&
      current.pathIdentity === path.identity
    ) {
      const demandChanged = !sameTranscriptWorkBudget(current.demandBudget, base.budget)
      const contracts =
        base.residency === 'settled' &&
        demandChanged &&
        transcriptWorkBudgetContracts(current.demandBudget, base.budget)
      const budget = contracts
        ? base.budget
        : demandChanged
          ? maxTranscriptWorkBudget(current.budget, base.budget)
          : current.budget
      const residentFloorOffset = contracts ? null : current.residentFloorOffset
      const tail = transcriptTailSpan(path, budget)
      const initialSpan =
        residentFloorOffset !== null
          ? path.window({
              offset: Math.min(tail.offset, residentFloorOffset),
              limit: path.length - Math.min(tail.offset, residentFloorOffset),
            })
          : tail
      const span = this.retainClaimedTranscriptSpan(active, this.activeSession(), path, initialSpan)
      if (
        budget === current.budget &&
        sameTranscriptWorkBudget(base.budget, current.demandBudget) &&
        residentFloorOffset === current.residentFloorOffset &&
        sameBranchPathSpan(span, current.span)
      ) {
        return current
      }
      const accepted = Object.freeze({
        ...current,
        demandBudget: base.budget,
        budget,
        span,
        residentFloorOffset,
      })
      active.transcriptPlan = accepted
      return accepted
    }
    const session = this.activeSession()
    const tail = transcriptTailSpan(path, base.budget)
    const resident = readyTranscriptWindow(active.transcript)
    const initialSpan =
      resident && transcriptBodyWindowMatchesPath(resident, path)
        ? path.window({
            offset: Math.min(tail.offset, resident.offset),
            limit: path.length - Math.min(tail.offset, resident.offset),
          })
        : tail
    const span = this.retainClaimedTranscriptSpan(active, session, path, initialSpan)
    const accepted = Object.freeze({
      selectionRevision: base.selectionRevision,
      selectionEpoch: base.selectionEpoch,
      pathIdentity: path.identity,
      demandBudget: base.budget,
      budget: base.budget,
      span,
      residentFloorOffset:
        resident && transcriptBodyWindowMatchesPath(resident, path) ? resident.offset : null,
      lastExpansionBoundaryOffset: null,
    })
    active.transcriptPlan = accepted
    return accepted
  }

  private retainClaimedTranscriptSpan(
    active: ActiveProjection,
    session: ChatSession | null,
    path: BranchPathDescriptor<MessageHeaderRow>,
    span: BranchPathSpan,
  ): BranchPathSpan {
    if (!session || this.workspaceId === null) return span
    let offset = span.offset
    for (const retention of this.transcriptRetentions.values()) {
      if (
        retention.workspaceId === this.workspaceId &&
        retention.replacementEpoch === this.workspaceEpoch &&
        retention.chatId === active.chatId &&
        retention.selectionRevision === session.selectionRevision &&
        retention.selectionEpoch === active.transcript.selectionEpoch &&
        path.has(retention.messageId)
      ) {
        offset = Math.min(
          offset,
          Math.max(0, path.indexOf(retention.messageId) - retention.precedingRowCount),
        )
      }
    }
    if (offset === span.offset) return span
    const retained = path.window({ offset, limit: path.length - offset })
    return Object.freeze({
      branchLength: retained.branchLength,
      offset: retained.offset,
      limit: retained.limit,
      boundaryParentId: retained.boundaryParentId,
    })
  }

  private currentTranscriptDemand(
    active: ActiveProjection,
    session: ChatSession,
  ): TranscriptDemandPlan | null {
    const explicit = maxTranscriptDemand(
      this.transcriptDemands,
      active.chatId,
      session.selectionRevision,
      active.transcript.selectionEpoch,
    )
    if (!this.presentationOwnsSurfaceWork(active, session, 'transcript')) {
      return explicit ? Object.freeze({ ...explicit, residency: 'monotonic' }) : null
    }
    return {
      chatId: active.chatId,
      selectionRevision: session.selectionRevision,
      selectionEpoch: active.transcript.selectionEpoch,
      residency: explicit ? 'monotonic' : 'settled',
      budget: explicit
        ? maxTranscriptWorkBudget(this.settledTranscriptBudget, explicit.budget)
        : this.settledTranscriptBudget,
    }
  }

  private recycleTranscriptResident(
    active: ActiveProjection,
    path: BranchPathDescriptor<MessageHeaderRow>,
  ): void {
    const current = readyTranscriptWindow(active.transcript)
    if (!current) return
    const resident = active.presentationResidents.transcript
    const span = this.retainClaimedTranscriptSpan(
      active,
      this.activeSession(),
      path,
      transcriptTailSpan(path, this.settledTranscriptBudget),
    )
    const retainedSource =
      resident &&
      resident.seal.chatId === active.chatId &&
      resident.seal.leafId === current.leafId &&
      resident.selectionEpoch === active.transcript.selectionEpoch
        ? reidentifyTranscriptBodyWindow(resident.window, path)
        : current
    const retained =
      retainTranscriptBodyWindowSpan(path, retainedSource, span) ??
      retainTranscriptBodyWindowSpan(path, current, span)
    if (!retained || retained === current) return
    active.transcript = readyTranscriptState(active.transcript.selectionEpoch, retained)
    if (
      resident &&
      resident.seal.chatId === active.chatId &&
      resident.seal.leafId === retained.leafId &&
      resident.selectionEpoch === active.transcript.selectionEpoch
    ) {
      active.presentationResidents.transcript = Object.freeze({
        ...resident,
        currency: 'retained',
        reveal: null,
        window: retained,
      })
    }
  }

  private requestInspector(): void {
    const active = this.active
    const demand = active ? latestInspectorDemand(this.inspectorDemands, active.chatId) : null
    if (!active || !demand) {
      this.cancelRead('inspector')
      if (
        active &&
        (active.inspector.exact || active.inspector.retained || active.inspector.resolvingKey)
      ) {
        active.inspector.exact = null
        active.inspector.retained = null
        active.inspector.resolvingKey = null
        this.compactExactHeaders()
        this.publish()
      }
      return
    }
    const source = this.source
    const header = this.authoritativeHeader(demand.messageId)
    if (!source || !header) {
      this.cancelRead('inspector')
      return
    }
    if (
      active.inspector.exact?.message.id === demand.messageId &&
      active.inspector.exact.bodyVersion === header.bodyVersion
    ) {
      return
    }
    const key = `${this.workspaceKey()}:${active.chatId}:${demand.messageId}:${header.bodyVersion}`
    if (this.reads.get('inspector')?.key === key) return
    if (this.readIsBlocked('inspector', key)) return
    if (active.inspector.exact) active.inspector.retained = active.inspector.exact
    active.inspector.exact = null
    active.inspector.resolvingKey = key
    const read = this.startRead('inspector', key)
    this.publish()
    void source.loadInspector(active.chatId, demand.messageId, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('inspector', read)) return
        const current = this.active
        const currentHeader = this.authoritativeHeader(demand.messageId)
        if (
          !this.matchesWorkspace(envelope) ||
          !current ||
          !currentHeader ||
          !envelope.value ||
          envelope.value.bodyVersion !== currentHeader.bodyVersion ||
          !sameMessageHeaderValue(envelope.value.header, currentHeader)
        ) {
          this.reconcileReadConflict(
            'inspector',
            read,
            key,
            new Error('ConversationInspectorResultMismatch'),
            () => this.requestInspector(),
          )
          return
        }
        const presentation = envelope.value
        const structuralVersion = Math.max(
          current.chat?.structuralVersion ?? 0,
          this.presentedSpine()?.structuralVersion ?? 0,
          current.topology.kind === 'exact' ? current.topology.structuralVersion : 0,
        )
        this.observationRevision += 1
        this.admitMessageRevisions(
          [Object.freeze({ header: currentHeader, structuralVersion, presentation })],
          { kind: 'body-snapshot' },
        )
        this.finishRead('inspector', read)
        this.publish()
      },
      (error) => {
        this.failRead('inspector', read, key, error)
      },
    )
  }

  private requestPreviews(): void {
    const source = this.source
    const active = this.active
    const demand = active ? combinedPreviewDemand(this.previewDemands, active.chatId) : null
    if (!source || !active || !demand || demand.targets.length === 0) {
      this.cancelRead('previews')
      return
    }
    const targets: TreePreviewTarget[] = []
    for (const target of demand.targets) {
      const header = this.authoritativeHeader(target.messageId)
      if (!header || header.deleted || header.bodyVersion !== target.bodyVersion) {
        this.cancelRead('previews')
        return
      }
      targets.push(target)
    }
    const missing = targets.filter(
      (target) => active.previews.get(target.messageId)?.bodyVersion !== target.bodyVersion,
    )
    if (missing.length === 0) {
      this.cancelRead('previews')
      return
    }
    const targetKey = missing.map(treePreviewTargetKey).join(',')
    const key = `${this.workspaceKey()}:${active.chatId}:${targetKey}`
    if (this.reads.get('previews')?.key === key) return
    if (this.readIsBlocked('previews', key)) return
    const read = this.startRead('previews', key)
    void source.loadPreviews(active.chatId, missing, read.controller.signal).then(
      (envelope) => {
        if (!this.readIsCurrent('previews', read)) return
        const current = this.active
        if (!this.matchesWorkspace(envelope) || !current || current.chatId !== active.chatId) {
          this.reconcileReadConflict(
            'previews',
            read,
            key,
            new Error('ConversationPreviewResultMismatch'),
            () => this.requestPreviews(),
          )
          return
        }
        this.finishRead('previews', read)
        for (const preview of envelope.value) {
          const header = this.authoritativeHeader(preview.messageId)
          if (header && !header.deleted && header.bodyVersion === preview.bodyVersion) {
            current.previews.set(preview.messageId, preview)
          }
        }
        trimPreviewCache(current.previews, targets)
        current.previewSnapshot = new Map(current.previews)
        this.publish()
      },
      (error) => {
        this.failRead('previews', read, key, error)
      },
    )
  }

  private refreshBodyDemands(): void {
    this.requestTranscript()
    this.requestInspector()
    this.requestPreviews()
  }

  private presentationOwnsSurfaceWork(
    active: ActiveProjection,
    session: ChatSession,
    surface: ConversationSurface,
  ): boolean {
    return (
      session.presentationRequest.surface === surface ||
      (this.paintedFrame?.chat.id === active.chatId &&
        this.paintedFrame.binding.surface === surface)
    )
  }

  private activeNeedsTopology(active: ActiveProjection): boolean {
    const session = this.activeSession()
    return Boolean(session && this.presentationOwnsSurfaceWork(active, session, 'tree'))
  }

  private refreshPresentationDemands(): void {
    const active = this.active
    if (active && this.activeNeedsTopology(active)) this.requestTopology()
    else this.releaseTopology()
    this.refreshBodyDemands()
  }

  private authoritativeHeader(messageId: MessageId): MessageHeaderRow | undefined {
    const active = this.active
    return active?.headers.get(messageId) ?? this.presentedSpine()?.path.get(messageId)
  }

  private publishedHeaderFacts(active: ActiveProjection): ConversationMessageHeaderLookup {
    const path = presentedConversationDestinationSpine(active.destination)?.path ?? null
    if (active.headerFactsHeaders === active.headers && active.headerFactsPath === path) {
      return active.headerFacts
    }
    const headers = active.headers
    active.headerFacts = Object.freeze({
      get: (messageId: MessageId) => headers.get(messageId) ?? path?.get(messageId),
      has: (messageId: MessageId) => headers.has(messageId) || Boolean(path?.has(messageId)),
    })
    active.headerFactsHeaders = headers
    active.headerFactsPath = path
    return active.headerFacts
  }

  private publishedTreeHeaderFacts(active: ActiveProjection): {
    readonly headers: ConversationMessageHeaderLookup
    readonly changedHeaderKeys: readonly string[]
  } {
    if (active.topology.kind !== 'exact') {
      return Object.freeze({
        headers: active.treeHeaderFacts,
        changedHeaderKeys: Object.freeze([]),
      })
    }
    const topology = active.topology.projection
    const source = active.topology.headers
    if (active.treeHeaderFactsSource !== source || active.treeHeaderFactsTopology !== topology) {
      active.treeHeaderFacts = Object.freeze({
        get: (messageId: MessageId) =>
          topology.byId.has(messageId) ? source.get(messageId) : undefined,
        has: (messageId: MessageId) => topology.byId.has(messageId) && source.has(messageId),
      })
      active.treeHeaderFactsSource = source
      active.treeHeaderFactsTopology = topology
    }
    if (
      active.treeChangedHeaderKeysSource !== active.changedHeaderKeys ||
      active.treeChangedHeaderKeysTopology !== topology
    ) {
      active.treeChangedHeaderKeys = Object.freeze(
        active.changedHeaderKeys.filter((messageId) => topology.byId.has(messageId)),
      )
      active.treeChangedHeaderKeysSource = active.changedHeaderKeys
      active.treeChangedHeaderKeysTopology = topology
    }
    return Object.freeze({
      headers: active.treeHeaderFacts,
      changedHeaderKeys: active.treeChangedHeaderKeys,
    })
  }

  private activeSession(): ChatSession | null {
    const active = this.active
    return active ? (this.sessions.get(active.chatId) ?? null) : null
  }

  private activeSpine(): VersionedActiveBranchSpine<MessageHeaderRow> | null {
    const destination = this.active?.destination
    return destination?.kind === 'ready' ? destination.spine : null
  }

  private presentedSpine(): VersionedActiveBranchSpine<MessageHeaderRow> | null {
    const destination = this.active?.destination
    return destination ? (retainedReadyDestination(destination)?.spine ?? null) : null
  }

  private matchesWorkspace(fence: WorkspaceFence): boolean {
    return (
      this.workspaceId !== null &&
      fence.workspaceId === this.workspaceId &&
      fence.replacementEpoch === this.workspaceEpoch
    )
  }

  private workspaceKey(): string {
    if (this.workspaceId === null) throw new Error('ConversationWorkspaceNotReconciled')
    return `${this.workspaceId}:${this.workspaceEpoch}`
  }

  private startRead(kind: ReadKind, key: string): PendingRead {
    const previous = this.reads.get(kind)
    if (previous) this.releaseReadOwner(previous)
    this.blockedReads.delete(kind)
    if (this.active?.failure?.kind === kind) this.active.failure = null
    const read = {
      key,
      observationRevision: this.observationRevision,
      controller: new AbortController(),
    }
    this.reads.set(kind, read)
    return read
  }

  private readIsBlocked(kind: ReadKind, key: string): boolean {
    const blocked = this.blockedReads.get(kind)
    return blocked?.key === key && blocked.observationRevision === this.observationRevision
  }

  private readIsCurrent(kind: ReadKind, read: PendingRead): boolean {
    return this.reads.get(kind) === read && !read.controller.signal.aborted
  }

  private finishRead(kind: ReadKind, read: PendingRead): void {
    if (this.reads.get(kind) !== read) return
    this.reads.delete(kind)
    this.releaseReadOwner(read)
  }

  private failRead(kind: ReadKind, read: PendingRead, key: string, error: unknown): void {
    if (!this.readIsCurrent(kind, read)) return
    this.finishRead(kind, read)
    this.blockRead(kind, key, 'read-failed', error)
  }

  private reconcileReadConflict(
    kind: ReadKind,
    read: PendingRead,
    key: string,
    error: Error,
    reread: () => void,
  ): void {
    if (!this.readIsCurrent(kind, read)) return
    this.finishRead(kind, read)
    if (read.observationRevision < this.observationRevision) {
      reread()
      return
    }
    this.blockRead(kind, key, 'source-invariant', error)
  }

  private failInvariant(kind: ReadKind, key: string, error: Error): void {
    this.cancelRead(kind)
    this.blockRead(kind, key, 'source-invariant', error)
  }

  private blockRead(
    kind: ReadKind,
    key: string,
    code: ConversationProjectionFailure['code'],
    error: unknown,
  ): void {
    this.blockedReads.set(kind, { key, observationRevision: this.observationRevision })
    const active = this.active
    if (!active) return
    this.stopResolving(kind)
    const failure = Object.freeze({
      kind,
      code,
      key,
      observationRevision: this.observationRevision,
      message: projectionFailureMessage(error),
    })
    active.failure = failure
    if (kind === 'selection' || kind === 'sibling-navigation') {
      this.settleSelectionDestination(
        Object.freeze({
          kind: 'failed',
          failure,
          retained: retainedReadyDestination(active.destination),
        }),
      )
    }
    this.publish()
  }

  private stopResolving(kind: ReadKind): void {
    const active = this.active
    if (!active) return
    if (kind === 'inspector') active.inspector.resolvingKey = null
  }

  private cancelRead(kind: ReadKind): void {
    const read = this.reads.get(kind)
    if (!read) return
    this.reads.delete(kind)
    this.releaseReadOwner(read)
  }

  private releaseReadOwner(read: PendingRead): void {
    read.controller.abort()
  }

  private cancelSelectionAttempt(): void {
    this.cancelRead('selection')
    if (this.active) this.active.selectionAttempt = null
  }

  private settleSelectionDestination(destination: ConversationDestinationProjection): void {
    const active = this.active
    if (!active) return
    this.cancelSelectionAttempt()
    active.destination = destination
    this.compactExactHeaders()
  }

  private cancelForkWork(): void {
    this.cancelRead('forks')
    this.pendingForkParentIds.clear()
    this.pendingForkChatId = null
    this.pendingForkSelectionRevision = null
  }

  private cancelAllReads(): void {
    const reads = [...this.reads.values()]
    this.reads.clear()
    for (const read of reads) this.releaseReadOwner(read)
    this.blockedReads.clear()
    if (this.active) this.active.failure = null
    this.pendingForkParentIds.clear()
    this.pendingForkChatId = null
    this.pendingForkSelectionRevision = null
    if (this.active) this.active.selectionAttempt = null
  }

  private compactExactHeaders(): void {
    const active = this.active
    if (!active) return
    if (active.topology.kind === 'exact' || this.activeRetainsObservedFacts(active)) return
    const previous = active.headers
    const path = this.presentedSpine()?.path
    let compact = previous
    const inspectorHeader = active.inspector.exact?.header ?? active.inspector.retained?.header
    const changedIds: MessageId[] = []
    for (const messageId of active.compactableHeaderIds) {
      if (path?.has(messageId) || inspectorHeader?.id === messageId) continue
      if (compact.has(messageId)) {
        compact = compact.delete(messageId)
        changedIds.push(messageId)
      }
      active.compactableHeaderIds.delete(messageId)
    }
    active.headers = compact
    if (compact !== previous) this.recordHeaderChanges(changedIds)
  }

  private activeRetainsObservedFacts(active: ActiveProjection): boolean {
    return (
      destinationRetainsObservedFacts(active.destination) ||
      (this.operationClaimCountsByChat.get(active.chatId) ?? 0) > 0 ||
      this.reads.has('topology')
    )
  }

  private persistSession(chatId: ChatId): void {
    if (this.workspaceId === null) return
    const session = this.sessions.get(chatId)
    if (!session) return
    writePersistedSession(
      chatId,
      { workspaceId: this.workspaceId, replacementEpoch: this.workspaceEpoch },
      {
        selection: session.intent.selection,
        presentation: session.presentationRequest.surface,
        ...(session.pendingRevealTargetId
          ? { pendingRevealTargetId: session.pendingRevealTargetId }
          : {}),
      },
    )
    if (this.activeChatId === chatId || this.operationClaimCountsByChat.has(chatId)) {
      return
    }
    this.sessions.delete(chatId)
  }

  private presentationTarget(
    active: ActiveProjection,
    session: ChatSession,
    transcript: ConversationTranscriptProjection,
  ): ConversationPresentationTarget {
    const surface = session.presentationRequest.surface
    const resource = this.presentationResourcePort?.get(surface) ?? ({ kind: 'idle' } as const)
    if (resource.kind === 'failed') {
      return Object.freeze({
        kind: 'failed',
        surface,
        blocker: 'module',
        message: resource.message,
      })
    }
    if (resource.kind !== 'ready') {
      return Object.freeze({ kind: 'pending', surface, blocker: 'module' })
    }
    if (active.destination.kind !== 'ready') {
      const failure = active.failure
      if (
        failure?.kind === 'chat' ||
        failure?.kind === 'selection' ||
        failure?.kind === 'sibling-navigation'
      ) {
        return Object.freeze({
          kind: 'failed',
          surface,
          blocker: 'destination',
          message: failure.message,
        })
      }
      return Object.freeze({ kind: 'pending', surface, blocker: 'destination' })
    }
    const spine = active.destination.spine
    const seal = this.currentPresentationSeal(active, session, spine)
    if (surface === 'transcript') {
      if (transcript.kind !== 'ready') {
        const failure = active.failure
        if (failure?.kind === 'transcript') {
          return Object.freeze({
            kind: 'failed',
            surface,
            blocker: 'transcript',
            message: failure.message,
          })
        }
        return Object.freeze({ kind: 'pending', surface, blocker: 'transcript' })
      }
      const presentation = this.prepareTranscriptPresentation(
        active,
        seal,
        transcript.window,
        this.promisedTranscriptSpan(active, session, spine.path),
      )
      const binding: ConversationCurrentSurfaceBinding = Object.freeze({
        surface,
        seal,
        spine,
        window: transcript.window,
        selectionEpoch: transcript.selectionEpoch,
        viewportRevision: presentation.viewportRevision,
        intentPresentations: this.presentedGenerationIntents(active.chatId, spine.resolvedLeafId),
        currency: 'current',
        reveal: presentation.reveal,
      })
      return Object.freeze({ kind: 'ready', binding })
    }
    if (
      active.topology.kind !== 'exact' ||
      active.topology.structuralVersion !== spine.structuralVersion ||
      active.topology.provedPathIdentity !== spine.path.identity
    ) {
      const failure = active.failure
      if (failure?.kind === 'topology') {
        return Object.freeze({
          kind: 'failed',
          surface,
          blocker: 'topology',
          message: failure.message,
        })
      }
      return Object.freeze({ kind: 'pending', surface, blocker: 'topology' })
    }
    const treeFacts = this.publishedTreeHeaderFacts(active)
    const residentInspector = this.retainedTreeInspector(active, seal)
    const binding: ConversationCurrentSurfaceBinding = Object.freeze({
      surface,
      seal,
      spine,
      headers: treeFacts.headers,
      topology: active.topology.projection,
      headerChangeRevision: active.headerChangeRevision,
      changedHeaderKeys: treeFacts.changedHeaderKeys,
      inspector: Object.freeze({
        exact: active.inspector.exact,
        retained: active.inspector.retained ?? residentInspector,
        resolving: active.inspector.resolvingKey !== null,
      }),
      previews: active.previewSnapshot,
      currency: 'current',
      reveal: eligiblePresentationReveal(
        active.reveal,
        seal,
        (messageId) =>
          active.topology.kind === 'exact' && active.topology.projection.byId.has(messageId),
      ),
    })
    return Object.freeze({ kind: 'ready', binding })
  }

  private presentedGenerationIntents(
    chatId: ChatId,
    leafId: MessageId | null,
  ): readonly ConversationMessagePresentation[] {
    let matched: readonly ConversationMessagePresentation[] | null = null
    for (const pending of this.generationIntentPresentations.values()) {
      if (
        pending.claim.chatId === chatId &&
        pending.baseLeafId === leafId &&
        this.operationClaimIsCurrent(pending.claim)
      ) {
        matched =
          matched === null
            ? pending.presentations
            : Object.freeze([...matched, ...pending.presentations])
      }
    }
    return matched ?? EMPTY_CONVERSATION_MESSAGE_PRESENTATIONS
  }

  private retainedTreeInspector(
    active: ActiveProjection,
    seal: ConversationPresentationSeal,
  ): ConversationMessagePresentation | null {
    const resident = active.presentationResidents.tree
    if (
      !resident ||
      resident.seal.workspaceId !== seal.workspaceId ||
      resident.seal.replacementEpoch !== seal.replacementEpoch ||
      resident.seal.chatId !== seal.chatId
    ) {
      return null
    }
    const candidate = resident.inspector.exact ?? resident.inspector.retained
    if (!candidate) return null
    const header = this.authoritativeHeader(candidate.message.id)
    return header && !header.deleted && header.bodyVersion === candidate.bodyVersion
      ? candidate
      : null
  }

  private currentPresentationSeal(
    active: ActiveProjection,
    session: ChatSession,
    spine: VersionedActiveBranchSpine<MessageHeaderRow>,
  ): ConversationPresentationSeal {
    const current = active.presentationSeal
    if (
      current?.workspaceId === this.workspaceId &&
      current.replacementEpoch === this.workspaceEpoch &&
      current.chatId === active.chatId &&
      current.selectionRevision === session.selectionRevision &&
      current.structuralVersion === spine.structuralVersion &&
      current.leafId === spine.resolvedLeafId
    ) {
      return current
    }
    const next = Object.freeze({
      workspaceId: this.workspaceId as string,
      replacementEpoch: this.workspaceEpoch,
      chatId: active.chatId,
      selectionRevision: session.selectionRevision,
      structuralVersion: spine.structuralVersion,
      leafId: spine.resolvedLeafId,
    })
    active.presentationSeal = next
    return next
  }

  private prepareTranscriptPresentation(
    active: ActiveProjection,
    seal: ConversationPresentationSeal,
    window: ConversationTranscriptFrame,
    promisedSpan: BranchPathSpan | null,
  ): {
    readonly viewportRevision: number
    readonly reveal: ConversationRevealEffect | null
  } {
    const previous = active.presentationResidents.transcript
    const viewport = this.viewportPort?.chatId === active.chatId ? this.viewportPort : null
    const pendingReveal = eligiblePresentationReveal(
      active.reveal,
      seal,
      (messageId) => transcriptBodyWindowFindRow(window, messageId) !== undefined,
    )
    let viewportRevision = previous?.viewportRevision ?? this.viewportTransitionRevision
    let prepared = false
    let transitionKind: ConversationViewportTransition['kind'] | null = null
    const retainingReplacementWindow =
      previous !== null &&
      replacementTranscriptOwesPaintedWindow(previous, seal, window, promisedSpan)
    if (
      viewport &&
      previous &&
      previous.window !== window &&
      previous.seal.workspaceId === seal.workspaceId &&
      previous.seal.chatId === seal.chatId &&
      !retainingReplacementWindow
    ) {
      const sameBranch =
        previous.window.leafId === window.leafId &&
        previous.window.branchLength === window.branchLength
      if (sameBranch) {
        const previousEnd = previous.window.offset + previous.window.rowCount
        const nextEnd = window.offset + window.rowCount
        transitionKind =
          window.offset < previous.window.offset && nextEnd >= previousEnd ? 'prepend' : 'content'
      } else {
        transitionKind = 'content'
      }
    }
    if (
      pendingReveal &&
      previous?.currency === 'current' &&
      previous.window === window &&
      previous.reveal?.id === pendingReveal.id
    ) {
      return Object.freeze({ viewportRevision: previous.viewportRevision, reveal: pendingReveal })
    }
    if (pendingReveal) transitionKind = 'reveal'
    if (viewport && transitionKind) {
      const revision = this.viewportTransitionRevision + 1
      const preparation = viewport.prepare({
        workspaceEpoch: this.workspaceEpoch,
        chatId: active.chatId,
        revision,
        fromSelectionKey: previous?.window.leafId ?? window.leafId,
        toSelectionKey: window.leafId,
        kind: transitionKind,
        ...(pendingReveal ? { revealTargetMessageId: pendingReveal.targetMessageId } : {}),
      })
      if (preparation.kind === 'prepared') {
        this.viewportTransitionRevision = revision
        viewportRevision = revision
        prepared = true
      }
    }
    if (!pendingReveal) return Object.freeze({ viewportRevision, reveal: null })
    return Object.freeze({ viewportRevision, reveal: prepared ? pendingReveal : null })
  }

  private proveTopologyPath(
    active: ActiveProjection,
    spine: VersionedActiveBranchSpine<MessageHeaderRow>,
  ): void {
    if (active.topology.kind !== 'exact') return
    const provedPathIdentity =
      active.topology.structuralVersion === spine.structuralVersion &&
      treeProjectionContainsSpine(active.topology.projection, spine.path)
        ? spine.path.identity
        : null
    if (provedPathIdentity === active.topology.provedPathIdentity) return
    active.topology = reproveExactTopologyState(active.topology, provedPathIdentity)
  }

  private presentationFrame(
    active: ActiveProjection,
    session: ChatSession,
    transcript: ConversationTranscriptProjection,
  ): ConversationPresentationFrame {
    const retainedPaintedBinding =
      this.paintedFrame?.chat.id === active.chatId ? this.paintedFrame.binding : null
    if (retainedPaintedBinding?.currency === 'retained') {
      if (retainedPaintedBinding.surface === 'transcript') {
        active.presentationResidents.transcript ??= retainedPaintedBinding
      } else {
        active.presentationResidents.tree ??= retainedPaintedBinding
      }
    }
    let target = this.presentationTarget(active, session, transcript)
    if (target.kind === 'ready') {
      const previousFrame = this.paintedFrame
      if (
        previousFrame?.chat.id === active.chatId &&
        previousFrame.binding.surface === 'transcript' &&
        target.binding.surface === 'transcript' &&
        transcript.kind === 'ready' &&
        replacementTranscriptOwesPaintedWindow(
          previousFrame.binding,
          target.binding.seal,
          target.binding.window,
          this.promisedTranscriptSpan(active, session, target.binding.spine.path),
        )
      ) {
        const retained = retainConversationBinding(previousFrame.binding)
        this.paintedFrame = Object.freeze({
          chat: previousFrame.chat,
          binding: retained,
        })
        active.presentationResidents.transcript = retained
        target = Object.freeze({
          kind: 'pending',
          surface: 'transcript',
          blocker: 'transcript',
        })
      }
    }
    if (target.kind === 'ready') {
      const previousFrame = this.paintedFrame
      const previous = previousFrame?.chat.id === active.chatId ? previousFrame.binding : null
      if (previous && previous.surface !== target.binding.surface) {
        const retained = retainConversationBinding(previous)
        if (retained.surface === 'transcript') {
          active.presentationResidents.transcript = retained
        } else {
          active.presentationResidents.tree = retained
        }
      }
      const binding = sameCurrentConversationBinding(previous, target.binding)
        ? (previous as ConversationCurrentSurfaceBinding)
        : target.binding
      this.paintedFrame = Object.freeze({ chat: active.chat as Chat, binding })
      if (binding.surface === 'transcript') {
        active.presentationResidents.transcript = binding
      } else {
        active.presentationResidents.tree = binding
      }
      target = Object.freeze({ kind: 'ready', binding })
    } else {
      const previousFrame = this.paintedFrame
      const previous = previousFrame?.binding
      const previousBelongsToActive = previousFrame?.chat.id === active.chatId
      if (target.kind === 'failed' && !previousBelongsToActive) {
        this.paintedFrame = null
      } else if (
        previousFrame !== null &&
        previous?.currency === 'current' &&
        (!previousBelongsToActive ||
          previous.surface === session.presentationRequest.surface ||
          !currentConversationBindingMatchesProjection(
            previous,
            this.workspaceId,
            this.workspaceEpoch,
            active,
            session,
          ))
      ) {
        const retained = retainConversationBinding(previous)
        this.paintedFrame = Object.freeze({
          chat: previousFrame.chat,
          binding: retained,
        })
        if (previousBelongsToActive) {
          if (retained.surface === 'transcript') {
            active.presentationResidents.transcript = retained
          } else {
            active.presentationResidents.tree = retained
          }
        }
      }
    }
    const request = Object.freeze({ ...session.presentationRequest })
    const paintedBinding = this.paintedFrame?.binding ?? null
    const transcriptResident =
      active.presentationResidents.transcript ??
      (paintedBinding?.surface === 'transcript' ? paintedBinding : null)
    const treeResident =
      active.presentationResidents.tree ??
      (paintedBinding?.surface === 'tree' ? paintedBinding : null)
    const mounted = Object.freeze({
      transcript:
        transcriptResident !== null ||
        request.surface === 'transcript' ||
        paintedBinding?.surface === 'transcript',
      tree:
        treeResident !== null || request.surface === 'tree' || paintedBinding?.surface === 'tree',
    })
    const residents: ConversationResidentSurfaces = Object.freeze({
      transcript: transcriptResident,
      tree: treeResident,
    })
    const visibleReady =
      this.paintedFrame?.chat.id === active.chatId &&
      paintedBinding?.currency === 'current' &&
      paintedBinding.reveal === null
    return Object.freeze({
      request,
      visibleReady,
      painted: this.paintedFrame,
      residents,
      target,
      mounted,
    })
  }

  private promisedTranscriptSpan(
    active: ActiveProjection,
    session: ChatSession,
    path: BranchPathDescriptor<MessageHeaderRow>,
  ): BranchPathSpan | null {
    const plan = active.transcriptPlan
    if (
      plan?.selectionRevision === session.selectionRevision &&
      plan.selectionEpoch === active.transcript.selectionEpoch &&
      plan.pathIdentity === path.identity
    ) {
      return plan.span
    }
    const demand = this.currentTranscriptDemand(active, session)
    if (!demand) return null
    return this.retainClaimedTranscriptSpan(
      active,
      session,
      path,
      transcriptTailSpan(path, demand.budget),
    )
  }

  private publish(): void {
    const active = this.active
    const session = this.activeSession()
    const readySpine = this.activeSpine()
    const presentedSpine = this.presentedSpine()
    const path = presentedSpine?.path ?? emptyBranchPath()
    const destinationCurrent = readySpine !== null
    const transcriptResolving =
      active?.destination.kind === 'unresolved' ||
      active?.destination.kind === 'resolving' ||
      this.reads.has('transcript')
    let transcript: ConversationTranscriptProjection
    if (!active) {
      transcript = Object.freeze({ kind: 'absent', selectionEpoch: 0, resolving: false })
    } else if (active.transcript.kind === 'absent') {
      transcript = Object.freeze({
        kind: 'absent',
        selectionEpoch: active.transcript.selectionEpoch,
        resolving: transcriptResolving,
      })
    } else if (active.transcript.kind === 'point') {
      transcript =
        (active.destination.kind === 'resolving' || active.destination.kind === 'failed') &&
        pointTranscriptMatchesAttempt(active.transcript, active.selectionAttempt)
          ? Object.freeze({
              kind: 'point',
              selectionEpoch: active.transcript.selectionEpoch,
              window: active.transcript.window,
              resolving: transcriptResolving,
            })
          : Object.freeze({
              kind: 'absent',
              selectionEpoch: active.transcript.selectionEpoch,
              resolving: transcriptResolving,
            })
    } else if (
      active.transcript.kind === 'ready' &&
      destinationCurrent &&
      transcriptBodyWindowMatchesPath(active.transcript.window, path)
    ) {
      transcript = Object.freeze({
        kind: 'ready',
        selectionEpoch: active.transcript.selectionEpoch,
        window: active.transcript.window,
        filling: this.reads.has('transcript'),
      })
    } else if (
      presentedSpine &&
      transcriptBodyWindowMatchesPath(active.transcript.window, presentedSpine.path)
    ) {
      transcript = Object.freeze({
        kind: 'retained',
        selectionEpoch: active.transcript.selectionEpoch,
        window: active.transcript.window,
        resolving: transcriptResolving,
      })
    } else {
      transcript = Object.freeze({
        kind: 'absent',
        selectionEpoch: active.transcript.selectionEpoch,
        resolving: transcriptResolving,
      })
    }
    const presentation =
      active && session ? this.presentationFrame(active, session, transcript) : null
    const activeSnapshot: ConversationChatSnapshot | null =
      active && session && presentation
        ? Object.freeze({
            chatId: active.chatId,
            chat: active.chat,
            selectionRevision: session.selectionRevision,
            transcriptSelectionEpoch: transcript.selectionEpoch,
            viewportRevision:
              presentation.residents.transcript?.viewportRevision ??
              this.viewportTransitionRevision,
            selectionTargetId: selectionTargetMessageId(session.intent.selection),
            destination: active.destination,
            headerFacts: this.publishedHeaderFacts(active),
            structuralTopology:
              active.topology.kind === 'exact'
                ? active.topology.projection
                : EMPTY_STRUCTURAL_TOPOLOGY,
            headerChangeRevision: active.headerChangeRevision,
            changedHeaderKeys: active.changedHeaderKeys,
            topologyLoaded: active.topology.kind === 'exact',
            transcript,
            inspector: Object.freeze({
              exact: active.inspector.exact,
              retained: active.inspector.retained,
              resolving: active.inspector.resolvingKey !== null,
            }),
            previews: active.previewSnapshot,
            failure: active.failure,
            presentation,
          })
        : null
    this.snapshot = Object.freeze({
      workspaceId: this.workspaceId,
      workspaceEpoch: this.workspaceEpoch,
      activeChatId: this.activeChatId,
      active: activeSnapshot,
    })
    const targetPresentationReceipts = activeSnapshot
      ? this.exactTargetPresentationReceipts(activeSnapshot)
      : EMPTY_EXACT_TARGET_PRESENTATION_RECEIPTS
    this.projectActiveRoute()
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        queueMicrotask(() => console.error('Conversation projection observer failed', error))
      }
    }
    if (targetPresentationReceipts.length > 0) {
      this.targetPresentationPort?.publishExactTargetPresentations(targetPresentationReceipts)
    }
  }

  private exactTargetPresentationReceipts(
    snapshot: ConversationChatSnapshot,
  ): readonly ExactTargetPresentationReceipt[] {
    const port = this.targetPresentationPort
    if (!port || this.workspaceId === null) return EMPTY_EXACT_TARGET_PRESENTATION_RECEIPTS
    return Object.freeze(
      port.targetPresentationInterests(snapshot.chatId).flatMap((interest) => {
        if (
          interest.workspaceId !== this.workspaceId ||
          interest.replacementEpoch !== this.workspaceEpoch
        ) {
          return []
        }
        const bodyVersion = exactPublishedTargetBodyVersion(snapshot, interest.messageId)
        if (bodyVersion === undefined) return []
        return [
          Object.freeze({
            streamId: interest.streamId,
            chatId: interest.chatId,
            messageId: interest.messageId,
            workspaceId: interest.workspaceId,
            replacementEpoch: interest.replacementEpoch,
            bodyVersion,
          }),
        ]
      }),
    )
  }

  private projectActiveRoute(): void {
    const port = this.navigationPort
    const active = this.active
    const session = this.activeSession()
    const path = this.activeSpine()?.path
    if (!port || !active || !session || !path) return
    const arrival = port.getArrival()
    if (arrival.route?.chatId !== active.chatId) return
    const leafId = path.leaf?.id
    const key = `${active.chatId}:${leafId ?? ''}`
    if (this.lastProjectedRouteKey === key) return
    this.lastProjectedRouteKey = key
    port.replaceConversationUrl(active.chatId, leafId ?? undefined)
  }
}

function exactTopologyState(
  structuralVersion: number,
  index: MessageTopologyIndex<StructuralMessageHeader>,
  headerById: ReadonlyMap<MessageId, MessageHeaderRow>,
  provedPathIdentity: object | null,
): ActiveTopologyState {
  if (!Number.isSafeInteger(structuralVersion) || structuralVersion < 0) {
    throw new Error('ConversationTopologyStructuralVersionInvalid')
  }
  for (const node of index.nodes) {
    if (!headerById.has(node.id)) {
      throw new Error(`ConversationTopologyHeaderMissing:${node.id}`)
    }
  }
  return Object.freeze({
    kind: 'exact',
    structuralVersion,
    index,
    projection: structuralTopologyView(index),
    headerById,
    headers: messageHeaderLookup(headerById),
    provedPathIdentity,
  })
}

function withExactTopologyHeaders(
  topology: Extract<ActiveTopologyState, { readonly kind: 'exact' }>,
  headerById: ReadonlyMap<MessageId, MessageHeaderRow>,
): ActiveTopologyState {
  for (const node of topology.index.nodes) {
    if (!headerById.has(node.id)) {
      throw new Error(`ConversationTopologyHeaderMissing:${node.id}`)
    }
  }
  return Object.freeze({
    ...topology,
    headerById,
    headers: messageHeaderLookup(headerById),
  })
}

function messageHeaderLookup(
  headerById: ReadonlyMap<MessageId, MessageHeaderRow>,
): ConversationMessageHeaderLookup {
  return Object.freeze({
    get: (messageId: MessageId) => headerById.get(messageId),
    has: (messageId: MessageId) => headerById.has(messageId),
  })
}

function reproveExactTopologyState(
  topology: Extract<ActiveTopologyState, { readonly kind: 'exact' }>,
  provedPathIdentity: object | null,
): ActiveTopologyState {
  return Object.freeze({ ...topology, provedPathIdentity })
}

function validateStructuralTransition(
  transition: ConversationStructuralTransition,
  revisionsById: ReadonlyMap<MessageId, ConversationMessageRevisionObservation>,
): void {
  if (transition.kind === 'none') return
  if (
    transition.toVersion !== null &&
    (!Number.isSafeInteger(transition.toVersion) || transition.toVersion < 0)
  ) {
    throw new Error('ConversationStructuralTransitionVersionInvalid')
  }
  if (transition.kind === 'incomplete') {
    if (transition.scope !== true && transition.scope.length === 0) {
      throw new Error('ConversationStructuralTransitionScopeEmpty')
    }
    return
  }
  if (transition.messageIds.length === 0 || transition.structuralVersions.length === 0) {
    throw new Error('ConversationStructuralTransitionExactEmpty')
  }
  const messageIds = new Set(transition.messageIds)
  if (messageIds.size !== transition.messageIds.length) {
    throw new Error('ConversationStructuralTransitionMessageDuplicate')
  }
  for (const messageId of transition.messageIds) {
    const revision = revisionsById.get(messageId)
    if (!revision) throw new Error(`ConversationStructuralTransitionRowMissing:${messageId}`)
    if (revision.structuralVersion > transition.toVersion) {
      throw new Error(`ConversationStructuralTransitionRowVersionInvalid:${messageId}`)
    }
  }
  let previous = -1
  for (const version of transition.structuralVersions) {
    if (!Number.isSafeInteger(version) || version < 0 || version <= previous) {
      throw new Error('ConversationStructuralTransitionVersionsInvalid')
    }
    previous = version
  }
  if (transition.structuralVersions.at(-1) !== transition.toVersion) {
    throw new Error('ConversationStructuralTransitionVersionCoverageInvalid')
  }
}

function exactStructuralTransitionVersion(
  currentVersion: number,
  transition: Extract<ConversationStructuralTransition, { readonly kind: 'exact-delta' }>,
): number | null {
  if (transition.toVersion <= currentVersion) return currentVersion
  let expected = currentVersion + 1
  for (const version of transition.structuralVersions) {
    if (version <= currentVersion) continue
    if (version !== expected) return null
    expected += 1
  }
  return expected - 1 === transition.toVersion ? transition.toVersion : null
}

function reduceAcceptedPath(
  spine: VersionedActiveBranchSpine<MessageHeaderRow> | null,
  observations: AppliedHeaderObservations,
): PathReduction {
  if (!spine || observations.changedIds.length === 0) {
    return Object.freeze({ kind: 'unchanged' })
  }
  const replacements: MessageHeaderRow[] = []
  for (const messageId of observations.changedIds) {
    const prior = spine.path.get(messageId)
    if (!prior) continue
    const current = observations.byId.get(messageId)
    const relation = classifyHeaderUpdate(current, prior)
    if (relation === 'not-newer') continue
    if (relation === 'structural-conflict') {
      return Object.freeze({ kind: 'structurally-invalidated' })
    }
    if (current !== prior) replacements.push(current as MessageHeaderRow)
  }
  return replacements.length === 0
    ? Object.freeze({ kind: 'unchanged' })
    : Object.freeze({ kind: 'compatible', replacements: Object.freeze(replacements) })
}

function exactTransitionChangesPath(
  active: ActiveProjection,
  spine: VersionedActiveBranchSpine<MessageHeaderRow>,
  messageIds: readonly MessageId[],
): boolean {
  for (const messageId of messageIds) {
    const selected = spine.path.get(messageId)
    if (!selected) continue
    const current = active.headers.get(messageId) ?? selected
    if (!sameStructuralHeader(current, selected)) return true
  }
  return false
}

function projectionFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' && error.length > 0 ? error : 'Unknown projection failure'
}

function projectionFailureError(error: unknown): Error {
  return error instanceof Error ? error : new Error(projectionFailureMessage(error))
}

function treeProjectionContainsSpine(
  topology: MessageTreeProjection<StructuralMessageHeader>,
  path: BranchPathDescriptor<MessageHeaderRow>,
): boolean {
  for (const messageId of path.messageIds) {
    const selected = path.get(messageId)
    const projected = topology.byId.get(messageId)
    if (!selected || !projected || !sameStructuralHeader(selected, projected)) return false
  }
  return true
}

function sameConversationBindingPayload(
  current: ConversationVisibleSurfaceBinding,
  incoming: ConversationVisibleSurfaceBinding,
): boolean {
  if (current.surface !== incoming.surface) return false
  if (
    current.seal.workspaceId !== incoming.seal.workspaceId ||
    current.seal.replacementEpoch !== incoming.seal.replacementEpoch ||
    current.seal.chatId !== incoming.seal.chatId ||
    current.seal.selectionRevision !== incoming.seal.selectionRevision ||
    current.seal.structuralVersion !== incoming.seal.structuralVersion ||
    current.seal.leafId !== incoming.seal.leafId ||
    current.spine !== incoming.spine
  ) {
    return false
  }
  return current.surface === 'transcript'
    ? incoming.surface === 'transcript' &&
        current.window === incoming.window &&
        current.selectionEpoch === incoming.selectionEpoch &&
        current.viewportRevision === incoming.viewportRevision &&
        current.intentPresentations === incoming.intentPresentations
    : incoming.surface === 'tree' &&
        current.headers === incoming.headers &&
        current.topology === incoming.topology &&
        current.headerChangeRevision === incoming.headerChangeRevision &&
        current.changedHeaderKeys === incoming.changedHeaderKeys &&
        current.inspector.exact === incoming.inspector.exact &&
        current.inspector.retained === incoming.inspector.retained &&
        current.inspector.resolving === incoming.inspector.resolving &&
        current.previews === incoming.previews
}

function sameCurrentConversationBinding(
  current: ConversationVisibleSurfaceBinding | null,
  incoming: ConversationCurrentSurfaceBinding,
): boolean {
  return Boolean(
    current?.currency === 'current' &&
      current.reveal === incoming.reveal &&
      sameConversationBindingPayload(current, incoming),
  )
}

function currentConversationBindingMatchesProjection(
  binding: ConversationCurrentSurfaceBinding,
  workspaceId: string | null,
  workspaceEpoch: number,
  active: ActiveProjection,
  session: ChatSession,
): boolean {
  if (workspaceId === null || active.destination.kind !== 'ready') return false
  const spine = active.destination.spine
  return (
    binding.seal.workspaceId === workspaceId &&
    binding.seal.replacementEpoch === workspaceEpoch &&
    binding.seal.chatId === active.chatId &&
    binding.seal.selectionRevision === session.selectionRevision &&
    binding.seal.structuralVersion === spine.structuralVersion &&
    binding.seal.leafId === spine.resolvedLeafId
  )
}

function retainConversationBinding(
  binding: ConversationTranscriptSurface,
): ConversationTranscriptSurface
function retainConversationBinding(binding: ConversationTreeSurface): ConversationTreeSurface
function retainConversationBinding(
  binding: ConversationVisibleSurfaceBinding,
): ConversationVisibleSurfaceBinding
function retainConversationBinding(
  binding: ConversationVisibleSurfaceBinding,
): ConversationVisibleSurfaceBinding {
  if (binding.currency === 'retained') return binding
  if (binding.surface === 'transcript') {
    return Object.freeze({ ...binding, currency: 'retained', reveal: null })
  }
  return Object.freeze({ ...binding, currency: 'retained', reveal: null })
}

function replacementTranscriptOwesPaintedWindow(
  previous: ConversationVisibleSurfaceBinding,
  nextSeal: ConversationPresentationSeal,
  nextWindow: ConversationTranscriptFrame,
  promisedSpan: BranchPathSpan | null,
): boolean {
  if (
    previous.surface !== 'transcript' ||
    previous.currency !== 'retained' ||
    previous.seal.workspaceId !== nextSeal.workspaceId ||
    previous.seal.chatId !== nextSeal.chatId ||
    !transcriptWindowIsStrictSubwindow(previous.window, nextWindow) ||
    promisedSpan === null ||
    promisedSpan.branchLength !== previous.window.branchLength ||
    promisedSpan.offset > previous.window.offset ||
    promisedSpan.offset + promisedSpan.limit < previous.window.offset + previous.window.rowCount
  ) {
    return false
  }
  return true
}

function transcriptWindowIsStrictSubwindow(
  previous: ConversationTranscriptFrame,
  next: ConversationTranscriptFrame,
): boolean {
  if (previous.leafId !== next.leafId || previous.branchLength !== next.branchLength) {
    return false
  }
  return (
    next.offset > previous.offset ||
    next.offset + next.rowCount < previous.offset + previous.rowCount
  )
}

function eligiblePresentationReveal(
  reveal: ConversationRevealEffect | null,
  seal: ConversationPresentationSeal,
  containsTarget: (messageId: MessageId) => boolean,
): ConversationRevealEffect | null {
  return reveal &&
    reveal.chatId === seal.chatId &&
    reveal.selectionRevision === seal.selectionRevision &&
    containsTarget(reveal.targetMessageId)
    ? reveal
    : null
}

interface ConversationPromptPathFrameInput {
  readonly workspaceFence: WorkspaceFence
  readonly chatId: ChatId
  readonly destination: ConversationDestinationProjection
  readonly topology: MessageTopologyIndex<StructuralMessageHeader> | null
  readonly topologyLoaded: boolean
  readonly topologyFailed: boolean
  readonly headers: PersistentStringMap<MessageHeaderRow>
  readonly captureMaterial: (headers: readonly MessageHeaderRow[]) => GenerationPromptMaterialLease
}

function createConversationPromptPathFrame({
  workspaceFence,
  chatId,
  destination,
  topology,
  topologyLoaded,
  topologyFailed,
  headers,
  captureMaterial,
}: ConversationPromptPathFrameInput): ConversationPromptPathFrame {
  const spine = destination.kind === 'ready' ? destination.spine : null
  const path = spine?.path ?? null
  const header = (messageId: MessageId): MessageHeaderRow | null => {
    const pathHeader = path?.get(messageId)
    if (pathHeader) return pathHeader
    if (!topologyLoaded || !topology) return null
    const structuralHeader = topology.byId.get(messageId)
    const exactHeader = headers.get(messageId)
    return structuralHeader &&
      exactHeader &&
      !exactHeader.deleted &&
      sameStructuralHeader(exactHeader, structuralHeader)
      ? exactHeader
      : null
  }
  const classify = (
    targetChatId: ChatId,
    targetKind: 'root' | 'include' | 'exclude',
    targetMessageId: MessageId | null,
    targetRole: 'any' | 'user' | 'assistant',
    childSlot: 'empty' | 'append' | 'none',
  ): ConversationPromptPathCapability => {
    if (targetChatId !== chatId) return 'pending'
    if (destination.kind === 'missing' || destination.kind === 'unavailable') return 'unavailable'
    if (destination.kind === 'failed') return 'error'
    if (!spine) return 'pending'
    if (targetKind === 'root') {
      return spine.resolvedLeafId === null ? 'available' : 'unavailable'
    }
    if (targetMessageId === null) return 'unavailable'
    const target = header(targetMessageId)
    if (!target) {
      if (topologyFailed) return 'error'
      return topologyLoaded ? 'unavailable' : 'pending'
    }
    if (targetRole !== 'any' && target.role !== targetRole) {
      return 'unavailable'
    }
    if (childSlot !== 'empty' || spine.resolvedLeafId === target.id) {
      return 'available'
    }
    if (!topologyLoaded || !topology) return topologyFailed ? 'error' : 'pending'
    return (topology.liveByParent.get(target.id)?.length ?? 0) === 0 ? 'available' : 'unavailable'
  }
  const requirementCapability = (
    requirement: Extract<GenerationPromptPathRequirement, { readonly surface: 'chat' }>,
  ): ConversationPromptPathCapability =>
    classify(
      requirement.chatId,
      requirement.target.kind,
      requirement.target.kind === 'root' ? null : requirement.target.messageId,
      requirement.target.kind === 'root' ? 'any' : requirement.target.role,
      requirement.childSlot,
    )
  const capability = (target: GenerationCapabilityTarget): ConversationPromptPathCapability => {
    switch (target.kind) {
      case 'new-chat-send':
        return 'pending'
      case 'send':
        return classify(
          target.chatId,
          target.expectedLeafId === null ? 'root' : 'include',
          target.expectedLeafId,
          'any',
          'empty',
        )
      case 'reply':
        return classify(target.chatId, 'include', target.parentUserId, 'user', 'empty')
      case 'regenerate':
        return classify(target.chatId, 'exclude', target.targetAssistantId, 'assistant', 'append')
      case 'edit-resend':
        return classify(target.chatId, 'exclude', target.targetUserId, 'user', 'append')
      case 'continue':
        return classify(target.chatId, 'include', target.targetAssistantId, 'assistant', 'none')
    }
  }
  const pathHeaders = (leafId: MessageId | null): readonly MessageHeaderRow[] | null => {
    if (leafId === null) return Object.freeze([])
    if (path?.has(leafId)) {
      const index = path.indexOf(leafId)
      return index < 0
        ? null
        : Object.freeze([...path.window({ offset: 0, limit: index + 1 }).nodes])
    }
    if (!topologyLoaded || !topology) return null
    const reversed: MessageHeaderRow[] = []
    const seen = new Set<MessageId>()
    let currentId: MessageId | null = leafId
    while (currentId !== null) {
      if (seen.has(currentId)) return null
      seen.add(currentId)
      const current = header(currentId)
      if (!current) return null
      reversed.push(current)
      currentId = current.parentId
    }
    reversed.reverse()
    return Object.freeze(reversed)
  }
  return Object.freeze({
    workspaceId: workspaceFence.workspaceId,
    replacementEpoch: workspaceFence.replacementEpoch,
    chatId,
    capability,
    capture: (
      requirement: Extract<GenerationPromptPathRequirement, { readonly surface: 'chat' }>,
    ) => {
      if (requirementCapability(requirement) !== 'available') return null
      let leafId = requirement.target.kind === 'root' ? null : requirement.target.messageId
      if (requirement.target.kind === 'exclude') {
        const target = header(requirement.target.messageId)
        if (!target) return null
        leafId = target.parentId
      }
      const capturedHeaders = pathHeaders(leafId)
      if (!capturedHeaders) return null
      return Object.freeze({
        claim: Object.freeze({
          chatId,
          leafId,
          headers: Object.freeze(
            capturedHeaders.map((capturedHeader) =>
              Object.freeze({
                messageId: capturedHeader.id,
                parentId: capturedHeader.parentId,
                requestContextVersion: capturedHeader.requestContextVersion,
              }),
            ),
          ),
        }),
        material: captureMaterial(capturedHeaders),
      })
    },
  })
}

const PENDING_CONVERSATION_PROMPT_PATH_FRAME: ConversationPromptPathFrame = Object.freeze({
  workspaceId: null,
  replacementEpoch: null,
  chatId: null,
  capability: () => 'pending' as const,
  capture: () => null,
})

export function createConversationController(
  targetPresentationPort: ConversationTargetPresentationPort | null = null,
): ConversationController {
  return new TabConversationController(targetPresentationPort)
}

export const conversationController = createConversationController(attemptController)

const EMPTY_EXACT_TARGET_PRESENTATION_RECEIPTS = Object.freeze(
  [],
) as readonly ExactTargetPresentationReceipt[]

function exactPublishedTargetBodyVersion(
  snapshot: ConversationChatSnapshot,
  messageId: MessageId,
): number | undefined {
  if (snapshot.transcript.kind !== 'absent') {
    const row = transcriptBodyWindowFindRow(snapshot.transcript.window, messageId)
    if (row?.bodyExact) return row.bodyVersion
  }
  const transcriptResident = snapshot.presentation.residents.transcript
  if (transcriptResident) {
    const row = transcriptBodyWindowFindRow(transcriptResident.window, messageId)
    if (row?.bodyExact) return row.bodyVersion
  }
  const inspector = snapshot.inspector.exact
  return inspector?.message.id === messageId ? inspector.bodyVersion : undefined
}

function presentedTranscriptWindow(
  transcript: ActiveTranscriptState,
): ConversationTranscriptFrame | null {
  return transcript.kind === 'absent' ? null : transcript.window
}

function presentedTranscriptMessageIds(transcript: ActiveTranscriptState): readonly MessageId[] {
  const window = presentedTranscriptWindow(transcript)
  return window
    ? Object.freeze([...transcriptBodyWindowRows(window)].map((row) => row.header.id))
    : Object.freeze([])
}

function readyTranscriptWindow(
  transcript: ActiveTranscriptState,
): ConversationTranscriptFrame | null {
  return transcript.kind === 'ready' ? transcript.window : null
}

function retainTranscriptState(
  transcript: ActiveTranscriptState,
  selectionEpoch = transcript.selectionEpoch,
): ActiveTranscriptState {
  if (transcript.kind === 'point') {
    return Object.freeze({ kind: 'absent', selectionEpoch })
  }
  const window = presentedTranscriptWindow(transcript)
  return window
    ? Object.freeze({ kind: 'retained', selectionEpoch, window })
    : Object.freeze({ kind: 'absent', selectionEpoch })
}

function readyTranscriptState(
  selectionEpoch: number,
  window: ConversationTranscriptFrame,
): ActiveTranscriptState {
  return Object.freeze({ kind: 'ready', selectionEpoch, window })
}

function pointTranscriptMatchesAttempt(
  transcript: Extract<ActiveTranscriptState, { readonly kind: 'point' }>,
  attempt: ConversationSelectionAttempt | null,
): boolean {
  return Boolean(attempt && attempt.id === transcript.attemptId)
}

function newActiveProjection(chatId: ChatId): ActiveProjection {
  const headers = PersistentStringMap.empty<MessageHeaderRow>()
  const headerFacts: ConversationMessageHeaderLookup = Object.freeze({
    get: (_messageId: MessageId) => undefined,
    has: (_messageId: MessageId) => false,
  })
  return {
    chatId,
    chat: null,
    selectionAttempt: null,
    destination: Object.freeze({ kind: 'unresolved', retained: null }),
    headers,
    headerFacts,
    headerFactsHeaders: headers,
    headerFactsPath: null,
    treeHeaderFacts: headerFacts,
    treeHeaderFactsSource: headerFacts,
    treeHeaderFactsTopology: null,
    treeChangedHeaderKeys: Object.freeze([]),
    treeChangedHeaderKeysSource: Object.freeze([]),
    treeChangedHeaderKeysTopology: null,
    compactableHeaderIds: new Set(),
    forks: PersistentStringMap.empty(),
    topology: ABSENT_TOPOLOGY,
    headerChangeRevision: 0,
    changedHeaderKeys: Object.freeze([]),
    transcript: Object.freeze({ kind: 'absent', selectionEpoch: 0 }),
    transcriptFill: null,
    transcriptPlan: null,
    inspector: { exact: null, retained: null, resolvingKey: null },
    previews: new Map(),
    previewSnapshot: new Map(),
    failure: null,
    presentationResidents: { transcript: null, tree: null },
    presentationSeal: null,
    reveal: null,
  }
}

function structuralTopologyView(
  topology: MessageTopologyIndex<StructuralMessageHeader>,
): MessageTreeProjection<StructuralMessageHeader> {
  return Object.freeze({
    nodes: topology.nodes,
    byId: topology.byId,
    byParent: topology.byParent,
    liveByParent: topology.liveByParent,
  })
}

function activeBranchSpineFromTopology(
  current: VersionedActiveBranchSpine<MessageHeaderRow>,
  structuralVersion: number,
  byId: ReadonlyMap<MessageId, MessageHeaderRow>,
): VersionedActiveBranchSpine<MessageHeaderRow> | null {
  if (current.resolvedLeafId === null) {
    return createActiveBranchSpine({
      chatId: current.chatId,
      structuralVersion,
      resolvedLeafId: null,
      headers: Object.freeze([]),
    })
  }
  const reversed: MessageHeaderRow[] = []
  const seen = new Set<MessageId>()
  let messageId: MessageId | null = current.resolvedLeafId
  while (messageId !== null) {
    if (seen.has(messageId)) return null
    seen.add(messageId)
    const header = byId.get(messageId)
    if (!header || header.chatId !== current.chatId || header.deleted) return null
    reversed.push(header)
    messageId = header.parentId
  }
  reversed.reverse()
  return createActiveBranchSpine({
    chatId: current.chatId,
    structuralVersion,
    resolvedLeafId: current.resolvedLeafId,
    headers: Object.freeze(reversed),
  })
}

function sameTopologyHeader(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    sameStructuralHeader(left, right) &&
    left.nodeVersion === right.nodeVersion &&
    left.bodyVersion === right.bodyVersion
  )
}

function chatMetadataReceiptDominates(candidate: Chat, current: Chat): boolean {
  return (
    candidate.metaVersion >= current.metaVersion &&
    candidate.summaryVersion >= current.summaryVersion &&
    candidate.structuralVersion >= current.structuralVersion &&
    (candidate.configurationVersion ?? 0) >= (current.configurationVersion ?? 0)
  )
}

function retainedReadyDestination(
  destination: ConversationDestinationProjection,
): ConversationDestinationReadyProjection | null {
  if (destination.kind === 'ready') return destination
  if (
    destination.kind === 'unresolved' ||
    destination.kind === 'resolving' ||
    destination.kind === 'unavailable' ||
    destination.kind === 'failed'
  ) {
    return destination.retained
  }
  return null
}

function destinationRetainsObservedFacts(destination: ConversationDestinationProjection): boolean {
  return destination.kind === 'unresolved' || destination.kind === 'resolving'
}

function replacePresentedDestinationSpine(
  destination: ConversationDestinationProjection,
  spine: VersionedActiveBranchSpine<MessageHeaderRow>,
): ConversationDestinationProjection {
  const ready = Object.freeze({ kind: 'ready', spine } as const)
  switch (destination.kind) {
    case 'ready':
      return ready
    case 'unresolved':
    case 'resolving':
    case 'unavailable':
    case 'failed':
      return Object.freeze({ ...destination, retained: ready })
    case 'missing':
      return destination
  }
}

export function currentConversationDestinationSpine(
  destination: ConversationDestinationProjection,
): VersionedActiveBranchSpine<MessageHeaderRow> | null {
  return destination.kind === 'ready' ? destination.spine : null
}

export function presentedConversationDestinationSpine(
  destination: ConversationDestinationProjection,
): VersionedActiveBranchSpine<MessageHeaderRow> | null {
  return retainedReadyDestination(destination)?.spine ?? null
}

function headerSupersedes(
  incoming: MessageHeaderRow,
  current: MessageHeaderRow | undefined,
): boolean {
  if (!current) return true
  const relation = classifyMessageHeaderRevision(incoming, current)
  if (relation === 'invalid-regression' || relation === 'version-collision') {
    throw new Error(`ConversationMessageRevisionInvariant:${incoming.id}:${relation}`)
  }
  return relation === 'compatible-newer' || relation === 'structural-newer'
}

function classifyHeaderUpdate(
  incoming: MessageHeaderRow | undefined,
  current: MessageHeaderRow,
): 'not-newer' | 'compatible' | 'structural-conflict' {
  if (!incoming) return 'not-newer'
  const relation = classifyMessageHeaderRevision(incoming, current)
  if (relation === 'invalid-regression' || relation === 'version-collision') {
    throw new Error(`ConversationMessageRevisionInvariant:${incoming.id}:${relation}`)
  }
  if (relation === 'older' || relation === 'identical') return 'not-newer'
  return relation === 'structural-newer' ? 'structural-conflict' : 'compatible'
}

function frameMatchesWindow(
  frame: ConversationTranscriptPage,
  path: BranchPathDescriptor<MessageHeaderRow>,
  window: BranchPathWindow<MessageHeaderRow>,
): boolean {
  const leaf = path.leaf
  if (
    !leaf ||
    frame.chatId !== leaf.chatId ||
    frame.leafId !== leaf.id ||
    frame.branchLength !== path.length ||
    frame.offset !== window.offset ||
    frame.headers.length !== window.nodes.length ||
    frame.headers.length !== frame.messages.length
  ) {
    return false
  }
  return window.nodes.every((expected, index) => {
    const header = frame.headers[index]
    const message = frame.messages[index]
    return Boolean(
      header && message && sameTopologyHeader(expected, header) && header.id === message.id,
    )
  })
}

function frameStructurallyMatchesWindow(
  frame: ConversationTranscriptPage,
  path: BranchPathDescriptor<MessageHeaderRow>,
  window: BranchPathWindow<MessageHeaderRow>,
): boolean {
  const leaf = path.leaf
  if (
    !leaf ||
    frame.chatId !== leaf.chatId ||
    frame.leafId !== leaf.id ||
    frame.branchLength !== path.length ||
    frame.offset !== window.offset ||
    frame.headers.length !== window.nodes.length ||
    frame.headers.length !== frame.messages.length
  ) {
    return false
  }
  return window.nodes.every((expected, index) => {
    const accepted = path.get(expected.id)
    const header = frame.headers[index]
    const message = frame.messages[index]
    return Boolean(
      accepted &&
        header &&
        message &&
        sameStructuralHeader(accepted, expected) &&
        sameStructuralHeader(accepted, header) &&
        header.id === message.id,
    )
  })
}

function pathStructurallyMatchesWindow(
  path: BranchPathDescriptor<MessageHeaderRow>,
  window: BranchPathWindow<MessageHeaderRow>,
): boolean {
  if (path.length !== window.branchLength) return false
  const current = path.window({ offset: window.offset, limit: window.nodes.length })
  return (
    current.offset === window.offset &&
    current.nodes.length === window.nodes.length &&
    current.boundaryParentId === window.boundaryParentId &&
    current.nodes.every((header, index) => {
      const expected = window.nodes[index]
      return Boolean(expected && sameStructuralHeader(header, expected))
    })
  )
}

function frameCoversWindow(
  frame: ConversationTranscriptFrame,
  path: BranchPathDescriptor<MessageHeaderRow>,
  window: BranchPathSpan,
): boolean {
  return (
    transcriptBodyWindowMatchesPath(frame, path) &&
    frame.offset <= window.offset &&
    frame.offset + frame.rowCount >= window.offset + window.limit
  )
}

function selectionKey(selection: ActiveBranchSelection): string {
  switch (selection.kind) {
    case 'default':
      return 'default'
    case 'message':
      return `message:${selection.messageId}:${selection.observedTipId ?? '__resolve__'}`
    case 'tip':
      return `tip:${selection.messageId}`
    case 'sibling-position':
      return `sibling:${selection.parentId ?? '__root__'}:${selection.position}:${selection.observedTipId ?? '__resolve__'}`
  }
}

function proofTargetKey(target: ConversationSelectionProofTarget): string {
  switch (target.kind) {
    case 'resolve-selection':
      return `resolve:${selectionKey(target.selection)}`
    case 'fixed-empty':
      return `empty:${selectionKey(target.selection)}`
    case 'fixed-tip':
      return `tip:${target.messageId}:${selectionKey(target.selection)}`
  }
}

function sameProofTarget(
  left: ConversationSelectionProofTarget,
  right: ConversationSelectionProofTarget,
): boolean {
  return proofTargetKey(left) === proofTargetKey(right)
}

function conversationSelectionIntent(
  selection: ActiveBranchSelection,
  unavailable: ConversationSelectionRecovery = 'retain',
): ConversationSelectionIntent {
  return Object.freeze({ selection: Object.freeze(selection), unavailable })
}

function selectionTargetMessageId(selection: ActiveBranchSelection): MessageId | null {
  return selection.kind === 'message' || selection.kind === 'tip' ? selection.messageId : null
}

function setDemand<T>(map: Map<object, T>, owner: object, demand: T | null): void {
  if (demand === null) map.delete(owner)
  else {
    map.delete(owner)
    map.set(owner, demand)
  }
}

function sameBranchPathSpan(left: BranchPathSpan, right: BranchPathSpan): boolean {
  return (
    left.branchLength === right.branchLength &&
    left.offset === right.offset &&
    left.limit === right.limit &&
    left.boundaryParentId === right.boundaryParentId
  )
}

function maxTranscriptDemand(
  map: ReadonlyMap<object, TranscriptDemand>,
  chatId: ChatId,
  selectionRevision: number | undefined,
  selectionEpoch: number,
): TranscriptDemand | null {
  if (selectionRevision === undefined) return null
  let minimumRowCount: number | null = null
  let textCharLimit: number | null = null
  let renderCostLimit: number | null = null
  for (const demand of map.values()) {
    if (
      demand.chatId !== chatId ||
      demand.selectionRevision !== selectionRevision ||
      demand.selectionEpoch !== selectionEpoch
    ) {
      continue
    }
    minimumRowCount =
      minimumRowCount === null
        ? demand.budget.minimumRowCount
        : Math.max(minimumRowCount, demand.budget.minimumRowCount)
    textCharLimit =
      textCharLimit === null
        ? demand.budget.textCharLimit
        : Math.max(textCharLimit, demand.budget.textCharLimit)
    renderCostLimit =
      renderCostLimit === null
        ? demand.budget.renderCostLimit
        : Math.max(renderCostLimit, demand.budget.renderCostLimit)
  }
  return minimumRowCount === null || textCharLimit === null || renderCostLimit === null
    ? null
    : {
        chatId,
        selectionRevision,
        selectionEpoch,
        budget: { minimumRowCount, textCharLimit, renderCostLimit },
      }
}

function maxTranscriptWorkBudget(
  current: TranscriptWorkBudget,
  base: TranscriptWorkBudget,
): TranscriptWorkBudget {
  if (
    current.minimumRowCount >= base.minimumRowCount &&
    current.textCharLimit >= base.textCharLimit &&
    current.renderCostLimit >= base.renderCostLimit
  ) {
    return current
  }
  return Object.freeze({
    minimumRowCount: Math.max(current.minimumRowCount, base.minimumRowCount),
    textCharLimit: Math.max(current.textCharLimit, base.textCharLimit),
    renderCostLimit: Math.max(current.renderCostLimit, base.renderCostLimit),
  })
}

function sameTranscriptWorkBudget(
  left: TranscriptWorkBudget,
  right: TranscriptWorkBudget,
): boolean {
  return (
    left.minimumRowCount === right.minimumRowCount &&
    left.textCharLimit === right.textCharLimit &&
    left.renderCostLimit === right.renderCostLimit
  )
}

function transcriptWorkBudgetContracts(
  previous: TranscriptWorkBudget,
  next: TranscriptWorkBudget,
): boolean {
  return (
    next.minimumRowCount < previous.minimumRowCount ||
    next.textCharLimit < previous.textCharLimit ||
    next.renderCostLimit < previous.renderCostLimit
  )
}

function latestInspectorDemand(
  map: ReadonlyMap<object, InspectorDemand>,
  chatId: ChatId,
): InspectorDemand | null {
  let result: InspectorDemand | null = null
  for (const demand of map.values()) if (demand.chatId === chatId) result = demand
  return result
}

function combinedPreviewDemand(
  map: ReadonlyMap<object, TreePreviewDemand>,
  chatId: ChatId,
): TreePreviewDemand | null {
  const byMessageId = new Map<MessageId, TreePreviewTarget>()
  for (const demand of map.values()) {
    if (demand.chatId !== chatId) continue
    for (const target of demand.targets) {
      const current = byMessageId.get(target.messageId)
      if (!current || target.bodyVersion > current.bodyVersion)
        byMessageId.set(target.messageId, target)
    }
  }
  if (byMessageId.size === 0) return null
  const targets = [...byMessageId.values()].sort((left, right) =>
    left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0,
  )
  return { chatId, targets: Object.freeze(targets) }
}

function treePreviewTargetKey(target: TreePreviewTarget): string {
  return `${target.messageId}:${target.bodyVersion}`
}

function trimPreviewCache(
  previews: Map<MessageId, MessageTextPreview>,
  protectedTargets: readonly TreePreviewTarget[],
): void {
  const protectedIds = new Set(protectedTargets.map((target) => target.messageId))
  let retainedCharacters = 0
  for (const preview of previews.values()) retainedCharacters += preview.text.length
  for (const [messageId, preview] of previews) {
    if (previews.size <= 256 && retainedCharacters <= 245_760) return
    if (protectedIds.has(messageId)) continue
    previews.delete(messageId)
    retainedCharacters -= preview.text.length
  }
}

interface PersistedConversationSession {
  selection: ActiveBranchSelection
  presentation: ConversationSurface
  pendingRevealTargetId?: MessageId
}

function persistedSessionKey(chatId: ChatId): string {
  return `${CONVERSATION_SESSION_PREFIX}${encodeURIComponent(chatId)}`
}

function loadPersistedSession(
  chatId: ChatId,
  fence: WorkspaceFence,
): PersistedConversationSession | null {
  const storage = browserSessionStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(persistedSessionKey(chatId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      version?: unknown
      workspaceId?: unknown
      replacementEpoch?: unknown
      selection?: unknown
      presentation?: unknown
      pendingRevealTargetId?: unknown
    }
    if (
      parsed.workspaceId !== fence.workspaceId ||
      parsed.replacementEpoch !== fence.replacementEpoch ||
      (parsed.presentation !== 'transcript' && parsed.presentation !== 'tree') ||
      (parsed.pendingRevealTargetId !== undefined &&
        typeof parsed.pendingRevealTargetId !== 'string')
    ) {
      deletePersistedSession(chatId)
      return null
    }
    const selection = parsed.version === 8 ? parsePersistedSelection(parsed.selection) : undefined
    if (!selection) {
      deletePersistedSession(chatId)
      return null
    }
    return {
      selection,
      presentation: parsed.presentation,
      ...(parsed.pendingRevealTargetId
        ? { pendingRevealTargetId: parsed.pendingRevealTargetId }
        : {}),
    }
  } catch {
    deletePersistedSession(chatId)
    return null
  }
}

function clearPersistedSessions(): void {
  const storage = browserSessionStorage()
  if (!storage) return
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(CONVERSATION_SESSION_PREFIX)) keys.push(key)
    }
    for (const key of keys) storage.removeItem(key)
  } catch {
    // Best effort for storage-restricted contexts.
  }
}

function projectionScopeTouchesSpine(
  scope: ConversationProjectionScope<MessageId> | undefined,
  spine: VersionedActiveBranchSpine<MessageHeaderRow> | null,
): boolean {
  if (scope === true) return true
  if (!scope || scope.length === 0) return false
  if (!spine) return true
  return scope.some((messageId) => spine.path.has(messageId))
}

class PendingConversationHandoffReducer {
  private readonly workspaceId: string
  private readonly replacementEpoch: number
  private readonly chatId: ChatId
  private sequence = 0
  private deleted = false
  private chat: PendingConversationChatFact | null = null
  private readonly revisions = new Map<MessageId, PendingConversationRevisionFact>()
  private readonly childSlots = new Map<
    string,
    { readonly accumulator: WorkspaceLocalChildSlotAccumulator; sequence: number }
  >()
  private readonly structural = new PendingConversationStructuralReducer()
  private readonly refresh = new PendingConversationRefreshReducer()

  constructor(effect: ConversationCommittedEffect) {
    this.workspaceId = effect.workspaceId
    this.replacementEpoch = effect.replacementEpoch
    this.chatId = effect.chatId
    this.add(effect)
  }

  add(effect: ConversationCommittedEffect): void {
    if (
      effect.workspaceId !== this.workspaceId ||
      effect.replacementEpoch !== this.replacementEpoch ||
      effect.chatId !== this.chatId
    ) {
      throw new Error('ConversationCommittedEffectOwnerMismatch')
    }
    if (this.deleted) return
    if (effect.kind === 'deleted') {
      this.deleted = true
      return
    }
    const factSequence = ++this.sequence
    this.structural.add(effect.structural)
    if (effect.chat && (!this.chat || chatMetadataReceiptDominates(effect.chat, this.chat.chat))) {
      this.chat = Object.freeze({ chat: effect.chat, sequence: factSequence })
    }
    for (const revision of effect.revisions ?? []) {
      this.revisions.set(
        revision.header.id,
        mergePendingConversationRevisionFact(
          this.revisions.get(revision.header.id),
          revision,
          factSequence,
          effect.source,
        ),
      )
    }
    for (const evidence of effect.childSlots ?? []) {
      let fact = this.childSlots.get(evidence.state.id)
      if (!fact) {
        fact = { accumulator: new WorkspaceLocalChildSlotAccumulator(), sequence: factSequence }
        this.childSlots.set(evidence.state.id, fact)
      }
      fact.accumulator.add(evidence)
      fact.sequence = factSequence
    }
    this.refresh.add(effect, ++this.sequence)
  }

  reduce(seed: SealedConversationSelection): PendingConversationHandoffReduction {
    if (seed.chat.id !== this.chatId || seed.proof.chatId !== this.chatId) {
      throw new Error(`ConversationRouteHandoffReductionSeedMismatch:${this.chatId}`)
    }
    const refresh = this.refresh.snapshot()
    if (this.deleted) {
      return Object.freeze({
        kind: 'deleted',
        chat: this.chat,
        revisions: Object.freeze([...this.revisions.values()]),
        childSlots: Object.freeze([]),
        structural: this.structural.snapshot(),
        refresh,
      })
    }
    const childSlots = [...this.childSlots.values()].flatMap((fact) => {
      const evidence = fact.accumulator.materialize()
      return evidence ? [Object.freeze({ evidence, sequence: fact.sequence })] : []
    })
    return Object.freeze({
      kind: 'changed',
      chat: this.chat,
      revisions: Object.freeze([...this.revisions.values()]),
      childSlots: Object.freeze(childSlots),
      structural: this.structural.snapshot(),
      refresh,
    })
  }
}

class PendingConversationStructuralReducer {
  private maxToVersion: number | null = null
  private exactToVersion: number | null = null
  private readonly structuralVersions = new Set<number>()
  private readonly messageIds = new Set<MessageId>()

  add(transition: ConversationStructuralTransition): void {
    if (transition.kind === 'none') return
    if (transition.toVersion !== null) {
      this.maxToVersion = Math.max(this.maxToVersion ?? transition.toVersion, transition.toVersion)
    }
    if (transition.kind !== 'exact-delta') return
    this.exactToVersion = Math.max(
      this.exactToVersion ?? transition.toVersion,
      transition.toVersion,
    )
    for (const structuralVersion of transition.structuralVersions) {
      this.structuralVersions.add(structuralVersion)
    }
    for (const messageId of transition.messageIds) this.messageIds.add(messageId)
  }

  snapshot(): PendingConversationStructuralSummary {
    return Object.freeze({
      maxToVersion: this.maxToVersion,
      exactToVersion: this.exactToVersion,
      structuralVersions: Object.freeze(
        [...this.structuralVersions].sort((left, right) => left - right),
      ),
      messageIds: Object.freeze([...this.messageIds]),
    })
  }
}

class PendingConversationRefreshReducer {
  private chatSequence: number | null = null
  private readonly headers = new PendingConversationInvalidationReducer<MessageId>()
  private readonly bodies = new PendingConversationInvalidationReducer<MessageId>()
  private readonly previews = new PendingConversationInvalidationReducer<MessageId>()
  private readonly topology = new PendingConversationInvalidationReducer<MessageId>()
  private readonly forkParentIds = new PendingConversationInvalidationReducer<MessageId | null>()

  add(effect: ConversationChangedCommittedEffect, sequence: number): void {
    const refresh = effect.refresh
    if (refresh) {
      if (refresh.chat) this.chatSequence = sequence
      this.headers.add(refresh.headers, sequence)
      this.bodies.add(refresh.bodies, sequence)
      this.previews.add(refresh.previews, sequence)
      this.forkParentIds.add(refresh.forkParentIds, sequence)
    }
    if (effect.structural.kind === 'incomplete') {
      this.topology.add(effect.structural.scope, sequence)
    }
  }

  snapshot(): PendingConversationHandoffReduction['refresh'] {
    return Object.freeze({
      chatSequence: this.chatSequence,
      headers: this.headers.snapshot(),
      bodies: this.bodies.snapshot(),
      previews: this.previews.snapshot(),
      topology: this.topology.snapshot(),
      forkParentIds: this.forkParentIds.snapshot(),
    })
  }
}

class PendingConversationInvalidationReducer<Id> {
  private globalSequence: number | null = null
  private readonly sequencesById = new Map<Id, number>()

  add(scope: ConversationProjectionScope<Id> | undefined, sequence: number): void {
    if (scope === undefined) return
    if (scope === true) {
      this.globalSequence = sequence
      this.sequencesById.clear()
      return
    }
    for (const id of scope) this.sequencesById.set(id, sequence)
  }

  snapshot(): PendingConversationInvalidationScope<Id> {
    return Object.freeze({
      globalSequence: this.globalSequence,
      sequencesById: new Map(this.sequencesById),
    })
  }
}

function mergePendingConversationRevisionFact(
  current: PendingConversationRevisionFact | undefined,
  incoming: ConversationMessageRevisionObservation,
  sequence: number,
  source: ConversationCommittedEffectSource,
): PendingConversationRevisionFact {
  if (!current) {
    return Object.freeze({
      observation: incoming,
      headerSequence: sequence,
      headerSource: source,
      presentationSequence: incoming.presentation ? sequence : null,
    })
  }
  const relation = classifyMessageHeaderRevision(incoming.header, current.observation.header)
  if (relation === 'invalid-regression' || relation === 'version-collision') {
    throw new Error(`ConversationMessageRevisionInvariant:${incoming.header.id}:${relation}`)
  }
  if (relation === 'older') return current
  if (relation === 'identical') {
    if (incoming.structuralVersion < current.observation.structuralVersion) return current
    const presentation = incoming.presentation ?? current.observation.presentation
    return Object.freeze({
      observation: Object.freeze({
        header: current.observation.header,
        structuralVersion: Math.max(
          incoming.structuralVersion,
          current.observation.structuralVersion,
        ),
        ...(presentation ? { presentation } : {}),
      }),
      headerSequence: sequence,
      headerSource: source,
      presentationSequence: incoming.presentation ? sequence : current.presentationSequence,
    })
  }
  if (
    incoming.structuralVersion < current.observation.structuralVersion ||
    (relation === 'structural-newer' &&
      incoming.structuralVersion === current.observation.structuralVersion)
  ) {
    throw new Error(`ConversationMessageStructuralVersionInvariant:${incoming.header.id}`)
  }
  const presentation =
    incoming.presentation ??
    (current.observation.presentation?.bodyVersion === incoming.header.bodyVersion
      ? Object.freeze({
          header: incoming.header,
          message: rebaseHydratedMessageHeader(
            current.observation.presentation.message,
            incoming.header,
          ),
          bodyVersion: incoming.header.bodyVersion,
        })
      : undefined)
  return Object.freeze({
    observation: Object.freeze({
      header: incoming.header,
      structuralVersion: incoming.structuralVersion,
      ...(presentation ? { presentation } : {}),
    }),
    headerSequence: sequence,
    headerSource: source,
    presentationSequence: incoming.presentation
      ? sequence
      : presentation
        ? current.presentationSequence
        : null,
  })
}

function pendingInvalidationApplies<Id>(
  scope: PendingConversationInvalidationScope<Id>,
  id: Id,
  exactSequence: number | null,
): boolean {
  const invalidationSequence = Math.max(
    scope.globalSequence ?? -1,
    scope.sequencesById.get(id) ?? -1,
  )
  return (
    invalidationSequence >= 0 && (exactSequence === null || invalidationSequence > exactSequence)
  )
}

function pendingInvalidationResidualScope<Id>(
  scope: PendingConversationInvalidationScope<Id>,
  exactSequence: (id: Id) => number | null,
): ConversationProjectionScope<Id> | undefined {
  if (scope.globalSequence !== null) return true
  const residual: Id[] = []
  for (const id of scope.sequencesById.keys()) {
    if (pendingInvalidationApplies(scope, id, exactSequence(id))) residual.push(id)
  }
  return residual.length > 0 ? Object.freeze(residual) : undefined
}

function reducePendingStructuralTransitions(
  summary: PendingConversationStructuralSummary,
  residualScope: ConversationProjectionScope<MessageId> | undefined,
): ConversationStructuralTransition {
  if (residualScope !== undefined) {
    return Object.freeze({
      kind: 'incomplete',
      toVersion: summary.maxToVersion,
      scope: residualScope,
    })
  }
  if (summary.exactToVersion === null || summary.messageIds.length === 0) {
    return Object.freeze({ kind: 'none' })
  }
  return Object.freeze({
    kind: 'exact-delta',
    toVersion: summary.exactToVersion,
    structuralVersions: summary.structuralVersions,
    messageIds: summary.messageIds,
  })
}

function pendingInvalidationTouchesPath(
  scope: PendingConversationInvalidationScope<MessageId>,
  path: BranchPathDescriptor<MessageHeaderRow>,
  exactSequence: (id: MessageId) => number | null,
): boolean {
  if (scope.globalSequence === null) {
    for (const id of scope.sequencesById.keys()) {
      if (path.has(id) && pendingInvalidationApplies(scope, id, exactSequence(id))) return true
    }
    return false
  }
  for (const id of path.messageIds) {
    if (pendingInvalidationApplies(scope, id, exactSequence(id))) return true
  }
  return false
}

function pendingInvalidatedTranscriptBodyIds(
  transcript: ActiveTranscriptState,
  inspectorMessageId: MessageId | undefined,
  scope: PendingConversationInvalidationScope<MessageId>,
  exactSequence: (id: MessageId) => number | null,
): readonly MessageId[] {
  const invalidated = new Set<MessageId>()
  if (transcript.kind !== 'absent') {
    for (const row of transcriptBodyWindowRows(transcript.window)) {
      if (pendingInvalidationApplies(scope, row.header.id, exactSequence(row.header.id))) {
        invalidated.add(row.header.id)
      }
    }
  }
  if (
    inspectorMessageId &&
    pendingInvalidationApplies(scope, inspectorMessageId, exactSequence(inspectorMessageId))
  ) {
    invalidated.add(inspectorMessageId)
  }
  return Object.freeze([...invalidated])
}

function pendingForkRefreshScope(
  scope: PendingConversationInvalidationScope<MessageId | null>,
  path: BranchPathDescriptor<MessageHeaderRow> | null,
  exactSequence: (id: MessageId | null) => number | null,
): ConversationProjectionScope<MessageId | null> | undefined {
  if (scope.globalSequence === null) {
    const ids = [...scope.sequencesById.keys()].filter((id) =>
      pendingInvalidationApplies(scope, id, exactSequence(id)),
    )
    return ids.length > 0 ? Object.freeze(ids) : undefined
  }
  if (!path) return true
  const ids = new Set<MessageId | null>()
  for (const messageId of path.messageIds) {
    const parentId = path.get(messageId)?.parentId
    if (
      parentId !== undefined &&
      pendingInvalidationApplies(scope, parentId, exactSequence(parentId))
    ) {
      ids.add(parentId)
    }
  }
  return ids.size > 0 ? Object.freeze([...ids]) : undefined
}

function writePersistedSession(
  chatId: ChatId,
  fence: WorkspaceFence,
  session: PersistedConversationSession,
): void {
  const storage = browserSessionStorage()
  if (!storage) return
  const key = persistedSessionKey(chatId)
  try {
    if (
      session.selection.kind === 'default' &&
      session.presentation === 'transcript' &&
      session.pendingRevealTargetId === undefined
    ) {
      storage.removeItem(key)
      return
    }
    storage.setItem(key, JSON.stringify({ version: 8, ...fence, ...session }))
  } catch {
    deletePersistedSession(chatId)
  }
}

function deletePersistedSession(chatId: ChatId): void {
  const storage = browserSessionStorage()
  if (!storage) return
  try {
    storage.removeItem(persistedSessionKey(chatId))
  } catch {
    // Best effort for storage-restricted contexts.
  }
}

function parsePersistedSelection(value: unknown): ActiveBranchSelection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const selection = value as {
    kind?: unknown
    messageId?: unknown
    observedTipId?: unknown
    parentId?: unknown
    position?: unknown
  }
  switch (selection.kind) {
    case 'default':
      return Object.freeze({ kind: 'default' })
    case 'message':
      return typeof selection.messageId === 'string' &&
        (selection.observedTipId === undefined || typeof selection.observedTipId === 'string')
        ? Object.freeze({
            kind: 'message',
            messageId: selection.messageId,
            ...(selection.observedTipId ? { observedTipId: selection.observedTipId } : {}),
          })
        : undefined
    case 'tip':
      return typeof selection.messageId === 'string'
        ? Object.freeze({ kind: 'tip', messageId: selection.messageId })
        : undefined
    case 'sibling-position':
      return (selection.parentId === null || typeof selection.parentId === 'string') &&
        typeof selection.position === 'number' &&
        Number.isInteger(selection.position) &&
        selection.position >= 0 &&
        (selection.observedTipId === undefined || typeof selection.observedTipId === 'string')
        ? Object.freeze({
            kind: 'sibling-position',
            parentId: selection.parentId,
            position: selection.position,
            ...(selection.observedTipId ? { observedTipId: selection.observedTipId } : {}),
          })
        : undefined
    default:
      return undefined
  }
}
