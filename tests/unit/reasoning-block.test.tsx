import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
