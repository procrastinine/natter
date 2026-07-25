type V89GenerationApi =
  | 'chat'
  | 'responses'
  | 'gemini-native'
  | 'anthropic-messages'
  | 'completion'
  | 'video-generation'

interface V89StreamStopControl {
  readonly requestId: string
  readonly requestedBy: string
  readonly requestedAt: number
  readonly reason: 'user'
}

interface V89StreamGenerationDispatchEvidence {
  readonly targetCommittedAt: number
  readonly requestedModel: string
  readonly apiUsed: V89GenerationApi
}

interface V89StreamContinuationDispatchEvidence extends V89StreamGenerationDispatchEvidence {
  readonly continuationStrategy: 'prompt' | 'prefill'
  readonly baseNodeVersion: number
  readonly baseBodyVersion: number
}

type V90ReasoningCarryForward = 'none' | 'visible-only' | 'carrier' | 'unknown'

interface V90StreamGenerationDispatchEvidence extends V89StreamGenerationDispatchEvidence {
  readonly reasoningCarryForward: V90ReasoningCarryForward
}

interface V90StreamContinuationDispatchEvidence extends V89StreamContinuationDispatchEvidence {
  readonly reasoningCarryForward: V90ReasoningCarryForward
}

type V92ReasoningVisibility =
  | Readonly<{ disclosure: 'unknown' }>
  | Readonly<{ disclosure: 'visible'; visibleKind: 'text' | 'summary' }>
  | Readonly<{
      disclosure: 'absent'
      unexpectedVisibleKind: 'text' | 'summary'
      reason: 'api-mode' | 'request-display' | 'provider-default' | 'disabled'
    }>

interface V92StreamGenerationDispatchEvidence extends V90StreamGenerationDispatchEvidence {
  readonly reasoningVisibility: V92ReasoningVisibility
}

interface V92StreamContinuationDispatchEvidence extends V90StreamContinuationDispatchEvidence {
  readonly reasoningVisibility: V92ReasoningVisibility
}

interface V89StreamPostCommitUsageEvidence {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly reasoningTokens?: number
}

interface V89StreamPostCommitCalibrationPlan {
  readonly modelId: string
  readonly family:
    | 'claude'
    | 'gpt'
    | 'gemini'
    | 'llama'
    | 'mistral'
    | 'deepseek'
    | 'qwen'
    | 'unknown'
  readonly mode: 'adaptive' | 'global-only' | 'family-defaults-only'
  readonly promptBasis?: Readonly<{ chars: number; tokenOverhead: number }>
  readonly promptAllowed: boolean
  readonly expectedChatGeneration: number
  readonly expectedGlobalClearGeneration: number
}

interface V89StreamPostCommitFinalEvidence {
  readonly selectedKeyId?: string
  readonly usage?: V89StreamPostCommitUsageEvidence
  readonly completionAllowed: boolean
  readonly expectedNodeVersion?: number
  readonly expectedBodyVersion?: number
  readonly calibration?: Readonly<{
    messageTextChars: number
    completionSample?: Readonly<{ chars: number; tokens: number }>
  }>
}

interface V89StreamPostCommitEvidence {
  readonly usedAt: number
  readonly profileId: string
  readonly presetId?: string
  readonly recentModelId?: string
  readonly selectedKeyId?: string
  readonly calibration?: V89StreamPostCommitCalibrationPlan
  readonly final?: V89StreamPostCommitFinalEvidence
}

type V89AttemptTerminalDecision =
  | Readonly<{ outcome: 'done'; finishReason?: string }>
  | Readonly<{
      outcome: 'error'
      finishReason?: string
      error: Readonly<{
        kind: string
        category: string
        code: string
        message: string
        statusCode?: number
        provider?: string
        retryable?: boolean
        midStream?: boolean
      }>
    }>
  | Readonly<{
      outcome: 'abort'
      finishReason?: string
      abortReason: 'user' | 'tab-close' | 'error' | 'network' | 'quota'
    }>

interface V89AttemptTerminalReceipt {
  readonly version: 1
  readonly finishedAt: number
  readonly journalMaxSeq: number
  readonly journalCompleteness: 'settled'
  readonly decision: V89AttemptTerminalDecision
}

interface V67StreamLeaseCommon {
  readonly streamId: string
  readonly chatId: string
  readonly messageId: string
  readonly replacementEpoch: number
  readonly startedAt: number
  readonly admissionSequence: number
  readonly revision: number
  readonly journalStorageBytes?: number
  readonly journalMaxSeq?: number
}

interface V88StreamLeaseCommon extends V67StreamLeaseCommon {
  readonly controlRevision: number
  readonly stopControl?: V89StreamStopControl
}

interface V89StreamLeaseCommon extends V88StreamLeaseCommon {
  readonly journalEventVersion: 1
}

interface V91StreamLeaseCommon extends V88StreamLeaseCommon {
  readonly journalEventVersion: 2
}

type V89StreamLeaseCustody =
  | Readonly<{
      custody: 'writer' | 'recovery'
      ownerClientId: string
      fenceToken: string
      heartbeatAt: number
      handoffId?: never
      handedOffAt?: never
      handoffReason?: never
    }>
  | Readonly<{
      custody: 'recovery-pending'
      ownerClientId?: never
      fenceToken?: never
      heartbeatAt?: never
      handoffId: string
      handedOffAt: number
      handoffReason:
        | 'adoption-failed'
        | 'cleanup-failed'
        | 'journal-settle-failed'
        | 'finalize-failed'
    }>

type V89StreamLeaseProgress<Dispatch> =
  | Readonly<{
      phase: 'reserved'
      targetOwnerKey: string
      postCommit: V89StreamPostCommitEvidence & { final?: never }
      dispatch?: never
      terminal?: never
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }>
  | Readonly<{
      phase: 'active'
      targetOwnerKey: string
      postCommit: V89StreamPostCommitEvidence & { final?: never }
      dispatch: Dispatch
      terminal?: never
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }>
  | Readonly<{
      phase: 'terminal-decided'
      targetOwnerKey: string
      postCommit: V89StreamPostCommitEvidence & { final?: never }
      dispatch: Dispatch | null
      terminal: V89AttemptTerminalReceipt
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }>
  | Readonly<{
      phase: 'canonical'
      targetOwnerKey: string
      postCommit: V89StreamPostCommitEvidence & { final: V89StreamPostCommitFinalEvidence }
      dispatch: Dispatch | null
      terminal?: never
      canonicalAt: number
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }>
  | Readonly<{
      phase: 'metadata-committed'
      targetOwnerKey?: never
      postCommit: V89StreamPostCommitEvidence & { final: V89StreamPostCommitFinalEvidence }
      dispatch: Dispatch | null
      terminal?: never
      canonicalAt: number
      metadataCommittedAt: number
      terminalRetentionAt: number
    }>

type V89StreamLeaseByAttempt =
  | (Readonly<{ attemptKind: 'generation' }> &
      V89StreamLeaseProgress<V89StreamGenerationDispatchEvidence>)
  | (Readonly<{ attemptKind: 'continuation' }> &
      V89StreamLeaseProgress<V89StreamContinuationDispatchEvidence>)

type V90StreamLeaseByAttempt =
  | (Readonly<{ attemptKind: 'generation' }> &
      V89StreamLeaseProgress<V90StreamGenerationDispatchEvidence>)
  | (Readonly<{ attemptKind: 'continuation' }> &
      V89StreamLeaseProgress<V90StreamContinuationDispatchEvidence>)

type V92StreamLeaseByAttempt =
  | (Readonly<{ attemptKind: 'generation' }> &
      V89StreamLeaseProgress<V92StreamGenerationDispatchEvidence>)
  | (Readonly<{ attemptKind: 'continuation' }> &
      V89StreamLeaseProgress<V92StreamContinuationDispatchEvidence>)

export type V67StreamLeaseRow = V67StreamLeaseCommon &
  V89StreamLeaseCustody &
  V89StreamLeaseByAttempt

export type V88StreamLeaseRow = V88StreamLeaseCommon &
  V89StreamLeaseCustody &
  V89StreamLeaseByAttempt

export type V89StreamLeaseRow = V89StreamLeaseCommon &
  V89StreamLeaseCustody &
  V89StreamLeaseByAttempt

export type V90StreamLeaseRow = V89StreamLeaseCommon &
  V89StreamLeaseCustody &
  V90StreamLeaseByAttempt

export type V91StreamLeaseRow = V91StreamLeaseCommon &
  V89StreamLeaseCustody &
  V90StreamLeaseByAttempt

export type V92StreamLeaseRow = V91StreamLeaseCommon &
  V89StreamLeaseCustody &
  V92StreamLeaseByAttempt

export function requireV67StreamLeaseRow(value: unknown): V67StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v67')) throw new Error('V67StreamLeaseRowInvalid')
  return value as V67StreamLeaseRow
}

export function requireV88StreamLeaseRow(value: unknown): V88StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v88')) throw new Error('V88StreamLeaseRowInvalid')
  return value as V88StreamLeaseRow
}

export function requireV89StreamLeaseRow(value: unknown): V89StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v89')) throw new Error('V89StreamLeaseRowInvalid')
  return value as V89StreamLeaseRow
}

export function requireV90StreamLeaseRow(value: unknown): V90StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v90')) throw new Error('V90StreamLeaseRowInvalid')
  return value as V90StreamLeaseRow
}

export function requireV91StreamLeaseRow(value: unknown): V91StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v91')) throw new Error('V91StreamLeaseRowInvalid')
  return value as V91StreamLeaseRow
}

export function requireV92StreamLeaseRow(value: unknown): V92StreamLeaseRow {
  if (!isVersionedStreamLeaseRow(value, 'v92')) throw new Error('V92StreamLeaseRowInvalid')
  return value as V92StreamLeaseRow
}

function isVersionedStreamLeaseRow(
  value: unknown,
  version: 'v67' | 'v88' | 'v89' | 'v90' | 'v91' | 'v92',
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (
    ((version === 'v89' || version === 'v90') && row.journalEventVersion !== 1) ||
    ((version === 'v91' || version === 'v92') && row.journalEventVersion !== 2) ||
    ((version === 'v67' || version === 'v88') && row.journalEventVersion !== undefined)
  ) {
    return false
  }
  if (version === 'v67') {
    if (row.controlRevision !== undefined || row.stopControl !== undefined) return false
  } else if (
    !isNonNegativeSafeInteger(row.controlRevision) ||
    !isStreamStopControl(row.stopControl) ||
    (row.stopControl === undefined) !== (row.controlRevision === 0)
  ) {
    return false
  }
  if (
    !isNonEmptyString(row.streamId) ||
    !isNonEmptyString(row.chatId) ||
    !isNonEmptyString(row.messageId) ||
    !isNonNegativeSafeInteger(row.replacementEpoch) ||
    !isNonNegativeSafeInteger(row.startedAt) ||
    !isNonNegativeSafeInteger(row.admissionSequence) ||
    !isNonNegativeSafeInteger(row.revision) ||
    (row.journalStorageBytes !== undefined && !isNonNegativeSafeInteger(row.journalStorageBytes)) ||
    (row.journalMaxSeq !== undefined && !isNonNegativeSafeInteger(row.journalMaxSeq)) ||
    (row.attemptKind !== 'generation' && row.attemptKind !== 'continuation') ||
    (row.canonicalAt !== undefined && !isNonNegativeSafeInteger(row.canonicalAt)) ||
    (row.metadataCommittedAt !== undefined && !isNonNegativeSafeInteger(row.metadataCommittedAt)) ||
    (row.terminalRetentionAt !== undefined && !isNonNegativeSafeInteger(row.terminalRetentionAt)) ||
    !isStreamLeaseCustody(row) ||
    !isStreamPostCommitEvidence(row.postCommit)
  ) {
    return false
  }
  const postCommit = row.postCommit
  if (
    postCommit.final !== undefined &&
    (row.phase === 'reserved' || row.phase === 'active' || row.phase === 'terminal-decided')
  ) {
    return false
  }
  const terminal = row.phase === 'canonical' || row.phase === 'metadata-committed'
  const decided = row.phase === 'terminal-decided'
  if (!terminal && !decided && row.phase !== 'reserved' && row.phase !== 'active') return false
  if (row.phase === 'metadata-committed') {
    if (row.targetOwnerKey !== undefined || row.terminalRetentionAt !== row.canonicalAt)
      return false
  } else if (row.targetOwnerKey !== row.messageId || row.terminalRetentionAt !== undefined) {
    return false
  }
  if (terminal !== (row.canonicalAt !== undefined)) return false
  if ((row.phase === 'metadata-committed') !== (row.metadataCommittedAt !== undefined)) return false
  if (terminal !== (postCommit.final !== undefined)) return false
  if (decided !== (row.terminal !== undefined)) return false
  if (decided && !isV89AttemptTerminalReceipt(row.terminal)) return false
  if (
    decided &&
    (row.terminal as { journalMaxSeq: number }).journalMaxSeq !== (row.journalMaxSeq ?? -1)
  ) {
    return false
  }
  if (row.phase === 'reserved') return row.dispatch === undefined && row.terminal === undefined
  if (!terminal && !decided && row.dispatch === null) return false
  if ((terminal || decided) && row.dispatch === null) return true
  return isStreamDispatchEvidence(row.dispatch, row.attemptKind, version)
}

function isStreamLeaseCustody(row: Record<string, unknown>): boolean {
  if (row.custody === 'recovery-pending') {
    return (
      row.ownerClientId === undefined &&
      row.fenceToken === undefined &&
      row.heartbeatAt === undefined &&
      isNonEmptyString(row.handoffId) &&
      isNonNegativeSafeInteger(row.handedOffAt) &&
      (row.handoffReason === 'adoption-failed' ||
        row.handoffReason === 'cleanup-failed' ||
        row.handoffReason === 'journal-settle-failed' ||
        row.handoffReason === 'finalize-failed')
    )
  }
  return (
    (row.custody === 'writer' || row.custody === 'recovery') &&
    isNonEmptyString(row.ownerClientId) &&
    isNonEmptyString(row.fenceToken) &&
    isNonNegativeSafeInteger(row.heartbeatAt) &&
    row.handoffId === undefined &&
    row.handedOffAt === undefined &&
    row.handoffReason === undefined
  )
}

function isStreamDispatchEvidence(
  value: unknown,
  attemptKind: unknown,
  version: 'v67' | 'v88' | 'v89' | 'v90' | 'v91' | 'v92',
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const dispatch = value as Record<string, unknown>
  if (
    !isNonNegativeSafeInteger(dispatch.targetCommittedAt) ||
    !isNonEmptyString(dispatch.requestedModel) ||
    !isGenerationApi(dispatch.apiUsed) ||
    (version === 'v90' || version === 'v91' || version === 'v92'
      ? !isV90ReasoningCarryForward(dispatch.reasoningCarryForward)
      : dispatch.reasoningCarryForward !== undefined) ||
    (version === 'v92'
      ? !isV92ReasoningVisibility(dispatch.reasoningVisibility)
      : version === 'v91'
        ? dispatch.reasoningVisibility !== undefined &&
          !isV92ReasoningVisibility(dispatch.reasoningVisibility)
        : dispatch.reasoningVisibility !== undefined)
  ) {
    return false
  }
  if (attemptKind === 'generation') {
    return (
      dispatch.continuationStrategy === undefined &&
      dispatch.baseNodeVersion === undefined &&
      dispatch.baseBodyVersion === undefined
    )
  }
  return (
    (dispatch.continuationStrategy === 'prompt' || dispatch.continuationStrategy === 'prefill') &&
    isNonNegativeSafeInteger(dispatch.baseNodeVersion) &&
    isNonNegativeSafeInteger(dispatch.baseBodyVersion)
  )
}

function isV92ReasoningVisibility(value: unknown): value is V92ReasoningVisibility {
  const visibility = record(value)
  if (!visibility) return false
  if (visibility.disclosure === 'unknown') return Object.keys(visibility).length === 1
  if (visibility.disclosure === 'visible') {
    return (
      Object.keys(visibility).length === 2 &&
      (visibility.visibleKind === 'text' || visibility.visibleKind === 'summary')
    )
  }
  return (
    visibility.disclosure === 'absent' &&
    Object.keys(visibility).length === 3 &&
    (visibility.unexpectedVisibleKind === 'text' ||
      visibility.unexpectedVisibleKind === 'summary') &&
    (visibility.reason === 'api-mode' ||
      visibility.reason === 'request-display' ||
      visibility.reason === 'provider-default' ||
      visibility.reason === 'disabled')
  )
}

function isV90ReasoningCarryForward(value: unknown): value is V90ReasoningCarryForward {
  return value === 'none' || value === 'visible-only' || value === 'carrier' || value === 'unknown'
}

function isStreamPostCommitEvidence(value: unknown): value is V89StreamPostCommitEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const evidence = value as Record<string, unknown>
  if (
    !isNonNegativeSafeInteger(evidence.usedAt) ||
    !isNonEmptyString(evidence.profileId) ||
    (evidence.presetId !== undefined && !isNonEmptyString(evidence.presetId)) ||
    (evidence.recentModelId !== undefined && !isNonEmptyString(evidence.recentModelId)) ||
    (evidence.selectedKeyId !== undefined && !isNonEmptyString(evidence.selectedKeyId))
  ) {
    return false
  }
  if (evidence.calibration !== undefined && !isCalibration(evidence.calibration)) return false
  if (evidence.final === undefined) return true
  if (!evidence.final || typeof evidence.final !== 'object' || Array.isArray(evidence.final)) {
    return false
  }
  const final = evidence.final as Record<string, unknown>
  if (
    (final.selectedKeyId !== undefined && !isNonEmptyString(final.selectedKeyId)) ||
    (evidence.selectedKeyId !== undefined &&
      final.selectedKeyId !== undefined &&
      evidence.selectedKeyId !== final.selectedKeyId) ||
    (final.usage !== undefined && !isStreamPostCommitUsageEvidence(final.usage)) ||
    typeof final.completionAllowed !== 'boolean' ||
    (final.expectedNodeVersion !== undefined &&
      !isNonNegativeSafeInteger(final.expectedNodeVersion)) ||
    (final.expectedBodyVersion !== undefined &&
      !isNonNegativeSafeInteger(final.expectedBodyVersion)) ||
    (final.calibration !== undefined && evidence.calibration === undefined)
  ) {
    return false
  }
  if (final.calibration === undefined) return true
  if (
    !final.calibration ||
    typeof final.calibration !== 'object' ||
    Array.isArray(final.calibration)
  ) {
    return false
  }
  const calibration = final.calibration as Record<string, unknown>
  const sample = calibration.completionSample
  return (
    isNonNegativeSafeInteger(calibration.messageTextChars) &&
    (sample === undefined ||
      (!!sample &&
        typeof sample === 'object' &&
        !Array.isArray(sample) &&
        isPositiveSafeInteger((sample as Record<string, unknown>).chars) &&
        isPositiveSafeInteger((sample as Record<string, unknown>).tokens)))
  )
}

function isCalibration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const calibration = value as Record<string, unknown>
  const basis = calibration.promptBasis
  return (
    isNonEmptyString(calibration.modelId) &&
    (calibration.family === 'claude' ||
      calibration.family === 'gpt' ||
      calibration.family === 'gemini' ||
      calibration.family === 'llama' ||
      calibration.family === 'mistral' ||
      calibration.family === 'deepseek' ||
      calibration.family === 'qwen' ||
      calibration.family === 'unknown') &&
    (calibration.mode === 'adaptive' ||
      calibration.mode === 'global-only' ||
      calibration.mode === 'family-defaults-only') &&
    typeof calibration.promptAllowed === 'boolean' &&
    isNonNegativeSafeInteger(calibration.expectedChatGeneration) &&
    isNonNegativeSafeInteger(calibration.expectedGlobalClearGeneration) &&
    (basis === undefined ||
      (!!basis &&
        typeof basis === 'object' &&
        !Array.isArray(basis) &&
        isNonNegativeFinite((basis as Record<string, unknown>).chars) &&
        isNonNegativeFinite((basis as Record<string, unknown>).tokenOverhead)))
  )
}

function isStreamPostCommitUsageEvidence(
  value: unknown,
): value is V89StreamPostCommitUsageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  const keys = Object.keys(usage)
  return (
    (keys.length === 2 || keys.length === 3) &&
    keys.every(
      (key) => key === 'promptTokens' || key === 'completionTokens' || key === 'reasoningTokens',
    ) &&
    isNonNegativeSafeInteger(usage.promptTokens) &&
    isNonNegativeSafeInteger(usage.completionTokens) &&
    (usage.reasoningTokens === undefined || isNonNegativeSafeInteger(usage.reasoningTokens))
  )
}

function isStreamStopControl(value: unknown): boolean {
  if (value === undefined) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const control = value as Record<string, unknown>
  return (
    Object.keys(control).length === 4 &&
    isNonEmptyString(control.requestId) &&
    isNonEmptyString(control.requestedBy) &&
    isNonNegativeSafeInteger(control.requestedAt) &&
    control.reason === 'user'
  )
}

function isGenerationApi(value: unknown): value is V89GenerationApi {
  return (
    value === 'chat' ||
    value === 'responses' ||
    value === 'gemini-native' ||
    value === 'anthropic-messages' ||
    value === 'completion' ||
    value === 'video-generation'
  )
}

const V89_TERMINAL_RECEIPT_KEYS = new Set([
  'version',
  'finishedAt',
  'journalMaxSeq',
  'journalCompleteness',
  'decision',
])
const V89_TERMINAL_DECISION_KEYS = new Set(['outcome', 'finishReason', 'error', 'abortReason'])
const V89_TERMINAL_FAILURE_KEYS = new Set([
  'kind',
  'category',
  'code',
  'message',
  'statusCode',
  'provider',
  'retryable',
  'midStream',
])
const V89_FAILURE_CATEGORIES = new Set([
  'abort',
  'network',
  'protocol',
  'provider',
  'storage',
  'integrity',
  'internal',
])
const V89_FAILURE_KINDS = new Set([
  'network',
  'timeout',
  'abort',
  'bad_request',
  'unauthorized',
  'payment_required',
  'moderation',
  'rate_limited',
  'provider_error',
  'no_provider_available',
  'validation',
  'protocol',
  'storage',
  'integrity',
  'internal',
])

function isV89AttemptTerminalReceipt(value: unknown): value is V89AttemptTerminalReceipt {
  const receipt = record(value)
  if (
    !hasOnlyKeys(receipt, V89_TERMINAL_RECEIPT_KEYS) ||
    receipt.version !== 1 ||
    !isNonNegativeSafeInteger(receipt.finishedAt) ||
    !isSafeIntegerAtLeast(receipt.journalMaxSeq, -1) ||
    receipt.journalCompleteness !== 'settled'
  ) {
    return false
  }
  const decision = record(receipt.decision)
  if (!hasOnlyKeys(decision, V89_TERMINAL_DECISION_KEYS)) return false
  if (decision.finishReason !== undefined && typeof decision.finishReason !== 'string') return false
  if (decision.outcome === 'done') {
    return decision.error === undefined && decision.abortReason === undefined
  }
  if (decision.outcome === 'abort') {
    return isV89AbortReason(decision.abortReason) && decision.error === undefined
  }
  if (decision.outcome !== 'error' || decision.abortReason !== undefined) return false
  const failure = record(decision.error)
  return (
    hasOnlyKeys(failure, V89_TERMINAL_FAILURE_KEYS) &&
    typeof failure.kind === 'string' &&
    V89_FAILURE_KINDS.has(failure.kind) &&
    typeof failure.category === 'string' &&
    V89_FAILURE_CATEGORIES.has(failure.category) &&
    typeof failure.code === 'string' &&
    typeof failure.message === 'string' &&
    (failure.statusCode === undefined || isV89StatusCode(failure.statusCode)) &&
    (failure.provider === undefined || typeof failure.provider === 'string') &&
    (failure.retryable === undefined || typeof failure.retryable === 'boolean') &&
    (failure.midStream === undefined || typeof failure.midStream === 'boolean')
  )
}

function isV89AbortReason(value: unknown): boolean {
  return (
    value === 'user' ||
    value === 'tab-close' ||
    value === 'error' ||
    value === 'network' ||
    value === 'quota'
  )
}

function isV89StatusCode(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasOnlyKeys(
  value: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
): value is Record<string, unknown> {
  return !!value && Object.keys(value).every((key) => allowed.has(key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
