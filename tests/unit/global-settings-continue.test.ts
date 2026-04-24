import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTINUE_SYSTEM_PROMPT_PLACEHOLDER,
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
  readGlobalPreferences,
  resolveContinueSystemPromptTemplate,
} from '../../src/core/global-settings'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { setSetting } from '../../src/store/settings'

const DB_NAME = 'natter'

async function resetAll() {
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('readGlobalPreferences — continue prompts', () => {
  it('fresh defaults keep both continue prompt slots nonblank', async () => {
    const prefs = await readGlobalPreferences()
    expect(prefs.continueSystemPrompt).toBe(DEFAULT_CONTINUE_SYSTEM_PROMPT)
    expect(prefs.continueUserPrompt).toBe(DEFAULT_CONTINUE_USER_PROMPT)
    expect(prefs.continueSystemPrompt).toContain(CONTINUE_SYSTEM_PROMPT_PLACEHOLDER)
  })

  it('migrates the legacy single continue prompt into the system slot only', async () => {
    await setSetting('global:continue-prompt', 'legacy continue prompt')
    const prefs = await readGlobalPreferences()
    expect(prefs.continueSystemPrompt).toBe('legacy continue prompt')
    expect(prefs.continueUserPrompt).toBe('')
  })

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
      resolveContinueSystemPromptTemplate(
        'Header\n```\n[SYSTEM_PROMPT]\n```',
        'original system',
      ),
    ).toBe('Header\n```\noriginal system\n```')
  })
})
