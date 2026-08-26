import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../../src/core/sidebar-sort'
import { ConfigurationPreferencesContext } from '../../src/hooks/useConfigurationPreferences'
import {
  createStreamingMarkdownSegmentCache,
  MarkdownView,
  PROGRESSIVE_STATIC_MARKDOWN_CHARS,
  STREAMING_MARKDOWN_SEGMENT_CHARS,
  segmentStreamingMarkdownForTests,
} from '../../src/ui/chat/MarkdownView'
import { RenderingPreferencesContext } from '../../src/ui/settings/RenderingSettings'

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

  it('keeps an adversarial oversized fenced stream whole until its closing boundary', () => {
    const cache = createStreamingMarkdownSegmentCache()
    const openFence = `\`\`\`ts\n${'x\n'.repeat(10_001)}stream-tail`
    const beforeClose = segmentStreamingMarkdownForTests(
      [openFence.slice(0, 19_997), openFence.slice(19_997)],
      cache,
    )

    expect(beforeClose).toEqual([{ content: openFence, streaming: true }])

    const closed = `${openFence}\n\`\`\`\n\nafter`
    const afterClose = segmentStreamingMarkdownForTests(
      [openFence.slice(0, 19_997), openFence.slice(19_997), closed.slice(openFence.length)],
      cache,
    )
    expect(afterClose[0]).toEqual({ content: `${openFence}\n\`\`\`\n`, streaming: false })
    expect(afterClose[1]).toEqual({ content: '\nafter', streaming: true })
  })

  it('bounds an oversized fenced block while it is still streaming', () => {
    const code = `\`\`\`ts\n${'x\n'.repeat(10_001)}still-streaming`
    const { container } = render(
      <MarkdownView
        content=""
        contentSegments={[code.slice(0, 19_997), code.slice(19_997)]}
        streaming
      />,
    )

    expect(
      container.querySelector('[data-ui="code-block"][data-overflow="truncated"]'),
    ).toBeTruthy()
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull()
  })

  it('does not rescan an unchanged frozen prefix when the live tail advances', () => {
    const prefix = `${'a'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS - 100)}\n\n${'b'.repeat(98)}`
    const cache = createStreamingMarkdownSegmentCache()
    const nativeIndexOf = String.prototype.indexOf
    let scanPositions: number[] = []
    const indexOf = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      searchString: string,
      position?: number,
    ) {
      if (searchString === '\n') scanPositions.push(position ?? 0)
      return nativeIndexOf.call(this, searchString, position)
    })

    try {
      segmentStreamingMarkdownForTests([prefix, 'tail'], cache)
      expect(scanPositions.length).toBeGreaterThan(0)
      const scannedThrough = cache.boundaryScanOffset

      scanPositions = []
      segmentStreamingMarkdownForTests([prefix, 'tail', '-advanced'], cache)
      expect(scanPositions.every((position) => position >= scannedThrough)).toBe(true)
    } finally {
      indexOf.mockRestore()
    }
  })

  it('keeps cumulative prefix boundary work linear and projected blocks logarithmic', () => {
    const cache = createStreamingMarkdownSegmentCache()
    const section = 'x'.repeat(STREAMING_MARKDOWN_SEGMENT_CHARS)
    const sectionCount = 64
    const totalLength = section.length * sectionCount
    const segmentBudget = Math.floor(Math.log2(sectionCount)) + 1
    const nativeLastIndexOf = String.prototype.lastIndexOf
    let boundaryScanChars = 0
    let projectedSegmentVisits = 0
    let content = ''
    let finalSegments: ReadonlyArray<{ content: string; streaming: boolean }> = []
    const lastIndexOf = vi.spyOn(String.prototype, 'lastIndexOf').mockImplementation(function (
      this: string,
      searchString: string,
      position?: number,
    ) {
      if (searchString === '\n\n' || searchString === '\n') {
        boundaryScanChars += String(this).length
      }
      return nativeLastIndexOf.call(this, searchString, position)
    })

    try {
      for (let index = 0; index < sectionCount; index += 1) {
        content += section
        finalSegments = segmentStreamingMarkdownForTests([content], cache)
        expect(finalSegments.length).toBeLessThanOrEqual(segmentBudget)
        projectedSegmentVisits += finalSegments.length
      }
    } finally {
      lastIndexOf.mockRestore()
    }

    expect(boundaryScanChars).toBeLessThanOrEqual(totalLength * 3)
    expect(projectedSegmentVisits).toBeLessThanOrEqual(sectionCount * segmentBudget)
    expect(finalSegments.map((segment) => segment.content).join('')).toBe(content)
    expect(finalSegments.at(-1)?.streaming).toBe(true)
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

  it('reserves the exact skipped-prefix geometry while a long static body completes', () => {
    const content = `${'x'.repeat(PROGRESSIVE_STATIC_MARKDOWN_CHARS)}\n\ntail`
    const { container } = render(<MarkdownView content={content} />)
    const spacer = container.querySelector<HTMLElement>('[data-ui="markdown-progressive-prefix"]')
    if (!spacer) throw new Error('progressive static prefix spacer missing')
    const prefixLength = Number(spacer.dataset.length)
    const expectedHeight = Math.min(2_000_000, Math.ceil(prefixLength / 84) * 22)

    expect(prefixLength).toBeGreaterThan(0)
    expect(spacer.style.getPropertyValue('--virtual-spacer-height')).toBe(`${expectedHeight}px`)
  })

  it('reparses the joined terminal document instead of retaining frozen stream seams', () => {
    const content = `# Heading\n\n${'word '.repeat(8_000)}\n\nTerminal paragraph`
    const { container, rerender } = render(
      <MarkdownView content="" contentSegments={[content]} streaming renderRevision={1} />,
    )
    const frozenPrefix = container.querySelector<HTMLElement>(
      '[data-ui="markdown-segment"][data-mode="static"]',
    )
    if (!frozenPrefix) throw new Error('streaming prefix did not freeze')
    frozenPrefix.dataset.finalizationAnchor = 'retained'

    rerender(
      <MarkdownView content="" contentSegments={[content]} streaming={false} renderRevision={2} />,
    )

    expect(container.querySelector('[data-finalization-anchor="retained"]')).toBeNull()
    expect(container.querySelector('[data-overflow="progressive-static"]')).toBeNull()
    expect(container.querySelectorAll('[data-ui="markdown-segment"]')).toHaveLength(1)
    expect(container.querySelector('[data-ui="markdown-segment"]')?.getAttribute('data-mode')).toBe(
      'static',
    )
    expect(Array.from(container.querySelectorAll('p')).at(-1)?.textContent).toBe(
      'Terminal paragraph',
    )
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

  it('applies the resident custom origin policy without one prop per message', () => {
    const { container } = render(
      <ConfigurationPreferencesContext.Provider
        value={{
          global: DEFAULT_GLOBAL_PREFERENCES,
          rendering: DEFAULT_RENDERING_PREFS,
          sidebarSortMode: DEFAULT_SIDEBAR_SORT_MODE,
          collapsedFolderIds: [],
          imageAllowlist: ['https://cdn.workspace.example'],
          samplePromptsDismissed: false,
        }}
      >
        <MarkdownView content="![a](https://cdn.workspace.example/a.png)" />
      </ConfigurationPreferencesContext.Provider>,
    )
    expect(container.querySelector('img[src="https://cdn.workspace.example/a.png"]')).toBeTruthy()
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

  it('routes oversized fences through the bounded production renderer before Shiki', async () => {
    const finalLine = 'must-stay-cold-until-explicit-highlight'
    const code = `${'x\n'.repeat(10_001)}${finalLine}`
    const { container } = render(<MarkdownView content={`\`\`\`ts\n${code}\n\`\`\``} />)

    expect(
      container.querySelector('[data-ui="code-block"][data-overflow="truncated"]'),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /highlight anyway/i })).toBeEnabled()
    expect(container.textContent).not.toContain(finalLine)
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /highlight anyway/i }))
    await waitFor(() =>
      expect(container.querySelector('[data-streamdown="code-block"]')).toBeTruthy(),
    )
    expect(container.textContent).toContain(finalLine)
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
    expect(container.querySelector('.katex-display')).toBeTruthy()
    expect(container.textContent).toContain('E=mc')
  })

  it('keeps malformed math inert and exposes the KaTeX parse explanation', () => {
    const { container } = render(<MarkdownView content={'$$\\frac{1}{2$$'} />)
    const error = container.querySelector('.katex-error')
    expect(error?.getAttribute('title')).toMatch(/parse error/i)
    expect(error?.textContent).toContain('\\frac{1}{2')
  })

  it('does not turn an untrusted KaTeX href into a link', () => {
    const { container } = render(
      <MarkdownView content={'$$\\href{https://evil.example}{click}$$'} />,
    )
    expect(container.querySelector('a[href*="evil.example"]')).toBeNull()
    expect(container.querySelector('.katex')).toBeTruthy()
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
