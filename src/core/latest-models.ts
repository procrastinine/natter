const UPCOMING_OPENROUTER_MODEL_IDS: readonly string[] = Object.freeze(['google/gemini-3.5-pro'])

export const CURRENT_OPENROUTER_MODEL_IDS: readonly string[] = Object.freeze([
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-fable-5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash-lite',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
])

export const OPENROUTER_PROBE_MODEL_IDS: readonly string[] = Object.freeze([
  'google/gemini-3.5-flash-lite',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
  'google/gemini-3.6-flash',
  'openai/gpt-5.6-luna',
  'anthropic/claude-haiku-4.5',
])

export const LATEST_OPENROUTER_MODEL_IDS: readonly string[] = Object.freeze([
  ...CURRENT_OPENROUTER_MODEL_IDS,
  ...UPCOMING_OPENROUTER_MODEL_IDS,
])
