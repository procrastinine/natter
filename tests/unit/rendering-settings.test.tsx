import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RenderingSettings } from '../../src/ui/settings/RenderingSettings'

vi.mock('../../src/store/settings', () => {
  const state = new Map<string, unknown>()
  return {
    async getSetting<T>(key: string): Promise<T | undefined> {
      return state.get(key) as T | undefined
    },
    async setSetting<T>(key: string, value: T): Promise<void> {
      state.set(key, value)
    },
    __get(key: string): unknown {
      return state.get(key)
    },
    __reset(): void {
      state.clear()
    },
  }
})

vi.mock('../../src/store/reactive-query', () => {
  return {
    useRepositoryQuery: <T,>(_key: string, _query: () => Promise<T>, initial: T): T => initial,
    useRepositoryQueryState: <T,>(_key: string, _query: () => Promise<T>, initial: T) => ({
      status: 'ready',
      value: initial,
      error: null,
    }),
  }
})

beforeEach(async () => {
  const mod = (await import('../../src/store/settings')) as unknown as { __reset(): void }
  mod.__reset()
})

describe('RenderingSettings', () => {
  it('shows single-dollar math disabled by default', () => {
    render(<RenderingSettings />)
    expect(screen.getByLabelText('Single-dollar LaTeX markdown')).not.toBeChecked()
  })

  it('shows single-newline hard breaks disabled by default', () => {
    render(<RenderingSettings />)
    expect(screen.getByLabelText('Single newline as line break')).not.toBeChecked()
  })

  it('writes the single-dollar math preference when toggled', async () => {
    render(<RenderingSettings />)
    fireEvent.click(screen.getByLabelText('Single-dollar LaTeX markdown'))
    const mod = (await import('../../src/store/settings')) as unknown as {
      __get(key: string): unknown
    }
    await waitFor(() => {
      expect(mod.__get('rendering-preferences')).toMatchObject({
        singleDollarTextMath: true,
      })
    })
  })

  it('writes the single-newline hard-break preference when toggled', async () => {
    render(<RenderingSettings />)
    fireEvent.click(screen.getByLabelText('Single newline as line break'))
    const mod = (await import('../../src/store/settings')) as unknown as {
      __get(key: string): unknown
    }
    await waitFor(() => {
      expect(mod.__get('rendering-preferences')).toMatchObject({
        singleNewlineHardBreaks: true,
      })
    })
  })
})
