import { describe, expect, it } from 'vitest'
import {
  GENERIC_FILE_TOKEN_FALLBACK,
  imageTokenEstimate,
  pdfTokenEstimate,
} from '../../src/core/media-tokens'

describe('imageTokenEstimate', () => {
  it('GPT family uses (w*h)/512 + 85 × 1.05 when dims known', () => {
    // 512 × 512 = 262144; /512 = 512; +85 = 597; ×1.05 = 626.85 → 627
    expect(imageTokenEstimate('gpt', { width: 512, height: 512 })).toBe(627)
  })

  it('Claude family uses (w*h)/750 × 1.05 when dims known', () => {
    // 512 × 512 = 262144; /750 = 349.52 → ceil 350; ×1.05 = 367.5 → ceil 368
    expect(imageTokenEstimate('claude', { width: 512, height: 512 })).toBe(368)
  })

  it('Gemini uses a fixed 258 × 1.05 → 271 baseline', () => {
    // 258 × 1.05 = 270.9 → ceil 271
    expect(imageTokenEstimate('gemini', { width: 1024, height: 1024 })).toBe(271)
  })

  it('falls back to 1024 × 1.05 and caps default OpenRouter images at 1000', () => {
    expect(imageTokenEstimate('gpt', {})).toBe(1000)
    expect(imageTokenEstimate('claude', {})).toBe(1000)
  })

  it('falls back when only one dim is known', () => {
    expect(imageTokenEstimate('gpt', { width: 100 })).toBe(1000)
    expect(imageTokenEstimate('gpt', { height: 100 })).toBe(1000)
  })

  it('normalizes large OpenRouter images before applying the default cap', () => {
    // 3500 × 3500 is normalized to 1400 × 1400 before the OpenAI-style
    // formula, then capped to the usual observed OpenRouter billing shape.
    expect(imageTokenEstimate('gpt', { width: 3500, height: 3500 })).toBe(1000)
  })

  it('uses the Kimi/Moonshot cap for the observed 3500px outlier', () => {
    expect(
      imageTokenEstimate(
        'unknown',
        { width: 3500, height: 3500 },
        { modelId: 'moonshotai/kimi-k2.6' },
      ),
    ).toBe(4000)
  })

  it('detects Kimi IDs with OpenRouter suffixes', () => {
    expect(
      imageTokenEstimate(
        'unknown',
        { width: 3500, height: 3500 },
        { modelId: 'moonshotai/kimi-k2.6:free' },
      ),
    ).toBe(4000)
  })

  it('normalizes absurdly large dims instead of letting raw pixels dominate', () => {
    expect(imageTokenEstimate('gpt', { width: 1_000_000, height: 1_000_000 })).toBe(1000)
  })

  it('caps absurd byte fallbacks at the OpenRouter image cap', () => {
    expect(imageTokenEstimate('gpt', { sizeBytes: 10_000_000_000 })).toBe(1000)
  })
})

describe('pdfTokenEstimate', () => {
  it('uses pageCount × family-rate × 1.05 when pageCount is known', () => {
    // GPT: 3 × 1500 × 1.05 = 4725
    expect(pdfTokenEstimate('gpt', { pageCount: 3 })).toBe(4725)
    // Claude: 3 × 2000 × 1.05 = 6300
    expect(pdfTokenEstimate('claude', { pageCount: 3 })).toBe(6300)
  })

  it('derives pageCount from sizeBytes when pageCount missing', () => {
    // 200_000 / 75_000 = 2.67 → ceil 3 pages. GPT: 3 × 1500 × 1.05 = 4725.
    expect(pdfTokenEstimate('gpt', { sizeBytes: 200_000 })).toBe(4725)
  })

  it('treats < 75_000 bytes as 1 page', () => {
    expect(pdfTokenEstimate('gpt', { sizeBytes: 10_000 })).toBe(1575) // 1 × 1500 × 1.05
  })

  it('falls back to 1 page when both pageCount and sizeBytes are missing', () => {
    expect(pdfTokenEstimate('gpt', {})).toBe(1575) // 1 × 1500 × 1.05
  })

  it('tier 2 (server-parser) uses 500/page regardless of family', () => {
    expect(pdfTokenEstimate('gpt', { pageCount: 4, tier: 'server-parser' })).toBe(2100)
    expect(pdfTokenEstimate('claude', { pageCount: 4, tier: 'server-parser' })).toBe(2100)
    // 4 × 500 × 1.05 = 2100
  })

  it('tier 3 (client-extract) returns 0 — text flows through calibration', () => {
    expect(pdfTokenEstimate('gpt', { pageCount: 5, tier: 'client-extract' })).toBe(0)
    expect(
      pdfTokenEstimate('gpt', { pageCount: 5, tier: 'client-extract', extractedText: 'hi' }),
    ).toBe(0)
  })

  it('caps implausibly enormous PDFs at MAX_PER_ATTACHMENT_TOKENS', () => {
    expect(pdfTokenEstimate('gpt', { pageCount: 1_000_000 })).toBe(10_000_000)
  })
})

describe('GENERIC_FILE_TOKEN_FALLBACK', () => {
  it('exports the constant used by non-PDF file items', () => {
    expect(GENERIC_FILE_TOKEN_FALLBACK).toBe(1000)
  })
})
