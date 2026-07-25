import { createContext } from 'react'
import { definePresentationInteraction } from '../../app/presentation-interactions'
import {
  DEFAULT_RENDERING_PREFS,
  type RenderingPreferences,
  SHIKI_THEME_CHOICES,
  type ShikiThemeChoice,
} from '../../core/rendering-preferences'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { configurationApplication } from '../../store/configuration-application'
import { InfoDisclosure } from './InfoDisclosure'

export const RenderingPreferencesContext = createContext<RenderingPreferences | null>(null)

const renderingPreferenceInteraction = definePresentationInteraction<keyof RenderingPreferences>({
  id: 'rendering-preference.patch',
  label: 'Rendering preference update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
})

async function writeRenderingPreferences(next: Partial<RenderingPreferences>): Promise<void> {
  await configurationApplication.patchRenderingPreferences(next)
}

function useRenderingPreferences(): RenderingPreferences {
  return useConfigurationPreferences()?.rendering ?? DEFAULT_RENDERING_PREFS
}

export function RenderingSettings() {
  const prefs = useRenderingPreferences()
  const renderingInteraction = usePresentationInteraction(renderingPreferenceInteraction)
  const writePreference = <Key extends keyof RenderingPreferences>(
    key: Key,
    value: RenderingPreferences[Key],
  ) => {
    renderingInteraction.run({
      target: key,
      action: () => writeRenderingPreferences({ [key]: value }),
    })
  }
  return (
    <div data-ui="settings-section" data-ui-section="rendering-settings">
      <h3>Rendering</h3>
      <div data-ui="rendering-settings">
        <div data-ui="field-group">
          <label data-ui="toggle-row" htmlFor="single-newline-hard-breaks">
            <input
              id="single-newline-hard-breaks"
              data-ui="single-newline-hard-breaks"
              type="checkbox"
              checked={prefs.singleNewlineHardBreaks}
              disabled={renderingInteraction.isPending('singleNewlineHardBreaks')}
              onChange={(e) => writePreference('singleNewlineHardBreaks', e.target.checked)}
            />
            <span>Single newline as line break</span>
            <InfoDisclosure title="Single newline as line break">
              When on, markdown soft line endings render as visible line breaks. Paragraph breaks
              still use blank lines.
            </InfoDisclosure>
          </label>
        </div>
        <div data-ui="field-group">
          <label data-ui="toggle-row" htmlFor="single-dollar-text-math">
            <input
              id="single-dollar-text-math"
              data-ui="single-dollar-text-math"
              type="checkbox"
              checked={prefs.singleDollarTextMath}
              disabled={renderingInteraction.isPending('singleDollarTextMath')}
              onChange={(e) => writePreference('singleDollarTextMath', e.target.checked)}
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
            disabled={renderingInteraction.isPending('shikiLight')}
            onChange={(e) => writePreference('shikiLight', e.target.value as ShikiThemeChoice)}
          >
            {SHIKI_THEME_CHOICES.map((v) => (
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
            disabled={renderingInteraction.isPending('shikiDark')}
            onChange={(e) => writePreference('shikiDark', e.target.value as ShikiThemeChoice)}
          >
            {SHIKI_THEME_CHOICES.map((v) => (
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
