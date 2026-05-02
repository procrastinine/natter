// Shared text-completions chat-template library.
//
// llama-server can either use its GGUF/server-defined template (`default`)
// or any client-rendered template here. OpenRouter has no embedded template
// surface, so it always uses a client-rendered built-in or saved user template.

import { newId } from '../lib/ulid'
import { getSetting, updateSetting } from '../store/settings'
import { filterReasoningForInclude } from './reasoning'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
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

const SAVED_TEXT_TEMPLATES_KEY = 'global:text-templates:v1'

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

function resolveTextTemplate(
  id: TextTemplateId,
  customFallback?: TextTemplateConfig,
): TextTemplateConfig | null {
  if (id === 'default') return null
  if (id === 'custom') return customFallback ?? EMPTY_TEXT_TEMPLATE
  return TEXT_TEMPLATES[id] ?? null
}

export async function resolveTextTemplateFromLibrary(
  id: TextTemplateId,
  customFallback?: TextTemplateConfig,
): Promise<TextTemplateConfig | null> {
  const builtIn = resolveTextTemplate(id, customFallback)
  if (builtIn || id === 'default' || id === 'custom') return builtIn
  const saved = await readSavedTextTemplates()
  return saved.find((row) => row.id === id)?.config ?? null
}

export async function readSavedTextTemplates(): Promise<SavedTextTemplate[]> {
  const raw = await getSetting<unknown>(SAVED_TEXT_TEMPLATES_KEY)
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeSavedTemplate).filter((row): row is SavedTextTemplate => row !== null)
}

export async function createSavedTextTemplate(input: {
  name: string
  config?: TextTemplateConfig
  now?: number
}): Promise<SavedTextTemplate> {
  const now = input.now ?? Date.now()
  const row: SavedTextTemplate = {
    id: `user:${newId()}`,
    name: input.name.trim() || 'Untitled template',
    config: normalizeTextTemplateConfig(input.config ?? EMPTY_TEXT_TEMPLATE),
    createdAt: now,
    updatedAt: now,
  }
  await updateSetting<SavedTextTemplate[]>(SAVED_TEXT_TEMPLATES_KEY, (current) => [
    ...sanitizeSavedTemplates(current),
    row,
  ])
  return row
}

export async function updateSavedTextTemplate(
  id: TextTemplateId,
  patch: Partial<Omit<SavedTextTemplate, 'id' | 'createdAt'>>,
  now = Date.now(),
): Promise<void> {
  await updateSetting<SavedTextTemplate[]>(SAVED_TEXT_TEMPLATES_KEY, (current) =>
    sanitizeSavedTemplates(current).map((row) => {
      if (row.id !== id) return row
      return {
        ...row,
        ...(patch.name !== undefined ? { name: patch.name.trim() || row.name } : {}),
        ...(patch.config !== undefined
          ? { config: normalizeTextTemplateConfig(patch.config) }
          : {}),
        updatedAt: now,
      }
    }),
  )
}

export async function deleteSavedTextTemplate(id: TextTemplateId): Promise<void> {
  await updateSetting<SavedTextTemplate[]>(SAVED_TEXT_TEMPLATES_KEY, (current) =>
    sanitizeSavedTemplates(current).filter((row) => row.id !== id),
  )
}

function sanitizeSavedTemplates(current: SavedTextTemplate[] | undefined): SavedTextTemplate[] {
  if (!Array.isArray(current)) return []
  return current.map(normalizeSavedTemplate).filter((row): row is SavedTextTemplate => row !== null)
}

function normalizeSavedTemplate(raw: unknown): SavedTextTemplate | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<SavedTextTemplate>
  if (typeof value.id !== 'string' || !value.id.startsWith('user:')) return null
  const name =
    typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Untitled template'
  return {
    id: value.id,
    name,
    config: normalizeTextTemplateConfig(value.config),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  }
}

function normalizeTextTemplateConfig(raw: unknown): TextTemplateConfig {
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

export function renderTextPrompt(
  template: TextTemplateConfig,
  settingsOrSystemPrompt: ChatSettings | string,
  branch: readonly Message[],
): string {
  if (template.template !== undefined) {
    return renderTemplatePrompt(template, settingsOrSystemPrompt, branch)
  }
  const settings = typeof settingsOrSystemPrompt === 'string' ? null : settingsOrSystemPrompt
  const implicitSystemPrompt =
    typeof settingsOrSystemPrompt === 'string'
      ? settingsOrSystemPrompt
      : settingsOrSystemPrompt.systemPrompt
  const systemPrompt = isPlainContinuationTemplate(template) ? '' : implicitSystemPrompt
  const visible = branch.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const parts: string[] = []
  if (template.bos) parts.push(template.bos)
  const hasImportedSystem = visible.some((m) => m.role === 'system' || m.role === 'developer')
  if (!hasImportedSystem && systemPrompt.length > 0) {
    parts.push(template.systemPrefix, systemPrompt, template.systemSuffix)
  }
  const tail = visible.at(-1)
  const tailIsOpenAssistant = tail?.role === 'assistant' && tail.origin === 'prefill'

  for (let index = 0; index < visible.length; index += 1) {
    const msg = visible[index]
    if (!msg) continue
    const text = extractMessageText(msg)
    if (msg.role === 'user') {
      parts.push(template.userPrefix, text, template.userSuffix)
    } else if (msg.role === 'assistant') {
      const renderedText = settings ? assistantTextForPrompt(msg, text, settings) : text
      const open = tailIsOpenAssistant && index === visible.length - 1
      parts.push(template.assistantPrefix, renderedText)
      if (!open) parts.push(template.assistantSuffix)
    } else if (msg.role === 'system' || msg.role === 'developer') {
      parts.push(template.systemPrefix, text, template.systemSuffix)
    }
  }
  if (!tailIsOpenAssistant) parts.push(template.assistantPrefix)
  return parts.join('')
}

interface TemplateMessage {
  role: Message['role']
  content: string
  is_open: boolean
}

interface TemplateLoopState {
  index0: number
  index: number
  first: boolean
  last: boolean
  length: number
}

interface TemplateContext {
  messages: readonly TemplateMessage[]
  add_generation_prompt: boolean
  bos_token: string
  eos_token: string
  vars: Record<string, unknown>
  loop?: TemplateLoopState
}

interface TemplateToken {
  kind: 'text' | 'expr' | 'stmt'
  value: string
  trimLeft: boolean
  trimRight: boolean
}

function renderTemplatePrompt(
  template: TextTemplateConfig,
  settingsOrSystemPrompt: ChatSettings | string,
  branch: readonly Message[],
): string {
  const settings = typeof settingsOrSystemPrompt === 'string' ? null : settingsOrSystemPrompt
  const systemPrompt =
    typeof settingsOrSystemPrompt === 'string'
      ? settingsOrSystemPrompt
      : settingsOrSystemPrompt.systemPrompt
  const messages = buildTemplateMessages(template, settings, systemPrompt, branch)
  const tail = messages.at(-1)
  return renderTemplateString(template.template ?? '', {
    messages,
    add_generation_prompt: !(tail?.role === 'assistant' && tail.is_open),
    bos_token: template.bos,
    eos_token: template.stop[0] ?? '',
    vars: {},
  })
}

function buildTemplateMessages(
  template: TextTemplateConfig,
  settings: ChatSettings | null,
  systemPrompt: string,
  branch: readonly Message[],
): TemplateMessage[] {
  const visible = branch.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const tail = visible.at(-1)
  const tailIsOpenAssistant = tail?.role === 'assistant' && tail.origin === 'prefill'
  const messages: TemplateMessage[] = []
  const hasImportedSystem = visible.some((m) => m.role === 'system' || m.role === 'developer')
  if (template.includeSystemPrompt !== false && !hasImportedSystem && systemPrompt.length > 0) {
    messages.push({ role: 'system', content: systemPrompt, is_open: false })
  }
  for (let index = 0; index < visible.length; index += 1) {
    const msg = visible[index]
    if (!msg) continue
    const text = extractMessageText(msg)
    const content =
      msg.role === 'assistant' && settings ? assistantTextForPrompt(msg, text, settings) : text
    messages.push({
      role: msg.role,
      content,
      is_open: tailIsOpenAssistant && index === visible.length - 1,
    })
  }
  return messages
}

function renderTemplateString(source: string, context: TemplateContext): string {
  const tokens = tokenizeTemplate(source)
  return renderTokenRange(tokens, 0, tokens.length, context)
}

function tokenizeTemplate(source: string): TemplateToken[] {
  const tokens: TemplateToken[] = []
  let index = 0
  let stripNextText = false
  while (index < source.length) {
    const exprIndex = source.indexOf('{{', index)
    const stmtIndex = source.indexOf('{%', index)
    const nextIndex = nextTemplateIndex(exprIndex, stmtIndex)
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
    const closeIndex = source.indexOf(close, bodyStart)
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

function nextTemplateIndex(exprIndex: number, stmtIndex: number): number {
  if (exprIndex < 0) return stmtIndex
  if (stmtIndex < 0) return exprIndex
  return Math.min(exprIndex, stmtIndex)
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

function renderTokenRange(
  tokens: readonly TemplateToken[],
  start: number,
  end: number,
  context: TemplateContext,
): string {
  const out: string[] = []
  let index = start
  while (index < end) {
    const token = tokens[index]
    if (!token) break
    if (token.kind === 'text') {
      out.push(token.value)
      index += 1
      continue
    }
    if (token.kind === 'expr') {
      out.push(stringifyTemplateValue(evaluateTemplateValue(token.value, context)))
      index += 1
      continue
    }
    if (token.value.startsWith('for ')) {
      const close = findMatchingStatement(tokens, index, 'for ', 'endfor')
      if (close < 0) {
        index += 1
        continue
      }
      out.push(renderForStatement(token.value, tokens, index + 1, close, context))
      index = close + 1
      continue
    }
    if (token.value.startsWith('if ')) {
      const resolved = renderIfStatement(tokens, index, context)
      out.push(resolved.output)
      index = resolved.next
      continue
    }
    index += 1
  }
  return out.join('')
}

function renderForStatement(
  statement: string,
  tokens: readonly TemplateToken[],
  start: number,
  end: number,
  context: TemplateContext,
): string {
  const match = /^for\s+([A-Za-z_]\w*)\s+in\s+(.+)$/u.exec(statement)
  if (!match) return ''
  const variable = match[1]
  const expression = match[2]
  if (!variable || !expression) return ''
  const iterable = evaluateTemplateValue(expression, context)
  if (!Array.isArray(iterable)) return ''
  const values = iterable as unknown[]
  return values
    .map((item, index) =>
      renderTokenRange(tokens, start, end, {
        ...context,
        vars: { ...context.vars, [variable]: item },
        loop: {
          index0: index,
          index: index + 1,
          first: index === 0,
          last: index === values.length - 1,
          length: values.length,
        },
      }),
    )
    .join('')
}

function renderIfStatement(
  tokens: readonly TemplateToken[],
  start: number,
  context: TemplateContext,
): { output: string; next: number } {
  const branches = collectIfBranches(tokens, start)
  if (!branches) return { output: '', next: start + 1 }
  for (const branch of branches.branches) {
    if (branch.condition === null || evaluateTemplateBoolean(branch.condition, context)) {
      return {
        output: renderTokenRange(tokens, branch.start, branch.end, context),
        next: branches.end + 1,
      }
    }
  }
  return { output: '', next: branches.end + 1 }
}

function collectIfBranches(
  tokens: readonly TemplateToken[],
  start: number,
): {
  branches: Array<{ condition: string | null; start: number; end: number }>
  end: number
} | null {
  const first = tokens[start]
  if (!first || first.kind !== 'stmt' || !first.value.startsWith('if ')) return null
  const branches: Array<{ condition: string | null; start: number; end: number }> = []
  let condition: string | null = first.value.slice(3).trim()
  let branchStart = start + 1
  let depth = 0
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.kind !== 'stmt') continue
    if (token.value.startsWith('if ')) {
      depth += 1
    } else if (token.value === 'endif') {
      if (depth === 0) {
        branches.push({ condition, start: branchStart, end: index })
        return { branches, end: index }
      }
      depth -= 1
    } else if (depth === 0 && token.value.startsWith('elif ')) {
      branches.push({ condition, start: branchStart, end: index })
      condition = token.value.slice(5).trim()
      branchStart = index + 1
    } else if (depth === 0 && token.value === 'else') {
      branches.push({ condition, start: branchStart, end: index })
      condition = null
      branchStart = index + 1
    }
  }
  return null
}

function findMatchingStatement(
  tokens: readonly TemplateToken[],
  start: number,
  opener: string,
  closer: string,
): number {
  let depth = 0
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token || token.kind !== 'stmt') continue
    if (token.value.startsWith(opener)) {
      depth += 1
    } else if (token.value === closer) {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

function evaluateTemplateBoolean(expression: string, context: TemplateContext): boolean {
  const trimmed = stripOuterParens(expression.trim())
  const orParts = splitByBooleanOperator(trimmed, 'or')
  if (orParts.length > 1) return orParts.some((part) => evaluateTemplateBoolean(part, context))
  const andParts = splitByBooleanOperator(trimmed, 'and')
  if (andParts.length > 1) return andParts.every((part) => evaluateTemplateBoolean(part, context))
  if (trimmed.startsWith('not ')) return !evaluateTemplateBoolean(trimmed.slice(4), context)
  const comparison = splitComparison(trimmed)
  if (comparison) {
    const left = evaluateTemplateValue(comparison.left, context)
    const right = evaluateTemplateValue(comparison.right, context)
    return comparison.operator === '==' ? left === right : left !== right
  }
  return Boolean(evaluateTemplateValue(trimmed, context))
}

function evaluateTemplateValue(expression: string, context: TemplateContext): unknown {
  const trimmed = stripOuterParens(expression.trim())
  const plusParts = splitOutsideQuotes(trimmed, '+')
  if (plusParts.length > 1) {
    return plusParts
      .map((part) => stringifyTemplateValue(evaluateTemplateValue(part, context)))
      .join('')
  }
  const filtered = splitOutsideQuotes(trimmed, '|')[0]?.trim() ?? ''
  if (isQuotedString(filtered)) return parseTemplateString(filtered)
  if (filtered === 'true' || filtered === 'True') return true
  if (filtered === 'false' || filtered === 'False') return false
  if (filtered === 'none' || filtered === 'None' || filtered === 'null') return null
  if (/^-?\d+(\.\d+)?$/u.test(filtered)) return Number(filtered)
  return resolveTemplatePath(filtered, context)
}

function splitByBooleanOperator(expression: string, operator: 'and' | 'or'): string[] {
  const parts: string[] = []
  let quote: string | null = null
  let depth = 0
  let start = 0
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (!char) continue
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (depth !== 0) continue
    if (matchesWordAt(expression, operator, index)) {
      parts.push(expression.slice(start, index).trim())
      start = index + operator.length
      index = start - 1
    }
  }
  if (parts.length === 0) return [expression]
  parts.push(expression.slice(start).trim())
  return parts
}

function matchesWordAt(source: string, word: string, index: number): boolean {
  if (source.slice(index, index + word.length) !== word) return false
  const before = source[index - 1]
  const after = source[index + word.length]
  return !isWordChar(before) && !isWordChar(after)
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/u.test(value)
}

function splitComparison(
  expression: string,
): { left: string; operator: '==' | '!='; right: string } | null {
  const neq = findOperatorOutsideQuotes(expression, '!=')
  if (neq >= 0) {
    return {
      left: expression.slice(0, neq).trim(),
      operator: '!=',
      right: expression.slice(neq + 2).trim(),
    }
  }
  const eq = findOperatorOutsideQuotes(expression, '==')
  if (eq >= 0) {
    return {
      left: expression.slice(0, eq).trim(),
      operator: '==',
      right: expression.slice(eq + 2).trim(),
    }
  }
  return null
}

function findOperatorOutsideQuotes(expression: string, operator: string): number {
  let quote: string | null = null
  for (let index = 0; index <= expression.length - operator.length; index += 1) {
    const char = expression[index]
    if (!char) continue
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (expression.slice(index, index + operator.length) === operator) return index
  }
  return -1
}

function splitOutsideQuotes(expression: string, separator: string): string[] {
  const parts: string[] = []
  let quote: string | null = null
  let start = 0
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (!char) continue
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === separator) {
      parts.push(expression.slice(start, index).trim())
      start = index + 1
    }
  }
  if (parts.length === 0) return [expression]
  parts.push(expression.slice(start).trim())
  return parts
}

function stripOuterParens(expression: string): string {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return expression
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]
    if (!char) continue
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0 && index < expression.length - 1) return expression
    }
  }
  return depth === 0 ? expression.slice(1, -1).trim() : expression
}

function isQuotedString(expression: string): boolean {
  if (expression.length < 2) return false
  const first = expression[0]
  return (first === '"' || first === "'") && expression.at(-1) === first
}

function parseTemplateString(expression: string): string {
  return expression
    .slice(1, -1)
    .replace(/\\n/gu, '\n')
    .replace(/\\r/gu, '\r')
    .replace(/\\t/gu, '\t')
    .replace(/\\"/gu, '"')
    .replace(/\\'/gu, "'")
    .replace(/\\\\/gu, '\\')
}

function resolveTemplatePath(path: string, context: TemplateContext): unknown {
  const normalized = path.replace(/\[['"]([^'"]+)['"]\]/gu, '.$1').replace(/\[(\d+)\]/gu, '.$1')
  const parts = normalized.split('.').filter((part) => part.length > 0)
  if (parts.length === 0) return ''
  const root = parts[0]
  if (!root) return ''
  let current: unknown
  if (root === 'messages') current = context.messages
  else if (root === 'add_generation_prompt') current = context.add_generation_prompt
  else if (root === 'bos_token') current = context.bos_token
  else if (root === 'eos_token') current = context.eos_token
  else if (root === 'loop') current = context.loop
  else current = context.vars[root]
  for (const part of parts.slice(1)) {
    if (current === null || current === undefined) return ''
    if (Array.isArray(current) && /^\d+$/u.test(part)) {
      current = current[Number(part)]
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      return ''
    }
  }
  return current
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined || value === false) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
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

function assistantTextForPrompt(msg: Message, visibleText: string, settings: ChatSettings): string {
  const think = reasoningThinkBlockForMessage(msg, settings)
  if (!think) return visibleText
  return visibleText.length > 0 ? `${think}\n\n${visibleText}` : think
}

function reasoningThinkBlockForMessage(msg: Message, settings: ChatSettings): string | null {
  if (!msg.reasoningDetails || msg.reasoningDetails.length === 0) return null
  const kept = filterReasoningForInclude(
    msg.reasoningDetails,
    settings.reasoning.include,
    undefined,
  )
  const ordered = kept
    .map((detail, position) => ({ detail, position }))
    .sort((left, right) => {
      const li = left.detail.index ?? left.position
      const ri = right.detail.index ?? right.position
      return li - ri || left.position - right.position
    })
    .map((row) => row.detail)
  const parts: string[] = []
  for (const detail of ordered) {
    const text = reasoningDetailPlainText(detail)
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return null
  return `<think>\n${parts.join('\n\n')}\n</think>`
}

function reasoningDetailPlainText(detail: ReasoningDetail): string {
  if (detail.type === 'reasoning.summary') return normalizeThinkPayload(detail.summary)
  if (detail.type === 'reasoning.text') return normalizeThinkPayload(detail.text ?? '')
  return ''
}

function normalizeThinkPayload(value: string): string {
  let text = value.trim()
  let changed = true
  while (changed) {
    const before = text
    text = text
      .replace(/^<think>\s*/iu, '')
      .replace(/\s*<\/think>$/iu, '')
      .replace(/^<thought>\s*/iu, '')
      .replace(/\s*<\/thought>$/iu, '')
      .trim()
    changed = text !== before
  }
  return text
    .replace(/<think>/giu, '<think >')
    .replace(/<\/think>/giu, '</think >')
    .replace(/<thought>/giu, '<thought >')
    .replace(/<\/thought>/giu, '</thought >')
    .trim()
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
