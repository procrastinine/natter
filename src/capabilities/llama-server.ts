// llama-server capability defaults. The kind is a dedicated connection
// option (separate from 'custom') so we can ship the llama.cpp-specific
// param set and surface the chat/text protocol toggle without muddling
// the stock OpenAI-compatible defaults.
//
// Every llama-server profile uses this descriptor unless the user pins
// a capability override per model.

import type { CapabilityDescriptor } from '../core/types'

// Superset of OAI-style + llama.cpp-only parameters that llama-server's
// /v1/chat/completions and /v1/completions accept. Names follow the wire
// names llama.cpp expects (see llama_server.md §sampling params and
// §POST /v1/chat/completions).
export const LLAMA_SERVER_PARAMETERS: readonly string[] = [
  // OAI-shared sampling
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'seed',
  // llama.cpp-only sampling
  'typical_p',
  'repeat_penalty',
  'repeat_last_n',
  'dynatemp_range',
  'dynatemp_exponent',
  'mirostat',
  'mirostat_tau',
  'mirostat_eta',
  'xtc_probability',
  'xtc_threshold',
  'dry_multiplier',
  'dry_base',
  'dry_allowed_length',
  'dry_penalty_last_n',
  'n_keep',
  // Output shape
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'response_format',
  'logit_bias',
  // Grammar / JSON schema (llama.cpp-specific server-side constraint)
  'grammar',
  'json_schema',
  // KV-cache reuse
  'cache_prompt',
  // Deliberately omitted: 'reasoning'. Whether a llama-server instance
  // honors the OAI-compat reasoning field depends on the loaded GGUF's
  // chat template, which we can only guess at from `chat_template_caps`.
  // The panel's out-of-the-box presence created false expectations on
  // non-thinking models (gemma etc.), so we hide it entirely. Users on
  // a thinking-capable GGUF can still request raw `<think>` output via
  // the model itself; the UI just doesn't expose an effort knob.
]

export const DEFAULT_LLAMA_SERVER_CAPABILITY: CapabilityDescriptor = {
  supportedParameters: [...LLAMA_SERVER_PARAMETERS],
  streaming: 'supported',
  // Context baseline. The real number comes from the probe's /v1/models
  // response (meta.n_ctx_train) — this just keeps the Context tab sliders
  // functional before the probe lands.
  contextLength: 8192,
  maxCompletionTokens: 4096,
  architecture: {
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
}
