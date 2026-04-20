// Text-completion chat templates for llama-server's /v1/completions path.
//
// For protocol='text', the wire endpoint takes a single `prompt` string
// instead of `messages[]`. We render the branch here by wrapping each
// message's content with the template's role-specific prefix/suffix, then
// appending an opening prefix for the new assistant turn so the server
// completes from there.
//
// Bundled templates mirror the most commonly used instruct presets from
// `SillyTavern/default/content/presets/instruct/*.json`. The shape is
// ours (trimmed to essentials), but the token sequences are copied from
// those presets.
//
// Special ids:
// - 'default' — delegate to the server's own Jinja template via
//   POST /apply-template (handled in api/probe.ts).
// - 'raw'    — concatenate message contents verbatim with no separators.
// - 'custom' — use the `customTextTemplate` on ChatSettings.

import type { Message, TextTemplateConfig, TextTemplateId } from './types'

export interface TextTemplateDescriptor extends TextTemplateConfig {
  id: TextTemplateId
  name: string
}

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
  // Gemma has no dedicated system role — folds into user.
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
  // Mistral V1/V2/V3 style. No system role; system text is prepended
  // inside the first [INST] block by convention (we just route it through
  // the systemPrefix/Suffix and let the user understand).
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
  // DeepSeek V2.5 / V3 — no system role; fold into user per their spec.
  userPrefix: '<｜User｜>',
  userSuffix: '',
  assistantPrefix: '<｜Assistant｜>',
  assistantSuffix: '<｜end▁of▁sentence｜>',
  systemPrefix: '<｜User｜>',
  systemSuffix: '',
  bos: '',
  stop: ['<｜end▁of▁sentence｜>'],
}

const VICUNA: TextTemplateConfig = {
  userPrefix: '\nUSER: ',
  userSuffix: '',
  assistantPrefix: '\nASSISTANT: ',
  assistantSuffix: '</s>',
  // Vicuna prepends "BEGINNING OF CONVERSATION:" to the system text.
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

const RAW: TextTemplateConfig = {
  userPrefix: '',
  userSuffix: '',
  assistantPrefix: '',
  assistantSuffix: '',
  systemPrefix: '',
  systemSuffix: '',
  bos: '',
  stop: [],
}

// Keyed by the stable id that lands in ChatSettings.textTemplate. The
// 'default' and 'custom' ids don't appear here — they're handled via
// /apply-template and ChatSettings.customTextTemplate respectively.
export const TEXT_TEMPLATES: Record<string, TextTemplateDescriptor> = {
  chatml: { id: 'chatml', name: 'ChatML', ...CHATML },
  llama3: { id: 'llama3', name: 'Llama 3 Instruct', ...LLAMA3 },
  llama4: { id: 'llama4', name: 'Llama 4 Instruct', ...LLAMA4 },
  gemma: { id: 'gemma', name: 'Gemma', ...GEMMA },
  mistral: { id: 'mistral', name: 'Mistral (V1–V3)', ...MISTRAL },
  'mistral-v7': { id: 'mistral-v7', name: 'Mistral V7', ...MISTRAL_V7 },
  deepseek: { id: 'deepseek', name: 'DeepSeek', ...DEEPSEEK },
  vicuna: { id: 'vicuna', name: 'Vicuna', ...VICUNA },
  alpaca: { id: 'alpaca', name: 'Alpaca', ...ALPACA },
  commandr: { id: 'commandr', name: 'Command R', ...COMMANDR },
  phi: { id: 'phi', name: 'Phi', ...PHI },
  raw: { id: 'raw', name: 'Raw (no separators)', ...RAW },
}

export const TEXT_TEMPLATE_ORDER: readonly TextTemplateId[] = [
  'default',
  'chatml',
  'llama3',
  'llama4',
  'gemma',
  'mistral',
  'mistral-v7',
  'deepseek',
  'vicuna',
  'alpaca',
  'commandr',
  'phi',
  'raw',
  'custom',
]

// Resolve a template id (+ optional custom override) to a concrete config.
// Returns null when the id is 'default' — the caller must route to
// /apply-template in that case.
export function resolveTextTemplate(
  id: TextTemplateId,
  customFallback?: TextTemplateConfig,
): TextTemplateConfig | null {
  if (id === 'default') return null
  if (id === 'custom') return customFallback ?? RAW
  return TEXT_TEMPLATES[id] ?? null
}

// Render a branch into a text-completion prompt string. The last segment
// is the assistant's prefix (with no content + no suffix) so the server
// completes from there to the next stop sequence.
export function renderTextPrompt(
  template: TextTemplateConfig,
  systemPrompt: string,
  branch: readonly Message[],
): string {
  const parts: string[] = []
  if (template.bos) parts.push(template.bos)
  if (systemPrompt.length > 0) {
    parts.push(template.systemPrefix, systemPrompt, template.systemSuffix)
  }
  for (const msg of branch) {
    const text = extractMessageText(msg)
    if (msg.role === 'user') {
      parts.push(template.userPrefix, text, template.userSuffix)
    } else if (msg.role === 'assistant') {
      parts.push(template.assistantPrefix, text, template.assistantSuffix)
    } else if (msg.role === 'system') {
      parts.push(template.systemPrefix, text, template.systemSuffix)
    }
    // Tool messages are not representable in pure text mode; silently drop.
  }
  parts.push(template.assistantPrefix)
  return parts.join('')
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
