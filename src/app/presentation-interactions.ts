import type {
  GenerationCapabilityOwner,
  NonReadyGenerationCapability,
} from '../core/interaction-capability'
import type { ChatId, MessageId, ProviderOutputMemberRef, ReasoningMemberRef } from '../core/types'
import { redactDiagnosticValue } from '../lib/diagnostic-redaction'
import type {
  GenerationPreparationPhase,
  PresentationInteractionCapability,
  PresentationInteractionFailure,
  PresentationInteractionPresenter,
  PresentationInteractionStart,
  TotalPresentationInteractionPromise,
  WorkspaceFence,
} from '../store/presentation-contracts'
import {
  definePresentationInteraction,
  PresentationInteractionController,
} from '../store/presentation-interaction-controller'
import {
  getWorkspaceTabSessionSnapshot,
  registerWorkspaceTabSessionParticipant,
} from '../store/workspace-tab-session'
import { useToastStore } from '../store/zustand/toastStore'

const presentationInteractionController = new PresentationInteractionController(
  {
    describe(capability, error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { message: `${capability.label} failed: ${message}`, tone: 'danger' }
    },
    present(failure) {
      useToastStore.getState().push({
        level: failure.tone,
        text: failure.message,
      })
    },
  },
  {
    currentFence: () => getWorkspaceTabSessionSnapshot().fence,
  },
)

registerWorkspaceTabSessionParticipant({
  resetWorkspace: () => {
    presentationInteractionController.reconcileWorkspace(getWorkspaceTabSessionSnapshot().fence)
  },
})

export { definePresentationInteraction }

export class ConversationActionUnavailableError extends Error {}

export const attachmentMutationInteraction = definePresentationInteraction<string>({
  id: 'attachment-reference.mutate',
  label: 'Attachment update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
  describeFailure: (error) => {
    const cause = error instanceof Error ? error : new Error('Unknown error')
    return cause instanceof ConversationActionUnavailableError
      ? presentationFailure(cause.message, 'info')
      : presentationFailure(`Attachment update failed: ${cause.message}`)
  },
})

export type GenerationSubmissionOutcome =
  | { readonly kind: 'prepared' }
  | {
      readonly kind: 'not-prepared'
      readonly reason: 'cancelled' | 'failed' | 'rejected-pending' | 'superseded'
      readonly failure?: {
        readonly message: string
        readonly diagnosticId: string
      }
    }

export type GenerationSubmissionAdmission =
  | { readonly kind: 'admitted' }
  | {
      readonly kind: 'not-admitted'
      readonly reason: 'cancelled' | 'failed' | 'rejected-pending' | 'superseded'
    }

export type GenerationSubmission =
  | {
      readonly kind: 'started'
      readonly admission: Promise<GenerationSubmissionAdmission>
      readonly completion: Promise<GenerationSubmissionOutcome>
      cancel(): void
    }
  | { readonly kind: 'not-started'; readonly capability: NonReadyGenerationCapability }

export const generationSubmitInteraction = definePresentationInteraction<string>({
  id: 'generation.submit',
  label: 'Send',
  concurrency: 'replace',
  lifetime: 'workspace-tab',
  workspaceStart: 'settle-current',
})

export interface GenerationSubmitIntent {
  readonly chatId: ChatId | null
  readonly action: 'composer' | 'reply' | 'edit-resend' | 'regenerate' | 'continue'
  readonly messageId?: MessageId
}

export function generationSubmitTarget(input: GenerationSubmitIntent): string {
  return input.chatId ? `chat:${input.chatId}:generation` : 'new-chat:generation'
}

export function generationSubmitDiagnosticTarget(input: GenerationSubmitIntent): string {
  const chat = input.chatId ? `chat:${input.chatId}` : 'new-chat'
  return input.messageId
    ? `${chat}:message:${input.messageId}:${input.action}`
    : `${chat}:${input.action}`
}

export function reportGenerationSubmissionFailure(input: {
  readonly claimId: number
  readonly target: string
  readonly failure: PresentationInteractionFailure
}): { readonly message: string; readonly diagnosticId: string } {
  const diagnosticId = `generation-submit-${input.claimId}`
  console.error(
    `[generation-submit][${diagnosticId}]`,
    redactDiagnosticValue({
      target: input.target,
      message: input.failure.message,
      tone: input.failure.tone,
    }),
  )
  return Object.freeze({ message: input.failure.message, diagnosticId })
}

export function reportGenerationSubmissionPhase(input: {
  readonly claimId: number
  readonly target: string
  readonly phase:
    | 'claimed'
    | 'waiting'
    | 'admitted'
    | GenerationPreparationPhase
    | 'cancelling'
    | 'settled'
  readonly owner?: GenerationCapabilityOwner
  readonly outcome?: string
  readonly elapsedMs?: number
  readonly phaseElapsedMs?: number
}): void {
  const diagnosticId = `generation-submit-${input.claimId}`
  console.info(
    `[generation-submit][${diagnosticId}]`,
    redactDiagnosticValue({
      target: input.target,
      phase: input.phase,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.elapsedMs === undefined ? {} : { elapsedMs: input.elapsedMs }),
      ...(input.phaseElapsedMs === undefined ? {} : { phaseElapsedMs: input.phaseElapsedMs }),
    }),
  )
}

export function reportConversationMutationPhase(input: {
  readonly claimId: number
  readonly target: string
  readonly phase: 'claimed' | 'admitted' | 'repository-requested' | 'local-applied' | 'settled'
  readonly outcome?: string
}): void {
  const diagnosticId = `conversation-mutation-${input.claimId}`
  console.info(
    `[conversation-mutation][${diagnosticId}]`,
    redactDiagnosticValue({
      target: input.target,
      phase: input.phase,
      ...(input.outcome ? { outcome: input.outcome } : {}),
    }),
  )
}

export function reportConversationMutationFailure(input: {
  readonly claimId: number
  readonly target: string
  readonly failure: PresentationInteractionFailure
}): void {
  const diagnosticId = `conversation-mutation-${input.claimId}`
  console.error(
    `[conversation-mutation][${diagnosticId}]`,
    redactDiagnosticValue({
      target: input.target,
      message: input.failure.message,
      tone: input.failure.tone,
    }),
  )
}

export const configurationWriteInteraction = definePresentationInteraction<string>({
  id: 'configuration.write',
  label: 'Configuration update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export const workspaceConfigurationWriteInteraction = definePresentationInteraction<string>({
  id: 'workspace-configuration.write',
  label: 'Workspace setting update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

export type ConversationMutationIntent =
  | Readonly<{ kind: 'edit'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{ kind: 'context'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{
      kind: 'reasoning'
      chatId: ChatId
      messageId: MessageId
      member: ReasoningMemberRef
    }>
  | Readonly<{
      kind: 'provider-output'
      chatId: ChatId
      messageId: MessageId
      member: ProviderOutputMemberRef
    }>
  | Readonly<{ kind: 'generation-notice'; chatId: ChatId; messageId: MessageId }>
  | Readonly<{ kind: 'delete'; chatId: ChatId }>
  | Readonly<{ kind: 'fork'; chatId: ChatId; messageId: MessageId }>

export type ConversationMutationSettlement = TotalPresentationInteractionPromise<void>
export type ConversationMutationRunner = (
  intent: ConversationMutationIntent,
  action: (
    signal: AbortSignal,
    reportPhase: (phase: 'repository-requested' | 'local-applied') => void,
  ) => Promise<void>,
  commit?: () => void,
) => ConversationMutationSettlement

export const conversationMutationInteraction = definePresentationInteraction<string>({
  id: 'conversation.mutate',
  label: 'Conversation update',
  concurrency: 'replace',
  lifetime: 'workspace-tab',
  describeFailure: (error) => {
    const cause = error instanceof Error ? error : new Error('Unknown error')
    return cause instanceof ConversationActionUnavailableError
      ? presentationFailure(cause.message, 'info')
      : presentationFailure(cause.message)
  },
})

export function configurationWriteTarget(chatId: string, target: string): string {
  return `chat:${chatId}:settings:${target}`
}

export function connectionConfigurationWriteTarget(profileId: string, target: string): string {
  return `profile:${profileId}:settings:${target}`
}

export function conversationMutationTarget(intent: ConversationMutationIntent): string {
  const message = `chat:${intent.chatId}:message:${'messageId' in intent ? intent.messageId : '*'}`
  switch (intent.kind) {
    case 'edit':
      return `${message}:content`
    case 'context':
      return `${message}:context`
    case 'reasoning':
      return `${message}:reasoning:${attemptOwnerKey(intent.member.owner)}:${intent.member.kind}:${intent.member.id}`
    case 'provider-output':
      return `${message}:provider-output:${attemptOwnerKey(intent.member.owner)}:${intent.member.itemIndex}`
    case 'generation-notice':
      return `${message}:generation-notice`
    case 'delete':
    case 'fork':
      return `chat:${intent.chatId}:structure`
  }
}

function attemptOwnerKey(owner: ReasoningMemberRef['owner']): string {
  return owner.kind === 'generation' ? 'generation' : `continuation:${owner.streamId}`
}

export function createPresentationInteractionPresenter(
  workspaceFence: WorkspaceFence | null,
): PresentationInteractionPresenter {
  return presentationInteractionController.createPresenter(workspaceFence)
}

export function releasePresentationInteractionPresenter(
  presenter: PresentationInteractionPresenter,
): void {
  presentationInteractionController.releasePresenter(presenter)
}

export function attachmentMutationTarget(input: {
  readonly refId: string
  readonly messageId?: string
  readonly draftChatId?: string
}): string {
  return input.messageId
    ? `message:${input.messageId}:${input.refId}`
    : `draft:${input.draftChatId}:${input.refId}`
}

export function startPresentationInteraction<Target extends PropertyKey, Value>(
  input: PresentationInteractionStart<Target, Value>,
) {
  return presentationInteractionController.start(input)
}

export function subscribePresentationInteraction<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
  listener: () => void,
): () => void {
  return presentationInteractionController.subscribe(capability, listener)
}

export function presentationInteractionRevision<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
): number {
  return presentationInteractionController.getRevision(capability)
}

export function presentationInteractionPending<Target extends PropertyKey>(
  capability: PresentationInteractionCapability<Target>,
  target: Target,
): boolean {
  return presentationInteractionController.isPending(capability, target)
}

export function presentationFailure(
  message: string,
  tone: PresentationInteractionFailure['tone'] = 'danger',
): PresentationInteractionFailure {
  return Object.freeze({ message, tone })
}
