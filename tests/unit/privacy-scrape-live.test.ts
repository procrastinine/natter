// Live-fixture parser tests. These consume HTML pages captured via
//   curl https://openrouter.ai/{model}/providers > tests/fixtures/privacy-scrape/<file>.html
// on 2026-04-19, and assert that `parsePrivacyPage` extracts the expected
// provider → policy pairs. See `plan/09-privacy.md §9.4 / §9.6` for the
// data_policy shape and the domination outcomes these fixtures witness.
//
// If OpenRouter re-skins the per-model page, refresh the fixtures with
// fresh curls; the shape the parser expects is stable but the scaffold
// around it changes occasionally.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePrivacyPage } from '../../src/api/privacy-scrape'

function readFixture(name: string): string {
  return readFileSync(join(__dirname, '..', 'fixtures', 'privacy-scrape', name), 'utf8')
}

describe('parsePrivacyPage — GPT-5.4 live fixture', () => {
  const html = readFixture('gpt-5.4.html')
  const policies = parsePrivacyPage(html)

  it('finds Azure (clean) and OpenAI (retained + user IDs)', () => {
    expect(policies).toHaveProperty('Azure')
    expect(policies).toHaveProperty('OpenAI')
  })

  it('Azure policy is clean (no retention, no user IDs)', () => {
    const azure = policies.Azure
    expect(azure?.training).toBe(false)
    expect(azure?.retainsPrompts).toBe(false)
    expect(azure?.requiresUserIDs).toBeUndefined()
  })

  it('OpenAI retains prompts with unknown period and requires user IDs', () => {
    const openai = policies.OpenAI
    expect(openai?.training).toBe(false)
    expect(openai?.retainsPrompts).toBe(true)
    expect(openai?.retentionDays).toBeUndefined() // "unknown" period
    expect(openai?.requiresUserIDs).toBe(true)
  })
})

describe('parsePrivacyPage — Claude Opus 4.7 live fixture', () => {
  const html = readFixture('claude-opus-4.7.html')
  const policies = parsePrivacyPage(html)

  it('finds Anthropic, Amazon Bedrock, and Google Vertex', () => {
    expect(policies).toHaveProperty('Anthropic')
    expect(policies).toHaveProperty('Amazon Bedrock')
    expect(policies).toHaveProperty('Google Vertex')
  })

  it('Anthropic has 30d retention + user IDs', () => {
    const a = policies.Anthropic
    expect(a?.retainsPrompts).toBe(true)
    expect(a?.retentionDays).toBe(30)
    expect(a?.requiresUserIDs).toBe(true)
  })

  it('Amazon Bedrock is clean', () => {
    const b = policies['Amazon Bedrock']
    expect(b?.retainsPrompts).toBe(false)
    expect(b?.requiresUserIDs).toBeUndefined()
  })

  it('Google Vertex is clean on retention but requires user IDs', () => {
    const v = policies['Google Vertex']
    expect(v?.retainsPrompts).toBe(false)
    expect(v?.requiresUserIDs).toBe(true)
  })
})

describe('parsePrivacyPage — Gemini 2.5 Pro live fixture', () => {
  const html = readFixture('gemini-2.5-pro.html')
  const policies = parsePrivacyPage(html)

  it('finds Google AI Studio', () => {
    expect(Object.keys(policies)).toContain('Google AI Studio')
  })

  // The page serializes Vertex as regional variants:
  // "Google Vertex (Global)", "Google Vertex (US)", etc. The JSON
  // `/endpoints` API collapses these to a single "Google" row, so the
  // filter relies on the curated `data_policies.json` fallback to
  // resolve "Google" → clean-retention-with-user-IDs (see
  // `privacy-filter.test.ts` "curated fallback fills gaps"). Here we
  // only assert the scrape correctly extracts the regional names.
  it('emits regional Vertex variants verbatim (names match the HTML)', () => {
    const keys = Object.keys(policies)
    const vertexKeys = keys.filter((k) => k.startsWith('Google Vertex'))
    expect(vertexKeys.length).toBeGreaterThan(0)
    // At least one of them is "(Global)" per the 2026-04-19 snapshot.
    expect(vertexKeys).toContain('Google Vertex (Global)')
  })

  it('AI Studio retains 55 days without user IDs', () => {
    const ai = policies['Google AI Studio']
    expect(ai?.retainsPrompts).toBe(true)
    expect(ai?.retentionDays).toBe(55)
    expect(ai?.requiresUserIDs).toBeUndefined()
  })
})
