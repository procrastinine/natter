import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MathBlock } from '../../src/ui/chat/MathBlock'

describe('MathBlock', () => {
  it('renders plain math source when no diagnostic tripped', () => {
    const { container } = render(<MathBlock source="E = mc^2" />)
    const node = container.querySelector('[data-ui="math-block"]')
    expect(node?.getAttribute('data-state')).toBe('ok')
  })

  it('flags mismatched braces with a tooltip', () => {
    render(<MathBlock source="\\frac{1}{2" />)
    const node = document.querySelector('[data-ui="math-block"][data-state="error"]')
    expect(node?.getAttribute('title')).toMatch(/mismatched braces/)
    expect(screen.getByText(/Math parse failed: mismatched braces/)).toBeTruthy()
  })

  it('blocks \\href for XSS safety', () => {
    render(<MathBlock source="\\href{http://evil}{click}" />)
    const node = document.querySelector('[data-ui="math-block"][data-state="error"]')
    expect(node?.getAttribute('title')).toMatch(/\\href is blocked/)
  })

  it('flags empty input as a parse error', () => {
    render(<MathBlock source="   " />)
    const node = document.querySelector('[data-ui="math-block"][data-state="error"]')
    expect(node?.getAttribute('title')).toMatch(/empty/)
  })

  it('carries data-display="true" for display-mode math', () => {
    const { container } = render(<MathBlock source="x^2" display />)
    expect(container.querySelector('[data-ui="math-block"][data-display="true"]')).toBeTruthy()
  })
})
