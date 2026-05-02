import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeBlock } from '../../src/ui/chat/CodeBlock'

describe('CodeBlock', () => {
  it('renders the code and toolbar with copy + download actions', () => {
    const { container } = render(<CodeBlock code="const x = 1" language="ts" />)
    expect(container.querySelector('[data-ui="code-block"]')).toBeTruthy()
    expect(screen.getByText('ts')).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /download/i })).toBeTruthy()
  })

  it('copies the raw code to the clipboard on Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<CodeBlock code="echo hi" language="sh" />)
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(writeText).toHaveBeenCalledWith('echo hi')
  })

  it('truncates to the first 20 lines when the block is >10_000 lines and offers "Highlight anyway"', () => {
    const huge = Array.from({ length: 10_200 }, (_, i) => `line ${i}`).join('\n')
    render(<CodeBlock code={huge} language="txt" />)
    expect(screen.getByRole('button', { name: /highlight anyway/i })).toBeTruthy()
    const body = document.querySelector('[data-ui="code-block-body"]')
    expect(body?.textContent.split('\n').length).toBeLessThanOrEqual(22)
  })

  it('after "Highlight anyway", renders the full text without the truncated prefix marker', () => {
    const huge = Array.from({ length: 10_500 }, (_, i) => `line ${i}`).join('\n')
    render(<CodeBlock code={huge} language="txt" />)
    fireEvent.click(screen.getByRole('button', { name: /highlight anyway/i }))
    const body = document.querySelector('[data-ui="code-block-body"]')
    expect(body?.textContent).toContain('line 10000')
  })

  it('offers line-numbers=on when content is longer than 5 lines', () => {
    const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    render(<CodeBlock code={manyLines} language="txt" />)
    expect(
      document.querySelector('[data-ui="code-block-body"][data-line-numbers="on"]'),
    ).toBeTruthy()
  })
})
