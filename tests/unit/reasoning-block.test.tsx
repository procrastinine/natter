import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ReasoningDetail } from '../../src/core/types'
import { ReasoningBlock } from '../../src/ui/chat/ReasoningBlock'

function openSummary(container: HTMLElement) {
  const details = container.querySelector('details')
  if (!details) throw new Error('details missing')
  details.open = true
}

describe('ReasoningBlock', () => {
  it('renders nothing when the details array is empty', () => {
    const { container } = render(<ReasoningBlock details={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a mix of reasoning.summary and reasoning.text faithfully', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        summary: 'Analyzed the problem by breaking it into components',
        id: 'reasoning-summary-1',
        format: 'anthropic-claude-v1',
        index: 0,
      },
      {
        type: 'reasoning.text',
        text: 'Let me work through this systematically:\n1. First consideration...\n2. Second consideration...',
        id: 'reasoning-text-1',
        format: 'anthropic-claude-v1',
        index: 1,
      },
    ]
    const { container } = render(<ReasoningBlock details={details} />)
    openSummary(container)
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="summary"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="text"]'),
    ).toBeTruthy()
    expect(screen.getByText(/Analyzed the problem/)).toBeTruthy()
    expect(screen.getByText(/work through this systematically/)).toBeTruthy()
    expect(container.querySelector('[data-reasoning-format="plaintext"]')).toBeTruthy()
    expect(container.querySelector('[data-reasoning-count="2"]')).toBeTruthy()
  })

  it('flags the block as encrypted when any entry is reasoning.encrypted', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: 'plain text here', id: 't' },
      { type: 'reasoning.encrypted', data: 'AAAABBBB', id: 'e' },
    ]
    const { container } = render(<ReasoningBlock details={details} />)
    expect(container.querySelector('[data-reasoning-format="encrypted"]')).toBeTruthy()
    openSummary(container)
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="encrypted"]'),
    ).toBeTruthy()
    expect(screen.getByText(/8 chars/)).toBeTruthy()
  })

  it('filters out tool-call leakages (id starts with "tool_")', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: 'real reasoning', id: 'reasoning-text-1' },
      {
        type: 'reasoning.text',
        text: 'tool-call sig',
        id: 'tool_call_123',
      },
    ]
    const { container } = render(<ReasoningBlock details={details} />)
    openSummary(container)
    expect(container.querySelector('[data-reasoning-count="1"]')).toBeTruthy()
    expect(screen.getByText('real reasoning')).toBeTruthy()
    expect(screen.queryByText('tool-call sig')).toBeNull()
  })

  it('falls back to a placeholder for empty text/summary', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: '', id: 'r-1' },
      { type: 'reasoning.summary', summary: '   ', id: 's-1' },
    ]
    render(<ReasoningBlock details={details} />)
    const { container } = render(<ReasoningBlock details={details} />)
    openSummary(container)
    expect(screen.getAllByText(/Empty reasoning block/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Empty summary/).length).toBeGreaterThan(0)
  })

  it('tolerates null signature / text (wire null vs undefined)', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.text',
        // @ts-expect-error — wire responses sometimes include explicit nulls.
        text: null,
        id: 'null-text',
      },
    ]
    expect(() => render(<ReasoningBlock details={details} />)).not.toThrow()
  })

  it('auto-expands while streaming with no content yet', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'streaming…', id: 's-1' },
    ]
    const { container } = render(<ReasoningBlock details={details} streaming hasContent={false} />)
    const outer = container.querySelector('details[data-ui="reasoning"]') as HTMLDetailsElement
    expect(outer.open).toBe(true)
    expect(outer.getAttribute('data-streaming')).toBeNull()
  })

  it('renders live reasoning sections contiguously without materializing one growing value', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: '', id: 'text#live', format: 'anthropic-claude-v1' },
      { type: 'reasoning.encrypted', data: '', id: 'encrypted#live' },
    ]
    const { container } = render(
      <ReasoningBlock
        details={details}
        liveRows={[
          { detail: details[0] as ReasoningDetail, valueSections: ['one ', 'two ', 'three'] },
          { detail: details[1] as ReasoningDetail, valueSections: ['A'.repeat(1024), 'B'] },
        ]}
        streaming
      />,
    )
    openSummary(container)
    expect(container.textContent).toContain('one two three')
    expect(container.querySelector('[data-ui="reasoning-lock"]')?.getAttribute('title')).toMatch(
      /1\.0 KB/,
    )
  })

  it('surfaces a lock badge + byte count when encrypted reasoning is present', () => {
    const bytes = 'A'.repeat(2048)
    const details: ReasoningDetail[] = [{ type: 'reasoning.encrypted', data: bytes, id: 'e-1' }]
    const { container } = render(<ReasoningBlock details={details} />)
    const lock = container.querySelector('[data-ui="reasoning-lock"]')
    expect(lock).toBeTruthy()
    expect(lock?.getAttribute('title')).toMatch(/2\.0 KB/)
  })

  it('renders Summary, Details, Encrypted as separate nested disclosures', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'sum', id: 's-1' },
      { type: 'reasoning.text', text: 'text', id: 't-1' },
      { type: 'reasoning.encrypted', data: 'AAAA', id: 'e-1' },
    ]
    const { container } = render(<ReasoningBlock details={details} />)
    const sections = container.querySelectorAll('[data-ui="reasoning-section"]')
    expect(sections).toHaveLength(3)
    const kinds = Array.from(sections).map((el) => el.getAttribute('data-reasoning-kind'))
    expect(kinds).toEqual(['summary', 'text', 'encrypted'])
  })

  it('can keep reasoning rows unmounted until the outer disclosure opens', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'cold summary', id: 's-1' },
      { type: 'reasoning.text', text: 'cold details', id: 't-1' },
    ]
    const { container } = render(<ReasoningBlock details={details} deferContentUntilOpen />)
    const outer = container.querySelector('details[data-ui="reasoning"]') as HTMLDetailsElement

    expect(outer).toBeTruthy()
    expect(outer.open).toBe(false)
    expect(container.querySelector('[data-ui="reasoning-details"]')).toBeNull()
    expect(container.querySelector('[data-ui="reasoning-row"]')).toBeNull()
    expect(container.textContent).not.toContain('cold summary')
    expect(container.textContent).not.toContain('cold details')

    outer.open = true
    fireEvent(outer, new Event('toggle'))

    expect(container.querySelector('[data-ui="reasoning-details"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-ui="reasoning-row"]')).toHaveLength(2)
    expect(container.textContent).toContain('cold summary')
    expect(container.textContent).toContain('cold details')
  })

  it('keeps the existing eager row mounting behavior by default', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: 'eager details', id: 't-1' },
    ]
    const { container } = render(<ReasoningBlock details={details} />)

    expect(container.querySelector('details[data-ui="reasoning"]')?.hasAttribute('open')).toBe(
      false,
    )
    expect(container.querySelector('[data-ui="reasoning-row"]')).toBeTruthy()
    expect(container.textContent).toContain('eager details')
  })

  it('renders a hide button per row when onToggleHidden is supplied and routes the click with the stored detail index', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'first', id: 's-1' },
      { type: 'reasoning.summary', summary: 'second', id: 's-2' },
      { type: 'reasoning.text', text: 'third', id: 't-1' },
    ]
    const onToggle = vi.fn()
    const { container } = render(<ReasoningBlock details={details} onToggleHidden={onToggle} />)
    openSummary(container)
    const hideButtons = container.querySelectorAll('[data-ui="reasoning-row-hide"]')
    expect(hideButtons).toHaveLength(3)
    fireEvent.click(hideButtons[1] as HTMLElement)
    expect(onToggle).toHaveBeenCalledWith(1)
    fireEvent.click(hideButtons[2] as HTMLElement)
    expect(onToggle).toHaveBeenLastCalledWith(2)
  })

  it('marks hidden rows with data-hidden + EyeOff icon', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'visible', id: 's-1' },
      { type: 'reasoning.summary', summary: 'gone', id: 's-2', hidden: true },
    ]
    const { container } = render(<ReasoningBlock details={details} onToggleHidden={() => {}} />)
    openSummary(container)
    const rows = container.querySelectorAll('[data-ui="reasoning-row"]')
    expect(rows[0]?.getAttribute('data-hidden')).toBeNull()
    expect(rows[1]?.getAttribute('data-hidden')).toBe('true')
    const pressedButtons = container.querySelectorAll(
      '[data-ui="reasoning-row-hide"][data-pressed="true"]',
    )
    expect(pressedButtons).toHaveLength(1)
  })

  it('hides the eye button when onToggleHidden is not supplied', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'read only', id: 's-1' },
    ]
    const { container } = render(<ReasoningBlock details={details} />)
    openSummary(container)
    expect(container.querySelector('[data-ui="reasoning-row-hide"]')).toBeNull()
  })
})
