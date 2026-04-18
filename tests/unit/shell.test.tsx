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

  it('mounts sidebar, header, and main-pane regions', () => {
    const { container } = render(<App />)
    expect(container.querySelector('[data-ui="app-shell"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="header"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
  })

  it('renders the settings overlay shell hidden by default', () => {
    const { container } = render(<App />)
    const overlay = container.querySelector('[data-ui="settings-overlay"]')
    expect(overlay).toBeInTheDocument()
    expect(overlay).not.toBeVisible()
    expect(overlay).toHaveAttribute('aria-hidden', 'true')
  })

  it('boots without console errors or warnings', () => {
    render(<App />)
    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
