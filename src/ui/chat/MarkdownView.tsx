import { createCjkPlugin } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import { createMermaidPlugin } from '@streamdown/mermaid'
import { useContext, useMemo } from 'react'
import type { Components } from 'streamdown'
import { Streamdown } from 'streamdown'
import { DEFAULT_IMAGE_ORIGINS, isImageOriginAllowed } from '../../core/image-allowlist'
import type { ShikiThemeChoice } from '../settings/RenderingSettings'
import { RenderingPreferencesContext } from '../settings/RenderingSettings'

export interface MarkdownViewProps {
  content: string
  streaming?: boolean
  allowImageOrigins?: string[]
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

const components: Components = {
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
}

export function MarkdownView({ content, streaming = false, allowImageOrigins }: MarkdownViewProps) {
  const allowed = useMemo(
    () => [...DEFAULT_IMAGE_ORIGINS, ...(allowImageOrigins ?? [])],
    [allowImageOrigins],
  )
  const safeContent = useMemo(
    () => promoteDisplayMath(rewriteBlockedImages(content, allowed)),
    [content, allowed],
  )
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
  const plugins = useMemo(
    () => getPlugins(shikiTheme, renderingPrefs.singleDollarTextMath),
    [shikiTheme, renderingPrefs.singleDollarTextMath],
  )
  const rendererKey = `${shikiTheme.join('::')}::single-dollar=${
    renderingPrefs.singleDollarTextMath ? 'on' : 'off'
  }`
  return (
    <div data-ui="markdown" data-overflow="full">
      <Streamdown
        key={rendererKey}
        mode={streaming ? 'streaming' : 'static'}
        plugins={plugins}
        components={components}
        shikiTheme={shikiTheme}
      >
        {safeContent}
      </Streamdown>
    </div>
  )
}

function buildPlugins(themes: [ShikiThemeChoice, ShikiThemeChoice], singleDollarTextMath: boolean) {
  return {
    math: createMathPlugin({ singleDollarTextMath }),
    code: createCodePlugin({ themes }),
    cjk: cjkPlugin,
    mermaid: mermaidPlugin,
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

// Pre-process images: any `![alt](url)` or `<img src="url">` pointing at a
// non-allowlisted origin is replaced with a stub that the markdown renderer
// turns into a visible "blocked image from <origin>" affordance. The
// rewrite happens BEFORE Streamdown parses so the final DOM never contains
// a tracking pixel.
function rewriteBlockedImages(md: string, allowed: string[]): string {
  const mdImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g
  const htmlImagePattern = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi
  const replaceMd = md.replace(mdImagePattern, (match, alt, url) => {
    return isImageOriginAllowed(url, allowed)
      ? match
      : `\n\n> \u26a0 Blocked image from \`${safeOrigin(url)}\`${alt ? ` (alt: ${alt})` : ''}\n\n`
  })
  return replaceMd.replace(htmlImagePattern, (_match, url) => {
    return isImageOriginAllowed(url, allowed)
      ? _match
      : `\n\n> \u26a0 Blocked image from \`${safeOrigin(url)}\`\n\n`
  })
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
        (_m, inner) => `\n\n$$\n${inner.trim()}\n$$\n\n`,
      )
    })
    .join('')
}
