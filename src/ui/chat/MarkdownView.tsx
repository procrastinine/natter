import { createCjkPlugin } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { type MutableRefObject, memo, useContext, useMemo, useRef } from 'react'
import type { Components, StreamdownProps } from 'streamdown'
import { defaultRemarkPlugins, Streamdown } from 'streamdown'
import { DEFAULT_IMAGE_ORIGINS, isImageOriginAllowed } from '../../core/image-allowlist'
import type { ShikiThemeChoice } from '../settings/RenderingSettings'
import { RenderingPreferencesContext } from '../settings/RenderingSettings'

interface MarkdownViewProps {
  content: string
  contentSegments?: readonly string[] | undefined
  streaming?: boolean
  allowImageOrigins?: string[]
}

export const STREAMING_MARKDOWN_SEGMENT_CHARS = 20_000
const STREAMING_MARKDOWN_CUT_LOOKBACK = 4_000

interface MarkdownSegment {
  id: string
  content: string
  streaming: boolean
}

interface MarkdownSegmentViewProps {
  content: string
  streaming: boolean
  plugins: ReturnType<typeof buildPlugins> | ReturnType<typeof buildStreamingPlugins>
  components: Components
  remarkPlugins: StreamdownProps['remarkPlugins']
  shikiTheme: [ShikiThemeChoice, ShikiThemeChoice]
  rendererKey: string
}

interface PrefixSegmentCache {
  target: number
  refs: readonly string[]
  content: string
}

// CJK plugin: adds remark plugins that make Chinese/Japanese/Korean text
// respect proper emphasis, strikethrough, and autolink boundaries. No
// options; pre-configured defaults suffice here.
const cjkPlugin = createCjkPlugin()

// Mermaid plugin: renders ```mermaid code fences as SVG diagrams.
// `securityLevel: 'strict'` (Mermaid's default) keeps click handlers
// sandboxed (LLM-generated content is rendered here), so any looser
// setting would let a model open dialogs or navigate the page.
const mermaidPlugin = createMermaidPlugin({
  config: { securityLevel: 'strict' },
})

const pluginCache = new Map<string, ReturnType<typeof buildPlugins>>()
const streamingPluginCache = new Map<string, ReturnType<typeof buildStreamingPlugins>>()
const defaultRemarkPluginList = Object.values(defaultRemarkPlugins)

function isExternalUrl(href: string | undefined): boolean {
  if (!href) return false
  if (href.startsWith('#')) return false
  if (href.startsWith('/')) return false
  try {
    const u = new URL(href, 'http://localhost/')
    if (u.origin === 'http://localhost' && !href.includes('://')) return false
    return true
  } catch {
    return false
  }
}

export function MarkdownView({
  content,
  contentSegments,
  streaming = false,
  allowImageOrigins,
}: MarkdownViewProps) {
  const allowed = useMemo(
    () => [...DEFAULT_IMAGE_ORIGINS, ...(allowImageOrigins ?? [])],
    [allowImageOrigins],
  )
  const components = useMemo(() => buildComponents(allowed), [allowed])
  // Syntax-highlighting themes are controlled by the user's rendering
  // preferences (Settings → Rendering). Streamdown ships a
  // `CodeHighlighterPlugin` interface but no built-in implementation —
  // without a plugin mounted under `plugins.code`, the highlighter call
  // returns null and code blocks render as raw monospace text. The
  // `@streamdown/code` plugin (Shiki-backed) is used and rebuilt whenever
  // the theme tuple changes so the Settings dropdown actually repaints
  // existing blocks.
  const renderingPrefs = useContext(RenderingPreferencesContext)
  const shikiTheme = useMemo<[ShikiThemeChoice, ShikiThemeChoice]>(
    () => [renderingPrefs.shikiLight, renderingPrefs.shikiDark],
    [renderingPrefs.shikiLight, renderingPrefs.shikiDark],
  )
  const staticPlugins = useMemo(
    () => getPlugins(shikiTheme, renderingPrefs.singleDollarTextMath),
    [shikiTheme, renderingPrefs.singleDollarTextMath],
  )
  const streamingPlugins = useMemo(
    () => getStreamingPlugins(renderingPrefs.singleDollarTextMath),
    [renderingPrefs.singleDollarTextMath],
  )
  const baseRendererKey = `${shikiTheme.join('::')}::single-dollar=${
    renderingPrefs.singleDollarTextMath ? 'on' : 'off'
  }::single-newline-breaks=${renderingPrefs.singleNewlineHardBreaks ? 'on' : 'off'}`
  const remarkPlugins = useMemo(
    () =>
      renderingPrefs.singleNewlineHardBreaks
        ? [...defaultRemarkPluginList, singleNewlineHardBreaksRemarkPlugin]
        : undefined,
    [renderingPrefs.singleNewlineHardBreaks],
  )
  const prefixSegmentCacheRef = useRef<PrefixSegmentCache | null>(null)
  const segments = useMemo(
    () =>
      streaming && contentSegments && contentSegments.length > 0
        ? segmentMarkdownSections(contentSegments, prefixSegmentCacheRef)
        : segmentMarkdown(content, streaming),
    [content, contentSegments, streaming],
  )
  const segmented = segments.length > 1

  return (
    <div data-ui="markdown" data-overflow={segmented ? 'streaming-segmented' : 'full'}>
      {segments.map((segment) => {
        const segmentMode = segment.streaming ? 'streaming' : 'static'
        return (
          <MarkdownSegmentView
            key={segment.id}
            content={segment.content}
            streaming={segment.streaming}
            plugins={segment.streaming ? streamingPlugins : staticPlugins}
            components={components}
            remarkPlugins={remarkPlugins}
            shikiTheme={shikiTheme}
            rendererKey={`${baseRendererKey}::mode=${segmentMode}`}
          />
        )
      })}
    </div>
  )
}

const MarkdownSegmentView = memo(function MarkdownSegmentView({
  content,
  streaming,
  plugins,
  components,
  remarkPlugins,
  shikiTheme,
  rendererKey,
}: MarkdownSegmentViewProps) {
  const safeContent = useMemo(() => promoteDisplayMath(content), [content])
  return (
    <div
      data-ui="markdown-segment"
      data-mode={streaming ? 'streaming' : 'static'}
      data-length={content.length}
    >
      <Streamdown
        key={rendererKey}
        mode={streaming ? 'streaming' : 'static'}
        plugins={plugins}
        components={components}
        {...(remarkPlugins ? { remarkPlugins } : {})}
        shikiTheme={shikiTheme}
      >
        {safeContent}
      </Streamdown>
    </div>
  )
})

function buildComponents(allowed: string[]): Components {
  return {
    a: ({ href, children, node: _node, ...props }) => {
      if (isExternalUrl(href)) {
        return (
          <a {...props} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        )
      }
      return (
        <a {...props} href={href}>
          {children}
        </a>
      )
    },
    img: ({ src, alt, node: _node, ...props }) => {
      if (!src) return null
      if (!isImageOriginAllowed(src, allowed)) {
        return (
          <span data-ui="blocked-image">
            Blocked image from <code>{safeOrigin(src)}</code>
            {alt ? ` (alt: ${alt})` : null}
          </span>
        )
      }
      return <img {...props} src={src} alt={alt} />
    },
  }
}

interface MarkdownAstNode {
  type?: string
  value?: unknown
  children?: MarkdownAstNode[]
}

function singleNewlineHardBreaksRemarkPlugin() {
  return (tree: MarkdownAstNode) => {
    replaceSoftLineEndings(tree)
  }
}

function replaceSoftLineEndings(node: MarkdownAstNode): void {
  if (!Array.isArray(node.children)) return
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i]
    if (child?.type === 'text' && typeof child.value === 'string' && child.value.includes('\n')) {
      const replacement = splitTextNodeOnLineEndings(child.value)
      node.children.splice(i, 1, ...replacement)
      i += replacement.length - 1
      continue
    }
    if (child) replaceSoftLineEndings(child)
  }
}

function splitTextNodeOnLineEndings(value: string): MarkdownAstNode[] {
  const parts = value.split('\n')
  const nodes: MarkdownAstNode[] = []
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]
    if (part) nodes.push({ type: 'text', value: part })
    if (i < parts.length - 1) nodes.push({ type: 'break' })
  }
  return nodes
}

function segmentMarkdown(content: string, streaming: boolean): MarkdownSegment[] {
  if (!streaming || content.length <= STREAMING_MARKDOWN_SEGMENT_CHARS) {
    return [{ id: '0-live', content, streaming }]
  }
  const prefixTarget =
    Math.floor((content.length - 1) / STREAMING_MARKDOWN_SEGMENT_CHARS) *
    STREAMING_MARKDOWN_SEGMENT_CHARS
  const cut = findSegmentCut(content, 0, prefixTarget)
  return [
    {
      id: `0-${cut}`,
      content: content.slice(0, cut),
      streaming: false,
    },
    {
      id: `${cut}-live`,
      content: content.slice(cut),
      streaming: true,
    },
  ]
}

function segmentMarkdownSections(
  contentSegments: readonly string[],
  cacheRef: MutableRefObject<PrefixSegmentCache | null>,
): MarkdownSegment[] {
  const totalLength = contentSegments.reduce((sum, segment) => sum + segment.length, 0)
  if (totalLength <= STREAMING_MARKDOWN_SEGMENT_CHARS) {
    return [{ id: '0-live', content: contentSegments.join(''), streaming: true }]
  }
  const prefixTarget =
    Math.floor((totalLength - 1) / STREAMING_MARKDOWN_SEGMENT_CHARS) *
    STREAMING_MARKDOWN_SEGMENT_CHARS
  const rawSplit = splitTextSegmentsAt(contentSegments, prefixTarget)
  const rawPrefixContent = rawSplit.prefixRefs.join('')
  const cut = findSegmentCut(rawPrefixContent, 0, prefixTarget)
  const { prefixRefs, tailRefs } =
    cut === prefixTarget ? rawSplit : splitTextSegmentsAt(contentSegments, cut)
  const cached = cacheRef.current
  const prefixContent =
    cached && cached.target === cut && sameStringRefs(cached.refs, prefixRefs)
      ? cached.content
      : cut === prefixTarget
        ? rawPrefixContent
        : prefixRefs.join('')
  if (cached?.content !== prefixContent) {
    cacheRef.current = { target: cut, refs: prefixRefs, content: prefixContent }
  }
  return [
    {
      id: `0-${cut}`,
      content: prefixContent,
      streaming: false,
    },
    {
      id: `${cut}-live`,
      content: tailRefs.join(''),
      streaming: true,
    },
  ]
}

function splitTextSegmentsAt(
  segments: readonly string[],
  target: number,
): { prefixRefs: string[]; tailRefs: string[] } {
  const prefixRefs: string[] = []
  const tailRefs: string[] = []
  let consumed = 0
  for (const segment of segments) {
    const nextConsumed = consumed + segment.length
    if (nextConsumed <= target) {
      prefixRefs.push(segment)
    } else if (consumed < target) {
      const splitAt = target - consumed
      prefixRefs.push(segment.slice(0, splitAt))
      tailRefs.push(segment.slice(splitAt))
    } else {
      tailRefs.push(segment)
    }
    consumed = nextConsumed
  }
  return { prefixRefs, tailRefs }
}

function sameStringRefs(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function findSegmentCut(content: string, start: number, target: number): number {
  const minCut = Math.max(start + 1, target - STREAMING_MARKDOWN_CUT_LOOKBACK)
  const blankLineCut = content.lastIndexOf('\n\n', target)
  if (blankLineCut >= minCut) {
    const cut = blankLineCut + 2
    if (!hasOpenFence(content, start, cut)) return cut
  }
  const lineCut = content.lastIndexOf('\n', target)
  if (lineCut >= minCut) {
    const cut = lineCut + 1
    if (!hasOpenFence(content, start, cut)) return cut
  }
  return target
}

function hasOpenFence(content: string, start: number, end: number): boolean {
  let openMarker: string | null = null
  const lines = content.slice(start, end).split('\n')
  for (const line of lines) {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
    if (!match) continue
    const marker = match[1]
    if (!marker) continue
    const markerKind = marker[0]
    if (!markerKind) continue
    if (!openMarker) {
      openMarker = marker
      continue
    }
    if (openMarker.startsWith(markerKind) && marker.length >= openMarker.length) {
      openMarker = null
    }
  }
  return openMarker !== null
}

function buildPlugins(themes: [ShikiThemeChoice, ShikiThemeChoice], singleDollarTextMath: boolean) {
  return {
    math: createMathPlugin({ singleDollarTextMath }),
    code: createCodePlugin({ themes }),
    cjk: cjkPlugin,
    mermaid: mermaidPlugin,
  }
}

function buildStreamingPlugins(singleDollarTextMath: boolean) {
  return {
    math: createMathPlugin({ singleDollarTextMath }),
    cjk: cjkPlugin,
  }
}

function getPlugins(themes: [ShikiThemeChoice, ShikiThemeChoice], singleDollarTextMath: boolean) {
  const key = `${themes.join('::')}::single-dollar=${singleDollarTextMath ? 'on' : 'off'}`
  const cached = pluginCache.get(key)
  if (cached) return cached
  const created = buildPlugins(themes, singleDollarTextMath)
  pluginCache.set(key, created)
  return created
}

function getStreamingPlugins(singleDollarTextMath: boolean) {
  const key = `single-dollar=${singleDollarTextMath ? 'on' : 'off'}`
  const cached = streamingPluginCache.get(key)
  if (cached) return cached
  const created = buildStreamingPlugins(singleDollarTextMath)
  streamingPluginCache.set(key, created)
  return created
}

function safeOrigin(url: string): string {
  try {
    const u = new URL(url)
    return u.origin
  } catch {
    return url.length > 40 ? `${url.slice(0, 37)}…` : url
  }
}

// Pre-process `$$...$$` so remark-math v6 treats it as display (flow)
// math even when the model emits it inline within a paragraph. The
// micromark-extension-math flow-math tokenizer requires both that the
// `$$` fences are preceded by a blank line AND that each fence is on
// its own line; `$$x$$` on a single line (even as a standalone block)
// is still parsed as text math. So every `$$inner$$` occurrence is
// rewritten to `\n\n$$\ninner\n$$\n\n` so the opening fence,
// content, and closing fence all live on separate lines. Skip content
// inside fenced code so code samples that legitimately contain dollar
// pairs are not corrupted.
function promoteDisplayMath(md: string): string {
  const parts = md.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(
        /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g,
        (_m: string, inner: string) => `\n\n$$\n${inner.trim()}\n$$\n\n`,
      )
    })
    .join('')
}
