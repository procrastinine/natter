import {
  type AppliedMessageView,
  createAppliedMessageView,
  projectAppliedMessageReasoningPresentation,
} from '../../core/continuation-content'
import type { ReasoningPresentation } from '../../core/reasoning-envelope'
import {
  messageTextCharCount,
  RATIO_BOUNDS,
  tokenizerFamilyForModel,
} from '../../core/token-calibration'
import type { GenerationServerToolCall, Message as MessageRow } from '../../core/types'

interface MessageInfoProps {
  message: MessageRow
  appliedView?: AppliedMessageView
  reasoningPresentation?: ReasoningPresentation
  // Set to true when the previous message on the active path was a user
  // message that got edited after this assistant was generated — the
  // factual-record (tokens, cost, text) is still the original but the
  // reply may look stale relative to the edited question. See §10.6
  // "stale reply?" hint. Surfaced as a row in the info panel so the
  // reading lane stays calm.
  staleReplyHint?: boolean
}

// Detail panel revealed via the ⓘ button on each message. Contains the
// metadata previously dumped as always-visible chips (model, timestamps,
// token breakdown, cost). Quiet two-column layout, no badges.
export function MessageInfo({
  message,
  appliedView,
  reasoningPresentation,
  staleReplyHint,
}: MessageInfoProps) {
  const view = appliedView ?? createAppliedMessageView(message)
  const gen = view.latestAttempt.metadata
  const rootGeneration =
    view.latestAttempt.kind === 'generation' ? view.latestAttempt.metadata : undefined
  const usage = gen?.usage
  const presentedReasoning =
    reasoningPresentation ?? projectAppliedMessageReasoningPresentation(view)
  const start = gen?.startedAt
  const end = gen?.finishedAt
  const elapsedSec =
    typeof start === 'number' && typeof end === 'number' && end >= start
      ? (end - start) / 1000
      : undefined
  const completionTokens = usage?.completion_tokens
  const tokenPerSec =
    elapsedSec && elapsedSec > 0 && completionTokens ? completionTokens / elapsedSec : undefined
  const rows: Array<[string, React.ReactNode]> = []
  rows.push(['Created', new Date(message.createdAt).toLocaleString()])
  if (view.latestAttempt.kind === 'continuation') rows.push(['Attempt', 'Continued response'])
  if (message.editedAt) {
    rows.push([
      'Edited',
      `${new Date(message.editedAt).toLocaleString()} (original token count and cost unchanged)`,
    ])
  }
  if (message.origin === 'imported') {
    rows.push(['Origin', 'Imported from another source'])
  }
  if (gen?.model) {
    rows.push([
      'Model',
      gen.requestedModel && gen.requestedModel !== gen.model ? (
        <span key="model-served" title={`Requested ${gen.requestedModel} → served ${gen.model}`}>
          {gen.model}
        </span>
      ) : (
        gen.model
      ),
    ])
  }
  // Resolved provider. Only present on OpenRouter — native providers
  // don't surface it. Rendering here (instead of as a header chip)
  // keeps the reading lane quiet; users who care click ⓘ.
  if (gen?.provider) {
    rows.push(['Provider', gen.provider])
  }
  if (rootGeneration?.requestedModels && rootGeneration.requestedModels.length > 1) {
    // Fallback chain was consulted — e.g. requested [gpt-5.4, gpt-5.4-mini].
    // Show the full chain so the user can see where the cascade landed.
    rows.push(['Fallback chain', rootGeneration.requestedModels.join(' → ')])
  }
  if (usage?.prompt_tokens !== undefined) {
    rows.push(['Prompt tokens', usage.prompt_tokens.toLocaleString()])
  }
  if (usage?.completion_tokens !== undefined) {
    rows.push(['Completion tokens', usage.completion_tokens.toLocaleString()])
  }
  const reasoningTok = usage?.completion_tokens_details?.reasoning_tokens
  const hasReasoningBreakout =
    (typeof reasoningTok === 'number' && reasoningTok > 0) || presentedReasoning.hasReasoning
  const answerTokens =
    hasReasoningBreakout && usage?.completion_tokens !== undefined && reasoningTok !== undefined
      ? Math.max(0, usage.completion_tokens - reasoningTok)
      : undefined
  if (answerTokens !== undefined) {
    rows.push(['Answer tokens', answerTokens.toLocaleString()])
  }
  if (reasoningTok) {
    rows.push(['Reasoning tokens', reasoningTok.toLocaleString()])
  } else {
    const reasoningChars =
      presentedReasoning.visibleCharCount + presentedReasoning.preservedCarrierBytes
    if (reasoningChars > 0) {
      rows.push(['Reasoning chars', formatReasoningChars(presentedReasoning)])
    }
  }
  const cachedTok = usage?.prompt_tokens_details?.cached_tokens
  if (cachedTok) {
    rows.push(['Cache read', cachedTok.toLocaleString()])
  }
  const cacheWrite = usage?.cache_creation_input_tokens
  if (cacheWrite) {
    rows.push(['Cache write', cacheWrite.toLocaleString()])
  }
  if (gen?.cost !== undefined) {
    const prefix = gen.costSource === 'estimated' ? '≈ ' : ''
    rows.push(['Cost', `${prefix}$${gen.cost.toFixed(6)}`])
  }
  // Phase B calibration readout. ALWAYS computed so pre-Phase-B rows
  // (no originalCharCount) still show an estimate — the UI reads the
  // current content and derives chars on the fly. Cached values are
  // preferred when present; otherwise the fallback is a family-anchor fresh
  // estimate. (The gauge path uses the full tiered resolver with chat +
  // global calibration; MessageInfo is a lighter display surface with
  // no access to those tables, so it uses the family anchor.)
  const contentChars = messageTextCharCount(message.content)
  const displayChars =
    typeof message.originalCharCount === 'number'
      ? message.originalCharCount +
        (typeof message.charCountDelta === 'number' ? message.charCountDelta : 0)
      : contentChars
  if (displayChars > 0) {
    rows.push(['Current chars', displayChars.toLocaleString()])
  }
  if (
    typeof message.charCountDelta === 'number' &&
    message.charCountDelta !== 0 &&
    typeof message.originalCharCount === 'number' &&
    message.originalCharCount > 0
  ) {
    const sign = message.charCountDelta > 0 ? '+' : ''
    rows.push([
      'Edit delta',
      `${sign}${message.charCountDelta.toLocaleString()} chars (orig ${message.originalCharCount.toLocaleString()})`,
    ])
  }
  const displayTextTokens = computeDisplayTextTokens(message, displayChars)
  if (displayTextTokens > 0) {
    const parts = [`${displayTextTokens.toLocaleString()} text`]
    if (typeof message.cachedMediaTokens === 'number' && message.cachedMediaTokens > 0) {
      parts.push(`+${message.cachedMediaTokens.toLocaleString()} media`)
    }
    const label =
      typeof message.cachedTokenEstimate === 'number' ? 'Estimated tokens' : 'Estimated tokens (~)'
    rows.push([label, parts.join(' ')])
  }
  const reasoningTiming = reasoningTimingRow(gen)
  if (reasoningTiming) {
    rows.push(reasoningTiming)
  }
  if (elapsedSec !== undefined) {
    rows.push(['Latency', `${elapsedSec.toFixed(2)} s`])
  }
  if (tokenPerSec !== undefined) {
    rows.push(['Throughput', `${tokenPerSec.toFixed(1)} tok/s`])
  }
  if (gen?.apiUsed) {
    rows.push(['API', gen.apiUsed])
  }
  if (rootGeneration?.delivery) {
    rows.push(['Delivery', rootGeneration.delivery])
  }
  if (rootGeneration?.serverTools && rootGeneration.serverTools.length > 0) {
    rows.push([
      'Tool calls',
      <ServerToolCalls key="tool-calls" tools={rootGeneration.serverTools} />,
    ])
  }
  if (staleReplyHint) {
    rows.push(['Note', 'Previous user message was edited after this reply — text may be stale.'])
  }
  return (
    <dl data-ui="message-info">
      {rows.map(([label, value]) => (
        <div key={label} data-ui="message-info-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ServerToolCalls({ tools }: { tools: readonly GenerationServerToolCall[] }) {
  return (
    <div data-ui="message-tool-calls">
      {tools.map((tool, index) => (
        <ServerToolCall key={`${tool.type}:${tool.id ?? tool.outputIndex ?? index}`} tool={tool} />
      ))}
    </div>
  )
}

function ServerToolCall({ tool }: { tool: GenerationServerToolCall }) {
  return <div data-ui="tool-call">{serverToolSummary(tool)}</div>
}

function serverToolSummary(tool: GenerationServerToolCall): string {
  const parts = [serverToolLabel(tool.type)]
  if (tool.status) parts.push(tool.status)
  if (tool.requestCount !== undefined) parts.push(`${tool.requestCount} request(s)`)
  if (tool.id) parts.push(tool.id)
  return parts.join(' · ')
}

function serverToolLabel(type: string): string {
  if (type === 'openrouter:web_search' || type === 'web_search_call') return 'web search'
  if (type === 'openrouter:web_fetch') return 'web fetch'
  if (type === 'openrouter:datetime') return 'datetime'
  if (type === 'image_generation_call') return 'image generation'
  if (type === 'code_interpreter_call') return 'code interpreter'
  if (type === 'shell_call') return 'shell'
  if (type === 'shell_call_output') return 'shell output'
  if (type === 'mcp_tool_call' || type === 'mcp_call') return 'remote MCP'
  if (type === 'google:google_search') return 'Google Search'
  if (type === 'google:url_context') return 'URL context'
  if (type === 'google:code_execution') return 'code execution'
  if (type === 'google:google_maps') return 'Google Maps'
  if (type === 'server_tool_use') return 'server tool use'
  if (type === 'web_search_tool_result') return 'web search result'
  if (type === 'web_fetch_tool_result') return 'web fetch result'
  if (type === 'advisor_tool_result') return 'advisor result'
  if (
    type === 'code_execution_tool_result' ||
    type === 'bash_code_execution_tool_result' ||
    type === 'text_editor_code_execution_tool_result'
  ) {
    return 'code execution result'
  }
  return type
}

function formatReasoningChars(presentation: ReasoningPresentation): string {
  const total = presentation.visibleCharCount + presentation.preservedCarrierBytes
  const parts: string[] = []
  if (presentation.textCharCount > 0) {
    parts.push(`text ${presentation.textCharCount.toLocaleString()}`)
  }
  if (presentation.summaryCharCount > 0) {
    parts.push(`summary ${presentation.summaryCharCount.toLocaleString()}`)
  }
  if (presentation.opaqueCarrierBytes > 0) {
    parts.push(`encrypted ${presentation.opaqueCarrierBytes.toLocaleString()}`)
  }
  if (presentation.authenticationCarrierBytes > 0) {
    parts.push(`signature ${presentation.authenticationCarrierBytes.toLocaleString()}`)
  }
  if (parts.length === 0) return total.toLocaleString()
  return `${total.toLocaleString()} total (${parts.join(', ')})`
}

// Compute the text-token count to display in MessageInfo. Prefers the
// cached estimate (which was written under the current calibration ratio
// at the time) but falls back to a family-anchor fresh estimate for
// pre-Phase-B rows. The `~` hint in the label signals it's a coarse
// fallback estimate in that case.
function computeDisplayTextTokens(message: MessageRow, displayChars: number): number {
  if (
    typeof message.cachedTokenEstimate === 'number' &&
    Number.isFinite(message.cachedTokenEstimate) &&
    message.cachedTokenEstimate > 0
  ) {
    return message.cachedTokenEstimate
  }
  if (displayChars <= 0) return 0
  const modelId = message.originalModelId ?? message.generation?.model ?? ''
  const family = modelId ? tokenizerFamilyForModel(modelId) : 'unknown'
  const ratio = RATIO_BOUNDS[family].anchor
  return Math.ceil(displayChars / ratio)
}

function reasoningTimingRow(
  gen:
    | Readonly<{
        reasoningStartedAt?: number
        firstTextAt?: number
        reasoningFinishedAt?: number
        finishedAt?: number
      }>
    | undefined,
): [string, string] | null {
  if (!gen || gen.reasoningStartedAt === undefined) return null
  const end =
    gen.firstTextAt !== undefined && gen.firstTextAt >= gen.reasoningStartedAt
      ? gen.firstTextAt
      : (gen.reasoningFinishedAt ?? gen.finishedAt)
  if (end === undefined || end <= gen.reasoningStartedAt) return null
  const seconds = ((end - gen.reasoningStartedAt) / 1000).toFixed(2)
  const value =
    gen.firstTextAt !== undefined && gen.firstTextAt >= gen.reasoningStartedAt
      ? `${seconds} s before answer`
      : `${seconds} s`
  return ['Reasoning time', value]
}
