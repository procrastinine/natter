import type { ChatSettingsPatch } from '../core/chat-metadata'
import {
  failedGenerationCapability,
  type GenerationCapability,
  type GenerationCapabilityOwner,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../core/interaction-capability'
import type { PreparedMessagePlacementFrame } from '../core/messages'
import { UNKNOWN_INBOUND_REASONING_VISIBILITY } from '../core/reasoning'
import type { AttachmentRef, ChatId, ContentItem, Message, MessageId } from '../core/types'
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
  type ClaimedConversationDestination,
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
  attemptAdmissionFrameForProbe,
  type GenerationAdmissionCapabilityProbe,
  type GenerationCapabilityFrame,
  generationAttemptTargetCapability,
  generationCapabilityController,
  generationConfigurationCapability,
  generationConfigurationRequirement,
  type SelectedSendAdmissionClaim,
} from './generation-capability-controller'
import {
  createGenerationPromptMaterialLease,
  type GenerationPromptMaterialLease,
} from './generation-prompt-material'
import { withSharedGenerationLifetime } from './locks'
import type { CommittedConversationTransition, WorkspaceFence } from './repository'
import type {
  GenerationPromptPathProof,
  GenerationPromptPathRequirement,
  PrepareAttemptConfigurationClaim,
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
      readonly expectedLeafId: MessageId | null
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

export interface SelectedSendGenerationIntent extends GenerationIntentBase {
  readonly kind: 'selected-send'
  readonly chatId: ChatId
  readonly content: readonly ContentItem[]
  readonly attachmentRefs?: readonly AttachmentRef[]
}

export type GenerationAdmissionRequest =
  | {
      readonly intent: NewChatGenerationIntent
      readonly routeOwner: ConversationRouteOwner
    }
  | {
      readonly intent: ExistingChatGenerationIntent
      readonly steering?: SessionSelectingConversationOperationClaim
      readonly selectedAdmission?: SelectedSendAdmissionClaim
      readonly selectedPromptPath?: ConversationPromptPathFrame
    }

export type SettlingGenerationAdmissionRequest =
  | GenerationAdmissionRequest
  | {
      readonly intent: SelectedSendGenerationIntent
      readonly admission?: SelectedSendAdmissionClaim
    }

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
    | (PrepareAttemptConfigurationClaim & {
        readonly kind: 'new-chat'
      })
    | (PrepareAttemptConfigurationClaim & {
        readonly kind: 'chat'
        readonly chatId: ChatId
        readonly configurationVersion: number
        readonly configurationLinkTransition: {
          readonly expectedResourceNames: readonly string[]
          readonly nextResourceNames: readonly string[]
        }
      })
  readonly promptPath: GenerationPromptPathProof
  readonly promptMaterial: GenerationPromptMaterialLease
  readonly intent: GenerationIntent
  readonly placement: PreparedMessagePlacementFrame
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
  targetClaim: AttemptTargetAdmissionClaim | null
}

export interface GenerationAdmissionController {
  claim(request: GenerationAdmissionRequest): GenerationAdmissionClaim
  claimWhenCapabilitySettles(
    request: SettlingGenerationAdmissionRequest,
    signal: AbortSignal,
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

class TabGenerationAdmissionController implements GenerationAdmissionController {
  private readonly states = new WeakMap<GenerationAdmissionClaim, GenerationAdmissionState>()
  private readonly adoptedSteeringClaims = new WeakSet<SessionSelectingConversationOperationClaim>()

  claim(request: GenerationAdmissionRequest): GenerationAdmissionClaim {
    return this.claimCaptured(request, snapshotGenerationIntent(request.intent))
  }

  claimWhenCapabilitySettles(
    request: SettlingGenerationAdmissionRequest,
    signal: AbortSignal,
  ): Promise<GenerationAdmissionClaim> {
    const captured = captureSettlingAdmissionRequest(request)
    return this.settleCapturedAdmission(captured, signal)
  }

  private claimCaptured(
    request: GenerationAdmissionRequest,
    capturedIntent: GenerationIntent,
  ): GenerationAdmissionClaim {
    const intent = capturedIntent
    const routeOwner = 'routeOwner' in request ? request.routeOwner : null
    const suppliedSteering = 'steering' in request ? (request.steering ?? null) : null
    const selectedAdmission =
      'selectedAdmission' in request ? (request.selectedAdmission ?? null) : null
    const selectedPromptPath =
      'selectedPromptPath' in request ? request.selectedPromptPath : undefined
    const selectedConfigurationResolution = selectedAdmission
      ? configurationController.resolveSelectedGenerationConfiguration(
          selectedAdmission.configuration,
        )
      : undefined
    const context = generationCapabilityController.captureContext(
      attemptAdmissionFrameForProbe(intent),
      selectedPromptPath,
      selectedConfigurationResolution,
    )
    if (!context.workspace || !context.configuration || !context.promptPath) {
      throw generationAdmissionErrorFor(context.frame.capability(intent))
    }
    const workspace = context.workspace
    const configurationResolution =
      selectedConfigurationResolution ??
      context.configuration.resolve(generationConfigurationRequirement(capturedIntent))
    if (configurationResolution.capability !== 'ready') {
      throw generationAdmissionErrorFor(generationConfigurationCapability(configurationResolution))
    }
    const chatId = capturedIntent.kind === 'new-chat-send' ? newId() : capturedIntent.chatId
    const configuration = captureGenerationConfiguration(
      configurationResolution,
      capturedIntent,
      chatId,
    )
    const attemptCapability = generationAttemptTargetCapability(
      capturedIntent,
      workspace,
      context.attemptAdmission,
    )
    if (attemptCapability.state !== 'ready') {
      throw generationAdmissionErrorFor(attemptCapability)
    }
    if (suppliedSteering) {
      assertSelectedSendSteering(suppliedSteering, capturedIntent, workspace, selectedAdmission)
      if (this.adoptedSteeringClaims.has(suppliedSteering)) {
        throw new Error('GenerationAdmissionSteeringAlreadyAdopted')
      }
    }
    const capturedPrompt = captureGenerationPromptPath(
      capturedIntent,
      chatId,
      workspace,
      context.promptPath,
    )
    let targetClaim: AttemptTargetAdmissionClaim | null = null
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
      const placement = prepareGenerationMessagePlacementFrame({
        intent: capturedIntent,
        chatId,
        assistantMessageId,
        userMessageId,
        model: configuration.settings.model,
        promptPath: capturedPrompt.proof,
        createdAt: Date.now(),
      })
      if (capturedIntent.kind === 'continue') {
        const claimedTarget = attemptController.claimTarget(
          workspace,
          chatId,
          assistantMessageId,
          claimId,
        )
        if (!claimedTarget) {
          throw generationAdmissionErrorFor(pendingGenerationCapability('attempt-target'))
        }
        targetClaim = claimedTarget
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
                  routeOwner: routeOwner!,
                }),
              })
            : Object.freeze({
                ...base,
                strategy: capturedIntent.kind,
                steering:
                  suppliedSteering ??
                  conversationController.claimOperation({
                    chatId,
                    workspaceFence: workspace,
                    steering: 'select-result',
                    selectionDelivery: 'session',
                  }),
              })
      if (suppliedSteering) this.adoptedSteeringClaims.add(suppliedSteering)
      this.states.set(claim, {
        status: 'claimed',
        payload: Object.freeze({
          configuration,
          promptPath: capturedPrompt.proof,
          promptMaterial: capturedPrompt.material,
          intent: capturedIntent,
          placement,
        }),
        targetClaim,
      })
      if (
        claim.strategy !== 'continue' &&
        claim.strategy !== 'new-chat-send' &&
        capturedIntent.kind !== 'continue' &&
        capturedIntent.kind !== 'new-chat-send'
      ) {
        const messages = placement.messages
        const destination = conversationController.resolveOperationDestination(claim.steering)
        if (messages.length > 0 && destination.kind === 'ready') {
          conversationController.presentGenerationIntent(claim.steering, {
            baseLeafId: destination.expectedLeafId,
            messages,
            ...(capturedIntent.kind === 'regenerate'
              ? { replacesFromMessageId: capturedIntent.targetAssistantId }
              : capturedIntent.kind === 'edit-resend'
                ? { replacesFromMessageId: capturedIntent.targetUserId }
                : {}),
          })
        }
      }
      if (selectedAdmission) {
        configurationController.cancelSelectedGenerationConfiguration(
          selectedAdmission.configuration,
        )
      }
      return claim
    } catch (error) {
      if (targetClaim) attemptController.releaseTargetClaim(targetClaim)
      capturedPrompt.material.release()
      throw error
    }
  }

  private async settleCapturedAdmission(
    captured: CapturedSettlingAdmissionRequest,
    signal: AbortSignal,
  ): Promise<GenerationAdmissionClaim> {
    let steeringTransferred = false
    let releasePublication: () => void = () => undefined
    const releaseCurrentPublication = () => {
      const release = releasePublication
      releasePublication = () => undefined
      release()
    }
    const selectedSteering =
      captured.kind === 'selected-send' ? captured.admission.destination.steering : undefined
    try {
      for (;;) {
        throwIfGenerationAdmissionAborted(signal)
        const ready = resolveCapturedSettlingAdmission(captured)
        if (ready.kind === 'pending-selection') {
          releaseCurrentPublication()
          releasePublication = await waitForGenerationAdmissionPublication(
            'prompt-path',
            ready.chatId,
            signal,
            selectedSteering,
            () => resolveCapturedSettlingAdmission(captured).kind === 'pending-selection',
          )
          continue
        }
        if (ready.kind === 'terminal-selection') {
          throw generationAdmissionErrorFor(ready.capability)
        }
        const capability = generationCapabilityForSettlingRequest(ready.request)
        if (capability.state === 'ready') {
          try {
            const claim = this.claimCaptured(ready.request, ready.request.intent)
            steeringTransferred = true
            releaseCurrentPublication()
            return claim
          } catch (error) {
            if (error instanceof GenerationAdmissionError && error.capability.state === 'pending') {
              const pendingOwner = error.capability.owner
              releaseCurrentPublication()
              releasePublication = await waitForGenerationAdmissionPublication(
                pendingOwner,
                ready.request.intent,
                signal,
                selectedSteering,
                () => {
                  const current = resolveCapturedSettlingAdmission(captured)
                  if (current.kind !== 'ready') return false
                  const currentCapability = generationCapabilityForSettlingRequest(current.request)
                  return (
                    currentCapability.state === 'pending' &&
                    currentCapability.owner === pendingOwner
                  )
                },
              )
              continue
            }
            throw error
          }
        }
        if (capability.state !== 'pending') throw generationAdmissionErrorFor(capability)
        releaseCurrentPublication()
        releasePublication = await waitForGenerationAdmissionPublication(
          capability.owner,
          ready.request.intent,
          signal,
          selectedSteering,
          () => {
            const current = resolveCapturedSettlingAdmission(captured)
            if (current.kind !== 'ready') return false
            const currentCapability = generationCapabilityForSettlingRequest(current.request)
            return (
              currentCapability.state === 'pending' && currentCapability.owner === capability.owner
            )
          },
        )
      }
    } finally {
      releaseCurrentPublication()
      if (!steeringTransferred && captured.kind === 'selected-send') {
        generationCapabilityController.cancelSelectedSend(captured.admission)
      }
    }
  }

  captureCapabilityFrame(
    attemptAdmission: AttemptTargetAdmissionFrame | null = null,
  ): GenerationCapabilityFrame {
    return generationCapabilityController.captureFrame(attemptAdmission)
  }

  capability(probe: GenerationAdmissionCapabilityProbe | null): GenerationCapability {
    return generationCapabilityController.capability(probe)
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
      releaseAdmissionTargetClaim(state)
      state.status = 'accepted'
      state.payload = null
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
    releaseAdmissionTargetClaim(state)
    state.status = 'accepted'
    state.payload = null
    return routeDelivery
  }

  fail(claim: GenerationAdmissionClaim): void {
    const state = this.states.get(claim)
    if (state?.status !== 'claimed') return
    releaseAdmissionTargetClaim(state)
    state.payload?.promptMaterial.release()
    state.status = 'failed'
    state.payload = null
    conversationController.cancelOperation(claim.steering)
  }

  cancel(claim: GenerationAdmissionClaim): void {
    const state = this.states.get(claim)
    if (state?.status !== 'claimed') return
    releaseAdmissionTargetClaim(state)
    state.payload?.promptMaterial.release()
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
}

type ReadyActiveGenerationConfigurationResolution = Extract<
  ActiveGenerationConfigurationResolution,
  { readonly capability: 'ready' }
>

function captureGenerationConfiguration(
  resolution: ReadyActiveGenerationConfigurationResolution,
  intent: GenerationIntent,
  chatId: ChatId,
): GenerationAdmissionPayload['configuration'] {
  const preferredDispatchKeyId = captureConnectionRuntimeKeyPreferenceFromProof(
    resolution.claim.profile,
    chatId,
  ).ref
  const claim = Object.freeze({
    ...resolution.claim,
    preferredDispatchKeyId,
  }) satisfies PrepareAttemptConfigurationClaim
  if (intent.kind === 'new-chat-send') {
    if (resolution.kind !== 'new-chat') {
      throw generationAdmissionErrorFor(pendingGenerationCapability('configuration'))
    }
    return Object.freeze({ kind: 'new-chat' as const, ...claim })
  }
  if (resolution.kind !== 'chat' || resolution.chatId !== chatId) {
    throw generationAdmissionErrorFor(pendingGenerationCapability('configuration'))
  }
  return Object.freeze({
    kind: 'chat' as const,
    chatId,
    configurationVersion: resolution.configurationVersion,
    configurationLinkTransition: resolution.configurationLinkTransition,
    ...claim,
  })
}

function captureGenerationPromptPath(
  intent: GenerationIntent,
  chatId: ChatId,
  workspace: WorkspaceFence,
  frame: ConversationPromptPathFrame,
): {
  readonly proof: GenerationPromptPathProof
  readonly material: GenerationPromptMaterialLease
} {
  const requirement = generationPromptPathRequirement(intent)
  if (requirement.surface === 'new-chat') {
    return Object.freeze({
      proof: Object.freeze({
        requirement,
        claim: Object.freeze({
          chatId,
          structuralVersion: 0,
          leafId: null,
          headers: Object.freeze([]),
          placementSlot: Object.freeze({
            parentId: null,
            slotVersion: 0,
            liveCount: 0,
            nextSiblingIndex: 0,
          }),
          targetTurn: null,
        }),
      }),
      material: createGenerationPromptMaterialLease(workspace, chatId, []),
    })
  }
  const capture = frame.capture(requirement)
  if (!capture) {
    const capability = frame.capability(intent)
    throw generationAdmissionErrorFor(
      capability === 'error'
        ? failedGenerationCapability('prompt-path')
        : capability === 'unavailable'
          ? unavailableGenerationCapability('target-unavailable')
          : pendingGenerationCapability('prompt-path'),
    )
  }
  return Object.freeze({
    proof: Object.freeze({ requirement, claim: capture.claim }),
    material: capture.material,
  })
}

function releaseAdmissionTargetClaim(state: GenerationAdmissionState): void {
  if (!state.targetClaim) return
  attemptController.releaseTargetClaim(state.targetClaim)
  state.targetClaim = null
}

function prepareGenerationMessagePlacementFrame(input: {
  readonly intent: GenerationIntent
  readonly chatId: ChatId
  readonly assistantMessageId: MessageId
  readonly userMessageId: MessageId | undefined
  readonly model: string
  readonly createdAt: number
  readonly promptPath: GenerationPromptPathProof
}): PreparedMessagePlacementFrame {
  const { claim } = input.promptPath
  if (input.intent.kind === 'continue') {
    return Object.freeze({
      chatId: input.chatId,
      structuralVersion: claim.structuralVersion,
      createdAt: input.createdAt,
      slot: null,
      messages: Object.freeze([]),
    })
  }
  if (!input.model) throw new Error(`GenerationModelNotSelected:${input.chatId}`)
  const slot = claim.placementSlot
  if (!slot) throw new Error(`GenerationPlacementSlotMissing:${input.chatId}`)
  const turnId = input.intent.kind === 'reply' ? claim.targetTurn?.turnId : newId()
  if (!turnId) throw new Error(`GenerationPlacementTargetTurnMissing:${input.chatId}`)
  const user =
    input.userMessageId === undefined
      ? undefined
      : Object.freeze({
          id: input.userMessageId,
          chatId: input.chatId,
          parentId: claim.leafId,
          siblingIndex: slot.nextSiblingIndex,
          turnId,
          turnIndex: 0,
          createdAt: input.createdAt,
          role: 'user' as const,
          origin: 'user' as const,
          content: structuredClone(
            input.intent.kind === 'new-chat-send' ||
              input.intent.kind === 'send' ||
              input.intent.kind === 'edit-resend'
              ? [...input.intent.content]
              : [],
          ),
          ...(input.intent.kind === 'new-chat-send' ||
          input.intent.kind === 'send' ||
          input.intent.kind === 'edit-resend'
            ? input.intent.attachmentRefs
              ? { attachmentRefs: structuredClone([...input.intent.attachmentRefs]) }
              : { attachmentRefs: [] }
            : {}),
          nodeVersion: 0,
          deleted: false,
        } satisfies Message)
  const assistant = Object.freeze({
    id: input.assistantMessageId,
    chatId: input.chatId,
    parentId: user?.id ?? claim.leafId,
    siblingIndex: user ? 0 : slot.nextSiblingIndex,
    turnId,
    turnIndex:
      user !== undefined
        ? 1
        : input.intent.kind === 'reply'
          ? (claim.targetTurn?.turnIndex ?? -1) + 1
          : 0,
    createdAt: input.createdAt,
    role: 'assistant' as const,
    origin: 'generated' as const,
    content: structuredClone([...(input.intent.prefillContent ?? [])]),
    attachmentRefs: [],
    generation: {
      model: input.model,
      requestedModel: input.model,
      status: 'preparing' as const,
      integrity: 'clean' as const,
      costSource: 'stream' as const,
      startedAt: input.createdAt,
      reasoningCarryForward: 'none' as const,
      reasoningVisibility: UNKNOWN_INBOUND_REASONING_VISIBILITY,
    },
    nodeVersion: 0,
    deleted: false,
  } satisfies Message)
  return Object.freeze({
    chatId: input.chatId,
    structuralVersion: claim.structuralVersion,
    createdAt: input.createdAt,
    slot: Object.freeze({ ...slot }),
    messages: Object.freeze([...(user ? [user] : []), assistant]),
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
        target:
          probe.expectedLeafId === null
            ? Object.freeze({ kind: 'root' as const })
            : Object.freeze({
                kind: 'include' as const,
                messageId: probe.expectedLeafId,
                role: 'any' as const,
              }),
        childSlot: 'empty',
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
        childSlot: 'empty',
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

type CapturedSettlingAdmissionRequest =
  | {
      readonly kind: 'admission'
      readonly request: GenerationAdmissionRequest
    }
  | {
      readonly kind: 'selected-send'
      readonly intent: SelectedSendGenerationIntent
      readonly admission: SelectedSendAdmissionClaim
    }

type ResolvedSettlingAdmission =
  | { readonly kind: 'pending-selection'; readonly chatId: ChatId }
  | { readonly kind: 'terminal-selection'; readonly capability: GenerationCapability }
  | { readonly kind: 'ready'; readonly request: GenerationAdmissionRequest }

function captureSettlingAdmissionRequest(
  request: SettlingGenerationAdmissionRequest,
): CapturedSettlingAdmissionRequest {
  if (request.intent.kind !== 'selected-send') {
    return Object.freeze({
      kind: 'admission',
      request: Object.freeze({
        ...request,
        intent: snapshotGenerationIntent(request.intent),
      }) as GenerationAdmissionRequest,
    })
  }
  const intent = snapshotSelectedSendGenerationIntent(request.intent)
  const admission =
    ('admission' in request ? request.admission : undefined) ??
    generationCapabilityController.claimSelectedSend(intent.chatId)
  if (admission.destination.steering.chatId !== intent.chatId) {
    throw new Error('GenerationAdmissionSelectedDestinationMismatch')
  }
  return Object.freeze({ kind: 'selected-send', intent, admission })
}

function resolveCapturedSettlingAdmission(
  captured: CapturedSettlingAdmissionRequest,
): ResolvedSettlingAdmission {
  if (captured.kind === 'admission') {
    return Object.freeze({ kind: 'ready', request: captured.request })
  }
  const destination = conversationController.resolveSelectedPromptPath(
    captured.admission.destination,
  )
  switch (destination.kind) {
    case 'pending':
      return Object.freeze({ kind: 'pending-selection', chatId: captured.intent.chatId })
    case 'ready':
      return Object.freeze({
        kind: 'ready',
        request: Object.freeze({
          intent: Object.freeze({
            ...captured.intent,
            kind: 'send' as const,
            expectedLeafId: destination.expectedLeafId,
          }),
          steering: captured.admission.destination.steering,
          selectedAdmission: captured.admission,
          selectedPromptPath: destination.promptPath,
        }),
      })
    case 'unavailable':
    case 'superseded':
      return Object.freeze({
        kind: 'terminal-selection',
        capability: unavailableGenerationCapability('target-unavailable'),
      })
    case 'failed':
      return Object.freeze({
        kind: 'terminal-selection',
        capability: failedGenerationCapability('prompt-path'),
      })
  }
}

function snapshotSelectedSendGenerationIntent(
  intent: SelectedSendGenerationIntent,
): SelectedSendGenerationIntent {
  return Object.freeze({
    ...intent,
    content: cloneFrozenGenerationPayload([...intent.content]),
    ...(intent.prefillContent !== undefined
      ? { prefillContent: cloneFrozenGenerationPayload([...intent.prefillContent]) }
      : {}),
    ...(intent.attachmentRefs !== undefined
      ? { attachmentRefs: cloneFrozenGenerationPayload([...intent.attachmentRefs]) }
      : {}),
  })
}

function assertSelectedSendSteering(
  steering: SessionSelectingConversationOperationClaim,
  intent: GenerationIntent,
  workspace: WorkspaceFence,
  selectedAdmission: SelectedSendAdmissionClaim | null,
): void {
  if (
    intent.kind !== 'send' ||
    steering.chatId !== intent.chatId ||
    steering.workspaceId !== workspace.workspaceId ||
    steering.workspaceEpoch !== workspace.replacementEpoch
  ) {
    throw new Error('GenerationAdmissionSteeringMismatch')
  }
  if (selectedAdmission && selectedAdmission.destination.steering !== steering) {
    throw new Error('GenerationAdmissionSelectedDestinationSteeringMismatch')
  }
  const destination = selectedAdmission
    ? conversationController.resolveSelectedDestination(selectedAdmission.destination)
    : conversationController.resolveOperationDestination(steering)
  if (destination.kind !== 'ready' || destination.expectedLeafId !== intent.expectedLeafId) {
    throw generationAdmissionErrorFor(
      destination.kind === 'failed'
        ? failedGenerationCapability('prompt-path')
        : destination.kind === 'unavailable' || destination.kind === 'superseded'
          ? unavailableGenerationCapability('target-unavailable')
          : pendingGenerationCapability('prompt-path'),
    )
  }
}

function generationCapabilityForSettlingRequest(
  request: GenerationAdmissionRequest,
): GenerationCapability {
  const selectedPromptPath =
    'selectedPromptPath' in request ? request.selectedPromptPath : undefined
  const selectedAdmission =
    'selectedAdmission' in request ? (request.selectedAdmission ?? null) : null
  const selectedConfigurationResolution = selectedAdmission
    ? configurationController.resolveSelectedGenerationConfiguration(
        selectedAdmission.configuration,
      )
    : undefined
  return generationCapabilityController
    .captureContext(
      attemptAdmissionFrameForProbe(request.intent),
      selectedPromptPath,
      selectedConfigurationResolution,
    )
    .frame.capability(request.intent)
}

async function waitForGenerationAdmissionPublication(
  owner: GenerationCapabilityOwner,
  probe: GenerationAdmissionCapabilityProbe | ChatId,
  signal: AbortSignal,
  steering?: SessionSelectingConversationOperationClaim,
  blocked: () => boolean = () => true,
): Promise<() => void> {
  throwIfGenerationAdmissionAborted(signal)
  return new Promise<() => void>((resolve, reject) => {
    let unsubscribe = () => undefined
    let unsubscribed = false
    let settled = false
    let armed = false
    let observed: unknown
    let observedDestination: ClaimedConversationDestination | null = null
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
      const currentDestination = steering
        ? conversationController.resolveOperationDestination(steering)
        : null
      if (!armed) {
        armed = true
        observed = currentIdentity
        observedDestination = currentDestination
        return
      }
      if (
        currentIdentity !== observed ||
        (steering &&
          !sameClaimedConversationDestination(
            currentDestination as ClaimedConversationDestination,
            observedDestination as ClaimedConversationDestination,
          ))
      ) {
        finish()
      }
    }
    const unsubscribeCapability = subscribeGenerationAdmissionPublication(owner, probe, inspect)
    const unsubscribeSteering =
      steering && owner !== 'prompt-path'
        ? conversationController.subscribe(inspect)
        : () => undefined
    unsubscribe = () => {
      if (unsubscribed) return
      unsubscribed = true
      unsubscribeCapability()
      unsubscribeSteering()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    inspect()
  })
}

function sameClaimedConversationDestination(
  left: ClaimedConversationDestination,
  right: ClaimedConversationDestination,
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'ready' ||
      (right.kind === 'ready' && left.expectedLeafId === right.expectedLeafId))
  )
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
