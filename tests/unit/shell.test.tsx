import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'

describe('shell smoke render', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('mounts sidebar, connection-header, and main-pane regions', () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="app-shell"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
    // Connection header sits at the top of main-pane (above the chat-title
    // bar), regardless of whether a connection is configured. This is the
    // entry point users use to add or edit credentials, so it must always be
    // mounted.
    expect(
      container.querySelector('[data-ui="connection-header"]'),
    ).toBeInTheDocument()
    // The shell no longer renders a separate top-of-shell <header> region —
    // the chat title row (only present when a chat is active) is `[data-ui=
    // "chat-title-bar"]` inside main-pane.
    expect(container.querySelector('[data-ui="header"]')).toBeNull()
  })

  it('does NOT render the chat-model panel or global-settings modal by default', () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="chat-model-panel"]')).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-ui="global-settings-overlay"]'),
    ).not.toBeInTheDocument()
    // The shell exposes the chat-model panel state via a data attribute so
    // CSS can grow / shrink the grid columns without remounting.
    expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
      'data-chat-model-panel',
      'closed',
    )
  })

  it('boots without console errors or warnings', () => {
    render(<App />)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
