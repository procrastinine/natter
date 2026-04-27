// Hand-maintained Anthropic capability table. See `plan/07-discovery.md §7.6`.
//
// Parameter names follow Anthropic's Messages API (`stop_sequences`, not
// `stop`; `max_tokens` required). Reasoning shows up as `thinking` on the
// wire for 4.x models; the registry narrows `allowedEffort` / verbosity on
// top of this table. The bundled list stays narrow, 4.5+ families only.

import type { CapabilityTable } from './types'

const CLAUDE_4_6_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'stop_sequences',
  'tools',
  'tool_choice',
  'thinking',
  'verbosity',
  'cache_control',
]

const CLAUDE_4_7_PARAMS = [
  'max_tokens',
  'stop_sequences',
  'tools',
  'tool_choice',
  'thinking',
  'verbosity',
  'cache_control',
]

const CLAUDE_LEGACY_PARAMS = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'stop_sequences',
  'tools',
  'tool_choice',
  'cache_control',
]

export const ANTHROPIC_CAPABILITIES: CapabilityTable = {
  'claude-opus-4.7': {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    family: 'anthropic',
    capability: {
      supportedParameters: CLAUDE_4_7_PARAMS,
      streaming: 'supported',
      contextLength: 200_000,
      maxCompletionTokens: 32_000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      architecture: {
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'claude-opus-4.6': {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    family: 'anthropic',
    capability: {
      supportedParameters: CLAUDE_4_6_PARAMS,
      streaming: 'supported',
      contextLength: 200_000,
      maxCompletionTokens: 32_000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      architecture: {
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'claude-sonnet-4.6': {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    family: 'anthropic',
    capability: {
      supportedParameters: CLAUDE_4_6_PARAMS,
      streaming: 'supported',
      contextLength: 200_000,
      maxCompletionTokens: 64_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: {
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
      },
    },
  },
  'claude-haiku-4.5': {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    family: 'anthropic',
    capability: {
      supportedParameters: CLAUDE_LEGACY_PARAMS,
      streaming: 'supported',
      contextLength: 200_000,
      maxCompletionTokens: 8192,
      pricing: { prompt: '0.0000008', completion: '0.000004' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
  'claude-sonnet-4.5': {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    family: 'anthropic',
    capability: {
      supportedParameters: CLAUDE_LEGACY_PARAMS,
      streaming: 'supported',
      contextLength: 200_000,
      maxCompletionTokens: 64_000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
      architecture: {
        inputModalities: ['text', 'image', 'file'],
        outputModalities: ['text'],
      },
    },
  },
}
