export type ShikiThemeChoice = 'github-light' | 'github-dark' | 'tokyo-night' | 'dracula'

export interface RenderingPreferences {
  shikiLight: ShikiThemeChoice
  shikiDark: ShikiThemeChoice
  singleDollarTextMath: boolean
  singleNewlineHardBreaks: boolean
}

export const RENDERING_PREFERENCES_KEY = 'rendering-preferences'

export const SHIKI_THEME_CHOICES: readonly ShikiThemeChoice[] = [
  'github-light',
  'github-dark',
  'tokyo-night',
  'dracula',
]

export const DEFAULT_RENDERING_PREFS: Readonly<RenderingPreferences> = Object.freeze({
  shikiLight: 'github-light',
  shikiDark: 'github-dark',
  singleDollarTextMath: false,
  singleNewlineHardBreaks: false,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shikiThemeOrDefault(value: unknown, fallback: ShikiThemeChoice): ShikiThemeChoice {
  return SHIKI_THEME_CHOICES.includes(value as ShikiThemeChoice)
    ? (value as ShikiThemeChoice)
    : fallback
}

export function normalizeRenderingPreferences(value: unknown): RenderingPreferences {
  if (!isRecord(value)) return { ...DEFAULT_RENDERING_PREFS }
  return {
    shikiLight: shikiThemeOrDefault(value.shikiLight, DEFAULT_RENDERING_PREFS.shikiLight),
    shikiDark: shikiThemeOrDefault(value.shikiDark, DEFAULT_RENDERING_PREFS.shikiDark),
    singleDollarTextMath: value.singleDollarTextMath === true,
    singleNewlineHardBreaks: value.singleNewlineHardBreaks === true,
  }
}
