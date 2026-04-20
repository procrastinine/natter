import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  collapseProfileFor,
  MessageStreamOverflow,
  nextCollapseMode,
} from '../../src/ui/chat/MessageStreamOverflow'

describe('MessageStreamOverflow', () => {
  it('renders the full children in full mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="full"
        fullChildren={<div>full</div>}
        compactChildren={<div>compact</div>}
        peekChildren={<div>peek</div>}
      />,
    )
    expect(container.textContent).toBe('full')
  })

  it('renders the compact children in compact mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="compact"
        fullChildren={<div>full-sample</div>}
        compactChildren={<div>compact-sample</div>}
        peekChildren={<div>peek-sample</div>}
      />,
    )
    expect(container.textContent).toBe('compact-sample')
  })

  it('renders the peek children in peek mode', () => {
    const { container } = render(
      <MessageStreamOverflow
        collapseMode="peek"
        fullChildren={<div>full-sample</div>}
        compactChildren={<div>compact-sample</div>}
        peekChildren={<div>peek-sample</div>}
      />,
    )
    expect(container.textContent).toBe('peek-sample')
  })
})

describe('collapseProfileFor', () => {
  it('keeps short messages on a simple full/peek cycle', () => {
    expect(collapseProfileFor(500)).toEqual({
      defaultMode: 'full',
      modes: ['full', 'peek'],
      oversized: false,
    })
  })

  it('gives long messages a three-step cycle', () => {
    expect(collapseProfileFor(6_000)).toEqual({
      defaultMode: 'full',
      modes: ['full', 'compact', 'peek'],
      oversized: false,
    })
  })

  it('auto-compacts truly oversized messages', () => {
    expect(collapseProfileFor(25_000)).toEqual({
      defaultMode: 'compact',
      modes: ['full', 'compact', 'peek'],
      oversized: true,
    })
  })
})

describe('nextCollapseMode', () => {
  it('cycles through the available states', () => {
    expect(nextCollapseMode('full', ['full', 'compact', 'peek'])).toBe('compact')
    expect(nextCollapseMode('compact', ['full', 'compact', 'peek'])).toBe('peek')
    expect(nextCollapseMode('peek', ['full', 'compact', 'peek'])).toBe('full')
  })
})
