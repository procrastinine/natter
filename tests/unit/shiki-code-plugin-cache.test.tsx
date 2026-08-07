import { render, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import type { TokensResult } from 'shiki/core'
import type { BundledLanguage } from 'shiki/langs'
import type { CodeHighlighterPlugin, ThemeInput } from 'streamdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  createShikiCodePlugin as CreateShikiCodePlugin,
  SHIKI_CODE_CACHE_LIMITS as ShikiCodeCacheLimits,
} from '../../src/ui/chat/shiki-code-plugin'

const shiki = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  loadLanguage: vi.fn(),
  loadTheme: vi.fn(),
  codeToTokens: vi.fn(),
}))

vi.mock('shiki/core', () => ({
  createBundledHighlighter: () => shiki.createHighlighter,
}))

const themes: [ThemeInput, ThemeInput] = ['github-light', 'github-dark']
type PluginHighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

let createShikiCodePlugin: typeof CreateShikiCodePlugin
let cacheLimits: typeof ShikiCodeCacheLimits

describe('Shiki code plugin cache', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    shiki.loadLanguage.mockResolvedValue(undefined)
    shiki.loadTheme.mockResolvedValue(undefined)
    shiki.codeToTokens.mockImplementation(async (code: string) => fakeResult(code))
    shiki.createHighlighter.mockResolvedValue({
      loadLanguage: shiki.loadLanguage,
      loadTheme: shiki.loadTheme,
      codeToTokens: shiki.codeToTokens,
    })
    const module = await import('../../src/ui/chat/shiki-code-plugin')
    createShikiCodePlugin = module.createShikiCodePlugin
    cacheLimits = module.SHIKI_CODE_CACHE_LIMITS
  })

  afterEach(() => {
    window.dispatchEvent(new Event('pageshow'))
  })

  it('retries the exact request after tokenization fails', async () => {
    const error = new Error('synthetic tokenizer failure')
    shiki.codeToTokens.mockRejectedValueOnce(error)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const callback = vi.fn()
    const plugin = createShikiCodePlugin()
    const request = { code: 'retry-me-94231', language: 'typescript' as const, themes }

    expect(plugin.highlight(request, callback)).toBeNull()
    await waitFor(() =>
      expect(errorLog).toHaveBeenCalledWith('[Natter Code] Failed to highlight code:', error),
    )
    expect(callback).not.toHaveBeenCalled()

    const result = await highlight(plugin, request.code, request.language)
    expect(result).toEqual(fakeResult(request.code))
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  it('resets a rejected highlighter initialization so a later request can retry', async () => {
    const error = new Error('synthetic highlighter initialization failure')
    shiki.createHighlighter.mockRejectedValueOnce(error).mockResolvedValueOnce({
      loadLanguage: shiki.loadLanguage,
      loadTheme: shiki.loadTheme,
      codeToTokens: shiki.codeToTokens,
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const plugin = createShikiCodePlugin()
    const code = 'retry-highlighter-18427'

    expect(plugin.highlight({ code, language: 'typescript', themes })).toBeNull()
    await waitFor(() => expect(errorLog).toHaveBeenCalled())
    const result = await highlight(plugin, code, 'typescript')

    expect(result).toEqual(fakeResult(code))
    expect(shiki.createHighlighter).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  it('drops a highlight failure after page teardown begins without reporting a runtime fault', async () => {
    let rejectTokenization!: (error: unknown) => void
    shiki.codeToTokens.mockImplementationOnce(
      () =>
        new Promise<TokensResult>((_resolve, reject) => {
          rejectTokenization = reject
        }),
    )
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const plugin = createShikiCodePlugin()
    const error = new TypeError('error loading dynamically imported module')

    expect(
      plugin.highlight({ code: 'teardown-highlight-94812', language: 'typescript', themes }),
    ).toBeNull()
    await waitFor(() => expect(shiki.codeToTokens).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('beforeunload'))
    rejectTokenization(error)
    await Promise.resolve()
    await Promise.resolve()

    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('evicts least-recently-used results at the entry budget', async () => {
    const plugin = createShikiCodePlugin()
    const codes = Array.from(
      { length: cacheLimits.entries + 1 },
      (_, index) => `entry-budget-${index}`,
    )
    for (const code of codes) await highlight(plugin, code, 'typescript')
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(codes.length)

    await highlight(plugin, codes[0] ?? '', 'typescript')
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(codes.length + 1)
  })

  it('evicts results when retained source text crosses the character budget', async () => {
    const plugin = createShikiCodePlugin()
    const eachLength = Math.floor(cacheLimits.sourceChars / 2) + 1
    const first = `a${'x'.repeat(eachLength - 1)}`
    const second = `b${'x'.repeat(eachLength - 1)}`

    await highlight(plugin, first, 'text' as BundledLanguage)
    await highlight(plugin, second, 'text' as BundledLanguage)
    await highlight(plugin, first, 'text' as BundledLanguage)

    expect(shiki.codeToTokens).toHaveBeenCalledTimes(3)
  })

  it('settles an oversized block without retaining it or entering a rerender loop', async () => {
    const plugin = createShikiCodePlugin()
    const code = 'x'.repeat(cacheLimits.sourceChars + 1)
    const first = render(<HighlightHarness plugin={plugin} code={code} />)

    await waitFor(() => expect(first.getByTestId('highlight-state')).toHaveTextContent('ready'))
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(1)
    first.rerender(<HighlightHarness plugin={plugin} code={code} />)
    await Promise.resolve()
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = render(<HighlightHarness plugin={plugin} code={code} />)
    await waitFor(() => expect(second.getByTestId('highlight-state')).toHaveTextContent('ready'))
    expect(shiki.codeToTokens).toHaveBeenCalledTimes(2)
  })
})

function HighlightHarness({ plugin, code }: { plugin: CodeHighlighterPlugin; code: string }) {
  const [result, setResult] = useState<PluginHighlightResult | null>(null)
  useEffect(() => {
    const immediate = plugin.highlight({ code, language: 'typescript', themes }, setResult)
    if (immediate) setResult(immediate)
  }, [code, plugin])
  return <div data-testid="highlight-state">{result ? 'ready' : 'pending'}</div>
}

function highlight(
  plugin: CodeHighlighterPlugin,
  code: string,
  language: BundledLanguage,
): Promise<PluginHighlightResult> {
  return new Promise((resolve) => {
    const immediate = plugin.highlight({ code, language, themes }, resolve)
    if (immediate) resolve(immediate)
  })
}

function fakeResult(code: string): TokensResult {
  return {
    bg: 'transparent',
    fg: 'inherit',
    tokens: [[{ content: code.length > 1_000 ? String(code.length) : code, offset: 0 }]],
  }
}
