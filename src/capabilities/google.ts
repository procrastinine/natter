// Hand-maintained Google Gemini capability table. See
// `plan/07-discovery.md §7.6`.
//
// Gemini uses `max_output_tokens` (not `max_tokens`), `stop_sequences`, and
// has its own `thinking_config` shape for reasoning. Bundled params use the
// abstract names; transforms map them to wire shape.

import type { CapabilityTable } from './types'

const GEMINI_3_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'max_output_tokens',
  'stop_sequences',
  'response_format',
  'tools',
  'tool_choice',
  'cache_control',
]

const GEMINI_LEGACY_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'max_output_tokens',
  'stop_sequences',
  'response_format',
  'tools',
  'tool_choice',
]

export const GOOGLE_CAPABILITIES: CapabilityTable = {
  'gemini-3.1-pro': {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_3_PARAMS,
      streaming: 'supported',
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'gemini-3.1-flash': {
    id: 'gemini-3.1-flash',
    name: 'Gemini 3.1 Flash',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_3_PARAMS,
      streaming: 'supported',
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'gemini-3.1-flash-lite-preview': {
    id: 'gemini-3.1-flash-lite-preview',
    name: 'Gemini 3.1 Flash Lite (preview)',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_3_PARAMS,
      streaming: 'supported',
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
      pricing: { prompt: '0.00000005', completion: '0.0000003' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
      },
    },
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_LEGACY_PARAMS,
      streaming: 'supported',
      contextLength: 2_000_000,
      maxCompletionTokens: 8192,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_LEGACY_PARAMS,
      streaming: 'supported',
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash Lite',
    family: 'google',
    capability: {
      supportedParameters: GEMINI_LEGACY_PARAMS,
      streaming: 'supported',
      contextLength: 1_000_000,
      maxCompletionTokens: 65_536,
      pricing: { prompt: '0.00000005', completion: '0.0000003' },
      architecture: {
        inputModalities: ['text', 'image', 'audio', 'video'],
        outputModalities: ['text'],
      },
    },
  },
}
