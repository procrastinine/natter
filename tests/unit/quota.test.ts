import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyQuota,
  isPersisted,
  probePersisted,
  probePersistRequest,
  probeQuota,
  QUOTA_HARD_WARN_RATIO,
  QUOTA_WARN_RATIO,
  requestNotificationPermissionForStoragePersistence,
  requestPersist,
  storagePersistenceAvailable,
  storagePersistenceNotificationMayHelp,
} from '../../src/store/quota'

const originalStorageDescriptor = Object.getOwnPropertyDescriptor(navigator, 'storage')
const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
const originalNotificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification')

function setNavigatorStorage(storage: Partial<StorageManager> | undefined): void {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: storage,
  })
}

function setNavigatorUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  })
}

function setNotificationApi(
  permission: NotificationPermission,
  requestPermissionResult: NotificationPermission = permission,
) {
  const requestPermission = vi
    .fn<() => Promise<NotificationPermission>>()
    .mockResolvedValue(requestPermissionResult)
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: {
      permission,
      requestPermission,
    },
  })
  return { requestPermission }
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalStorageDescriptor) {
    Object.defineProperty(navigator, 'storage', originalStorageDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'storage')
  }
  if (originalUserAgentDescriptor) {
    Object.defineProperty(navigator, 'userAgent', originalUserAgentDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'userAgent')
  }
  if (originalNotificationDescriptor) {
    Object.defineProperty(globalThis, 'Notification', originalNotificationDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'Notification')
  }
})

describe('classifyQuota', () => {
  it('flags ok / warn / hard-warn at the 80% and 95% breakpoints', () => {
    expect(classifyQuota(0, 100)).toBe('ok')
    expect(classifyQuota(79, 100)).toBe('ok')
    expect(classifyQuota(80, 100)).toBe('warn')
    expect(classifyQuota(94, 100)).toBe('warn')
    expect(classifyQuota(95, 100)).toBe('hard-warn')
    expect(classifyQuota(100, 100)).toBe('hard-warn')
  })

  it('returns ok when quota is 0 or negative (division-by-zero safety)', () => {
    expect(classifyQuota(10, 0)).toBe('ok')
    expect(classifyQuota(10, -1)).toBe('ok')
  })

  it('exposes the threshold constants in sync with the body', () => {
    expect(QUOTA_WARN_RATIO).toBe(0.8)
    expect(QUOTA_HARD_WARN_RATIO).toBe(0.95)
  })
})

describe('storage probes (fallback when navigator.storage is unavailable)', () => {
  it('requestPersist resolves to false when the API is missing', async () => {
    expect(await requestPersist()).toBe(false)
  })

  it('isPersisted resolves to false when the API is missing', async () => {
    expect(await isPersisted()).toBe(false)
  })

  it('reports persistent storage support only when both APIs exist', () => {
    expect(storagePersistenceAvailable()).toBe(false)
    setNavigatorStorage({
      persist: vi.fn(),
      persisted: vi.fn(),
    })
    expect(storagePersistenceAvailable()).toBe(true)
  })

  it('wraps the browser persistence calls', async () => {
    const persist = vi.fn<StorageManager['persist']>().mockResolvedValue(true)
    const persisted = vi.fn<StorageManager['persisted']>().mockResolvedValue(true)
    setNavigatorStorage({ persist, persisted })

    expect(await requestPersist()).toBe(true)
    expect(await isPersisted()).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persisted).toHaveBeenCalledTimes(1)
  })

  it('settles missing, rejected, and hung browser probes independently', async () => {
    setNavigatorStorage(undefined)
    await expect(probeQuota()).resolves.toEqual({ status: 'unavailable' })

    setNavigatorStorage({
      estimate: vi.fn<StorageManager['estimate']>().mockImplementation(() => new Promise(() => {})),
      persist: vi.fn<StorageManager['persist']>().mockRejectedValue(new Error('blocked')),
      persisted: vi.fn<StorageManager['persisted']>().mockResolvedValue(false),
    })

    const quota = probeQuota({ timeoutMs: 1 })
    await expect(probePersisted({ timeoutMs: 50 })).resolves.toEqual({
      status: 'ready',
      value: false,
    })
    await expect(probePersistRequest({ timeoutMs: 50 })).resolves.toEqual({
      status: 'error',
      reason: 'failed',
    })
    await expect(quota).resolves.toEqual({ status: 'error', reason: 'timeout' })
  })

  it('requests notification permission for Chromium and Safari persistence requests only', async () => {
    setNavigatorUserAgent(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    )
    const chromeNotification = setNotificationApi('default', 'granted')

    expect(storagePersistenceNotificationMayHelp()).toBe(true)
    expect(await requestNotificationPermissionForStoragePersistence()).toBe('granted')
    expect(chromeNotification.requestPermission).toHaveBeenCalledTimes(1)

    setNavigatorUserAgent('Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')
    const safariNotification = setNotificationApi('default', 'denied')

    expect(storagePersistenceNotificationMayHelp()).toBe(true)
    expect(await requestNotificationPermissionForStoragePersistence()).toBe('denied')
    expect(safariNotification.requestPermission).toHaveBeenCalledTimes(1)

    setNavigatorUserAgent('Mozilla/5.0 Gecko/20100101 Firefox/145.0')
    const firefoxNotification = setNotificationApi('default', 'granted')

    expect(storagePersistenceNotificationMayHelp()).toBe(false)
    expect(await requestNotificationPermissionForStoragePersistence()).toBe('skipped')
    expect(firefoxNotification.requestPermission).not.toHaveBeenCalled()
  })
})
