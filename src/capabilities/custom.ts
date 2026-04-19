// Custom / unknown-endpoint capability defaults. The user explicitly asked
// for a permissive stance: "on custom providers we should just enable all
// of the settings in case they work." We surface every common top-level
// control; the upstream endpoint will reject what it doesn't understand
// and the user decides whether to prune.
//
// This is the default for every `kind: 'custom'` profile and every unknown
// model id on any non-OpenRouter connection.

import type { CapabilityDescriptor } from '../core/types'

export const PERMISSIVE_PARAMETERS: readonly string[] = [
  // Sampling
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  // Output shape
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  'stop',
  'stop_sequences',
  'response_format',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  // Reasoning / verbosity
  'reasoning',
  'thinking',
  'verbosity',
  // Tools
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  // Caching (Anthropic-style)
  'cache_control',
  // Structured outputs / JSON
  'structured_outputs',
  // Include reasoning on wire
  'include_reasoning',
]

export const DEFAULT_CUSTOM_CAPABILITY: CapabilityDescriptor = {
  supportedParameters: [...PERMISSIVE_PARAMETERS],
  streaming: 'supported',
  architecture: {
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
}
