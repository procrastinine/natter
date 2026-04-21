// UI tests for the global-settings Token Calibration section.

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenCalibrationSettings } from '../../src/ui/settings/TokenCalibrationSettings'

// Stub settings store so the useLiveQuery hook doesn't hit real Dexie.
vi.mock('../../src/store/settings', () => {
  const state = new Map<string, unknown>()
  return {
    async getSetting<T>(key: string): Promise<T | undefined> {
      return state.get(key) as T | undefined
    },
    async setSetting<T>(key: string, value: T): Promise<void> {
      state.set(key, value)
    },
    async deleteSetting(key: string): Promise<void> {
      state.delete(key)
    },
    __reset(): void {
      state.clear()
    },
  }
})

// Stub dexie-react-hooks with a trivial live-query replacement. Returns the
// initial default then a resolved value on next tick.
vi.mock('dexie-react-hooks', () => {
  return {
    useLiveQuery: <T,>(
      query: () => Promise<T>,
      _deps: unknown[],
      initial: T,
    ): T | undefined => {
      return initial
    },
  }
})

beforeEach(async () => {
  const mod = (await import('../../src/store/settings')) as unknown as { __reset(): void }
  mod.__reset()
})

describe('TokenCalibrationSettings', () => {
  it('renders all three mode options', () => {
    const { container } = render(
      <TokenCalibrationSettings mode="adaptive" onModeChange={() => {}} />,
    )
    const options = container.querySelectorAll('option')
    expect(options.length).toBe(3)
    const values = Array.from(options).map((o) => (o as HTMLOptionElement).value)
    expect(values).toEqual(['adaptive', 'global-only', 'family-defaults-only'])
  })

  it('shows the helper text for the currently-selected mode', () => {
    const { container, rerender } = render(
      <TokenCalibrationSettings mode="family-defaults-only" onModeChange={() => {}} />,
    )
    expect(container.textContent).toMatch(/hardcoded per-family anchor/i)
    rerender(<TokenCalibrationSettings mode="adaptive" onModeChange={() => {}} />)
    expect(container.textContent).toMatch(/per-chat.*global.*default/i)
  })

  it('shows empty-state hint when no global samples yet', () => {
    const { container } = render(
      <TokenCalibrationSettings mode="adaptive" onModeChange={() => {}} />,
    )
    expect(container.textContent).toMatch(/No cross-chat samples yet/i)
    // No reset button when empty.
    expect(container.querySelector('[data-role="token-calibration-reset"]')).toBeNull()
  })
})
