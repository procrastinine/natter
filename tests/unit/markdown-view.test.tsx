import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownView, STREAMING_MARKDOWN_SEGMENT_CHARS } from '../../src/ui/chat/MarkdownView'
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

  it('keeps streaming mode off the root element', () => {
    const { container } = render(<MarkdownView content="streaming..." streaming />)
    expect(container.querySelector('[data-ui="markdown"]')?.getAttribute('data-streaming')).toBe(
      null,
    )
  })

  it('freezes oversized live stream prefixes and keeps the tail streaming', () => {
    const content = `# Heading\n\n${'x'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS + 1)}`
    const { container } = render(<MarkdownView content={content} streaming />)

    expect(container.querySelector('[data-ui="markdown"]')?.getAttribute('data-overflow')).toBe(
      'streaming-segmented',
    )
    const segments = container.querySelectorAll('[data-ui="markdown-segment"]')
    expect(segments).toHaveLength(2)
    expect(segments[0]?.getAttribute('data-mode')).toBe('static')
    expect(segments[1]?.getAttribute('data-mode')).toBe('streaming')
    expect(container.querySelector('h1')?.textContent).toContain('Heading')
  })

  it('refreshes the frozen live-stream prefix as the live window advances', () => {
    const content = `# Heading\n\n${'x'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS * 2 + 1)}`
    const { container } = render(<MarkdownView content={content} streaming />)

    const segments = container.querySelectorAll('[data-ui="markdown-segment"]')
    expect(segments).toHaveLength(2)
    expect(segments[0]?.getAttribute('data-mode')).toBe('static')
    expect(Number(segments[0]?.getAttribute('data-length'))).toBeGreaterThan(
      STREAMING_MARKDOWN_SEGMENT_CHARS,
    )
    expect(segments[1]?.getAttribute('data-mode')).toBe('streaming')
  })

  it('prefers safe boundaries for segmented live-stream content', () => {
    const content = `${'a'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS - 100)}\n\n${'b'.repeat(200)}`
    const { container } = render(
      <MarkdownView
        content=""
        contentSegments={[
          content.slice(0, STREAMING_MARKDOWN_SEGMENT_CHARS),
          content.slice(STREAMING_MARKDOWN_SEGMENT_CHARS),
        ]}
        streaming
      />,
    )

    const segments = container.querySelectorAll('[data-ui="markdown-segment"]')
    expect(segments).toHaveLength(2)
    expect(Number(segments[0]?.getAttribute('data-length'))).toBe(
      STREAMING_MARKDOWN_SEGMENT_CHARS - 98,
    )
    expect(segments[1]?.getAttribute('data-mode')).toBe('streaming')
  })

  it('returns oversized stream content to Markdown after the stream completes', () => {
    const content = `# Heading\n\n${'x'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS + 1)}`
    const { container } = render(<MarkdownView content={content} streaming={false} />)

    expect(container.querySelector('[data-ui="markdown"]')?.getAttribute('data-overflow')).toBe(
      'full',
    )
    expect(container.querySelectorAll('[data-ui="markdown-segment"]')).toHaveLength(1)
    expect(container.querySelector('h1')?.textContent).toContain('Heading')
  })

  it('blocks images from unlisted origins with a visible fallback', () => {
    const { container } = render(
      <MarkdownView content="![alt text](https://tracker.example.com/pixel.gif)" />,
    )
    const text = container.textContent
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

  it('keeps single newlines as soft breaks by default', () => {
    const { container } = render(<MarkdownView content={'alpha\nbeta'} />)
    expect(container.querySelector('p br')).toBeNull()
  })

  it('renders single newlines as hard breaks when the rendering preference is enabled', () => {
    const { container } = render(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleNewlineHardBreaks: true }}
      >
        <MarkdownView content={'alpha\nbeta'} />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('p br')).toBeTruthy()
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

  it('re-renders mounted markdown when the newline preference changes', () => {
    const content = 'alpha\nbeta'
    const { container, rerender } = render(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleNewlineHardBreaks: false }}
      >
        <MarkdownView content={content} />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('p br')).toBeNull()

    rerender(
      <RenderingPreferencesContext.Provider
        value={{ ...DEFAULT_RENDERING_PREFS, singleNewlineHardBreaks: true }}
      >
        <MarkdownView content={content} />
      </RenderingPreferencesContext.Provider>,
    )
    expect(container.querySelector('p br')).toBeTruthy()
  })
})
