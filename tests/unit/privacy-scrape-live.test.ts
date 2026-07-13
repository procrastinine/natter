import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePrivacyPage } from '../../src/api/privacy-scrape'

const LOCAL_FIXTURE_ROOT = join(__dirname, '..', 'fixtures', 'privacy-scrape')

const compactPages = {
  'gpt-5.4': privacyPage([
    policy('Azure', { training: false, retains_prompts: false, can_publish: false }),
    policy('OpenAI', {
      training: false,
      retains_prompts: true,
      requires_user_ids: true,
      can_publish: false,
    }),
  ]),
  'claude-opus-4.7': privacyPage([
    policy('Anthropic', {
      training: false,
      retains_prompts: true,
      retention_days: 30,
      requires_user_ids: true,
      can_publish: false,
    }),
    policy('Amazon Bedrock', {
      training: false,
      retains_prompts: false,
      can_publish: false,
    }),
    policy('Google Vertex', {
      training: false,
      retains_prompts: false,
      requires_user_ids: true,
      can_publish: false,
    }),
  ]),
  'gemini-2.5-pro': privacyPage([
    policy('Google AI Studio', {
      training: false,
      retains_prompts: true,
      retention_days: 55,
      can_publish: false,
    }),
    policy('Google Vertex (Global)', {
      training: false,
      retains_prompts: false,
      can_publish: false,
    }),
  ]),
}

describe('parsePrivacyPage — compact provider-page fixtures', () => {
  assertGptPolicies(compactPages['gpt-5.4'])
  assertClaudePolicies(compactPages['claude-opus-4.7'])
  assertGeminiPolicies(compactPages['gemini-2.5-pro'])
})

const localFiles = {
  'gpt-5.4': join(LOCAL_FIXTURE_ROOT, 'gpt-5.4.html'),
  'claude-opus-4.7': join(LOCAL_FIXTURE_ROOT, 'claude-opus-4.7.html'),
  'gemini-2.5-pro': join(LOCAL_FIXTURE_ROOT, 'gemini-2.5-pro.html'),
}

if (Object.values(localFiles).every((path) => existsSync(path))) {
  describe('parsePrivacyPage — full local provider-page captures', () => {
    assertGptPolicies(readFileSync(localFiles['gpt-5.4'], 'utf8'))
    assertClaudePolicies(readFileSync(localFiles['claude-opus-4.7'], 'utf8'))
    assertGeminiPolicies(readFileSync(localFiles['gemini-2.5-pro'], 'utf8'))
  })
}

function assertGptPolicies(html: string): void {
  const policies = parsePrivacyPage(html)
  it('finds clean Azure and retained OpenAI policies', () => {
    expect(policies.Azure).toMatchObject({ training: false, retainsPrompts: false })
    expect(policies.Azure?.requiresUserIDs).toBeUndefined()
    expect(policies.OpenAI).toMatchObject({
      training: false,
      retainsPrompts: true,
      requiresUserIDs: true,
    })
    expect(policies.OpenAI?.retentionDays).toBeUndefined()
  })
}

function assertClaudePolicies(html: string): void {
  const policies = parsePrivacyPage(html)
  it('finds Anthropic, Bedrock, and Vertex policies', () => {
    expect(policies.Anthropic).toMatchObject({
      retainsPrompts: true,
      retentionDays: 30,
      requiresUserIDs: true,
    })
    expect(policies['Amazon Bedrock']).toMatchObject({ retainsPrompts: false })
    expect(policies['Amazon Bedrock']?.requiresUserIDs).toBeUndefined()
    expect(policies['Google Vertex']).toMatchObject({
      retainsPrompts: false,
      requiresUserIDs: true,
    })
  })
}

function assertGeminiPolicies(html: string): void {
  const policies = parsePrivacyPage(html)
  it('keeps regional Vertex names and AI Studio retention', () => {
    expect(Object.keys(policies)).toContain('Google Vertex (Global)')
    expect(policies['Google AI Studio']).toMatchObject({
      retainsPrompts: true,
      retentionDays: 55,
    })
    expect(policies['Google AI Studio']?.requiresUserIDs).toBeUndefined()
  })
}

function policy(
  providerName: string,
  dataPolicy: Record<string, unknown>,
): Record<string, unknown> {
  return { provider_name: providerName, data_policy: dataPolicy }
}

function privacyPage(rows: Record<string, unknown>[]): string {
  return `<script>window.__PROVIDERS__=${JSON.stringify(rows)}</script>`
}
