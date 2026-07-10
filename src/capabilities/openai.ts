// Hand-maintained OpenAI capability table. OpenRouter returns this info
// live via /endpoints; OpenAI-direct ConnectionProfiles lack that, so a
// bundled table populates the ParamForm.
//
// Only the most-used models are listed. Users who need others can add
// entries via ConnectionProfile.capabilityOverrides.

import type { BundledModelEntry, CapabilityTable } from './types'

const TOOLS = ['tools', 'tool_choice', 'parallel_tool_calls'] as const

// GPT-5.4 family — Responses-API-required, no temperature/top_p/top_k per
// the 5.4 migration (see CLAUDE.md per-model quirks).
const GPT_5_4_PARAMS = [
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'response_format',
  'seed',
  'reasoning',
  'verbosity',
  ...TOOLS,
] as const

const GPT_5_5_PLUS_PARAMS = [
  'temperature',
  'top_p',
  'logprobs',
  'max_completion_tokens',
  'response_format',
  'reasoning',
  'verbosity',
  ...TOOLS,
] as const

const GPT_5_5_PRO_PARAMS = GPT_5_5_PLUS_PARAMS.filter(
  (parameter) => !['temperature', 'top_p', 'logprobs'].includes(parameter),
)

function gpt55PlusEntry(
  id: string,
  name: string,
  pricing: { prompt: string; completion: string },
  streaming: 'supported' | 'buffered-only' = 'supported',
  supportedParameters: readonly string[] = GPT_5_5_PLUS_PARAMS,
): BundledModelEntry {
  return {
    id,
    name,
    family: 'openai',
    capability: {
      supportedParameters: [...supportedParameters],
      streaming,
      contextLength: 1_050_000,
      maxCompletionTokens: 128_000,
      pricing,
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  }
}

// GPT-4o and older: classic chat-completions top-level param set.
const GPT_4O_PARAMS = [
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'response_format',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  ...TOOLS,
] as const

export const OPENAI_CAPABILITIES: CapabilityTable = {
  'gpt-5.6-sol': gpt55PlusEntry('gpt-5.6-sol', 'GPT-5.6 Sol', {
    prompt: '0.000005',
    completion: '0.00003',
  }),
  'gpt-5.6-terra': gpt55PlusEntry('gpt-5.6-terra', 'GPT-5.6 Terra', {
    prompt: '0.0000025',
    completion: '0.000015',
  }),
  'gpt-5.6-luna': gpt55PlusEntry('gpt-5.6-luna', 'GPT-5.6 Luna', {
    prompt: '0.000001',
    completion: '0.000006',
  }),
  'gpt-5.5': gpt55PlusEntry('gpt-5.5', 'GPT-5.5', {
    prompt: '0.000005',
    completion: '0.00003',
  }),
  'gpt-5.5-pro': gpt55PlusEntry(
    'gpt-5.5-pro',
    'GPT-5.5 Pro',
    { prompt: '0.00003', completion: '0.00018' },
    'buffered-only',
    GPT_5_5_PRO_PARAMS,
  ),
  'gpt-5.4': {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_5_4_PARAMS],
      streaming: 'supported',
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
  'gpt-5.4-pro': {
    id: 'gpt-5.4-pro',
    name: 'GPT-5.4 Pro',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_5_4_PARAMS],
      streaming: 'supported',
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      pricing: { prompt: '0.0000025', completion: '0.00002' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_5_4_PARAMS],
      streaming: 'supported',
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      pricing: { prompt: '0.00000025', completion: '0.000002' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
  'gpt-5.4-nano': {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_5_4_PARAMS],
      streaming: 'supported',
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      pricing: { prompt: '0.00000005', completion: '0.0000004' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_4O_PARAMS],
      streaming: 'supported',
      contextLength: 128_000,
      maxCompletionTokens: 16_384,
      pricing: { prompt: '0.0000025', completion: '0.00001' },
      architecture: {
        inputModalities: ['text', 'image', 'audio'],
        outputModalities: ['text'],
      },
    },
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    family: 'openai',
    capability: {
      supportedParameters: [...GPT_4O_PARAMS],
      streaming: 'supported',
      contextLength: 128_000,
      maxCompletionTokens: 16_384,
      pricing: { prompt: '0.00000015', completion: '0.0000006' },
      architecture: {
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
    },
  },
}
