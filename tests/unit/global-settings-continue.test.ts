import { describe, expect, it } from 'vitest'
import {
  CONTINUE_SYSTEM_PROMPT_PLACEHOLDER,
  resolveContinueSystemPromptTemplate,
} from '../../src/core/global-settings'

// Continue prompts now live on `chat.settings.continueSystemPrompt` /
// `continueUserPrompt` rather than on GlobalPreferences. The legacy global
// keys migrate into each chat + ChatPreset via the v5 Dexie upgrade; that
// migration is exercised in `tests/integration/continue-prompts-migration`.
// What's left here is the pure template resolver, which still lives in
// `core/global-settings.ts` because the seed defaults do too.

describe('resolveContinueSystemPromptTemplate', () => {
  it('uses no system prompt when the template is blank', () => {
    expect(resolveContinueSystemPromptTemplate('', 'original system')).toBe('')
  })

  it('does not add the original system prompt when the placeholder is absent', () => {
    expect(
      resolveContinueSystemPromptTemplate('continue without reference', 'original system'),
    ).toBe('continue without reference')
  })

  it('uses only the original system prompt when the template is exactly the placeholder', () => {
    expect(
      resolveContinueSystemPromptTemplate(CONTINUE_SYSTEM_PROMPT_PLACEHOLDER, 'original system'),
    ).toBe('original system')
  })

  it('expands placeholder occurrences verbatim, including inside code blocks', () => {
    expect(
      resolveContinueSystemPromptTemplate('Header\n```\n[SYSTEM_PROMPT]\n```', 'original system'),
    ).toBe('Header\n```\noriginal system\n```')
  })
})
