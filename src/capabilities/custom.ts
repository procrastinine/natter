// Custom / unknown-endpoint capability defaults. The user explicitly asked
// for a permissive stance: "on custom providers all of the settings should
// just be enabled in case they work." Every common top-level control is
// surfaced; the upstream endpoint will reject what it doesn't understand
// and the user decides whether to prune.
//
// This is the default for every `kind: 'custom'` profile and every unknown
// model id on any non-OpenRouter connection.

import type { CapabilityDescriptor } from '../core/types'

const PERMISSIVE_PARAMETERS: readonly string[] = [
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
  // Custom endpoints rarely advertise their context window in an easy-to-
  // parse form; llama.cpp's /v1/models returns `meta.n_ctx_train` but
  // OpenAI-compatible clients don't read it. 8k is a safe baseline that
  // keeps the Context tab functional — the user can widen it in
  // capabilityOverrides or via the slider.
  contextLength: 8192,
  maxCompletionTokens: 4096,
  architecture: {
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
}
