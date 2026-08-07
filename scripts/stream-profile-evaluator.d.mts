export type StreamProfileSurface = 'transcript' | 'tree'

export type StreamProfilePhase =
  | { readonly kind: 'fresh' | 'pre-release' | 'recycled' }
  | {
      readonly kind: 'turn-active' | 'turn-settled' | 'regeneration-settled' | 'reload'
      readonly ordinal: number
    }
  | { readonly kind: 'surface'; readonly surface: StreamProfileSurface; readonly cycle: number }

export interface StreamProfileHeapSample {
  readonly phase: StreamProfilePhase
  readonly label: string
  readonly usedSize: number
  readonly totalSize: number
  readonly dom: { readonly documents: number; readonly jsEventListeners: number; readonly nodes: number }
  readonly debugState: {
    readonly measurementTransactions: {
      readonly activeBeforeGarbageCollection: number
      readonly activeBeforeCapture: number
      readonly activeAfterCapture: number
      readonly revisionBeforeGarbageCollection: number
      readonly revisionBeforeCapture: number
      readonly revisionAfterCapture: number
      readonly attempts: number
    }
    readonly [key: string]: unknown
  }
}

export interface StreamProfileState {
  readonly mountedMessages: number
  readonly loadedMessages: number
  readonly virtualized: boolean
  readonly initialRenderWork: number
  readonly totalMessages: number
  readonly assistantTextLengths: readonly number[]
  readonly transcriptVisible: boolean
  readonly treeVisible: boolean
  readonly treeNodeCount: number
  readonly treePreviewTextChars: number
  readonly treeInspectorTextChars: number
  readonly counts: Readonly<Record<'messageBodies' | 'messages' | 'streamChunks', number>>
}

export interface StreamProfileStoreState {
  readonly phase: StreamProfilePhase
  readonly label: string
  readonly state: StreamProfileState
}

export interface StreamProfileReport {
  readonly schemaVersion: 2
  readonly measurementModel: 'external-http-ui-v1'
  readonly scenario: {
    readonly regenCount: number
    readonly targetChars: number
    readonly reasoningChars: number
    readonly turnCount: number
    readonly reloadCount: number
    readonly surfaceCycleCount: number
  }
  readonly residentHeapCaptureOrder: readonly ['storage-evidence', 'forced-gc', 'heap-and-dom']
  readonly samples: readonly StreamProfileHeapSample[]
  readonly storeStates: readonly StreamProfileStoreState[]
  readonly failures: readonly string[]
}

export interface StreamProfileEvaluation {
  readonly schemaVersion: 1
  readonly status: 'pass' | 'fail'
  readonly contract:
    | typeof STREAM_PROFILE_EVIDENCE_CONTRACT
    | typeof CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT
  readonly metrics: Readonly<Record<string, number>>
  readonly problems: readonly string[]
}

export const STREAM_PROFILE_EVIDENCE_CONTRACT: Readonly<{
  reportSchemaVersion: 2
  minimumSurfaceCycles: number
  minimumReloads: number
  minimumRegenerations: number
  minimumTargetChars: number
  minimumReasoningChars: number
  minimumBranchDemandMultiples: number
  maximumGcRetainedGrowthBytes: number
  series: readonly Readonly<{
    id: string
    value: (sample: StreamProfileHeapSample) => number
    maximumSlope?: number
    maximumCeilingGrowth: number
  }>[]
}>

export const CONCURRENT_STREAM_PROFILE_EVIDENCE_CONTRACT: Readonly<{
  reportSchemaVersion: 2
  minimumPageCount: number
  minimumStreamsPerPage: number
  minimumTotalStreams: number
  minimumContextChars: number
  minimumTargetChars: number
  minimumReasoningChars: number
  minimumRegenerations: number
  maximumReloadGrowthBytes: number
}>

export function streamProfilePhaseLabel(phase: StreamProfilePhase): string
export function evaluateStreamProfile(input: unknown): StreamProfileEvaluation
export function evaluateConcurrentStreamProfile(input: unknown): StreamProfileEvaluation
