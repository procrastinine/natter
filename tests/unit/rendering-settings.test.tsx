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

vi.mock('dexie-react-hooks', () => {
  return {
    useLiveQuery: <T,>(_query: () => Promise<T>, _deps: unknown[], initial: T): T | undefined => {
      return initial
    },
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
