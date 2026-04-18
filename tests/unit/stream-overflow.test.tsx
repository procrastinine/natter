import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageStreamOverflow } from '../../src/ui/chat/MessageStreamOverflow'

describe('MessageStreamOverflow', () => {
  it('renders the full children when under the threshold', () => {
    const { container } = render(
      <MessageStreamOverflow
        totalChars={500}
        truncatedChildren={<div>trunc</div>}
        fullChildren={<div>full</div>}
        threshold={2000}
      />,
    )
    expect(container.textContent).toBe('full')
    expect(container.querySelector('[data-ui="stream-overflow"]')).toBeNull()
  })

  it('shows the truncated children + "show full" affordance when over the threshold', () => {
    render(
      <MessageStreamOverflow
        totalChars={5000}
        truncatedChildren={<div>trunc-sample</div>}
        fullChildren={<div>full-sample</div>}
        threshold={2000}
      />,
    )
    expect(screen.getByText('trunc-sample')).toBeTruthy()
    expect(screen.queryByText('full-sample')).toBeNull()
    expect(screen.getByText(/5,000 characters/)).toBeTruthy()
  })

  it('switches to the full children after the reveal button is clicked', () => {
    render(
      <MessageStreamOverflow
        totalChars={5000}
        truncatedChildren={<div>trunc-sample</div>}
        fullChildren={<div>full-sample</div>}
        threshold={2000}
      />,
    )
    fireEvent.click(screen.getByText('Show full'))
    expect(screen.getByText('full-sample')).toBeTruthy()
    expect(screen.queryByText('trunc-sample')).toBeNull()
  })
})
