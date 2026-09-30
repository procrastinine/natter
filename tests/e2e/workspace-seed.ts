import type { BrowserContext, Page } from '@playwright/test'
import {
  configureWorkspaceBackup,
  restoreWorkspaceThroughUi,
} from '../../scripts/workspace-provider-fixture.mjs'

export interface SeedOptions {
  model?: string
  disablePrivacyFilter?: boolean
  corsProxyUrl?: string
}

export type WorkspaceSeedTemplate = () => Promise<string>
const bindings = new WeakMap<
  BrowserContext,
  { readonly template: WorkspaceSeedTemplate; readonly applicationUrl: string }
>()
export const DEFAULT_E2E_MODEL = 'google/gemini-3.5-flash'
const DEFAULT_E2E_API_KEY = 'sk-or-v1-test-00000000000000000000000000000000000000000000'
const EMPTY_TEMPLATE_TABLES = [
  'chats',
  'messages',
  'childLists',
  'chatBranchCache',
  'attachments',
  'promptPresets',
  'folders',
  'tags',
  'drafts',
] as const

export function createWorkspaceSeedTemplate(
  produce: () => Promise<Record<string, unknown>>,
): WorkspaceSeedTemplate {
  let result: Promise<string> | undefined
  return () =>
    (result ??= Promise.resolve()
      .then(produce)
      .then((backup) => {
        const payload = backup.payload as Record<string, unknown>
        for (const table of EMPTY_TEMPLATE_TABLES) {
          if (!Array.isArray(payload[table]) || payload[table].length !== 0) {
            throw new Error(`WorkspaceSeedTemplateContainsCaseState:${table}`)
          }
        }
        for (const table of ['profiles', 'presets', 'keys']) {
          if (!Array.isArray(payload[table]) || payload[table].length !== 1) {
            throw new Error(`WorkspaceSeedTemplateConnectionCount:${table}`)
          }
        }
        return JSON.stringify(backup)
      }))
}

export function bindWorkspaceSeedTemplate(
  context: BrowserContext,
  template: WorkspaceSeedTemplate,
  baseURL: string,
): () => void {
  if (bindings.has(context)) throw new Error('WorkspaceSeedTemplateAlreadyBound')
  bindings.set(context, { template, applicationUrl: new URL('/', baseURL).href })
  let bound = true
  return () => {
    if (!bound) return
    bound = false
    bindings.delete(context)
  }
}

export async function seedWorkspaceFromTemplate(page: Page, opts: SeedOptions): Promise<void> {
  const binding = bindings.get(page.context())
  if (!binding) throw new Error('WorkspaceSeedTemplateOwnerMissing')
  const backup = cloneWorkspaceSeedTemplate(await binding.template(), opts)
  await restoreWorkspaceThroughUi(page, backup, {
    filename: 'natter-workspace-seed-fixture.json',
    applicationUrl: binding.applicationUrl,
  })
}

export function cloneWorkspaceSeedTemplate(
  template: string,
  opts: SeedOptions,
  now = Date.now(),
): Record<string, unknown> {
  const backup = configureWorkspaceBackup(JSON.parse(template) as Record<string, unknown>, {
    model: opts.model ?? DEFAULT_E2E_MODEL,
    ...(opts.disablePrivacyFilter === false ? {} : { paretoFilter: false }),
    ...(opts.corsProxyUrl === undefined
      ? {}
      : { workspaceSettings: { 'global:cors-proxy-url': opts.corsProxyUrl } }),
  })
  backup.createdAt = now
  const payload = backup.payload as Record<string, Array<Record<string, unknown>>>
  for (const table of ['profiles', 'presets', 'keys']) {
    for (const row of payload[table] ?? []) {
      for (const field of ['createdAt', 'updatedAt', 'lastUsedAt']) {
        if (typeof row[field] === 'number') row[field] = now
      }
    }
  }
  return backup
}

export async function addFirstRunConnection(page: Page): Promise<void> {
  const currentUrl = new URL(page.url())
  if (currentUrl.pathname !== '/' || currentUrl.hash) await page.goto('/')
  await page.locator('[data-ui="connection-add"]').click()
  await page.locator('[data-ui="connection-setup-key"]').fill(DEFAULT_E2E_API_KEY)
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await page.locator('[data-ui="connection-empty-action"]').waitFor({ state: 'detached' })
}
