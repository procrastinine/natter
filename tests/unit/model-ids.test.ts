import { describe, expect, it } from 'vitest'
import {
  bestGuessTokenizerFamilyKey,
  canonicalCompatModelId,
  canonicalModelSlug,
  compatModelIdsMatch,
  deterministicStructuralModelId,
  deterministicStructuralModelIdentity,
  tokenCalibrationKey,
} from '../../src/core/model-ids'

describe('model identity normalization', () => {
  it('normalizes shipped crosswalk aliases onto one canonical slug', () => {
    expect(canonicalModelSlug('claude-opus-4-7')).toBe('claude-opus-4.7')
    expect(canonicalModelSlug('anthropic/claude-opus-4.7')).toBe('claude-opus-4.7')
    expect(compatModelIdsMatch('claude-opus-4-7', 'anthropic/claude-opus-4.7')).toBe(true)
    expect(canonicalModelSlug('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(compatModelIdsMatch('claude-opus-4-8', 'anthropic/claude-opus-4.8')).toBe(true)
    expect(deterministicStructuralModelId('models/gemini-3.1-flash-lite-preview')).toBe(
      'google:gemini-3.1-flash-lite-preview',
    )
    expect(
      deterministicStructuralModelId('publishers/google/models/gemini-3.1-flash-lite-preview'),
    ).toBe('google:gemini-3.1-flash-lite-preview')
    expect(deterministicStructuralModelId('gpt-5.5')).toBe('openai:gpt-5.5')
    expect(canonicalModelSlug('openai/gpt-5.5-pro')).toBe('gpt-5.5-pro')
    expect(compatModelIdsMatch('gpt-5.5', 'openai/gpt-5.5')).toBe(true)
  })

  it('maps Anthropic dated ids onto the undated OpenRouter slug', () => {
    expect(canonicalModelSlug('claude-opus-4-7-20260101')).toBe('claude-opus-4-7-20260101')
    expect(canonicalCompatModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4:5')
  })

  it('drops OpenRouter free and thinking suffixes before matching', () => {
    expect(canonicalModelSlug('openai/gpt-5.4:free')).toBe('gpt-5.4')
    expect(canonicalModelSlug('openai/gpt-5.4:thinking')).toBe('gpt-5.4')
    expect(compatModelIdsMatch('openai/gpt-5.4:free', 'gpt-5.4')).toBe(true)
  })

  it('builds a deterministic unified id even when the curated crosswalk has no row yet', () => {
    expect(deterministicStructuralModelId('openai/new-model-1:free')).toBe('openai:new-model-1')
    expect(deterministicStructuralModelId('brand-new-model', 'google')).toBe(
      'google:brand-new-model',
    )
    expect(deterministicStructuralModelId('totally-unknown-model')).toBe('totally-unknown-model')
    expect(deterministicStructuralModelIdentity('qwen/new-model-preview').compatKey).toBe(
      'qwen:new-model-preview',
    )
  })

  it('best-guesses exact official bare ids without loosening to arbitrary lookalikes', () => {
    expect(deterministicStructuralModelId('gpt-5.4')).toBe('openai:gpt-5.4')
    expect(deterministicStructuralModelId('gpt-5.4@openai')).toBe('openai:gpt-5.4')
    expect(deterministicStructuralModelId('openai_gpt_5')).toBe('openai:gpt-5')
    expect(deterministicStructuralModelId('openai_gpt_5_4')).toBe('openai:gpt-5.4')
    expect(deterministicStructuralModelId('gpt-5.4-llama')).toBe('gpt-5.4-llama')
  })

  it('guesses family-level tokenizer sharing for plausible fine-tunes without collapsing to a base model', () => {
    expect(deterministicStructuralModelId('gemma-3-somefinetune')).toBe(
      'google:gemma-3-somefinetune',
    )
    expect(canonicalModelSlug('gemma-3-somefinetune')).toBe('gemma-3-somefinetune')
    expect(bestGuessTokenizerFamilyKey('gemma-3-somefinetune')).toBe('google:gemma3')
  })

  it('uses exact-known matches for tokenizer family guesses and stays strict on unknown lookalikes', () => {
    expect(bestGuessTokenizerFamilyKey('gpt-5.4')).toBe('openai:o200k_base')
    expect(bestGuessTokenizerFamilyKey('gpt-5.4@openai')).toBe('openai:o200k_base')
    expect(bestGuessTokenizerFamilyKey('openai_gpt_5')).toBe('openai:o200k_base')
    expect(bestGuessTokenizerFamilyKey('gpt-5.4-llama')).toBeNull()
    expect(bestGuessTokenizerFamilyKey('asdfmodel')).toBeNull()
  })

  it('normalizes live OpenRouter names onto canonical provider-qualified ids', () => {
    expect(deterministicStructuralModelId('moonshotai/kimi-k2')).toBe('moonshotai:kimi-k2')
    expect(deterministicStructuralModelId('moonshotai/kimi-k2:free')).toBe('moonshotai:kimi-k2')
    expect(deterministicStructuralModelId('minimax/minimax-m1')).toBe('minimax:minimax-m1')
    expect(deterministicStructuralModelId('mistralai/mistral-nemo')).toBe('mistralai:mistral-nemo')
    expect(deterministicStructuralModelId('mistralai/mistral-small-3.2-24b-instruct')).toBe(
      'mistralai:mistral-small-3.2-24b-instruct',
    )
  })

  it('has minimum smartness for bare local-server names from known families', () => {
    expect(deterministicStructuralModelId('deepseek-math-7b-instruct')).toBe(
      'deepseek:deepseek-math-7b-instruct',
    )
    expect(bestGuessTokenizerFamilyKey('deepseek-math-7b-instruct')).toBe('oss:deepseek-v2')
    expect(bestGuessTokenizerFamilyKey('deepseek-v4-local')).toBe('oss:deepseek-v4')
    expect(bestGuessTokenizerFamilyKey('qwen3.6-local')).toBe('oss:qwen3.5-bpe')
    expect(deterministicStructuralModelId('glm-4.5')).toBe('z-ai:glm-4.5')
    expect(deterministicStructuralModelId('glm-4.5@z-ai')).toBe('z-ai:glm-4.5')
    expect(bestGuessTokenizerFamilyKey('glm-4.5')).toBe('oss:glm-4.5-4.7')
    expect(deterministicStructuralModelId('chatglm3-6b')).toBe('z-ai:chatglm3-6b')
    expect(bestGuessTokenizerFamilyKey('chatglm3-6b')).toBe('oss:chatglm2-3')
  })

  it('keeps llama fine-tunes in the llama tokenizer family', () => {
    expect(deterministicStructuralModelId('llama-euryale-70b')).toBe('meta-llama:llama-euryale-70b')
    expect(bestGuessTokenizerFamilyKey('llama-euryale-70b')).toBe('oss:llama3')
  })

  it('uses tokenizer families as the durable calibration key when known', () => {
    expect(tokenCalibrationKey('openai/gpt-4o')).toBe('openai:o200k_base')
    expect(tokenCalibrationKey('google/gemini-2.5-pro-preview-05-06')).toBe('google:gemma3')
    expect(tokenCalibrationKey('llama-euryale-70b')).toBe('oss:llama3')
    expect(tokenCalibrationKey('claude-opus-4-8')).toBe('anthropic:claude-opus-4.8')
    expect(tokenCalibrationKey('anthropic/claude-opus-4.7')).toBe('anthropic:claude-opus-4.7')
  })
})
