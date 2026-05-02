import { useLiveQuery } from 'dexie-react-hooks'
import { createContext, type ReactNode, useCallback, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../../store/settings'
import { InfoDisclosure } from './InfoDisclosure'

export type ShikiThemeChoice = 'github-light' | 'github-dark' | 'tokyo-night' | 'dracula'

interface RenderingPreferences {
  shikiLight: ShikiThemeChoice
  shikiDark: ShikiThemeChoice
  singleDollarTextMath: boolean
}

export const DEFAULT_RENDERING_PREFS: RenderingPreferences = {
  shikiLight: 'github-light',
  shikiDark: 'github-dark',
  singleDollarTextMath: false,
}

export const RenderingPreferencesContext =
  createContext<RenderingPreferences>(DEFAULT_RENDERING_PREFS)

const STORAGE_KEY = 'rendering-preferences'
type RenderingPreferencesListener = (prefs: RenderingPreferences) => void
const renderingPreferencesListeners = new Set<RenderingPreferencesListener>()
let latestRenderingPreferences = DEFAULT_RENDERING_PREFS

function publishRenderingPreferences(prefs: RenderingPreferences): void {
  latestRenderingPreferences = prefs
  for (const listener of renderingPreferencesListeners) listener(prefs)
}

function subscribeRenderingPreferences(listener: RenderingPreferencesListener): () => void {
  renderingPreferencesListeners.add(listener)
  return () => renderingPreferencesListeners.delete(listener)
}

async function readRenderingPreferences(): Promise<RenderingPreferences> {
  const stored = await getSetting<Partial<RenderingPreferences>>(STORAGE_KEY)
  return { ...DEFAULT_RENDERING_PREFS, ...(stored ?? {}) }
}

async function writeRenderingPreferences(next: Partial<RenderingPreferences>): Promise<void> {
  publishRenderingPreferences({ ...latestRenderingPreferences, ...next })
  const current = await readRenderingPreferences()
  const updated = { ...current, ...next }
  await setSetting(STORAGE_KEY, updated)
  publishRenderingPreferences(updated)
}

function useRenderingPreferences(): RenderingPreferences {
  const storedPrefs = useLiveQuery(readRenderingPreferences, [], DEFAULT_RENDERING_PREFS)
  const [prefs, setPrefs] = useState<RenderingPreferences>(storedPrefs ?? DEFAULT_RENDERING_PREFS)
  useEffect(() => {
    const next = storedPrefs ?? DEFAULT_RENDERING_PREFS
    latestRenderingPreferences = next
    setPrefs(next)
  }, [storedPrefs])
  useEffect(() => subscribeRenderingPreferences(setPrefs), [])
  return prefs
}

export function RenderingPreferencesProvider({ children }: { children: ReactNode }) {
  const prefs = useRenderingPreferences()
  return (
    <RenderingPreferencesContext.Provider value={prefs}>
      {children}
    </RenderingPreferencesContext.Provider>
  )
}

export function RenderingSettings() {
  const prefs = useRenderingPreferences()
  const onLight = useCallback((value: ShikiThemeChoice) => {
    void writeRenderingPreferences({ shikiLight: value })
  }, [])
  const onDark = useCallback((value: ShikiThemeChoice) => {
    void writeRenderingPreferences({ shikiDark: value })
  }, [])
  const onSingleDollarTextMath = useCallback((value: boolean) => {
    void writeRenderingPreferences({ singleDollarTextMath: value })
  }, [])
  return (
    <div data-ui="settings-section" data-ui-section="rendering-settings">
      <h3>Rendering</h3>
      <div data-ui="rendering-settings">
        <div data-ui="field-group">
          <label data-ui="toggle-row" htmlFor="single-dollar-text-math">
            <input
              id="single-dollar-text-math"
              data-ui="single-dollar-text-math"
              type="checkbox"
              checked={prefs.singleDollarTextMath}
              onChange={(e) => onSingleDollarTextMath(e.target.checked)}
            />
            <span>Single-dollar LaTeX markdown</span>
            <InfoDisclosure title="Single-dollar LaTeX markdown">
              When on, $...$ renders as inline math. Keep off for price-heavy chats; use $$...$$ for
              math.
            </InfoDisclosure>
          </label>
        </div>
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
