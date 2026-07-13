import { createBundledHighlighter, type TokensResult } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { CodeHighlighterPlugin, ThemeInput } from 'streamdown'
import type { ShikiThemeChoice } from '../../core/rendering-preferences'

const DEFAULT_THEMES: ShikiThemePair = ['github-light', 'github-dark']

export const SHIKI_CODE_CACHE_LIMITS = Object.freeze({
  entries: 64,
  sourceChars: 500_000,
})

type ShikiThemePair = [ShikiThemeChoice, ShikiThemeChoice]
type HighlightLanguage = SupportedLanguage | 'text'
type HighlightCallback = (result: TokensResult) => void

interface RequestKey {
  language: HighlightLanguage
  themes: ShikiThemePair
}

interface PendingHighlight {
  callbacks: Set<HighlightCallback>
}

interface CachedHighlight {
  code: string
  key: RequestKey
  result: TokensResult
}

type CodeBucket<T> = Map<string, T>
type DarkThemeBuckets<T> = Map<ShikiThemeChoice, CodeBucket<T>>
type LightThemeBuckets<T> = Map<ShikiThemeChoice, DarkThemeBuckets<T>>
type RequestIndex<T> = Map<HighlightLanguage, LightThemeBuckets<T>>

const themeLoaders = {
  'github-light': () => import('@shikijs/themes/github-light'),
  'github-dark': () => import('@shikijs/themes/github-dark'),
  'tokyo-night': () => import('@shikijs/themes/tokyo-night'),
  dracula: () => import('@shikijs/themes/dracula'),
} satisfies Record<ShikiThemeChoice, () => Promise<{ default: ThemeInput }>>

const languageLoaders = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  docker: () => import('@shikijs/langs/docker'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  jsx: () => import('@shikijs/langs/jsx'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  latex: () => import('@shikijs/langs/latex'),
  lua: () => import('@shikijs/langs/lua'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  r: () => import('@shikijs/langs/r'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const

type SupportedLanguage = keyof typeof languageLoaders

const languageAliases = {
  bash: 'shellscript',
  'c#': 'csharp',
  'c++': 'cpp',
  cjs: 'javascript',
  cs: 'csharp',
  cts: 'typescript',
  dockerfile: 'docker',
  htm: 'html',
  js: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  ps: 'powershell',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'shellscript',
  shell: 'shellscript',
  tex: 'latex',
  ts: 'typescript',
  xhtml: 'html',
  yml: 'yaml',
  zsh: 'shellscript',
} as const satisfies Record<string, SupportedLanguage>

const createHighlighter = createBundledHighlighter({
  langs: languageLoaders,
  themes: themeLoaders,
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
})

type ShikiHighlighter = Awaited<ReturnType<typeof createHighlighter>>

export const SHIKI_SUPPORTED_LANGUAGES = Object.freeze(
  Object.keys(languageLoaders) as SupportedLanguage[],
)
const supportedLanguages = SHIKI_SUPPORTED_LANGUAGES
const supportedLanguageSet = new Set<string>(supportedLanguages)
const languageAliasMap = new Map<string, SupportedLanguage>(Object.entries(languageAliases))
const allowedThemeSet = new Set<ShikiThemeChoice>(Object.keys(themeLoaders) as ShikiThemeChoice[])

let highlighterPromise: Promise<ShikiHighlighter> | undefined
const languageLoads = new Map<SupportedLanguage, Promise<void>>()
const themeLoads = new Map<ShikiThemeChoice, Promise<void>>()
const pendingHighlights: RequestIndex<PendingHighlight> = new Map()

export interface ShikiCodePluginOptions {
  themes?: ShikiThemePair
}

export function createShikiCodePlugin(options: ShikiCodePluginOptions = {}): CodeHighlighterPlugin {
  const configuredThemes: ShikiThemePair = options.themes
    ? [...options.themes]
    : [...DEFAULT_THEMES]

  return {
    name: 'shiki',
    type: 'code-highlighter',
    getSupportedLanguages: () => [...supportedLanguages],
    getThemes: () => configuredThemes,
    supportsLanguage: (language) => supportedLanguageSet.has(normalizeLanguage(language)),
    highlight: ({ code, language, themes }, callback) => {
      const key: RequestKey = {
        language: normalizedHighlightLanguage(language),
        themes: normalizeThemes(themes, configuredThemes),
      }
      const cached = resultCache.get(key, code)
      if (cached) return cached

      const existing = getIndexed(pendingHighlights, key, code)
      if (existing) {
        if (callback) existing.callbacks.add(callback)
        return null
      }

      const pending: PendingHighlight = { callbacks: new Set() }
      if (callback) pending.callbacks.add(callback)
      setIndexed(pendingHighlights, key, code, pending)
      void tokenize(code, key)
        .then((result) => {
          if (!deleteIndexed(pendingHighlights, key, code, pending)) return
          resultCache.set(key, code, result)
          notifyCallbacks(pending.callbacks, result)
        })
        .catch((error: unknown) => {
          deleteIndexed(pendingHighlights, key, code, pending)
          console.error('[Natter Code] Failed to highlight code:', error)
        })
      return null
    },
  }
}

async function tokenize(code: string, key: RequestKey): Promise<TokensResult> {
  const highlighter = await getHighlighter()
  await Promise.all([
    ensureLanguageLoaded(highlighter, key.language),
    ensureThemeLoaded(highlighter, key.themes[0]),
    ensureThemeLoaded(highlighter, key.themes[1]),
  ])
  return highlighter.codeToTokens(code, {
    lang: key.language,
    themes: { light: key.themes[0], dark: key.themes[1] },
  })
}

function getHighlighter(): Promise<ShikiHighlighter> {
  if (highlighterPromise) return highlighterPromise
  const created = createHighlighter({ langs: [], themes: [] })
  highlighterPromise = created
  void created.catch(() => {
    if (highlighterPromise === created) highlighterPromise = undefined
  })
  return created
}

function ensureLanguageLoaded(
  highlighter: ShikiHighlighter,
  language: HighlightLanguage,
): Promise<void> {
  if (language === 'text') return Promise.resolve()
  const existing = languageLoads.get(language)
  if (existing) return existing
  const created = Promise.resolve(highlighter.loadLanguage(language)).catch((error: unknown) => {
    if (languageLoads.get(language) === created) languageLoads.delete(language)
    throw error
  })
  languageLoads.set(language, created)
  return created
}

function ensureThemeLoaded(highlighter: ShikiHighlighter, theme: ShikiThemeChoice): Promise<void> {
  const existing = themeLoads.get(theme)
  if (existing) return existing
  const created = Promise.resolve(highlighter.loadTheme(theme)).catch((error: unknown) => {
    if (themeLoads.get(theme) === created) themeLoads.delete(theme)
    throw error
  })
  themeLoads.set(theme, created)
  return created
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase()
  return languageAliasMap.get(normalized) ?? normalized
}

function normalizedHighlightLanguage(language: string): HighlightLanguage {
  const normalized = normalizeLanguage(language)
  return supportedLanguageSet.has(normalized) ? (normalized as SupportedLanguage) : 'text'
}

function normalizeThemes(
  themes: [ThemeInput, ThemeInput],
  fallbacks: ShikiThemePair,
): ShikiThemePair {
  return [normalizeTheme(themes[0], fallbacks[0]), normalizeTheme(themes[1], fallbacks[1])]
}

function normalizeTheme(theme: ThemeInput, fallback: ShikiThemeChoice): ShikiThemeChoice {
  const name = typeof theme === 'string' ? theme : theme.name
  return allowedThemeSet.has(name as ShikiThemeChoice) ? (name as ShikiThemeChoice) : fallback
}

function notifyCallbacks(callbacks: Set<HighlightCallback>, result: TokensResult): void {
  for (const callback of callbacks) {
    try {
      callback(result)
    } catch (error) {
      console.error('[Natter Code] Highlight callback failed:', error)
    }
  }
}

class HighlightResultCache {
  readonly #index: RequestIndex<CachedHighlight> = new Map()
  readonly #recency = new Map<CachedHighlight, true>()
  readonly #maxEntries: number
  readonly #maxSourceChars: number
  #sourceChars = 0

  constructor(maxEntries: number, maxSourceChars: number) {
    this.#maxEntries = maxEntries
    this.#maxSourceChars = maxSourceChars
  }

  get(key: RequestKey, code: string): TokensResult | undefined {
    const entry = getIndexed(this.#index, key, code)
    if (!entry) return undefined
    this.#recency.delete(entry)
    this.#recency.set(entry, true)
    return entry.result
  }

  set(key: RequestKey, code: string, result: TokensResult): void {
    if (code.length > this.#maxSourceChars) return
    const existing = getIndexed(this.#index, key, code)
    if (existing) {
      existing.result = result
      this.#recency.delete(existing)
      this.#recency.set(existing, true)
      return
    }
    const entry: CachedHighlight = {
      code,
      key: { language: key.language, themes: [...key.themes] },
      result,
    }
    setIndexed(this.#index, key, code, entry)
    this.#recency.set(entry, true)
    this.#sourceChars += code.length
    while (this.#recency.size > this.#maxEntries || this.#sourceChars > this.#maxSourceChars) {
      const oldest = this.#recency.keys().next().value
      if (!oldest) break
      this.#recency.delete(oldest)
      if (deleteIndexed(this.#index, oldest.key, oldest.code, oldest)) {
        this.#sourceChars -= oldest.code.length
      }
    }
  }
}

const resultCache = new HighlightResultCache(
  SHIKI_CODE_CACHE_LIMITS.entries,
  SHIKI_CODE_CACHE_LIMITS.sourceChars,
)

function getIndexed<T>(index: RequestIndex<T>, key: RequestKey, code: string): T | undefined {
  return index.get(key.language)?.get(key.themes[0])?.get(key.themes[1])?.get(code)
}

function setIndexed<T>(index: RequestIndex<T>, key: RequestKey, code: string, value: T): void {
  let lightThemes = index.get(key.language)
  if (!lightThemes) {
    lightThemes = new Map()
    index.set(key.language, lightThemes)
  }
  let darkThemes = lightThemes.get(key.themes[0])
  if (!darkThemes) {
    darkThemes = new Map()
    lightThemes.set(key.themes[0], darkThemes)
  }
  let codes = darkThemes.get(key.themes[1])
  if (!codes) {
    codes = new Map()
    darkThemes.set(key.themes[1], codes)
  }
  codes.set(code, value)
}

function deleteIndexed<T>(
  index: RequestIndex<T>,
  key: RequestKey,
  code: string,
  expected: T,
): boolean {
  const lightThemes = index.get(key.language)
  const darkThemes = lightThemes?.get(key.themes[0])
  const codes = darkThemes?.get(key.themes[1])
  if (codes?.get(code) !== expected) return false
  codes.delete(code)
  if (codes.size === 0) darkThemes?.delete(key.themes[1])
  if (darkThemes?.size === 0) lightThemes?.delete(key.themes[0])
  if (lightThemes?.size === 0) index.delete(key.language)
  return true
}
