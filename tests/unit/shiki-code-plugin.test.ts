// @vitest-environment node

import type { BundledLanguage } from 'shiki/langs'
import type { CodeHighlighterPlugin, ThemeInput } from 'streamdown'
import { describe, expect, it } from 'vitest'
import {
  createShikiCodePlugin,
  SHIKI_SUPPORTED_LANGUAGES,
} from '../../src/ui/chat/shiki-code-plugin'

const defaultThemes: [ThemeInput, ThemeInput] = ['github-light', 'github-dark']
type PluginHighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

describe('Shiki code plugin', () => {
  it('advertises only the curated language set and normalizes common aliases', () => {
    const plugin = createShikiCodePlugin()

    expect(plugin.getSupportedLanguages()).toEqual(SHIKI_SUPPORTED_LANGUAGES)
    expect(SHIKI_SUPPORTED_LANGUAGES).toHaveLength(32)
    expect(plugin.supportsLanguage('javascript')).toBe(true)
    expect(plugin.supportsLanguage('js')).toBe(true)
    expect(plugin.supportsLanguage(' JS ' as BundledLanguage)).toBe(true)
    expect(plugin.supportsLanguage('bash')).toBe(true)
    expect(plugin.supportsLanguage('c++')).toBe(true)
    expect(plugin.supportsLanguage('dockerfile')).toBe(true)
    expect(plugin.supportsLanguage('py')).toBe(true)
    expect(plugin.supportsLanguage('yml')).toBe(true)
    expect(plugin.supportsLanguage('abap')).toBe(false)
    expect(plugin.supportsLanguage('definitely-not-a-language' as BundledLanguage)).toBe(false)
  })

  it('uses the configured pair and loads each of the four allowed themes', async () => {
    const pairs = [
      ['github-light', 'github-dark'],
      ['tokyo-night', 'dracula'],
    ] as const

    for (const themes of pairs) {
      const configured: [ThemeInput, ThemeInput] = [...themes]
      const plugin = createShikiCodePlugin({ themes: [...themes] })
      expect(plugin.getThemes()).toEqual(configured)
      const result = await highlight(plugin, `const theme = '${themes.join(':')}'`, 'typescript')
      expect(textFrom(result)).toContain('const theme')
      expect(
        result.tokens
          .flat()
          .some((token) => token.htmlStyle?.color && token.htmlStyle['--shiki-dark']),
      ).toBe(true)
    }
  })

  it('fans out one in-flight alias-normalized request and then returns it synchronously', async () => {
    const plugin = createShikiCodePlugin()
    const code = 'const sameRequest = { value: 928_441 }'
    let resolveFirst: (result: PluginHighlightResult) => void = () => undefined
    let resolveSecond: (result: PluginHighlightResult) => void = () => undefined
    const firstResult = new Promise<PluginHighlightResult>((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = new Promise<PluginHighlightResult>((resolve) => {
      resolveSecond = resolve
    })

    expect(
      plugin.highlight({ code, language: 'js', themes: defaultThemes }, resolveFirst),
    ).toBeNull()
    expect(
      plugin.highlight({ code, language: 'javascript', themes: defaultThemes }, resolveSecond),
    ).toBeNull()

    const [first, second] = await Promise.all([firstResult, secondResult])
    expect(second).toBe(first)
    expect(plugin.highlight({ code, language: 'js', themes: defaultThemes })).toBe(first)
  })

  it('falls unknown language tags back to exact plain text', async () => {
    const plugin = createShikiCodePlugin()
    const code = 'unregistered-language <must stay literal> 884219'
    const result = await highlight(plugin, code, 'unregistered-language' as BundledLanguage)

    expect(textFrom(result)).toBe(code)
  })

  it('loads aliases through their canonical grammar', async () => {
    const plugin = createShikiCodePlugin()
    const cases = [
      ['bash', 'echo "$HOME"'],
      ['c++', 'std::vector<int> values;'],
      ['dockerfile', 'FROM node:24-alpine'],
      ['py', 'def answer() -> int:'],
      ['yml', 'enabled: true'],
    ] as const

    for (const [language, code] of cases) {
      expect(textFrom(await highlight(plugin, code, language as BundledLanguage))).toBe(code)
    }
  })

  it('does not alias distinct full sources with matching prefixes and suffixes', async () => {
    const plugin = createShikiCodePlugin()
    const prefix = 'x'.repeat(120)
    const suffix = 'z'.repeat(120)
    const firstCode = `${prefix}alpha${suffix}`
    const secondCode = `${prefix}bravo${suffix}`
    const first = await highlight(plugin, firstCode, 'text' as BundledLanguage)
    const second = await highlight(plugin, secondCode, 'text' as BundledLanguage)

    expect(textFrom(first)).toBe(firstCode)
    expect(textFrom(second)).toBe(secondCode)
    expect(
      plugin.highlight({
        code: firstCode,
        language: 'text' as BundledLanguage,
        themes: defaultThemes,
      }),
    ).toBe(first)
    expect(
      plugin.highlight({
        code: secondCode,
        language: 'text' as BundledLanguage,
        themes: defaultThemes,
      }),
    ).toBe(second)
  })
})

function highlight(
  plugin: CodeHighlighterPlugin,
  code: string,
  language: BundledLanguage,
): Promise<PluginHighlightResult> {
  return new Promise((resolve) => {
    const immediate = plugin.highlight({ code, language, themes: plugin.getThemes() }, resolve)
    if (immediate) resolve(immediate)
  })
}

function textFrom(result: PluginHighlightResult): string {
  return result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')
}
