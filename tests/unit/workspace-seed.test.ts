import type { BrowserContext, Page } from '@playwright/test'
import { describe, expect, it, vi } from 'vitest'
import type * as WorkspaceProviderFixture from '../../scripts/workspace-provider-fixture.mjs'
import {
  restoreWorkspaceThroughUi,
  waitForWorkspaceRunning,
} from '../../scripts/workspace-provider-fixture.mjs'
import {
  bindWorkspaceSeedTemplate,
  cloneWorkspaceSeedTemplate,
  createWorkspaceSeedTemplate,
  seedWorkspaceFromTemplate,
} from '../e2e/workspace-seed'

vi.mock('../../scripts/workspace-provider-fixture.mjs', async (importOriginal) => {
  const original = await importOriginal<typeof WorkspaceProviderFixture>()
  return { ...original, restoreWorkspaceThroughUi: vi.fn().mockResolvedValue(undefined) }
})

const BASE_URL = 'https://natter.test/nested/path?ignored=1#old'

function blankWorkspace() {
  return {
    createdAt: 1,
    payload: {
      chats: [],
      messages: [],
      childLists: [],
      chatBranchCache: [],
      attachments: [],
      promptPresets: [],
      folders: [],
      tags: [],
      drafts: [],
      profiles: [{ id: 'profile', kind: 'openrouter', createdAt: 1, updatedAt: 1 }],
      presets: [
        {
          id: 'preset',
          connectionProfileId: 'profile',
          createdAt: 1,
          updatedAt: 1,
          settings: { profileId: 'profile', model: 'original', privacy: { paretoFilter: true } },
        },
      ],
      keys: [{ id: 'key', ciphertext: 'synthetic', createdAt: 1 }],
      settings: [{ key: 'other', value: { unchanged: true } }],
    },
  }
}

describe('worker-owned workspace seed template', () => {
  it('observes terminal startup failure before accepting a retained running shell', async () => {
    let predicate: (() => boolean) | undefined
    const page = {
      waitForFunction: async (observe: () => boolean) => {
        predicate = observe
      },
    } as unknown as Page
    await waitForWorkspaceRunning(page)
    if (!predicate) throw new Error('Missing startup observation')
    try {
      for (const state of ['opening', 'blocked']) {
        document.body.innerHTML = `<main data-ui="workspace-bootstrap" data-state="${state}"></main>`
        expect(predicate()).toBe(false)
      }
      document.body.innerHTML =
        '<main data-ui="app-shell" data-workspace-runtime-state="RUNNING"></main>'
      expect(predicate()).toBe(true)
      document.body.insertAdjacentHTML(
        'beforeend',
        '<main data-ui="workspace-bootstrap" data-state="failed"><details data-ui="workspace-bootstrap-diagnostics"><pre>{"stage":"database-open","errorNames":["Error"]}</pre></details></main>',
      )
      expect(predicate).toThrow(
        'WorkspaceStartupFailed: {"stage":"database-open","errorNames":["Error"]}',
      )
    } finally {
      document.body.replaceChildren()
    }
  })

  it('constructs once for concurrent callers and serializes before exposing immutable bytes', async () => {
    const backup = blankWorkspace()
    const produce = vi.fn(async () => backup)
    const template = createWorkspaceSeedTemplate(produce)
    const [first, second] = await Promise.all([template(), template()])
    for (const profile of backup.payload.profiles) profile.kind = 'changed after publication'
    expect(produce).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(await template()).toBe(first)
    const restored = JSON.parse(first) as ReturnType<typeof blankWorkspace>
    expect(restored.payload.profiles[0]?.kind).toBe('openrouter')
  })

  it('keeps profile, model, privacy, settings and timestamps local to each imported clone', async () => {
    const template = await createWorkspaceSeedTemplate(async () => blankWorkspace())()
    const first = cloneWorkspaceSeedTemplate(template, { model: 'one', corsProxyUrl: '/first' }, 10)
    const second = cloneWorkspaceSeedTemplate(
      template,
      {
        model: 'two',
        disablePrivacyFilter: false,
        corsProxyUrl: '/second',
      },
      20,
    )
    const firstPayload = first.payload as ReturnType<typeof blankWorkspace>['payload']
    const secondPayload = second.payload as ReturnType<typeof blankWorkspace>['payload']
    for (const profile of firstPayload.profiles) profile.kind = 'google'
    for (const key of firstPayload.keys) key.ciphertext = 'case mutation'
    firstPayload.settings.length = 0
    expect(secondPayload.profiles[0]).toMatchObject({
      kind: 'openrouter',
      createdAt: 20,
      updatedAt: 20,
    })
    expect(secondPayload.presets[0]).toMatchObject({
      settings: { profileId: 'profile', model: 'two', privacy: { paretoFilter: true } },
      createdAt: 20,
    })
    expect(secondPayload.keys[0]).toMatchObject({ ciphertext: 'synthetic', createdAt: 20 })
    expect(secondPayload.settings).toContainEqual({
      key: 'global:cors-proxy-url',
      value: '/second',
    })
    expect(firstPayload.presets[0]?.settings.privacy.paretoFilter).toBe(false)
    expect(JSON.parse(template)).toEqual(blankWorkspace())
  })

  it('rejects inherited chats, messages and drafts instead of sharing a prior test workspace', async () => {
    for (const table of ['chats', 'messages', 'drafts'] as const) {
      const backup = blankWorkspace()
      ;(backup.payload[table] as unknown[]).push({ id: 'case-state' })
      await expect(createWorkspaceSeedTemplate(async () => backup)()).rejects.toThrow(
        `WorkspaceSeedTemplateContainsCaseState:${table}`,
      )
    }
  })

  it('owns a failed template construction without retrying it in later cases', async () => {
    const failure = new Error('onboarding failed')
    const produce = vi.fn(async () => {
      throw failure
    })
    const template = createWorkspaceSeedTemplate(produce)
    await expect(template()).rejects.toBe(failure)
    await expect(template()).rejects.toBe(failure)
    expect(produce).toHaveBeenCalledTimes(1)
  })

  it.each([
    'about:blank',
    'https://natter.test/#/chat/current',
    'https://another.test/#/chat/unrelated',
  ])(
    'restores %s at the bound origin and leaves destination navigation to its caller',
    async (url) => {
      const context = {} as BrowserContext
      const goto = vi.fn()
      const page = { context: () => context, url: () => url, goto } as unknown as Page
      const template = createWorkspaceSeedTemplate(async () => blankWorkspace())
      const release = bindWorkspaceSeedTemplate(context, template, BASE_URL)
      vi.mocked(restoreWorkspaceThroughUi).mockClear()
      try {
        await seedWorkspaceFromTemplate(page, {})
        expect(restoreWorkspaceThroughUi).toHaveBeenCalledTimes(1)
        expect(restoreWorkspaceThroughUi).toHaveBeenCalledWith(page, expect.any(Object), {
          filename: 'natter-workspace-seed-fixture.json',
          applicationUrl: 'https://natter.test/',
        })
        expect(goto).not.toHaveBeenCalled()
      } finally {
        release()
      }
    },
  )

  it('requires the current test context owner and releases the binding at teardown', async () => {
    const context = {} as BrowserContext
    const page = { context: () => context } as Page
    const template = createWorkspaceSeedTemplate(async () => blankWorkspace())
    await expect(seedWorkspaceFromTemplate(page, {})).rejects.toThrow(
      'WorkspaceSeedTemplateOwnerMissing',
    )
    const release = bindWorkspaceSeedTemplate(context, template, BASE_URL)
    expect(() => bindWorkspaceSeedTemplate(context, template, BASE_URL)).toThrow(
      'WorkspaceSeedTemplateAlreadyBound',
    )
    release()
    await expect(seedWorkspaceFromTemplate(page, {})).rejects.toThrow(
      'WorkspaceSeedTemplateOwnerMissing',
    )
    const releaseNext = bindWorkspaceSeedTemplate(context, template, BASE_URL)
    release()
    expect(() => bindWorkspaceSeedTemplate(context, template, BASE_URL)).toThrow(
      'WorkspaceSeedTemplateAlreadyBound',
    )
    releaseNext()
  })
})
