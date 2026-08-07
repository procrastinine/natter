import type { ActiveBranchIntentTarget } from '../core/active-branch-spine'
import type { ChatSettingsPatch } from '../core/chat-metadata'
import {
  failedGenerationCapability,
  type GenerationCapability,
  type GenerationCapabilityOwner,
  pendingGenerationCapability,
} from '../core/interaction-capability'
import type {
  AttachmentRef,
  ChatId,
  ChatSettings,
  ContentItem,
  MessageId,
  PresetId,
} from '../core/types'
import { newId } from '../lib/ulid'
import {
  type AttemptTargetAdmissionClaim,
  type AttemptTargetAdmissionFrame,
  attemptController,
} from './attempt-controller'
import {
  type ActiveGenerationConfigurationResolution,
  configurationController,
} from './configuration-controller'
import { captureConnectionRuntimeKeyPreferenceFromProof } from './connection-runtime'
import {
  type ConversationCommittedEffect,
  type ConversationPromptPathFrame,
  type ConversationRouteDelivery,
  conversationController,
  type PreservingConversationOperationClaim,
  type RouteSelectingConversationOperationClaim,
  type SessionSelectingConversationOperationClaim,
} from './conversation-controller'
import type { ConversationRouteOwner } from './conversation-route-owner'
import {
  type GenerationAdmissionCapabilityProbe,
  type GenerationCapabilityFrame,
  generationCapabilityController,
  generationConfigurationRequirement,
} from './generation-capability-controller'
import type { GenerationPromptMaterialLease } from './generation-prompt-material'
import { withSharedGenerationLifetime } from './locks'
import type { CommittedConversationTransition, WorkspaceFence } from './repository'
import type {
  GenerationPromptPathProof,
  GenerationPromptPathRequirement,
  PrepareAttemptPlacementIntent,
} from './workspace-protocol'
import {
  getWorkspaceRuntimeFence,
  getWorkspaceRuntimeState,
  runWorkspaceActionAtFence,
  subscribeWorkspaceRuntimeState,
  type WorkspaceWritePermit,
} from './workspace-runtime'

interface GenerationIntentBase {
  readonly prefillContent?: readonly ContentItem[]
}

export type GenerationIntent =
  | (GenerationIntentBase & {
      readonly kind: 'new-chat-send'
      readonly title?: string
      readonly content: readonly ContentItem[]
      readonly attachmentRefs?: readonly AttachmentRef[]
    })
  | (GenerationIntentBase & {
      readonly kind: 'send'
      readonly chatId: ChatId
      readonly target: ActiveBranchIntentTarget
      readonly content: readonly ContentItem[]
      readonly attachmentRefs?: readonly AttachmentRef[]
    })
  | (GenerationIntentBase & {
      readonly kind: 'reply'
      readonly chatId: ChatId
      readonly parentUserId: MessageId
    })
  | (GenerationIntentBase & {
      readonly kind: 'regenerate'
      readonly chatId: ChatId
      readonly targetAssistantId: MessageId
      readonly settingsPatch?: ChatSettingsPatch
    })
  | (GenerationIntentBase & {
      readonly kind: 'edit-resend'
      readonly chatId: ChatId
      readonly targetUserId: MessageId
      readonly content: readonly ContentItem[]
      readonly attachmentRefs?: readonly AttachmentRef[]
    })
  | {
      readonly kind: 'continue'
      readonly chatId: ChatId
      readonly targetAssistantId: MessageId
    }

export type NewChatGenerationIntent = Extract<GenerationIntent, { readonly kind: 'new-chat-send' }>
export type ExistingChatGenerationIntent = Exclude<GenerationIntent, NewChatGenerationIntent>

export type GenerationAdmissionRequest =
  | {
      readonly intent: NewChatGenerationIntent
      readonly routeOwner: ConversationRouteOwner
    }
  | {
      readonly intent: ExistingChatGenerationIntent
    }

export type SettlingGenerationAdmissionRequest = GenerationAdmissionRequest

interface GenerationAdmissionClaimBase {
  readonly id: string
  readonly workspace: WorkspaceFence
  readonly streamId: string
  readonly chatId: ChatId
  readonly assistantMessageId: MessageId
  readonly userMessageId?: MessageId
}

export type GenerationAdmissionClaim =
  | (GenerationAdmissionClaimBase & {
      readonly strategy: 'continue'
      readonly steering: PreservingConversationOperationClaim
    })
  | (GenerationAdmissionClaimBase & {
      readonly strategy: 'new-chat-send'
      readonly steering: RouteSelectingConversationOperationClaim
    })
  | (GenerationAdmissionClaimBase & {
      readonly strategy: Exclude<GenerationIntent['kind'], 'continue' | 'new-chat-send'>
      readonly steering: SessionSelectingConversationOperationClaim
    })

export interface GenerationAdmissionPayload {
  readonly configuration:
    | {
        readonly kind: 'new-chat'
        readonly settings: ChatSettings
        readonly presetId: PresetId | null
        readonly preferredDispatchKeyId: string | null
      }
    | {
        readonly kind: 'chat'
        readonly chatId: ChatId
        readonly preferredDispatchKeyId: string | null
        readonly settingsPatch?: ChatSettingsPatch
      }
  readonly promptPath: GenerationPromptPathProof
  readonly promptMaterial: GenerationPromptMaterialLease
  readonly intent: GenerationIntent
  readonly placement: PrepareAttemptPlacementIntent
}

export type {
  GenerationAdmissionCapabilityProbe,
  GenerationCapabilityFrame,
} from './generation-capability-controller'

export type GenerationAdmissionFailureReason =
  | 'workspace-unavailable'
  | 'configuration-unavailable'
  | 'prompt-path-unavailable'
  | 'attempt-target-unavailable'
  | 'claim-not-current'

export class GenerationAdmissionError extends Error {
  readonly reason: GenerationAdmissionFailureReason
  readonly capability: GenerationCapability

  constructor(reason: GenerationAdmissionFailureReason, capability: GenerationCapability) {
    super(`GenerationAdmission:${reason}`)
    this.name = 'GenerationAdmissionError'
    this.reason = reason
    this.capability = capability
  }
}

interface GenerationAdmissionState {
  status: 'claimed' | 'accepted' | 'cancelled' | 'failed'
  payload: GenerationAdmissionPayload | null
  attemptTargetClaim: AttemptTargetAdmissionClaim | null
}

export interface GenerationAdmissionController {
  claim(request: GenerationAdmissionRequest): GenerationAdmissionClaim
  claimWhenCapabilitySettles(
    request: SettlingGenerationAdmissionRequest,
    signal: AbortSignal,
    observer?: GenerationPreparationObserver,
  ): Promise<GenerationAdmissionClaim>
  captureCapabilityFrame(
    attemptAdmission?: AttemptTargetAdmissionFrame | null,
  ): GenerationCapabilityFrame
  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability
  takePayload(claim: GenerationAdmissionClaim): GenerationAdmissionPayload
  execute<T>(
    claim: GenerationAdmissionClaim,
    operation: (permit: WorkspaceWritePermit) => T | PromiseLike<T>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<T>
  acceptPrepared(
    claim: GenerationAdmissionClaim,
    input: {
      readonly selection: CommittedConversationTransition | null
      readonly committedEffect: ConversationCommittedEffect
    },
  ): ConversationRouteDelivery | undefined
  fail(claim: GenerationAdmissionClaim): void
  cancel(claim: GenerationAdmissionClaim): void
}

export type GenerationPreparationPhase =
  | 'workspace-requested'
  | 'workspace-admitted'
  | 'ownership-requested'
  | 'repository-requested'
  | 'local-applied'

export interface GenerationPreparationObserver {
  pending(owner: GenerationCapabilityOwner): void
  phase(phase: GenerationPreparationPhase): void
}

class TabGenerationAdmissionController implements GenerationAdmissionController {
  private readonly states = new WeakMap<GenerationAdmissionClaim, GenerationAdmissionState>()

  claim(request: GenerationAdmissionRequest): GenerationAdmissionClaim {
    return this.claimCaptured(request, snapshotGenerationIntent(request.intent))
  }

  claimWhenCapabilitySettles(
    request: SettlingGenerationAdmissionRequest,
    signal: AbortSignal,
    observer?: GenerationPreparationObserver,
  ): Promise<GenerationAdmissionClaim> {
    const captured = captureSettlingAdmissionRequest(request)
    return this.settleCapturedAdmission(captured, signal, observer)
  }

  private claimCaptured(
    request: GenerationAdmissionRequest,
    capturedIntent: GenerationIntent,
  ): GenerationAdmissionClaim {
    const intent = capturedIntent
    const routeOwner = 'routeOwner' in request ? request.routeOwner : null
    const context = generationCapabilityController.captureContext(
      attemptAdmissionForIntent(capturedIntent),
    )
    if (!context.workspace) {
      throw generationAdmissionErrorFor(context.frame.capability(intent))
    }
    const workspace = context.workspace
    const chatId = capturedIntent.kind === 'new-chat-send' ? newId() : capturedIntent.chatId
    const configuration = captureGenerationConfiguration(
      context.configuration?.resolve(generationConfigurationRequirement(capturedIntent)),
      capturedIntent,
      chatId,
    )
    const capturedPrompt = captureGenerationPromptPath(
      capturedIntent,
      chatId,
      workspace,
      context.promptPath,
    )
    let attemptTargetClaim: AttemptTargetAdmissionClaim | undefined
    try {
      const claimId = newId()
      const streamId = newId()
      const assistantMessageId =
        capturedIntent.kind === 'continue' ? capturedIntent.targetAssistantId : newId()
      const userMessageId =
        capturedIntent.kind === 'new-chat-send' ||
        capturedIntent.kind === 'send' ||
        capturedIntent.kind === 'edit-resend'
          ? newId()
          : undefined
      const placement = prepareGenerationMessagePlacementIntent({
        intent: capturedIntent,
        chatId,
        assistantMessageId,
        userMessageId,
        createdAt: Date.now(),
      })
      const trackedAttemptFrame = context.attemptAdmission
      if (
        capturedIntent.kind === 'continue' &&
        trackedAttemptFrame?.workspaceId === workspace.workspaceId &&
        trackedAttemptFrame.replacementEpoch === workspace.replacementEpoch &&
        trackedAttemptFrame.chatId === chatId
      ) {
        attemptTargetClaim = attemptController.claimTarget(
          workspace,
          chatId,
          assistantMessageId,
          `generation:${claimId}`,
        )
        if (!attemptTargetClaim) {
          throw generationAdmissionErrorFor(pendingGenerationCapability('attempt-target'))
        }
      }
      const base = {
        id: claimId,
        workspace,
        streamId,
        chatId,
        assistantMessageId,
        ...(userMessageId ? { userMessageId } : {}),
      } as const
      const claim: GenerationAdmissionClaim =
        capturedIntent.kind === 'continue'
          ? Object.freeze({
              ...base,
              strategy: capturedIntent.kind,
              steering: conversationController.claimOperation({
                chatId,
                workspaceFence: workspace,
                steering: 'preserve',
              }),
            })
          : capturedIntent.kind === 'new-chat-send'
            ? Object.freeze({
                ...base,
                strategy: 'new-chat-send',
                steering: conversationController.claimOperation({
                  chatId,
                  workspaceFence: workspace,
                  steering: 'select-result',
                  selectionDelivery: 'route-handoff',
                  routeOwner: requireNewChatRouteOwner(routeOwner),
                }),
              })
            : Object.freeze({
                ...base,
                strategy: capturedIntent.kind,
                steering: conversationController.claimOperation({
                  chatId,
                  workspaceFence: workspace,
                  steering: 'select-result',
                  selectionDelivery: 'session',
                }),
              })
      this.states.set(claim, {
        status: 'claimed',
        attemptTargetClaim: attemptTargetClaim ?? null,
        payload: Object.freeze({
          configuration,
          promptPath: capturedPrompt.proof,
          promptMaterial: capturedPrompt.material,
          intent: capturedIntent,
          placement,
        }),
      })
      return claim
    } catch (error) {
      if (attemptTargetClaim) attemptController.releaseTargetClaim(attemptTargetClaim)
      capturedPrompt.material.release()
      throw error
    }
  }

  private async settleCapturedAdmission(
    captured: GenerationAdmissionRequest,
    signal: AbortSignal,
    observer?: GenerationPreparationObserver,
  ): Promise<GenerationAdmissionClaim> {
    let releasePublication: () => void = () => undefined
    const releaseCurrentPublication = () => {
      const release = releasePublication
      releasePublication = () => undefined
      release()
    }
    try {
      for (;;) {
        throwIfGenerationAdmissionAborted(signal)
        const capability = generationCapabilityForSettlingRequest(captured)
        if (capability.state === 'ready') {
          try {
            const claim = this.claimCaptured(captured, captured.intent)
            releaseCurrentPublication()
            return claim
          } catch (error) {
            if (error instanceof GenerationAdmissionError && error.capability.state === 'pending') {
              const pendingOwner = error.capability.owner
              observeGenerationAdmissionPending(observer, pendingOwner)
              releaseCurrentPublication()
              releasePublication = await waitForGenerationAdmissionPublication(
                pendingOwner,
                captured.intent,
                signal,
                () => generationCapabilityForSettlingRequest(captured).state === 'pending',
              )
              continue
            }
            throw error
          }
        }
        if (capability.state !== 'pending') throw generationAdmissionErrorFor(capability)
        observeGenerationAdmissionPending(observer, capability.owner)
        releaseCurrentPublication()
        releasePublication = await waitForGenerationAdmissionPublication(
          capability.owner,
          captured.intent,
          signal,
          () => {
            const currentCapability = generationCapabilityForSettlingRequest(captured)
            return (
              currentCapability.state === 'pending' && currentCapability.owner === capability.owner
            )
          },
        )
      }
    } finally {
      releaseCurrentPublication()
    }
  }

  captureCapabilityFrame(
    attemptAdmission: AttemptTargetAdmissionFrame | null = null,
  ): GenerationCapabilityFrame {
    return generationCapabilityController.captureFrame(attemptAdmission)
  }

  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability {
    return generationCapabilityController
      .captureFrame(probe ? attemptAdmissionForIntent(probe) : null)
      .capability(probe)
  }

  takePayload(claim: GenerationAdmissionClaim): GenerationAdmissionPayload {
    const state = this.assertClaimed(claim)
    const payload = state.payload
    if (!payload) {
      throw new GenerationAdmissionError(
        'claim-not-current',
        failedGenerationCapability('workspace'),
      )
    }
    state.payload = null
    return payload
  }

  execute<T>(
    claim: GenerationAdmissionClaim,
    operation: (permit: WorkspaceWritePermit) => T | PromiseLike<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<T> {
    this.assertClaimed(claim)
    try {
      return withSharedGenerationLifetime(
        () =>
          runWorkspaceActionAtFence('conversation-generation', claim.workspace, operation, {
            ...options,
            lineageId: `generation:${claim.streamId}`,
          }),
        options,
      )
    } catch (error) {
      return Promise.reject(generationAdmissionError(error))
    }
  }

  acceptPrepared(
    claim: GenerationAdmissionClaim,
    input: {
      readonly selection: CommittedConversationTransition | null
      readonly committedEffect: ConversationCommittedEffect
    },
  ): ConversationRouteDelivery | undefined {
    const state = this.assertClaimed(claim)
    if (claim.strategy === 'continue') {
      conversationController.acceptLocalResult(claim.steering, {
        kind: 'preserve',
        revealTargetMessageId: claim.assistantMessageId,
        committedEffect: input.committedEffect,
      })
      state.status = 'accepted'
      state.payload = null
      this.releaseAttemptTarget(state)
      return undefined
    }
    if (!input.selection) throw new Error('GenerationAdmissionSelectionMissing')
    const result = {
      kind: 'select-transition' as const,
      receipt: input.selection,
      revealTargetMessageId: claim.assistantMessageId,
      committedEffect: input.committedEffect,
    }
    const routeDelivery =
      claim.strategy === 'new-chat-send'
        ? (() => {
            const receipt = conversationController.acceptLocalResult(claim.steering, result)
            if (!receipt.accepted) throw new Error('GenerationNewChatSelectionRejected')
            return receipt.routeDelivery
          })()
        : (() => {
            conversationController.acceptLocalResult(claim.steering, result)
            return undefined
          })()
    state.status = 'accepted'
    state.payload = null
    this.releaseAttemptTarget(state)
    return routeDelivery
  }

  fail(claim: GenerationAdmissionClaim): void {
    const state = this.states.get(claim)
    if (state?.status !== 'claimed') return
    state.payload?.promptMaterial.release()
    this.releaseAttemptTarget(state)
    state.status = 'failed'
    state.payload = null
    conversationController.cancelOperation(claim.steering)
  }

  cancel(claim: GenerationAdmissionClaim): void {
    const state = this.states.get(claim)
    if (state?.status !== 'claimed') return
    state.payload?.promptMaterial.release()
    this.releaseAttemptTarget(state)
    state.status = 'cancelled'
    state.payload = null
    conversationController.cancelOperation(claim.steering)
  }

  private assertClaimed(claim: GenerationAdmissionClaim): GenerationAdmissionState {
    const state = this.states.get(claim)
    if (state?.status !== 'claimed') {
      throw new GenerationAdmissionError(
        'claim-not-current',
        failedGenerationCapability('workspace'),
      )
    }
    return state
  }

  private releaseAttemptTarget(state: GenerationAdmissionState): void {
    const claim = state.attemptTargetClaim
    state.attemptTargetClaim = null
    if (claim) attemptController.releaseTargetClaim(claim)
  }
}

function requireNewChatRouteOwner(
  routeOwner: ConversationRouteOwner | null,
): ConversationRouteOwner {
  if (!routeOwner) throw new Error('GenerationAdmissionNewChatRouteOwnerMissing')
  return routeOwner
}

function captureGenerationConfiguration(
  resolution: ActiveGenerationConfigurationResolution | undefined,
  intent: GenerationIntent,
  chatId: ChatId,
): GenerationAdmissionPayload['configuration'] {
  if (intent.kind === 'new-chat-send') {
    if (resolution?.capability !== 'ready' || resolution.kind !== 'new-chat') {
      throw generationAdmissionErrorFor(pendingGenerationCapability('configuration'))
    }
    const preferredDispatchKeyId = captureConnectionRuntimeKeyPreferenceFromProof(
      resolution.claim.profile,
      chatId,
    ).ref
    return Object.freeze({
      kind: 'new-chat' as const,
      settings: resolution.claim.settings,
      presetId: resolution.claim.presetId,
      preferredDispatchKeyId,
    })
  }
  const preferredDispatchKeyId =
    resolution?.capability === 'ready' && resolution.kind === 'chat' && resolution.chatId === chatId
      ? captureConnectionRuntimeKeyPreferenceFromProof(resolution.claim.profile, chatId).ref
      : null
  return Object.freeze({
    kind: 'chat' as const,
    chatId,
    preferredDispatchKeyId,
    ...(intent.kind === 'regenerate' && intent.settingsPatch
      ? { settingsPatch: intent.settingsPatch }
      : {}),
  })
}

function captureGenerationPromptPath(
  intent: GenerationIntent,
  chatId: ChatId,
  workspace: WorkspaceFence,
  frame: ConversationPromptPathFrame | null,
): {
  readonly proof: GenerationPromptPathProof
  readonly material: GenerationPromptMaterialLease
} {
  const requirement = generationPromptPathRequirement(intent)
  if (requirement.surface === 'chat' && frame) {
    const capture = frame.capture(requirement)
    if (capture) {
      return Object.freeze({
        proof: Object.freeze({ requirement, pathHint: capture.pathHint }),
        material: capture.material,
      })
    }
  }
  return Object.freeze({
    proof: Object.freeze({
      requirement,
      pathHint: Object.freeze({
        chatId,
        structuralVersion: 0,
        leafId:
          requirement.target.kind === 'include'
            ? requirement.target.messageId
            : requirement.target.kind === 'fixed'
              ? requirement.target.messageId
              : null,
        headers: Object.freeze([]),
        placementSlot: null,
        targetTurn: null,
      }),
    }),
    material: conversationController.acquirePromptMaterial(workspace, chatId, []),
  })
}

function prepareGenerationMessagePlacementIntent(input: {
  readonly intent: GenerationIntent
  readonly chatId: ChatId
  readonly assistantMessageId: MessageId
  readonly userMessageId: MessageId | undefined
  readonly createdAt: number
}): PrepareAttemptPlacementIntent {
  const contentIntent =
    input.intent.kind === 'new-chat-send' ||
    input.intent.kind === 'send' ||
    input.intent.kind === 'edit-resend'
      ? input.intent
      : null
  return Object.freeze({
    chatId: input.chatId,
    createdAt: input.createdAt,
    assistantMessageId: input.assistantMessageId,
    ...(input.userMessageId && contentIntent
      ? {
          user: Object.freeze({
            messageId: input.userMessageId,
            content: cloneFrozenGenerationPayload([...contentIntent.content]),
            attachmentRefs: cloneFrozenGenerationPayload([...(contentIntent.attachmentRefs ?? [])]),
          }),
        }
      : {}),
    prefillContent: cloneFrozenGenerationPayload([
      ...('prefillContent' in input.intent ? (input.intent.prefillContent ?? []) : []),
    ]),
  })
}

function generationAdmissionErrorFor(capability: GenerationCapability): GenerationAdmissionError {
  if (capability.state === 'pending') {
    return new GenerationAdmissionError(
      capability.owner === 'workspace'
        ? 'workspace-unavailable'
        : capability.owner === 'configuration'
          ? 'configuration-unavailable'
          : capability.owner === 'attempt-target'
            ? 'attempt-target-unavailable'
            : 'prompt-path-unavailable',
      capability,
    )
  }
  if (capability.state === 'unavailable') {
    return new GenerationAdmissionError(
      capability.reason === 'target-unavailable'
        ? 'prompt-path-unavailable'
        : 'configuration-unavailable',
      capability,
    )
  }
  if (capability.state === 'failed') {
    return new GenerationAdmissionError(
      capability.owner === 'workspace'
        ? 'workspace-unavailable'
        : capability.owner === 'configuration'
          ? 'configuration-unavailable'
          : capability.owner === 'attempt-target'
            ? 'attempt-target-unavailable'
            : 'prompt-path-unavailable',
      capability,
    )
  }
  return new GenerationAdmissionError('claim-not-current', failedGenerationCapability('workspace'))
}

export function generationPromptPathRequirement(
  probe: GenerationAdmissionCapabilityProbe,
): GenerationPromptPathRequirement {
  switch (probe.kind) {
    case 'new-chat-send':
      return Object.freeze({
        kind: 'new-chat-send',
        surface: 'new-chat',
        target: Object.freeze({ kind: 'root' }),
        childSlot: 'empty',
      })
    case 'send':
      return Object.freeze({
        kind: 'send',
        surface: 'chat',
        chatId: probe.chatId,
        target: Object.freeze(probe.target),
        childSlot: 'append',
      })
    case 'reply':
      return Object.freeze({
        kind: 'reply',
        surface: 'chat',
        chatId: probe.chatId,
        target: Object.freeze({
          kind: 'include',
          messageId: probe.parentUserId,
          role: 'user',
        }),
        childSlot: 'append',
      })
    case 'regenerate':
      return Object.freeze({
        kind: 'regenerate',
        surface: 'chat',
        chatId: probe.chatId,
        target: Object.freeze({
          kind: 'exclude',
          messageId: probe.targetAssistantId,
          role: 'assistant',
        }),
        childSlot: 'append',
      })
    case 'edit-resend':
      return Object.freeze({
        kind: 'edit-resend',
        surface: 'chat',
        chatId: probe.chatId,
        target: Object.freeze({
          kind: 'exclude',
          messageId: probe.targetUserId,
          role: 'user',
        }),
        childSlot: 'append',
      })
    case 'continue':
      return Object.freeze({
        kind: 'continue',
        surface: 'chat',
        chatId: probe.chatId,
        target: Object.freeze({
          kind: 'include',
          messageId: probe.targetAssistantId,
          role: 'assistant',
        }),
        childSlot: 'none',
      })
  }
}

function snapshotGenerationIntent(intent: GenerationIntent): GenerationIntent {
  const prefill =
    intent.kind !== 'continue' && intent.prefillContent !== undefined
      ? { prefillContent: cloneFrozenGenerationPayload([...intent.prefillContent]) }
      : {}
  switch (intent.kind) {
    case 'new-chat-send':
      return Object.freeze({
        ...intent,
        ...prefill,
        content: cloneFrozenGenerationPayload([...intent.content]),
        ...(intent.attachmentRefs !== undefined
          ? { attachmentRefs: cloneFrozenGenerationPayload([...intent.attachmentRefs]) }
          : {}),
      })
    case 'send':
    case 'edit-resend':
      return Object.freeze({
        ...intent,
        ...prefill,
        content: cloneFrozenGenerationPayload([...intent.content]),
        ...(intent.attachmentRefs !== undefined
          ? { attachmentRefs: cloneFrozenGenerationPayload([...intent.attachmentRefs]) }
          : {}),
      })
    case 'regenerate':
      return Object.freeze({
        ...intent,
        ...prefill,
        ...(intent.settingsPatch !== undefined
          ? { settingsPatch: cloneFrozenGenerationPayload(intent.settingsPatch) }
          : {}),
      })
    case 'reply':
      return Object.freeze({ ...intent, ...prefill })
    case 'continue':
      return Object.freeze({ ...intent })
  }
}

function captureSettlingAdmissionRequest(
  request: SettlingGenerationAdmissionRequest,
): GenerationAdmissionRequest {
  return Object.freeze({
    ...request,
    intent: snapshotGenerationIntent(request.intent),
  }) as GenerationAdmissionRequest
}

function generationCapabilityForSettlingRequest(
  request: GenerationAdmissionRequest,
): GenerationCapability {
  return generationCapabilityController
    .captureContext(attemptAdmissionForIntent(request.intent))
    .frame.capability(request.intent)
}

function attemptAdmissionForIntent(
  intent: GenerationAdmissionCapabilityProbe,
): AttemptTargetAdmissionFrame | null {
  return intent.kind === 'continue'
    ? attemptController.getTargetAdmissionFrame(intent.chatId)
    : null
}

async function waitForGenerationAdmissionPublication(
  owner: GenerationCapabilityOwner,
  probe: GenerationAdmissionCapabilityProbe | ChatId,
  signal: AbortSignal,
  blocked: () => boolean = () => true,
): Promise<() => void> {
  throwIfGenerationAdmissionAborted(signal)
  return new Promise<() => void>((resolve, reject) => {
    let unsubscribe = () => undefined
    let unsubscribed = false
    let settled = false
    let armed = false
    let observed: unknown
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error === undefined) resolve(unsubscribe)
      else {
        unsubscribe()
        reject(generationAdmissionError(error))
      }
    }
    const onAbort = () => finish(generationAdmissionAbortReason(signal))
    const inspect = () => {
      if (settled) return
      if (signal.aborted) {
        onAbort()
        return
      }
      if (!blocked()) {
        finish()
        return
      }
      const currentIdentity = generationAdmissionPublicationIdentity(owner, probe)
      if (!armed) {
        armed = true
        observed = currentIdentity
        return
      }
      if (currentIdentity !== observed) finish()
    }
    const unsubscribeCapability = subscribeGenerationAdmissionPublication(owner, probe, inspect)
    unsubscribe = () => {
      if (unsubscribed) return
      unsubscribed = true
      unsubscribeCapability()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      inspect()
    } catch (error) {
      finish(error)
    }
  })
}

function observeGenerationAdmissionPending(
  observer: GenerationPreparationObserver | undefined,
  owner: GenerationCapabilityOwner,
): void {
  try {
    observer?.pending(owner)
  } catch {
    // Diagnostics cannot participate in admission.
  }
}

function subscribeGenerationAdmissionPublication(
  owner: GenerationCapabilityOwner,
  probe: GenerationAdmissionCapabilityProbe | ChatId,
  listener: () => void,
): () => void {
  switch (owner) {
    case 'workspace':
      return subscribeWorkspaceRuntimeState(listener)
    case 'configuration':
      return configurationController.subscribe(listener)
    case 'prompt-path':
      return conversationController.subscribe(listener)
    case 'attempt-target':
      return typeof probe === 'string' || probe.kind === 'new-chat-send'
        ? () => undefined
        : attemptController.subscribeChat(probe.chatId, listener)
  }
}

function generationAdmissionPublicationIdentity(
  owner: GenerationCapabilityOwner,
  probe: GenerationAdmissionCapabilityProbe | ChatId,
): unknown {
  switch (owner) {
    case 'workspace': {
      const fence = getWorkspaceRuntimeFence()
      return `${getWorkspaceRuntimeState()}:${fence?.workspaceId ?? ''}:${fence?.replacementEpoch ?? ''}`
    }
    case 'configuration':
      return configurationController.getSnapshot().frame.generation
    case 'prompt-path': {
      if (typeof probe === 'string') return conversationController.getSnapshot()
      const fence = getWorkspaceRuntimeFence()
      return fence ? conversationController.capturePromptPathFrame(fence) : null
    }
    case 'attempt-target':
      return typeof probe === 'string' || probe.kind === 'new-chat-send'
        ? null
        : attemptController.getTargetAdmissionFrame(probe.chatId)
  }
}

function throwIfGenerationAdmissionAborted(signal: AbortSignal): void {
  if (signal.aborted) throw generationAdmissionAbortReason(signal)
}

function generationAdmissionAbortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  if (reason && typeof reason === 'object') {
    const record = reason as Record<string, unknown>
    if (typeof record.name === 'string' && typeof record.message === 'string') {
      const error = new Error(record.message, { cause: reason })
      error.name = record.name
      return error
    }
  }
  return new DOMException('The operation was aborted.', 'AbortError')
}

function generationAdmissionError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('GenerationAdmissionFailed', { cause: reason })
}

function cloneFrozenGenerationPayload<T>(value: T): T {
  return freezeGenerationPayload(structuredClone(value))
}

function freezeGenerationPayload<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value
  for (const child of Object.values(value)) freezeGenerationPayload(child)
  return Object.freeze(value)
}

export const generationAdmissionController: GenerationAdmissionController =
  new TabGenerationAdmissionController()
