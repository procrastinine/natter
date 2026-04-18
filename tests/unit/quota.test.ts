import { describe, expect, it } from 'vitest'
import {
  classifyQuota,
  estimateQuota,
  isPersisted,
  QUOTA_HARD_WARN_RATIO,
  QUOTA_WARN_RATIO,
  requestPersist,
} from '../../src/store/quota'

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
  it('estimateQuota resolves to null when the API is missing', async () => {
    // jsdom 29 does not implement navigator.storage.estimate; the probe must
    // report "unknown" rather than throw.
    expect(await estimateQuota()).toBeNull()
  })

  it('requestPersist resolves to false when the API is missing', async () => {
    expect(await requestPersist()).toBe(false)
  })

  it('isPersisted resolves to false when the API is missing', async () => {
    expect(await isPersisted()).toBe(false)
  })
})
