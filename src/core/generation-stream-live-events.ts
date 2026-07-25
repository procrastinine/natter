import type {
  ChatUsageV2,
  ContentItemV2,
  GenerationServerToolCallV2,
  GenerationStreamIntegrityV2,
  MessagePhaseV2,
  NonReasoningStreamEventV2,
  ProviderOutputItemV2,
  ResultSnapshotOutcomeV2,
  ResultSnapshotTextPartV2,
  ResultSnapshotToolCallV2,
} from './generation-stream-events'
import type { ReasoningObservationBatch } from './reasoning-observation'

export interface LiveResultSnapshotReplacement {
  readonly kind: 'replace'
  readonly textParts: readonly ResultSnapshotTextPartV2[]
  readonly reasoning: ReasoningObservationBatch
  readonly toolCalls: readonly ResultSnapshotToolCallV2[]
  readonly generatedContent: readonly ContentItemV2[]
  readonly serverTools: readonly GenerationServerToolCallV2[]
  readonly providerOutputItems: readonly ProviderOutputItemV2[]
  readonly phase: MessagePhaseV2 | null
}

export type LiveResultSnapshotPayload = LiveResultSnapshotReplacement | Readonly<{ kind: 'retain' }>

export interface LiveResultSnapshotStreamEvent {
  readonly lane: 'result-snapshot'
  readonly payload: LiveResultSnapshotPayload
  readonly outcome: ResultSnapshotOutcomeV2
  readonly model?: string
  readonly generationId?: string
  readonly usage?: Partial<ChatUsageV2> & Record<string, unknown>
  readonly integrity?: readonly GenerationStreamIntegrityV2[]
}

export interface ReasoningObservationStreamEvent {
  readonly lane: 'reasoning-observation'
  readonly batch: ReasoningObservationBatch
  readonly chunkId?: string
}

type SharedNonReasoningStreamEvent = Exclude<NonReasoningStreamEventV2, { lane: 'result-snapshot' }>

export type LiveNonReasoningStreamEvent =
  | SharedNonReasoningStreamEvent
  | LiveResultSnapshotStreamEvent

export type StreamLaneEvent = LiveNonReasoningStreamEvent | ReasoningObservationStreamEvent
