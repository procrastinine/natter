import { createCjkPlugin } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import {
  type MutableRefObject,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Components, StreamdownProps } from 'streamdown'
import {
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  type CustomRendererProps,
  defaultRemarkPlugins,
  Streamdown,
  CodeBlock as StreamdownCodeBlock,
  StreamdownContext,
} from 'streamdown'
import 'streamdown/styles.css'
import 'katex/dist/katex.css'
import type { CitationDisplayTarget } from '../../core/content-annotations'
import { DEFAULT_IMAGE_ORIGINS, isImageOriginAllowed } from '../../core/image-allowlist'
import { DEFAULT_RENDERING_PREFS, type ShikiThemeChoice } from '../../core/rendering-preferences'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { yieldToEventLoop } from '../../lib/yield-to-event-loop'
import { useVirtualSpacerHeight } from '../primitives/virtual-spacer'
import { RenderingPreferencesContext } from '../settings/RenderingSettings'
import { CitationLink } from './CitationLink'
import { CODE_HIGHLIGHT_LIMITS, CodeBlock } from './CodeBlock'
import { createLazyMermaidPlugin } from './lazy-mermaid-plugin'
import { useScrollRegionCommands } from './ScrollRegion'
import { createShikiCodePlugin } from './shiki-code-plugin'

interface MarkdownViewProps {
  content: string
  contentSegments?: readonly string[] | undefined
  streaming?: boolean
  renderRevision?: string | number | undefined
  allowImageOrigins?: string[]
  citationTargets?: readonly CitationDisplayTarget[]
}

export const STREAMING_MARKDOWN_SEGMENT_CHARS = 20_000
export const PROGRESSIVE_STATIC_MARKDOWN_CHARS = 120_000
const STREAMING_MARKDOWN_CUT_LOOKBACK = 4_000
const PROGRESSIVE_STATIC_TAIL_CHARS = 24_000

interface MarkdownSegment {
  id: string
  content: string
  streaming: boolean
}

interface ProgressiveStaticMarkdown {
  readonly pending: boolean
  readonly content: string
  readonly tail: string
  readonly prefixLength: number
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

interface FrozenMarkdownBlock {
  start: number
  end: number
  level: number
  content: string
}

export interface StreamingMarkdownSegmentCache {
  inputLength: number
  tailStart: number
  tailContent: string
  frozenBlocks: FrozenMarkdownBlock[]
  boundaryScanOffset: number
  boundaryOpenMarker: string | null
  lastSafeBlankCut: number | null
  lastSafeLineCut: number | null
  firstSafeCutAfterTarget: number | null
  targetHasOpenFence: boolean | null
}

// CJK plugin: adds remark plugins that make Chinese/Japanese/Korean text
// respect proper emphasis, strikethrough, and autolink boundaries. No
// options; pre-configured defaults suffice here.
const cjkPlugin = createCjkPlugin()

// Mermaid plugin: renders ```mermaid code fences as SVG diagrams.
// `securityLevel: 'strict'` (Mermaid's default) keeps click handlers
// sandboxed (LLM-generated content is rendered here), so any looser
// setting would let a model open dialogs or navigate the page.
const mermaidPlugin = createLazyMermaidPlugin({
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
  renderRevision,
  allowImageOrigins,
  citationTargets,
}: MarkdownViewProps) {
  const configurationPreferences = useConfigurationPreferences()
  const scrollRegionCommands = useScrollRegionCommands()
  const markdownRootRef = useRef<HTMLDivElement | null>(null)
  const captureProgressiveStaticAnchor = useCallback(
    () => scrollRegionCommands?.captureLayoutAnchor({ replaceExisting: false }),
    [scrollRegionCommands],
  )
  const allowed = useMemo(
    () => [
      ...new Set([
        ...DEFAULT_IMAGE_ORIGINS,
        ...(configurationPreferences?.imageAllowlist ?? []),
        ...(allowImageOrigins ?? []),
      ]),
    ],
    [allowImageOrigins, configurationPreferences?.imageAllowlist],
  )
  const components = useMemo(
    () => buildComponents(allowed, citationTargets),
    [allowed, citationTargets],
  )
  // Syntax-highlighting themes are controlled by the user's rendering
  // preferences (Settings → Rendering). Streamdown ships a
  // `CodeHighlighterPlugin` interface but no built-in implementation —
  // without a plugin mounted under `plugins.code`, the highlighter call
  // returns null and code blocks render as raw monospace text. The
  // The Shiki-backed plugin is rebuilt whenever the theme tuple changes so
  // the Settings dropdown actually repaints existing blocks.
  const renderingPrefs =
    useContext(RenderingPreferencesContext) ??
    configurationPreferences?.rendering ??
    DEFAULT_RENDERING_PREFS
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
  }::single-newline-breaks=${
    renderingPrefs.singleNewlineHardBreaks ? 'on' : 'off'
  }::revision=${renderRevision ?? 'stable'}`
  const streamingRendererKeyRef = useRef(baseRendererKey)
  if (streaming) streamingRendererKeyRef.current = baseRendererKey
  const remarkPlugins = useMemo(
    () =>
      renderingPrefs.singleNewlineHardBreaks
        ? [...defaultRemarkPluginList, singleNewlineHardBreaksRemarkPlugin]
        : undefined,
    [renderingPrefs.singleNewlineHardBreaks],
  )
  const prefixSegmentCacheRef = useRef<StreamingMarkdownSegmentCache | null>(null)
  const prefixSegmentCacheRevisionRef = useRef(renderRevision)
  if (prefixSegmentCacheRevisionRef.current !== renderRevision) {
    prefixSegmentCacheRevisionRef.current = renderRevision
    const cache = prefixSegmentCacheRef.current
    const finalizedStreamMatches =
      !streaming &&
      contentSegments !== undefined &&
      contentSegments.length > 0 &&
      cache !== null &&
      streamingMarkdownCacheMatches(cache, contentSegments)
    if (!finalizedStreamMatches) prefixSegmentCacheRef.current = null
  }
  const [reparsedTerminalSource, setReparsedTerminalSource] = useState<readonly string[] | null>(
    null,
  )
  const terminalStreamingSegments = useMemo(() => {
    if (
      streaming ||
      !contentSegments ||
      contentSegments.length === 0 ||
      reparsedTerminalSource === contentSegments
    ) {
      return null
    }
    const cache = prefixSegmentCacheRef.current
    if (!cache || !streamingMarkdownCacheMatches(cache, contentSegments)) return null
    return segmentMarkdownSections(contentSegments, prefixSegmentCacheRef)
  }, [contentSegments, reparsedTerminalSource, streaming])
  useEffect(() => {
    if (!terminalStreamingSegments || !contentSegments) return
    captureProgressiveStaticAnchor()
    setReparsedTerminalSource(contentSegments)
  }, [captureProgressiveStaticAnchor, contentSegments, terminalStreamingSegments])
  const progressiveStatic = useProgressiveStaticMarkdown(
    content,
    contentSegments,
    streaming || terminalStreamingSegments !== null,
    captureProgressiveStaticAnchor,
  )
  const progressivePrefixRef = useVirtualSpacerHeight<HTMLDivElement>(
    estimatedMarkdownPrefixHeight(progressiveStatic.prefixLength),
  )
  const segments = useMemo(() => {
    if (terminalStreamingSegments) return terminalStreamingSegments
    if (progressiveStatic.pending) return []
    if (streaming && contentSegments && contentSegments.length > 0) {
      return segmentMarkdownSections(contentSegments, prefixSegmentCacheRef)
    }
    prefixSegmentCacheRef.current = null
    return segmentMarkdown(progressiveStatic.content, streaming)
  }, [
    contentSegments,
    terminalStreamingSegments,
    progressiveStatic.content,
    progressiveStatic.pending,
    streaming,
  ])
  if (progressiveStatic.pending) {
    return (
      <div ref={markdownRootRef} data-ui="markdown" data-overflow="progressive-static">
        <div
          ref={progressivePrefixRef}
          aria-hidden="true"
          data-ui="markdown-progressive-prefix"
          data-length={progressiveStatic.prefixLength}
        />
        <MarkdownSegmentView
          content={progressiveStatic.tail}
          streaming={false}
          plugins={staticPlugins}
          components={components}
          remarkPlugins={remarkPlugins}
          shikiTheme={shikiTheme}
          rendererKey={`${baseRendererKey}::mode=progressive-tail`}
        />
      </div>
    )
  }
  const segmented = segments.length > 1

  return (
    <div
      ref={markdownRootRef}
      data-ui="markdown"
      data-overflow={segmented ? 'streaming-segmented' : 'full'}
    >
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
            rendererKey={`${
              terminalStreamingSegments ? streamingRendererKeyRef.current : baseRendererKey
            }::mode=${segmentMode}`}
          />
        )
      })}
    </div>
  )
}

function useProgressiveStaticMarkdown(
  content: string,
  contentSegments: readonly string[] | undefined,
  streaming: boolean,
  beforeComplete: () => unknown,
): ProgressiveStaticMarkdown {
  const staticSegments =
    !streaming && contentSegments && contentSegments.length > 0 ? contentSegments : undefined
  const source: string | readonly string[] = staticSegments ?? content
  const sourceLength = staticSegments
    ? staticSegments.reduce((sum, segment) => sum + segment.length, 0)
    : content.length
  const needsProgressive = !streaming && sourceLength > PROGRESSIVE_STATIC_MARKDOWN_CHARS
  const [completed, setCompleted] = useState<{
    readonly source: string | readonly string[]
    readonly content: string
  } | null>(() => (needsProgressive ? null : { source, content }))
  const readyContent = completed?.source === source ? completed.content : null
  useEffect(() => {
    if (!needsProgressive) {
      return
    }
    if (readyContent !== null) return
    let cancelled = false
    const complete = () => {
      if (!cancelled) {
        beforeComplete()
        setCompleted({ source, content: typeof source === 'string' ? source : source.join('') })
      }
    }
    void yieldToEventLoop().then(complete)
    return () => {
      cancelled = true
    }
  }, [beforeComplete, needsProgressive, readyContent, source])
  if (!needsProgressive) {
    return {
      pending: false,
      content: typeof source === 'string' ? source : content.length > 0 ? content : source.join(''),
      tail: '',
      prefixLength: 0,
    }
  }
  if (readyContent !== null) {
    return { pending: false, content: readyContent, tail: '', prefixLength: 0 }
  }
  const tailSource = boundedMarkdownTail(
    source,
    PROGRESSIVE_STATIC_TAIL_CHARS + STREAMING_MARKDOWN_CUT_LOOKBACK,
  )
  const tailStart = progressiveStaticTailStart(tailSource)
  const tail = tailSource.slice(tailStart)
  return {
    pending: true,
    content: '',
    tail,
    prefixLength: Math.max(0, sourceLength - tail.length),
  }
}

function boundedMarkdownTail(source: string | readonly string[], maxChars: number): string {
  if (typeof source === 'string') return source.slice(Math.max(0, source.length - maxChars))
  const parts: string[] = []
  let remaining = maxChars
  for (let index = source.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const segment = source[index] as string
    const take = Math.min(remaining, segment.length)
    parts.push(segment.slice(segment.length - take))
    remaining -= take
  }
  return parts.reverse().join('')
}

function progressiveStaticTailStart(content: string): number {
  const target = Math.max(0, content.length - PROGRESSIVE_STATIC_TAIL_CHARS)
  const blankLine = content.indexOf('\n\n', target)
  if (blankLine >= target && blankLine - target <= STREAMING_MARKDOWN_CUT_LOOKBACK) {
    return blankLine + 2
  }
  const line = content.indexOf('\n', target)
  return line >= target && line - target <= STREAMING_MARKDOWN_CUT_LOOKBACK ? line + 1 : target
}

function estimatedMarkdownPrefixHeight(characterCount: number): number {
  const estimatedLines = Math.ceil(characterCount / 84)
  return Math.min(2_000_000, Math.max(0, estimatedLines * 22))
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
  const safeContent = useMemo(
    () => guardOversizedCodeFences(promoteDisplayMath(content)),
    [content],
  )
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

function buildComponents(
  allowed: string[],
  citationTargets: readonly CitationDisplayTarget[] | undefined,
): Components {
  const citations = new Map(
    (citationTargets ?? []).map((target) => [`#natter-citation-${target.token}`, target]),
  )
  return {
    a: ({ href, children, node: _node, ...props }) => {
      const citation = href ? citations.get(href) : undefined
      if (citation) {
        return <CitationLink annotation={citation.annotation}>{children}</CitationLink>
      }
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
  if (cut === null) return [{ id: '0-live', content, streaming: true }]
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
  cacheRef: MutableRefObject<StreamingMarkdownSegmentCache | null>,
): MarkdownSegment[] {
  const totalLength = contentSegments.reduce((sum, segment) => sum + segment.length, 0)
  let cache = cacheRef.current
  if (!cache || totalLength < cache.inputLength) {
    cache = createStreamingMarkdownSegmentCache()
    cacheRef.current = cache
  }
  if (totalLength > cache.inputLength) {
    appendMarkdownSuffix(cache, contentSegments, cache.inputLength)
    cache.inputLength = totalLength
  }
  if (cache.frozenBlocks.length === 0) {
    return [{ id: '0-live', content: cache.tailContent, streaming: true }]
  }
  return [
    ...cache.frozenBlocks.map((block) => ({
      id: `${block.start}-${block.end}`,
      content: block.content,
      streaming: false,
    })),
    {
      id: `${cache.tailStart}-live`,
      content: cache.tailContent,
      streaming: true,
    },
  ]
}

function streamingMarkdownCacheMatches(
  cache: StreamingMarkdownSegmentCache,
  contentSegments: readonly string[],
): boolean {
  const cachedSegments = [...cache.frozenBlocks.map((block) => block.content), cache.tailContent]
  let cachedIndex = 0
  let cachedOffset = 0
  let sourceIndex = 0
  let sourceOffset = 0
  let compared = 0
  while (cachedIndex < cachedSegments.length && sourceIndex < contentSegments.length) {
    const cached = cachedSegments[cachedIndex] as string
    const source = contentSegments[sourceIndex] as string
    const length = Math.min(cached.length - cachedOffset, source.length - sourceOffset)
    for (let index = 0; index < length; index += 1) {
      if (cached.charCodeAt(cachedOffset + index) !== source.charCodeAt(sourceOffset + index)) {
        return false
      }
    }
    cachedOffset += length
    sourceOffset += length
    compared += length
    if (cachedOffset === cached.length) {
      cachedIndex += 1
      cachedOffset = 0
    }
    if (sourceOffset === source.length) {
      sourceIndex += 1
      sourceOffset = 0
    }
  }
  return (
    compared === cache.inputLength &&
    cachedIndex === cachedSegments.length &&
    sourceIndex === contentSegments.length
  )
}

export function createStreamingMarkdownSegmentCache(): StreamingMarkdownSegmentCache {
  return {
    inputLength: 0,
    tailStart: 0,
    tailContent: '',
    frozenBlocks: [],
    boundaryScanOffset: 0,
    boundaryOpenMarker: null,
    lastSafeBlankCut: null,
    lastSafeLineCut: null,
    firstSafeCutAfterTarget: null,
    targetHasOpenFence: null,
  }
}

export function segmentStreamingMarkdownForTests(
  segments: readonly string[],
  cache: StreamingMarkdownSegmentCache,
): ReadonlyArray<{ content: string; streaming: boolean }> {
  const ref = { current: cache }
  return segmentMarkdownSections(segments, ref).map(({ content, streaming }) => ({
    content,
    streaming,
  }))
}

function appendMarkdownSuffix(
  cache: StreamingMarkdownSegmentCache,
  segments: readonly string[],
  start: number,
): void {
  let consumed = 0
  for (const segment of segments) {
    const nextConsumed = consumed + segment.length
    if (nextConsumed > start) {
      appendMarkdownText(cache, segment, Math.max(0, start - consumed))
    }
    consumed = nextConsumed
  }
}

function appendMarkdownText(
  cache: StreamingMarkdownSegmentCache,
  text: string,
  initialOffset: number,
): void {
  cache.tailContent += text.slice(initialOffset)
  scanStreamingMarkdownBoundaries(cache)
  while (cache.tailContent.length > STREAMING_MARKDOWN_SEGMENT_CHARS) {
    const cut = streamingMarkdownSegmentCut(cache)
    if (cut === null) return
    freezeMarkdownPrefix(cache, cut)
  }
}

function freezeMarkdownPrefix(cache: StreamingMarkdownSegmentCache, cut: number): void {
  const block: FrozenMarkdownBlock = {
    start: cache.tailStart,
    end: cache.tailStart + cut,
    level: 0,
    content: cache.tailContent.slice(0, cut),
  }
  cache.tailStart = block.end
  cache.tailContent = cache.tailContent.slice(cut)
  while (cache.frozenBlocks.at(-1)?.level === block.level) {
    const previous = cache.frozenBlocks.pop() as FrozenMarkdownBlock
    block.start = previous.start
    block.level += 1
    block.content = `${previous.content}${block.content}`
  }
  cache.frozenBlocks.push(block)
  resetStreamingMarkdownBoundaries(cache)
}

function streamingMarkdownSegmentCut(cache: StreamingMarkdownSegmentCache): number | null {
  if (cache.lastSafeBlankCut !== null) return cache.lastSafeBlankCut
  if (cache.lastSafeLineCut !== null) return cache.lastSafeLineCut
  cache.targetHasOpenFence ??= hasOpenFence(cache.tailContent, 0, STREAMING_MARKDOWN_SEGMENT_CHARS)
  if (!cache.targetHasOpenFence) return STREAMING_MARKDOWN_SEGMENT_CHARS
  return cache.firstSafeCutAfterTarget
}

function resetStreamingMarkdownBoundaries(cache: StreamingMarkdownSegmentCache): void {
  cache.boundaryScanOffset = 0
  cache.boundaryOpenMarker = null
  cache.lastSafeBlankCut = null
  cache.lastSafeLineCut = null
  cache.firstSafeCutAfterTarget = null
  cache.targetHasOpenFence = null
  scanStreamingMarkdownBoundaries(cache)
}

function scanStreamingMarkdownBoundaries(cache: StreamingMarkdownSegmentCache): void {
  for (;;) {
    const newline = cache.tailContent.indexOf('\n', cache.boundaryScanOffset)
    if (newline < 0) return
    const line = cache.tailContent.slice(cache.boundaryScanOffset, newline)
    cache.boundaryOpenMarker = advanceFenceMarker(line, cache.boundaryOpenMarker)
    const cut = newline + 1
    if (cache.boundaryOpenMarker === null) {
      if (
        cut <= STREAMING_MARKDOWN_SEGMENT_CHARS &&
        cut >= STREAMING_MARKDOWN_SEGMENT_CHARS - STREAMING_MARKDOWN_CUT_LOOKBACK
      ) {
        cache.lastSafeLineCut = cut
        if (line.length === 0) cache.lastSafeBlankCut = cut
      } else if (cut > STREAMING_MARKDOWN_SEGMENT_CHARS && cache.firstSafeCutAfterTarget === null) {
        cache.firstSafeCutAfterTarget = cut
      }
    }
    cache.boundaryScanOffset = cut
  }
}

function findSegmentCut(content: string, start: number, target: number): number | null {
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
  if (!hasOpenFence(content, start, target)) return target
  let lineStart = content.indexOf('\n', target)
  while (lineStart >= 0) {
    const cut = lineStart + 1
    if (!hasOpenFence(content, start, cut)) return cut
    lineStart = content.indexOf('\n', cut)
  }
  return null
}

function hasOpenFence(content: string, start: number, end: number): boolean {
  let openMarker: string | null = null
  const lines = content.slice(start, end).split('\n')
  for (const line of lines) {
    openMarker = advanceFenceMarker(line, openMarker)
  }
  return openMarker !== null
}

function advanceFenceMarker(line: string, openMarker: string | null): string | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  const marker = match?.[1]
  if (!marker) return openMarker
  if (!openMarker) return marker
  return marker[0] === openMarker[0] && marker.length >= openMarker.length ? null : openMarker
}

const OVERSIZED_CODE_LANGUAGE = 'natter-oversized-code'
const OVERSIZED_CODE_LANGUAGE_META = 'natter-language='

const oversizedCodeRenderer = Object.freeze({
  language: OVERSIZED_CODE_LANGUAGE,
  component: OversizedCodeRenderer,
})

function OversizedCodeRenderer({ code, isIncomplete, meta }: CustomRendererProps) {
  const streamdown = useContext(StreamdownContext)
  const configurationPreferences = useConfigurationPreferences()
  const renderingPrefs =
    useContext(RenderingPreferencesContext) ??
    configurationPreferences?.rendering ??
    DEFAULT_RENDERING_PREFS
  const [forced, setForced] = useState(false)
  const language = originalOversizedCodeLanguage(meta)
  const originalMeta = originalOversizedCodeMeta(meta)
  const themes = useMemo<[ShikiThemeChoice, ShikiThemeChoice]>(
    () => [renderingPrefs.shikiLight, renderingPrefs.shikiDark],
    [renderingPrefs.shikiDark, renderingPrefs.shikiLight],
  )
  const mermaidSource = useMemo(
    () => (language === 'mermaid' && forced ? fencedMarkdown(language, originalMeta, code) : ''),
    [code, forced, language, originalMeta],
  )

  if (!forced || streamdown.mode === 'streaming' || isIncomplete) {
    return (
      <CodeBlock
        code={code}
        language={language}
        highlightAnywayDisabled={streamdown.mode === 'streaming' || isIncomplete}
        onHighlightAnyway={() => setForced(true)}
      />
    )
  }
  if (language === 'mermaid') {
    return (
      <Streamdown
        mode="static"
        plugins={getPlugins(themes, renderingPrefs.singleDollarTextMath)}
        shikiTheme={themes}
      >
        {mermaidSource}
      </Streamdown>
    )
  }
  return (
    <StreamdownCodeBlock code={code} language={language} lineNumbers={streamdown.lineNumbers}>
      <CodeBlockDownloadButton code={code} language={language} />
      <CodeBlockCopyButton code={code} />
    </StreamdownCodeBlock>
  )
}

interface FenceOpening {
  readonly marker: number
  readonly markerLength: number
  readonly markerEnd: number
  readonly language: string
  readonly languageEnd: number
  readonly lineEnd: number
}

interface OpenFence extends FenceOpening {
  readonly codeStart: number
  codeLines: number
}

interface FenceReplacement {
  readonly start: number
  readonly end: number
  readonly value: string
}

function guardOversizedCodeFences(content: string): string {
  let open: OpenFence | null = null
  const replacements: FenceReplacement[] = []
  let lineStart = 0
  for (;;) {
    const newline = content.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? content.length : newline
    if (open) {
      if (isClosingFence(content, lineStart, lineEnd, open.marker, open.markerLength)) {
        appendOversizedFenceReplacement(content, open, lineStart, replacements)
        open = null
      } else {
        open.codeLines += 1
      }
    } else {
      const opening = readFenceOpening(content, lineStart, lineEnd)
      if (opening && opening.language !== OVERSIZED_CODE_LANGUAGE) {
        open = {
          ...opening,
          codeStart: newline < 0 ? lineEnd : lineEnd + 1,
          codeLines: 0,
        }
      }
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  if (open) appendOversizedFenceReplacement(content, open, content.length, replacements)
  if (replacements.length === 0) return content
  let result = ''
  let copiedThrough = 0
  for (const replacement of replacements) {
    result += content.slice(copiedThrough, replacement.start)
    result += replacement.value
    copiedThrough = replacement.end
  }
  return result + content.slice(copiedThrough)
}

function appendOversizedFenceReplacement(
  content: string,
  open: OpenFence,
  codeEnd: number,
  replacements: FenceReplacement[],
): void {
  if (
    open.codeLines <= CODE_HIGHLIGHT_LIMITS.lines &&
    codeEnd - open.codeStart <= CODE_HIGHLIGHT_LIMITS.sourceChars
  ) {
    return
  }
  replacements.push({
    start: open.markerEnd,
    end: open.lineEnd,
    value: `${OVERSIZED_CODE_LANGUAGE} ${OVERSIZED_CODE_LANGUAGE_META}${encodeURIComponent(
      open.language || 'text',
    )}${content.slice(open.languageEnd, open.lineEnd)}`,
  })
}

function readFenceOpening(
  content: string,
  lineStart: number,
  lineEnd: number,
): FenceOpening | null {
  let cursor = lineStart
  let indent = 0
  while (cursor < lineEnd && indent < 4 && isHorizontalSpace(content.charCodeAt(cursor))) {
    cursor += 1
    indent += 1
  }
  if (indent > 3) return null
  const marker = content.charCodeAt(cursor)
  if (marker !== 96 && marker !== 126) return null
  const markerStart = cursor
  while (cursor < lineEnd && content.charCodeAt(cursor) === marker) cursor += 1
  const markerLength = cursor - markerStart
  if (markerLength < 3) return null
  const markerEnd = cursor
  while (cursor < lineEnd && isHorizontalSpace(content.charCodeAt(cursor))) cursor += 1
  const languageStart = cursor
  while (cursor < lineEnd && !isHorizontalSpace(content.charCodeAt(cursor))) cursor += 1
  return {
    marker,
    markerLength,
    markerEnd,
    language: content.slice(languageStart, cursor),
    languageEnd: cursor,
    lineEnd,
  }
}

function isClosingFence(
  content: string,
  lineStart: number,
  lineEnd: number,
  marker: number,
  minimumLength: number,
): boolean {
  let cursor = lineStart
  let indent = 0
  while (cursor < lineEnd && indent < 4 && isHorizontalSpace(content.charCodeAt(cursor))) {
    cursor += 1
    indent += 1
  }
  if (indent > 3 || content.charCodeAt(cursor) !== marker) return false
  const markerStart = cursor
  while (cursor < lineEnd && content.charCodeAt(cursor) === marker) cursor += 1
  if (cursor - markerStart < minimumLength) return false
  while (cursor < lineEnd && isHorizontalSpace(content.charCodeAt(cursor))) cursor += 1
  return cursor === lineEnd
}

function isHorizontalSpace(code: number): boolean {
  return code === 9 || code === 32
}

function originalOversizedCodeLanguage(meta: string | undefined): string {
  const match = meta?.match(/(?:^|\s)natter-language=([^\s]+)/u)
  if (!match?.[1]) return 'text'
  try {
    return decodeURIComponent(match[1])
  } catch {
    return 'text'
  }
}

function originalOversizedCodeMeta(meta: string | undefined): string {
  return meta?.replace(/(?:^|\s)natter-language=[^\s]+\s*/u, '').trim() ?? ''
}

function fencedMarkdown(language: string, meta: string, code: string): string {
  const marker = '~'.repeat(Math.max(3, longestLinePrefixRun(code, 126) + 1))
  return `${marker}${language}${meta ? ` ${meta}` : ''}\n${code}\n${marker}`
}

function longestLinePrefixRun(content: string, marker: number): number {
  let longest = 0
  let lineStart = true
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)
    if (lineStart && code === marker) {
      let cursor = index
      while (cursor < content.length && content.charCodeAt(cursor) === marker) cursor += 1
      longest = Math.max(longest, cursor - index)
      index = cursor - 1
      lineStart = false
      continue
    }
    lineStart = code === 10
  }
  return longest
}

function buildPlugins(themes: [ShikiThemeChoice, ShikiThemeChoice], singleDollarTextMath: boolean) {
  return {
    math: createMathPlugin({ singleDollarTextMath }),
    code: createShikiCodePlugin({ themes }),
    cjk: cjkPlugin,
    mermaid: mermaidPlugin,
    renderers: [oversizedCodeRenderer],
  }
}

function buildStreamingPlugins(singleDollarTextMath: boolean) {
  return {
    math: createMathPlugin({ singleDollarTextMath }),
    cjk: cjkPlugin,
    renderers: [oversizedCodeRenderer],
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
