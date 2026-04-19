import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import { getSetting, setSetting } from '../../store/settings'

export type ShikiThemeChoice = 'github-light' | 'github-dark' | 'tokyo-night' | 'dracula'

export interface RenderingPreferences {
  shikiLight: ShikiThemeChoice
  shikiDark: ShikiThemeChoice
}

export const DEFAULT_RENDERING_PREFS: RenderingPreferences = {
  shikiLight: 'github-light',
  shikiDark: 'github-dark',
}

const STORAGE_KEY = 'rendering-preferences'

export async function readRenderingPreferences(): Promise<RenderingPreferences> {
  const stored = await getSetting<Partial<RenderingPreferences>>(STORAGE_KEY)
  return { ...DEFAULT_RENDERING_PREFS, ...(stored ?? {}) }
}

export async function writeRenderingPreferences(
  next: Partial<RenderingPreferences>,
): Promise<void> {
  const current = await readRenderingPreferences()
  await setSetting(STORAGE_KEY, { ...current, ...next })
}

export function RenderingSettings() {
  const prefs = useLiveQuery(readRenderingPreferences, [], DEFAULT_RENDERING_PREFS)
  const onLight = useCallback((value: ShikiThemeChoice) => {
    void writeRenderingPreferences({ shikiLight: value })
  }, [])
  const onDark = useCallback((value: ShikiThemeChoice) => {
    void writeRenderingPreferences({ shikiDark: value })
  }, [])
  return (
    <div data-ui="settings-section" data-ui-section="rendering-settings">
      <h3>Rendering</h3>
      <div data-ui="rendering-settings">
        <div data-ui="field-group">
          <label htmlFor="shiki-light">Code theme · light</label>
          <select
            id="shiki-light"
            data-ui="shiki-theme-light"
            value={prefs.shikiLight}
            onChange={(e) => onLight(e.target.value as ShikiThemeChoice)}
          >
            {THEME_CHOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div data-ui="field-group">
          <label htmlFor="shiki-dark">Code theme · dark</label>
          <select
            id="shiki-dark"
            data-ui="shiki-theme-dark"
            value={prefs.shikiDark}
            onChange={(e) => onDark(e.target.value as ShikiThemeChoice)}
          >
            {THEME_CHOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

const THEME_CHOICES: ShikiThemeChoice[] = ['github-light', 'github-dark', 'tokyo-night', 'dracula']
