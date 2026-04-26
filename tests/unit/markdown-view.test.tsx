import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownView } from '../../src/ui/chat/MarkdownView'
import {
  DEFAULT_RENDERING_PREFS,
  RenderingPreferencesContext,
} from '../../src/ui/settings/RenderingSettings'

describe('MarkdownView', () => {
  it('renders an empty surface for empty content without throwing', () => {
    const { container } = render(<MarkdownView content="" />)
    expect(container.querySelector('[data-ui="markdown"]')).toBeTruthy()
  })

  it('renders headings and paragraphs', () => {
    const { container } = render(<MarkdownView content={'# Hello\n\nThis is a paragraph.'} />)
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toMatch(/Hello/)
    expect(container.querySelector('p')?.textContent).toMatch(/paragraph/)
  })

  it('marks external links with rel="noopener noreferrer" and target="_blank"', () => {
    const { container } = render(<MarkdownView content="[open](https://example.com)" />)
    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('href')).toMatch(/https:\/\/example\.com/)
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toMatch(/noopener/)
  })

  it('renders streaming flag on the root when passed', () => {
    const { container } = render(<MarkdownView content="streaming..." streaming />)
    expect(container.querySelector('[data-ui="markdown"][data-streaming="true"]')).toBeTruthy()
  })

  it('blocks images from unlisted origins with a visible fallback', () => {
    const { container } = render(
      <MarkdownView content="![alt text](https://tracker.example.com/pixel.gif)" />,
    )
    const text = container.textContent ?? ''
    expect(text).toMatch(/Blocked image from/)
    expect(container.querySelector('img[src*="tracker.example.com"]')).toBeNull()
  })

  it('allows images from the default allowlist (openrouter.ai)', () => {
    const { container } = render(<MarkdownView content="![alt](https://openrouter.ai/logo.png)" />)
    expect(container.querySelector('img[src="https://openrouter.ai/logo.png"]')).toBeTruthy()
  })

  it('allows user-provided origins at render time', () => {
    const { container } = render(
      <MarkdownView
        content="![a](https://cdn.mysite.example/a.png)"
        allowImageOrigins={['https://cdn.mysite.example']}
      />,
    )
    expect(container.querySelector('img[src="https://cdn.mysite.example/a.png"]')).toBeTruthy()
  })

  it('renders lists, tables, and blockquotes from fixtures', () => {
    const md = `
* item one
* item two

| col a | col b |
|-------|-------|
| foo   | bar   |

> quoted
`.trim()
    const { container } = render(<MarkdownView content={md} />)
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('blockquote')).toBeTruthy()
  })

  it('renders unterminated code fences gracefully (no crash)', () => {
    const md = '```ts\nconst x = 1\n// no closing fence'
    expect(() => render(<MarkdownView content={md} streaming />)).not.toThrow()
  })

  it('leaves currency ranges with single dollar signs as text', () => {
    const { container } = render(
      <MarkdownView content="The usual price recommendation is $10 to $12 per month." />,
    )
    expect(container.textContent).toContain('$10 to $12')
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('still renders double-dollar math', () => {
    const { container } = render(<MarkdownView content="Use $$E = mc^2$$ here." />)
    expect(container.querySelector('.katex')).toBeTruthy()
    expect(container.textContent).toContain('E=mc')
  })

  it('renders single-dollar math when the rendering preference is enabled', () => {
    const { container } = render(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleDollarTextMath: true }}
      >
        <MarkdownView content="Use $x + y$ here." />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('.katex')).toBeTruthy()
    expect(container.textContent).toContain('x+y')
  })

  it('re-renders mounted markdown when the single-dollar preference changes', () => {
    const content = 'Use $x + y$ here.'
    const { container, rerender } = render(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleDollarTextMath: false }}
      >
        <MarkdownView content={content} />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('.katex')).toBeNull()

    rerender(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleDollarTextMath: true }}
      >
        <MarkdownView content={content} />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('.katex')).toBeTruthy()
  })
})
