import { expect, it, vi } from 'vitest'
import { auditTestRuntimeIsolation } from '../../scripts/audit-test-runtime-isolation.mjs'
import { createBrowserWorkspaceSuiteOwner } from '../helpers/browser-workspace-suite'

it('may leave fake timers active inside one test', () => {
  vi.useFakeTimers()
  expect(vi.isFakeTimers()).toBe(true)
})

it('starts the next test with real timers', () => {
  expect(vi.isFakeTimers()).toBe(false)
})

it('drains an admitted workspace open through exactly one owned shutdown', async () => {
  let releaseOpen!: () => void
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve
  })
  const capabilities = {
    open: vi.fn(() => openGate),
    shutdown: vi.fn(async () => undefined),
  }
  const owner = createBrowserWorkspaceSuiteOwner(capabilities)

  const opening = owner.open()
  expect(owner.open()).toBe(opening)
  const disposal = owner.dispose()
  await expect(
    Promise.race([disposal.then(() => 'disposed'), Promise.resolve('pending')]),
  ).resolves.toBe('pending')

  releaseOpen()
  await opening
  await disposal

  expect(capabilities.open).toHaveBeenCalledOnce()
  expect(capabilities.shutdown).toHaveBeenCalledOnce()
  await expect(owner.open()).rejects.toThrow('BrowserWorkspaceSuiteOwnerDisposed')
})

it('requires every raw browser workspace opener to own a shutdown', () => {
  const result = auditTestRuntimeIsolation()

  expect(result.browserWorkspaceLifetimeFileCount).toBeGreaterThan(0)
  expect(result.unownedBrowserWorkspaceLifetimeFiles).toEqual([])
  expect(result.problems).toEqual([])
})
