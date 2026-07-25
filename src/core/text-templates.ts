// Shared text-completions chat-template library.
//
// llama-server can either use its GGUF/server-defined template (`default`)
// or any client-rendered template here. OpenRouter has no embedded template
// surface, so it always uses a client-rendered built-in or saved user template.

import { createAppliedMessageView } from './continuation-content'
import {
  type OutboundReasoningResolver,
  resolveOutboundReasoningResolver,
} from './outbound-reasoning'
import {
  type AttemptProviderOutputContract,
  projectProviderOutputForContext,
  renderProviderOutputContextFallback,
} from './provider-tool-context'
import {
  mergeSealedReasoningCarryForward,
  sealedReasoningCarryForwardEvidence,
  type TextReasoningContract,
} from './reasoning'
import type {
  ChatSettings,
  Message,
  ReasoningCarryForwardEvidence,
  SealedReasoningCarryForward,
  TextTemplateConfig,
  TextTemplateId,
} from './types'

interface TextTemplateDescriptor extends TextTemplateConfig {
  id: TextTemplateId
  name: string
  description?: string
}

export interface SavedTextTemplate {
  id: TextTemplateId
  name: string
  config: TextTemplateConfig
  createdAt: number
  updatedAt: number
}

export type SavedTextTemplateCatalogRow = Omit<SavedTextTemplate, 'config'>

export const LEGACY_SAVED_TEXT_TEMPLATES_KEY = 'global:text-templates:v1'

const EMPTY_LEGACY_TEXT_TEMPLATE: TextTemplateConfig = {
  userPrefix: '',
  userSuffix: '',
  assistantPrefix: '',
  assistantSuffix: '',
  systemPrefix: '',
  systemSuffix: '',
  bos: '',
  stop: [],
}

export const RAW_TEXT_TEMPLATE_SOURCE =
  '{% for message in messages %}{{ message.content }}{% endfor %}'

export const EMPTY_TEXT_TEMPLATE: TextTemplateConfig = Object.freeze({
  ...EMPTY_LEGACY_TEXT_TEMPLATE,
  template: RAW_TEXT_TEMPLATE_SOURCE,
  includeSystemPrompt: false,
})

const CHATML: TextTemplateConfig = {
  userPrefix: '<|im_start|>user\n',
  userSuffix: '<|im_end|>\n',
  assistantPrefix: '<|im_start|>assistant\n',
  assistantSuffix: '<|im_end|>\n',
  systemPrefix: '<|im_start|>system\n',
  systemSuffix: '<|im_end|>\n',
  bos: '',
  stop: ['<|im_end|>'],
}

const LLAMA3: TextTemplateConfig = {
  userPrefix: '<|start_header_id|>user<|end_header_id|>\n\n',
  userSuffix: '<|eot_id|>',
  assistantPrefix: '<|start_header_id|>assistant<|end_header_id|>\n\n',
  assistantSuffix: '<|eot_id|>',
  systemPrefix: '<|start_header_id|>system<|end_header_id|>\n\n',
  systemSuffix: '<|eot_id|>',
  bos: '<|begin_of_text|>',
  stop: ['<|eot_id|>'],
}

const LLAMA4: TextTemplateConfig = {
  userPrefix: '<|header_start|>user<|header_end|>\n\n',
  userSuffix: '<|eot|>',
  assistantPrefix: '<|header_start|>assistant<|header_end|>\n\n',
  assistantSuffix: '<|eot|>',
  systemPrefix: '<|header_start|>system<|header_end|>\n\n',
  systemSuffix: '<|eot|>',
  bos: '<|begin_of_text|>',
  stop: ['<|eot|>'],
}

const GEMMA: TextTemplateConfig = {
  userPrefix: '<start_of_turn>user\n',
  userSuffix: '<end_of_turn>\n',
  assistantPrefix: '<start_of_turn>model\n',
  assistantSuffix: '<end_of_turn>\n',
  systemPrefix: '<start_of_turn>user\n',
  systemSuffix: '<end_of_turn>\n',
  bos: '<bos>',
  stop: ['<end_of_turn>'],
}

const MISTRAL: TextTemplateConfig = {
  userPrefix: '[INST] ',
  userSuffix: ' [/INST]',
  assistantPrefix: '',
  assistantSuffix: '</s>',
  systemPrefix: '[INST] ',
  systemSuffix: ' [/INST]',
  bos: '<s>',
  stop: ['</s>'],
}

const MISTRAL_V7: TextTemplateConfig = {
  userPrefix: '[INST]',
  userSuffix: '[/INST]',
  assistantPrefix: '',
  assistantSuffix: '</s>',
  systemPrefix: '[SYSTEM_PROMPT]',
  systemSuffix: '[/SYSTEM_PROMPT]',
  bos: '<s>',
  stop: ['</s>'],
}

const DEEPSEEK: TextTemplateConfig = {
  userPrefix: '<｜User｜>',
  userSuffix: '',
  assistantPrefix: '<｜Assistant｜>',
  assistantSuffix: '<｜end▁of▁sentence｜>',
  systemPrefix: '<｜User｜>',
  systemSuffix: '',
  bos: '',
  stop: ['<｜end▁of▁sentence｜>'],
}

const GLM_ROLE_TAGS: TextTemplateConfig = {
  userPrefix: '<|user|>\n',
  userSuffix: '\n',
  assistantPrefix: '<|assistant|>\n',
  assistantSuffix: '\n',
  systemPrefix: '<|system|>\n',
  systemSuffix: '\n',
  bos: '',
  stop: ['<|user|>', '<|system|>', '<|assistant|>'],
}

const CHATGLM3: TextTemplateConfig = {
  userPrefix: '<|user|>\n',
  userSuffix: '\n',
  assistantPrefix: '<|assistant|>\n',
  assistantSuffix: '\n',
  systemPrefix: '<|system|>\n',
  systemSuffix: '\n',
  bos: '[gMASK]<sop>',
  stop: ['<|user|>', '<|system|>', '<|assistant|>'],
}

const HARMONY: TextTemplateConfig = {
  userPrefix: '<|start|>user<|message|>',
  userSuffix: '<|end|>',
  assistantPrefix: '<|start|>assistant<|channel|>final<|message|>',
  assistantSuffix: '<|end|>',
  systemPrefix: '<|start|>system<|message|>',
  systemSuffix: '<|end|>',
  bos: '',
  stop: ['<|end|>'],
}

const VICUNA: TextTemplateConfig = {
  userPrefix: '\nUSER: ',
  userSuffix: '',
  assistantPrefix: '\nASSISTANT: ',
  assistantSuffix: '</s>',
  systemPrefix: 'BEGINNING OF CONVERSATION: ',
  systemSuffix: '',
  bos: '',
  stop: ['</s>'],
}

const ALPACA: TextTemplateConfig = {
  userPrefix: '### Instruction:\n',
  userSuffix: '\n\n',
  assistantPrefix: '### Response:\n',
  assistantSuffix: '\n\n',
  systemPrefix: '',
  systemSuffix: '\n\n',
  bos: '',
  stop: [],
}

const COMMANDR: TextTemplateConfig = {
  userPrefix: '<|START_OF_TURN_TOKEN|><|USER_TOKEN|>',
  userSuffix: '<|END_OF_TURN_TOKEN|>',
  assistantPrefix: '<|START_OF_TURN_TOKEN|><|CHATBOT_TOKEN|>',
  assistantSuffix: '<|END_OF_TURN_TOKEN|>',
  systemPrefix: '<|START_OF_TURN_TOKEN|><|SYSTEM_TOKEN|>',
  systemSuffix: '<|END_OF_TURN_TOKEN|>',
  bos: '<BOS_TOKEN>',
  stop: ['<|END_OF_TURN_TOKEN|>'],
}

const PHI: TextTemplateConfig = {
  userPrefix: '<|user|>\n',
  userSuffix: '<|end|>\n',
  assistantPrefix: '<|assistant|>\n',
  assistantSuffix: '<|end|>\n',
  systemPrefix: '<|system|>\n',
  systemSuffix: '<|end|>\n',
  bos: '',
  stop: ['<|end|>'],
}

const RAW: TextTemplateConfig = EMPTY_TEXT_TEMPLATE

export const TEXT_TEMPLATES: Record<string, TextTemplateDescriptor> = {
  chatml: {
    id: 'chatml',
    name: 'ChatML',
    description: 'Qwen/Kimi-style <|im_start|> role blocks.',
    ...CHATML,
  },
  'qwen-chatml': {
    id: 'qwen-chatml',
    name: 'Qwen ChatML',
    description: 'Qwen 1.5/2/2.5 ChatML-compatible template.',
    ...CHATML,
  },
  'qwen3-chatml-thinking': {
    id: 'qwen3-chatml-thinking',
    name: 'Qwen3 ChatML',
    description: 'Qwen3-family ChatML scaffold; thinking policy stays separate.',
    ...CHATML,
  },
  'kimi-k2-im-thinking': {
    id: 'kimi-k2-im-thinking',
    name: 'Kimi K2 IM',
    description: 'Kimi K2-family IM scaffold; reasoning policy stays separate.',
    ...CHATML,
  },
  llama3: { id: 'llama3', name: 'Llama 3 Instruct', ...LLAMA3 },
  'llama3-header': { id: 'llama3-header', name: 'Llama 3 Header', ...LLAMA3 },
  llama4: { id: 'llama4', name: 'Llama 4 Instruct', ...LLAMA4 },
  gemma: { id: 'gemma', name: 'Gemma', ...GEMMA },
  gemma4: { id: 'gemma4', name: 'Gemma 4', ...GEMMA },
  mistral: { id: 'mistral', name: 'Mistral (legacy [INST])', ...MISTRAL },
  'mistral-v7': { id: 'mistral-v7', name: 'Mistral V7', ...MISTRAL_V7 },
  'mistral-3-2512-inst': {
    id: 'mistral-3-2512-inst',
    name: 'Mistral 3 2512',
    ...MISTRAL_V7,
  },
  deepseek: { id: 'deepseek', name: 'DeepSeek V2.5/V3', ...DEEPSEEK },
  'deepseek-v31-v32': {
    id: 'deepseek-v31-v32',
    name: 'DeepSeek V3.1/V3.2',
    ...DEEPSEEK,
  },
  'deepseek-r1': { id: 'deepseek-r1', name: 'DeepSeek R1', ...DEEPSEEK },
  glm: { id: 'glm', name: 'GLM role tags', ...GLM_ROLE_TAGS },
  'glm-5': { id: 'glm-5', name: 'GLM 4.7/5 role tags', ...GLM_ROLE_TAGS },
  'glm-5.1-thinking': {
    id: 'glm-5.1-thinking',
    name: 'GLM 5.1 role tags',
    ...GLM_ROLE_TAGS,
  },
  chatglm3: { id: 'chatglm3', name: 'ChatGLM3', ...CHATGLM3 },
  'openai-gpt-oss-harmony': {
    id: 'openai-gpt-oss-harmony',
    name: 'OpenAI gpt-oss Harmony',
    ...HARMONY,
  },
  'minimax-m2-think': {
    id: 'minimax-m2-think',
    name: 'MiniMax M2',
    description: 'MiniMax M2-family ChatML-like scaffold; thinking policy stays separate.',
    ...CHATML,
  },
  vicuna: { id: 'vicuna', name: 'Vicuna', ...VICUNA },
  alpaca: { id: 'alpaca', name: 'Alpaca', ...ALPACA },
  commandr: { id: 'commandr', name: 'Command R', ...COMMANDR },
  phi: { id: 'phi', name: 'Phi', ...PHI },
  raw: { id: 'raw', name: 'Raw (no separators)', ...RAW },
}

export const BUILTIN_TEXT_TEMPLATE_ORDER: readonly TextTemplateId[] = [
  'chatml',
  'qwen-chatml',
  'qwen3-chatml-thinking',
  'kimi-k2-im-thinking',
  'llama3',
  'llama3-header',
  'llama4',
  'gemma',
  'gemma4',
  'mistral',
  'mistral-v7',
  'mistral-3-2512-inst',
  'deepseek',
  'deepseek-v31-v32',
  'deepseek-r1',
  'glm',
  'glm-5',
  'glm-5.1-thinking',
  'chatglm3',
  'openai-gpt-oss-harmony',
  'minimax-m2-think',
  'vicuna',
  'alpaca',
  'commandr',
  'phi',
  'raw',
]

export function resolveStaticTextTemplate(
  id: TextTemplateId,
  customFallback?: TextTemplateConfig,
): TextTemplateConfig | null {
  if (id === 'default') return null
  if (id === 'custom') return customFallback ?? EMPTY_TEXT_TEMPLATE
  return TEXT_TEMPLATES[id] ?? null
}

export function isStaticTextTemplateId(id: TextTemplateId): boolean {
  return id === 'default' || id === 'custom' || Object.hasOwn(TEXT_TEMPLATES, id)
}

export function savedTextTemplatesFromStoredValue(value: unknown): SavedTextTemplate[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<TextTemplateId, SavedTextTemplate>()
  for (const raw of value) {
    const row = normalizeSavedTextTemplate(raw)
    if (!row) continue
    const current = byId.get(row.id)
    if (
      !current ||
      row.updatedAt > current.updatedAt ||
      (row.updatedAt === current.updatedAt && row.createdAt > current.createdAt)
    ) {
      byId.set(row.id, row)
    }
  }
  return [...byId.values()].sort(compareSavedTextTemplates)
}

export function savedTextTemplatesStoredValueIsCanonical(
  value: unknown,
  normalized: readonly SavedTextTemplate[],
): boolean {
  if (!Array.isArray(value) || value.length !== normalized.length) return false
  return value.every((raw, index) => {
    const expected = normalized[index]
    if (!expected || !raw || typeof raw !== 'object') return false
    const current = raw as Partial<SavedTextTemplate>
    return (
      current.id === expected.id &&
      current.name === expected.name &&
      current.createdAt === expected.createdAt &&
      current.updatedAt === expected.updatedAt &&
      sameTextTemplateConfig(current.config, expected.config)
    )
  })
}

export function normalizeSavedTextTemplate(raw: unknown): SavedTextTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<SavedTextTemplate>
  if (typeof value.id !== 'string' || !value.id.startsWith('user:')) return null
  const name =
    typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Untitled template'
  return {
    id: value.id,
    name,
    config: normalizeTextTemplateConfig(value.config),
    createdAt:
      typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    updatedAt:
      typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
  }
}

export function savedTextTemplateCatalogRow(
  template: SavedTextTemplate,
): SavedTextTemplateCatalogRow {
  return {
    id: template.id,
    name: template.name,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  }
}

function compareSavedTextTemplates(left: SavedTextTemplate, right: SavedTextTemplate): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id.localeCompare(right.id)
}

function sameTextTemplateConfig(left: unknown, right: TextTemplateConfig): boolean {
  if (!left || typeof left !== 'object') return false
  const value = left as Partial<TextTemplateConfig>
  return (
    value.template === right.template &&
    value.includeSystemPrompt === right.includeSystemPrompt &&
    value.userPrefix === right.userPrefix &&
    value.userSuffix === right.userSuffix &&
    value.assistantPrefix === right.assistantPrefix &&
    value.assistantSuffix === right.assistantSuffix &&
    value.systemPrefix === right.systemPrefix &&
    value.systemSuffix === right.systemSuffix &&
    value.bos === right.bos &&
    Array.isArray(value.stop) &&
    value.stop.length === right.stop.length &&
    value.stop.every((stop, index) => stop === right.stop[index])
  )
}

export function normalizeTextTemplateConfig(raw: unknown): TextTemplateConfig {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_TEXT_TEMPLATE, stop: [] }
  const value = raw as Partial<TextTemplateConfig>
  const next: TextTemplateConfig = {
    userPrefix: stringOrEmpty(value.userPrefix),
    userSuffix: stringOrEmpty(value.userSuffix),
    assistantPrefix: stringOrEmpty(value.assistantPrefix),
    assistantSuffix: stringOrEmpty(value.assistantSuffix),
    systemPrefix: stringOrEmpty(value.systemPrefix),
    systemSuffix: stringOrEmpty(value.systemSuffix),
    bos: stringOrEmpty(value.bos),
    stop: Array.isArray(value.stop)
      ? value.stop.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [],
  }
  if (typeof value.template === 'string') next.template = value.template
  if (typeof value.includeSystemPrompt === 'boolean') {
    next.includeSystemPrompt = value.includeSystemPrompt
  }
  return next
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function templateSourceForConfig(config: TextTemplateConfig): string {
  return config.template ?? prefixTemplateSourceForConfig(config)
}

export function editableTextTemplateConfig(config: TextTemplateConfig): TextTemplateConfig {
  const next: TextTemplateConfig = {
    ...EMPTY_LEGACY_TEXT_TEMPLATE,
    ...config,
    stop: [...config.stop],
    template: templateSourceForConfig(config),
  }
  next.includeSystemPrompt = config.includeSystemPrompt ?? !isPlainContinuationTemplate(config)
  return next
}

function prefixTemplateSourceForConfig(config: TextTemplateConfig): string {
  if (isPlainContinuationTemplate(config)) return RAW_TEXT_TEMPLATE_SOURCE
  const parts: string[] = []
  if (config.bos.length > 0) parts.push(config.bos)
  parts.push('{% for message in messages %}')
  pushRoleTemplate(parts, 'system', config.systemPrefix, config.systemSuffix, 'if')
  pushRoleTemplate(parts, 'developer', config.systemPrefix, config.systemSuffix, 'elif')
  pushRoleTemplate(parts, 'user', config.userPrefix, config.userSuffix, 'elif')
  parts.push('{% elif message.role == "assistant" %}')
  parts.push(config.assistantPrefix, '{{ message.content }}')
  if (config.assistantSuffix.length > 0) {
    parts.push('{% if not message.is_open %}', config.assistantSuffix, '{% endif %}')
  }
  parts.push('{% endif %}{% endfor %}')
  if (config.assistantPrefix.length > 0) {
    parts.push('{% if add_generation_prompt %}', config.assistantPrefix, '{% endif %}')
  }
  return parts.join('')
}

function pushRoleTemplate(
  parts: string[],
  role: string,
  prefix: string,
  suffix: string,
  branch: 'if' | 'elif',
) {
  parts.push(`{% ${branch} message.role == "${role}" %}`, prefix, '{{ message.content }}', suffix)
}

export interface RenderedTextPrompt {
  readonly prompt: string
  readonly reasoning: ReasoningCarryForwardEvidence
}

export interface OpaqueServerRenderedPrompt {
  readonly kind: 'opaque-server-rendered-prompt'
  readonly prompt: string
}

export function renderedTextPromptFromOpaqueServer(
  rendered: OpaqueServerRenderedPrompt,
  candidateReasoningCarryForward: SealedReasoningCarryForward,
): RenderedTextPrompt {
  return candidateReasoningCarryForward === 'none'
    ? renderedTextPromptFromClient(rendered.prompt, 'none')
    : {
        prompt: rendered.prompt,
        reasoning: { certainty: 'opaque', possible: candidateReasoningCarryForward },
      }
}

function renderedTextPromptFromClient(
  prompt: string,
  reasoningCarryForward: SealedReasoningCarryForward,
): RenderedTextPrompt {
  return {
    prompt,
    reasoning: sealedReasoningCarryForwardEvidence(reasoningCarryForward),
  }
}

export function renderTextPromptProjection(
  template: TextTemplateConfig,
  settings: ChatSettings,
  branch: readonly Message[],
  reasoning: TextReasoningContract,
  providerOutput: AttemptProviderOutputContract,
  options: {
    reasoningCarryForwardByMessageId?: ReadonlyMap<Message['id'], SealedReasoningCarryForward>
    reasoningResolver?: OutboundReasoningResolver
  } = {},
): RenderedTextPrompt {
  const projected = projectTextPromptMessagesProjection(
    settings,
    branch,
    reasoning,
    providerOutput,
    {
      includeSystemPrompt: !isPlainContinuationTemplate(template),
      ...(options.reasoningCarryForwardByMessageId
        ? { reasoningCarryForwardByMessageId: options.reasoningCarryForwardByMessageId }
        : {}),
      ...(options.reasoningResolver ? { reasoningResolver: options.reasoningResolver } : {}),
    },
  )
  const rendered =
    template.template !== undefined
      ? renderProjectedTemplatePrompt(template, projected.messages)
      : renderDelimitedTextPromptMessages(template, projected.messages)
  return renderedTextPromptFromClient(rendered.text, rendered.reasoningCarryForward)
}

function renderDelimitedTextPromptMessages(
  template: TextTemplateConfig,
  messages: readonly TextPromptMessage[],
): RenderedTemplateString {
  const parts: string[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'
  if (template.bos) parts.push(template.bos)
  for (const message of messages) {
    if (message.role === 'user') {
      parts.push(template.userPrefix, message.content, template.userSuffix)
    } else if (message.role === 'assistant') {
      parts.push(template.assistantPrefix, message.content)
      if (!message.is_open) parts.push(template.assistantSuffix)
    } else if (message.role === 'system' || message.role === 'developer') {
      parts.push(template.systemPrefix, message.content, template.systemSuffix)
    }
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      message.reasoningCarryForward,
    )
  }
  if (!messages.at(-1)?.is_open) parts.push(template.assistantPrefix)
  return { text: parts.join(''), reasoningCarryForward }
}

export interface TextPromptProjection {
  readonly messages: readonly TextPromptMessage[]
  readonly reasoningCarryForward: SealedReasoningCarryForward
}

export function projectTextPromptMessagesProjection(
  settings: ChatSettings,
  branch: readonly Message[],
  reasoning: TextReasoningContract,
  providerOutput: AttemptProviderOutputContract,
  options: {
    includeSystemPrompt?: boolean
    reasoningCarryForwardByMessageId?: ReadonlyMap<Message['id'], SealedReasoningCarryForward>
    reasoningResolver?: OutboundReasoningResolver
  } = {},
): TextPromptProjection {
  const reasoningResolver = resolveOutboundReasoningResolver(
    { kind: 'text', contract: reasoning },
    options.reasoningResolver,
  )
  let tailIndex = -1
  let hasImportedSystem = false
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const message = branch[index]
    if (!message || message.hiddenFromContext === true || message.deleted) continue
    if (tailIndex < 0) tailIndex = index
    if (message.role === 'system' || message.role === 'developer') hasImportedSystem = true
  }
  const tail = tailIndex >= 0 ? branch[tailIndex] : undefined
  const tailIsOpenAssistant = tail?.role === 'assistant' && tail.origin === 'prefill'
  const messages: TextPromptMessage[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'
  if (
    options.includeSystemPrompt !== false &&
    !hasImportedSystem &&
    settings.systemPrompt.length > 0
  ) {
    messages.push({
      role: 'system',
      content: settings.systemPrompt,
      is_open: false,
      reasoningCarryForward: 'none',
    })
  }
  for (const [index, message] of branch.entries()) {
    if (message.hiddenFromContext === true || message.deleted) continue
    const text = extractMessageText(message)
    const assistantProjection =
      message.role === 'assistant'
        ? assistantTextForPrompt(
            message,
            text,
            providerOutput,
            settings.toolCallContext.include,
            options.reasoningCarryForwardByMessageId?.get(message.id) ?? 'none',
            reasoningResolver,
          )
        : null
    if (assistantProjection) {
      reasoningCarryForward = mergeSealedReasoningCarryForward(
        reasoningCarryForward,
        assistantProjection.reasoningCarryForward,
      )
    }
    messages.push({
      role: message.role,
      content: assistantProjection?.text ?? text,
      is_open: tailIsOpenAssistant && index === tailIndex,
      reasoningCarryForward: assistantProjection?.reasoningCarryForward ?? 'none',
    })
  }
  return { messages, reasoningCarryForward }
}

export interface TextPromptMessage {
  readonly role: Message['role']
  readonly content: string
  readonly is_open: boolean
  readonly reasoningCarryForward: SealedReasoningCarryForward
}

interface TemplateLoopState {
  index0: number
  index: number
  first: boolean
  last: boolean
  length: number
}

interface TemplateContext {
  readonly messages: readonly TextPromptMessage[]
  readonly add_generation_prompt: boolean
  readonly bos_token: string
  readonly eos_token: string
  readonly variables: unknown[]
  readonly loops: TemplateLoopState[]
}

interface TemplateStringValue {
  readonly kind: 'template-string'
  readonly text: string
  readonly reasoningCarryForward: SealedReasoningCarryForward
}

interface RenderedTemplateString {
  text: string
  reasoningCarryForward: SealedReasoningCarryForward
}

interface TemplateOutputWriter {
  readonly parts: string[]
  reasoningCarryForward: SealedReasoningCarryForward
}

interface TemplateToken {
  kind: 'text' | 'expr' | 'stmt'
  value: string
  trimLeft: boolean
  trimRight: boolean
}

type TemplateNode =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'expr'; readonly expression: TemplateExpression }
  | {
      readonly kind: 'for'
      readonly variableSlot: number
      readonly expression: TemplateExpression
      readonly body: readonly TemplateNode[]
    }
  | {
      readonly kind: 'if'
      readonly branches: readonly {
        readonly condition: TemplateExpression | null
        readonly body: readonly TemplateNode[]
      }[]
    }

type TemplateExpression =
  | { readonly kind: 'literal'; readonly value: unknown }
  | {
      readonly kind: 'path'
      readonly root:
        | 'messages'
        | 'add-generation-prompt'
        | 'bos-token'
        | 'eos-token'
        | 'loop'
        | 'variable'
        | 'unknown'
      readonly variableSlot?: number
      readonly parts: readonly string[]
    }
  | { readonly kind: 'concat'; readonly values: readonly TemplateExpression[] }
  | { readonly kind: 'not'; readonly value: TemplateExpression }
  | {
      readonly kind: 'boolean'
      readonly operator: 'and' | 'or'
      readonly left: TemplateExpression
      readonly right: TemplateExpression
    }
  | {
      readonly kind: 'compare'
      readonly operator: '==' | '!='
      readonly left: TemplateExpression
      readonly right: TemplateExpression
    }

type TemplateExpressionToken =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'atom'; readonly value: string }
  | {
      readonly kind: 'operator'
      readonly value: '+' | '==' | '!=' | '(' | ')' | 'and' | 'or' | 'not'
    }

interface TemplateExpressionParser {
  readonly tokens: readonly TemplateExpressionToken[]
  readonly scope: TemplateCompilerScope
  index: number
}

interface TemplateCompilerScope {
  readonly variableSlots: Map<string, number[]>
  depth: number
}

type TemplateBlockStop = 'endfor' | 'elif' | 'else' | 'endif'

interface ParsedTemplateBlock {
  readonly nodes: readonly TemplateNode[]
  readonly next: number
  readonly stop?: TemplateBlockStop
  readonly stopValue?: string
}

function renderProjectedTemplatePrompt(
  template: TextTemplateConfig,
  messages: readonly TextPromptMessage[],
): RenderedTemplateString {
  const tail = messages.at(-1)
  return renderTemplateString(template.template ?? '', {
    messages,
    add_generation_prompt: !(tail?.role === 'assistant' && tail.is_open),
    bos_token: template.bos,
    eos_token: template.stop[0] ?? '',
    variables: [],
    loops: [],
  })
}

function renderTemplateString(source: string, context: TemplateContext): RenderedTemplateString {
  const tokens = tokenizeTemplate(source)
  const writer: TemplateOutputWriter = { parts: [], reasoningCarryForward: 'none' }
  renderTemplateNodes(
    compileTemplate(tokens, { variableSlots: new Map(), depth: 0 }),
    context,
    writer,
  )
  return { text: writer.parts.join(''), reasoningCarryForward: writer.reasoningCarryForward }
}

function templateStringValue(
  text: string,
  reasoningCarryForward: SealedReasoningCarryForward,
): TemplateStringValue {
  return { kind: 'template-string', text, reasoningCarryForward }
}

function isTemplateStringValue(value: unknown): value is TemplateStringValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'template-string'
  )
}

function tokenizeTemplate(source: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  let index = 0
  let stripNextText = false
  while (index < source.length) {
    const nextIndex = findNextTemplateMarker(source, index)
    if (nextIndex < 0) {
      pushTextToken(tokens, source.slice(index), stripNextText)
      break
    }
    pushTextToken(tokens, source.slice(index, nextIndex), stripNextText)
    const kind: TemplateToken['kind'] = source.startsWith('{{', nextIndex) ? 'expr' : 'stmt'
    const close = kind === 'expr' ? '}}' : '%}'
    let bodyStart = nextIndex + 2
    const trimLeft = source[bodyStart] === '-'
    if (trimLeft) bodyStart += 1
    const closeIndex = findTemplateClose(source, close, bodyStart)
    if (closeIndex < 0) {
      pushTextToken(tokens, source.slice(nextIndex), false)
      break
    }
    let bodyEnd = closeIndex
    const trimRight = source[bodyEnd - 1] === '-'
    if (trimRight) bodyEnd -= 1
    if (trimLeft && tokens.length > 0) {
      const last = tokens[tokens.length - 1]
      if (last?.kind === 'text') last.value = last.value.replace(/\s+$/u, '')
    }
    tokens.push({ kind, value: source.slice(bodyStart, bodyEnd).trim(), trimLeft, trimRight })
    stripNextText = trimRight
    index = closeIndex + 2
  }
  return tokens
}

function findNextTemplateMarker(source: string, start: number): number {
  for (let index = start; index < source.length - 1; index += 1) {
    if (source[index] === '{' && (source[index + 1] === '{' || source[index + 1] === '%')) {
      return index
    }
  }
  return -1
}

function findTemplateClose(source: string, close: '}}' | '%}', start: number): number {
  for (let index = start; index < source.length - 1; index += 1) {
    if (source[index] === close[0] && source[index + 1] === close[1]) return index
  }
  return -1
}

function pushTextToken(tokens: TemplateToken[], value: string, stripLeadingWhitespace: boolean) {
  if (value.length === 0) return
  tokens.push({
    kind: 'text',
    value: stripLeadingWhitespace ? value.replace(/^\s+/u, '') : value,
    trimLeft: false,
    trimRight: false,
  })
}

function compileTemplate(
  tokens: readonly TemplateToken[],
  scope: TemplateCompilerScope,
): readonly TemplateNode[] {
  return parseTemplateBlock(tokens, 0, new Set(), scope).nodes
}

function parseTemplateBlock(
  tokens: readonly TemplateToken[],
  start: number,
  stops: ReadonlySet<TemplateBlockStop>,
  scope: TemplateCompilerScope,
): ParsedTemplateBlock {
  const nodes: TemplateNode[] = []
  let index = start
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) break
    if (token.kind === 'text') {
      nodes.push({ kind: 'text', value: token.value })
      index += 1
      continue
    }
    if (token.kind === 'expr') {
      nodes.push({ kind: 'expr', expression: compileTemplateExpression(token.value, scope) })
      index += 1
      continue
    }
    const stop = templateBlockStop(token.value)
    if (stop && stops.has(stop)) {
      return { nodes, next: index + 1, stop, stopValue: token.value }
    }
    const forMatch = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/u.exec(token.value)
    if (forMatch) {
      const variable = forMatch[1]
      const expression = forMatch[2]
      if (!variable || !expression) {
        index += 1
        continue
      }
      const variableSlot = enterTemplateVariable(scope, variable)
      const body = parseTemplateBlock(tokens, index + 1, new Set(['endfor']), scope)
      leaveTemplateVariable(scope, variable)
      nodes.push({
        kind: 'for',
        variableSlot,
        expression: compileTemplateExpression(expression, scope),
        body: body.nodes,
      })
      index = body.next
      continue
    }
    if (token.value.startsWith('if ')) {
      const parsed = parseTemplateIf(tokens, index + 1, token.value.slice(3).trim(), scope)
      nodes.push(parsed.node)
      index = parsed.next
      continue
    }
    index += 1
  }
  return { nodes, next: index }
}

function parseTemplateIf(
  tokens: readonly TemplateToken[],
  start: number,
  firstCondition: string,
  scope: TemplateCompilerScope,
): { readonly node: Extract<TemplateNode, { kind: 'if' }>; readonly next: number } {
  const branches: Array<{
    condition: TemplateExpression | null
    body: readonly TemplateNode[]
  }> = []
  let condition: TemplateExpression | null = compileTemplateExpression(firstCondition, scope)
  let index = start
  while (index <= tokens.length) {
    const branch = parseTemplateBlock(tokens, index, new Set(['elif', 'else', 'endif']), scope)
    branches.push({ condition, body: branch.nodes })
    index = branch.next
    if (branch.stop === 'elif') {
      condition = compileTemplateExpression(branch.stopValue?.slice(5).trim() ?? '', scope)
      continue
    }
    if (branch.stop === 'else') {
      const fallback = parseTemplateBlock(tokens, index, new Set(['endif']), scope)
      branches.push({ condition: null, body: fallback.nodes })
      index = fallback.next
    }
    break
  }
  return { node: { kind: 'if', branches }, next: index }
}

function enterTemplateVariable(scope: TemplateCompilerScope, variable: string): number {
  const slot = scope.depth
  scope.depth += 1
  const slots = scope.variableSlots.get(variable)
  if (slots) slots.push(slot)
  else scope.variableSlots.set(variable, [slot])
  return slot
}

function leaveTemplateVariable(scope: TemplateCompilerScope, variable: string): void {
  scope.depth -= 1
  const slots = scope.variableSlots.get(variable)
  slots?.pop()
  if (slots?.length === 0) scope.variableSlots.delete(variable)
}

function templateBlockStop(value: string): TemplateBlockStop | undefined {
  if (value === 'endfor' || value === 'else' || value === 'endif') return value
  if (value.startsWith('elif ')) return 'elif'
  return undefined
}

function renderTemplateNodes(
  nodes: readonly TemplateNode[],
  context: TemplateContext,
  writer: TemplateOutputWriter,
): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      writer.parts.push(node.value)
      continue
    }
    if (node.kind === 'expr') {
      appendTemplateExpression(node.expression, context, writer)
      continue
    }
    if (node.kind === 'for') {
      renderForNode(node, context, writer)
      continue
    }
    renderIfNode(node, context, writer)
  }
}

function renderForNode(
  node: Extract<TemplateNode, { kind: 'for' }>,
  context: TemplateContext,
  writer: TemplateOutputWriter,
): void {
  const iterable = evaluateTemplateExpression(node.expression, context)
  if (!Array.isArray(iterable)) return
  const loop: TemplateLoopState = {
    index0: 0,
    index: 1,
    first: true,
    last: iterable.length === 1,
    length: iterable.length,
  }
  context.variables.push(undefined)
  context.loops.push(loop)
  for (let index = 0; index < iterable.length; index += 1) {
    context.variables[node.variableSlot] = iterable[index]
    loop.index0 = index
    loop.index = index + 1
    loop.first = index === 0
    loop.last = index === iterable.length - 1
    renderTemplateNodes(node.body, context, writer)
  }
  context.loops.pop()
  context.variables.pop()
}

function renderIfNode(
  node: Extract<TemplateNode, { kind: 'if' }>,
  context: TemplateContext,
  writer: TemplateOutputWriter,
): void {
  for (const branch of node.branches) {
    if (
      branch.condition === null ||
      comparableTemplateValue(evaluateTemplateExpression(branch.condition, context))
    ) {
      renderTemplateNodes(branch.body, context, writer)
      return
    }
  }
}

function compileTemplateExpression(
  source: string,
  scope: TemplateCompilerScope,
): TemplateExpression {
  const parser: TemplateExpressionParser = {
    tokens: tokenizeTemplateExpression(source),
    scope,
    index: 0,
  }
  return parseTemplateOrExpression(parser)
}

function tokenizeTemplateExpression(source: string): TemplateExpressionToken[] {
  const tokens: TemplateExpressionToken[] = []
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (!char) break
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    if (char === '|') break
    if (char === '"' || char === "'") {
      const quoted = readTemplateQuotedString(source, index, char)
      tokens.push({ kind: 'string', value: quoted.value })
      index = quoted.next
      continue
    }
    const pair = source.slice(index, index + 2)
    if (pair === '==' || pair === '!=') {
      tokens.push({ kind: 'operator', value: pair })
      index += 2
      continue
    }
    if (char === '+' || char === '(' || char === ')') {
      tokens.push({ kind: 'operator', value: char })
      index += 1
      continue
    }
    const atom = readTemplateExpressionAtom(source, index)
    if (atom.next === index) {
      index += 1
      continue
    }
    if (atom.value === 'and' || atom.value === 'or' || atom.value === 'not') {
      tokens.push({ kind: 'operator', value: atom.value })
    } else if (/^-?\d+(?:\.\d+)?$/u.test(atom.value)) {
      tokens.push({ kind: 'number', value: Number(atom.value) })
    } else {
      tokens.push({ kind: 'atom', value: atom.value })
    }
    index = atom.next
  }
  return tokens
}

function readTemplateQuotedString(
  source: string,
  start: number,
  quote: '"' | "'",
): { readonly value: string; readonly next: number } {
  const parts: string[] = []
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (!char) break
    if (char === quote) return { value: parts.join(''), next: index + 1 }
    if (char !== '\\') {
      parts.push(char)
      index += 1
      continue
    }
    const escaped = source[index + 1]
    if (escaped === undefined) {
      parts.push('\\')
      return { value: parts.join(''), next: source.length }
    }
    parts.push(escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped)
    index += 2
  }
  return { value: parts.join(''), next: source.length }
}

function readTemplateExpressionAtom(
  source: string,
  start: number,
): { readonly value: string; readonly next: number } {
  let index = start
  let bracketDepth = 0
  let quote: '"' | "'" | null = null
  while (index < source.length) {
    const char = source[index]
    if (!char) break
    if (quote) {
      if (char === '\\') index += 2
      else {
        if (char === quote) quote = null
        index += 1
      }
      continue
    }
    if (bracketDepth > 0 && (char === '"' || char === "'")) {
      quote = char
      index += 1
      continue
    }
    if (char === '[') {
      bracketDepth += 1
      index += 1
      continue
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1)
      index += 1
      continue
    }
    if (
      bracketDepth === 0 &&
      (/\s/u.test(char) ||
        char === '+' ||
        char === '(' ||
        char === ')' ||
        char === '|' ||
        source.startsWith('==', index) ||
        source.startsWith('!=', index))
    ) {
      break
    }
    index += 1
  }
  return { value: source.slice(start, index), next: index }
}

function parseTemplateOrExpression(parser: TemplateExpressionParser): TemplateExpression {
  let expression = parseTemplateAndExpression(parser)
  while (consumeTemplateOperator(parser, 'or')) {
    expression = {
      kind: 'boolean',
      operator: 'or',
      left: expression,
      right: parseTemplateAndExpression(parser),
    }
  }
  return expression
}

function parseTemplateAndExpression(parser: TemplateExpressionParser): TemplateExpression {
  let expression = parseTemplateNotExpression(parser)
  while (consumeTemplateOperator(parser, 'and')) {
    expression = {
      kind: 'boolean',
      operator: 'and',
      left: expression,
      right: parseTemplateNotExpression(parser),
    }
  }
  return expression
}

function parseTemplateNotExpression(parser: TemplateExpressionParser): TemplateExpression {
  if (consumeTemplateOperator(parser, 'not')) {
    return { kind: 'not', value: parseTemplateNotExpression(parser) }
  }
  return parseTemplateComparisonExpression(parser)
}

function parseTemplateComparisonExpression(parser: TemplateExpressionParser): TemplateExpression {
  const left = parseTemplateConcatExpression(parser)
  const operator = peekTemplateOperator(parser)
  if (operator !== '==' && operator !== '!=') return left
  parser.index += 1
  return {
    kind: 'compare',
    operator,
    left,
    right: parseTemplateConcatExpression(parser),
  }
}

function parseTemplateConcatExpression(parser: TemplateExpressionParser): TemplateExpression {
  const values = [parseTemplatePrimaryExpression(parser)]
  while (consumeTemplateOperator(parser, '+')) {
    values.push(parseTemplatePrimaryExpression(parser))
  }
  return values.length === 1 ? (values[0] as TemplateExpression) : { kind: 'concat', values }
}

function parseTemplatePrimaryExpression(parser: TemplateExpressionParser): TemplateExpression {
  if (consumeTemplateOperator(parser, '(')) {
    const expression = parseTemplateOrExpression(parser)
    consumeTemplateOperator(parser, ')')
    return expression
  }
  const token = parser.tokens[parser.index]
  if (!token) return { kind: 'literal', value: '' }
  parser.index += 1
  if (token.kind === 'string' || token.kind === 'number') {
    return { kind: 'literal', value: token.value }
  }
  if (token.kind === 'atom') {
    if (token.value === 'true' || token.value === 'True') return { kind: 'literal', value: true }
    if (token.value === 'false' || token.value === 'False') return { kind: 'literal', value: false }
    if (token.value === 'none' || token.value === 'None' || token.value === 'null') {
      return { kind: 'literal', value: null }
    }
    return compileTemplatePath(token.value, parser.scope)
  }
  return { kind: 'literal', value: '' }
}

function consumeTemplateOperator(
  parser: TemplateExpressionParser,
  operator: Extract<TemplateExpressionToken, { kind: 'operator' }>['value'],
): boolean {
  if (peekTemplateOperator(parser) !== operator) return false
  parser.index += 1
  return true
}

function peekTemplateOperator(
  parser: TemplateExpressionParser,
): Extract<TemplateExpressionToken, { kind: 'operator' }>['value'] | undefined {
  const token = parser.tokens[parser.index]
  return token?.kind === 'operator' ? token.value : undefined
}

function evaluateTemplateExpression(
  expression: TemplateExpression,
  context: TemplateContext,
): unknown {
  if (expression.kind === 'literal') return expression.value
  if (expression.kind === 'path') return resolveTemplatePath(expression, context)
  if (expression.kind === 'not') {
    return !comparableTemplateValue(evaluateTemplateExpression(expression.value, context))
  }
  if (expression.kind === 'boolean') {
    const left = Boolean(
      comparableTemplateValue(evaluateTemplateExpression(expression.left, context)),
    )
    if (expression.operator === 'and') {
      return (
        left &&
        Boolean(comparableTemplateValue(evaluateTemplateExpression(expression.right, context)))
      )
    }
    return (
      left ||
      Boolean(comparableTemplateValue(evaluateTemplateExpression(expression.right, context)))
    )
  }
  if (expression.kind === 'compare') {
    const left = comparableTemplateValue(evaluateTemplateExpression(expression.left, context))
    const right = comparableTemplateValue(evaluateTemplateExpression(expression.right, context))
    return expression.operator === '==' ? left === right : left !== right
  }
  const writer: TemplateOutputWriter = { parts: [], reasoningCarryForward: 'none' }
  appendTemplateExpression(expression, context, writer)
  return templateStringValue(writer.parts.join(''), writer.reasoningCarryForward)
}

function compileTemplatePath(
  path: string,
  scope: TemplateCompilerScope,
): Extract<TemplateExpression, { kind: 'path' }> {
  const normalized = path.replace(/\[['"]([^'"]+)['"]\]/gu, '.$1').replace(/\[(\d+)\]/gu, '.$1')
  const [root = '', ...parts] = normalized.split('.').filter((part) => part.length > 0)
  if (root === 'messages') return { kind: 'path', root: 'messages', parts }
  if (root === 'add_generation_prompt') {
    return { kind: 'path', root: 'add-generation-prompt', parts }
  }
  if (root === 'bos_token') return { kind: 'path', root: 'bos-token', parts }
  if (root === 'eos_token') return { kind: 'path', root: 'eos-token', parts }
  if (root === 'loop') return { kind: 'path', root: 'loop', parts }
  const slots = scope.variableSlots.get(root)
  const variableSlot = slots?.at(-1)
  return variableSlot === undefined
    ? { kind: 'path', root: 'unknown', parts }
    : { kind: 'path', root: 'variable', variableSlot, parts }
}

function resolveTemplatePath(
  expression: Extract<TemplateExpression, { kind: 'path' }>,
  context: TemplateContext,
): unknown {
  let current: unknown
  if (expression.root === 'messages') current = context.messages
  else if (expression.root === 'add-generation-prompt') current = context.add_generation_prompt
  else if (expression.root === 'bos-token') current = context.bos_token
  else if (expression.root === 'eos-token') current = context.eos_token
  else if (expression.root === 'loop') current = context.loops.at(-1)
  else if (expression.root === 'variable')
    current = context.variables[expression.variableSlot ?? -1]
  else return ''
  for (const part of expression.parts) {
    if (current === null || current === undefined) return ''
    if (Array.isArray(current) && /^\d+$/u.test(part)) {
      current = current[Number(part)]
    } else if (typeof current === 'object') {
      const record = current as Record<string, unknown>
      current =
        part === 'content' && isProjectedTemplateMessage(record)
          ? templateStringValue(record.content, record.reasoningCarryForward)
          : record[part]
    } else {
      return ''
    }
  }
  return current
}

function appendTemplateExpression(
  expression: TemplateExpression,
  context: TemplateContext,
  writer: TemplateOutputWriter,
): void {
  if (expression.kind === 'concat') {
    for (const value of expression.values) appendTemplateExpression(value, context, writer)
    return
  }
  appendTemplateValue(evaluateTemplateExpression(expression, context), writer)
}

function appendTemplateValue(value: unknown, writer: TemplateOutputWriter): void {
  writer.parts.push(stringifyTemplateValue(value))
  writer.reasoningCarryForward = mergeSealedReasoningCarryForward(
    writer.reasoningCarryForward,
    reasoningCarryForwardForTemplateValue(value),
  )
}

function isProjectedTemplateMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Pick<TextPromptMessage, 'content' | 'reasoningCarryForward'> {
  return (
    typeof value.content === 'string' &&
    (value.reasoningCarryForward === 'none' ||
      value.reasoningCarryForward === 'visible-only' ||
      value.reasoningCarryForward === 'carrier')
  )
}

function stringifyTemplateValue(value: unknown): string {
  if (isTemplateStringValue(value)) return value.text
  if (value === null || value === undefined || value === false) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function reasoningCarryForwardForTemplateValue(value: unknown): SealedReasoningCarryForward {
  return isTemplateStringValue(value) ? value.reasoningCarryForward : 'none'
}

function comparableTemplateValue(value: unknown): unknown {
  return isTemplateStringValue(value) ? value.text : value
}

function isPlainContinuationTemplate(template: TextTemplateConfig): boolean {
  return (
    template.bos === '' &&
    template.systemPrefix === '' &&
    template.systemSuffix === '' &&
    template.userPrefix === '' &&
    template.userSuffix === '' &&
    template.assistantPrefix === '' &&
    template.assistantSuffix === '' &&
    template.stop.length === 0
  )
}

function assistantTextForPrompt(
  msg: Message,
  visibleText: string,
  providerOutput: AttemptProviderOutputContract,
  includeToolCalls: boolean,
  rewrittenReasoningCarryForward: SealedReasoningCarryForward,
  reasoningResolver: OutboundReasoningResolver,
): { text: string; reasoningCarryForward: SealedReasoningCarryForward } {
  const appliedView = createAppliedMessageView(msg)
  const reasoningProjection = reasoningThinkBlockForMessage(msg, reasoningResolver)
  const toolContext = renderProviderOutputContextFallback(
    projectProviderOutputForContext(appliedView, providerOutput, {
      includeToolCalls,
    }),
  )
  return {
    text: [reasoningProjection.text, visibleText, toolContext]
      .filter((part): part is string => Boolean(part))
      .join('\n\n'),
    reasoningCarryForward: mergeSealedReasoningCarryForward(
      reasoningProjection.reasoningCarryForward,
      visibleText.length > 0 ? rewrittenReasoningCarryForward : 'none',
    ),
  }
}

function reasoningThinkBlockForMessage(
  message: Message,
  reasoningResolver: OutboundReasoningResolver,
): { text: string | null; reasoningCarryForward: SealedReasoningCarryForward } {
  const compiled = reasoningResolver.compilationFor(message)
  if (compiled.kind !== 'text') throw new Error(`ReasoningRouteMismatch:text:${message.id}`)
  return {
    text: compiled.inline,
    reasoningCarryForward: compiled.reasoningCarryForward,
  }
}

function extractMessageText(msg: Message): string {
  const chunks: string[] = []
  for (const item of msg.content) {
    if (item.type === 'text' || item.type === 'output_text') {
      chunks.push(item.text)
    }
  }
  return chunks.join('')
}
