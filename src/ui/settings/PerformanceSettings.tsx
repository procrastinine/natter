import { useCallback } from 'react'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  MESSAGE_RENDER_WINDOW_SIZE_MAX,
  MESSAGE_RENDER_WINDOW_SIZE_MIN,
  type RenderWindowLoadMode,
  readGlobalPreferences,
  SIDEBAR_RENDER_WINDOW_SIZE_MAX,
  SIDEBAR_RENDER_WINDOW_SIZE_MIN,
  writeMessageRenderWindowLoadMode,
  writeMessageRenderWindowSize,
  writeSidebarRenderWindowLoadMode,
  writeSidebarRenderWindowSize,
} from '../../core/global-settings'
import { GLOBAL_PREFERENCES_DEPENDENCIES } from '../../store/reactive-dependencies'
import { useRepositoryQuery } from '../../store/reactive-query'
import { InfoDisclosure } from './InfoDisclosure'

const LOAD_MODE_OPTIONS: ReadonlyArray<{ value: RenderWindowLoadMode; label: string }> = [
  { value: 'auto', label: 'Auto load while scrolling' },
  { value: 'manual', label: 'Require Load more' },
]

export function PerformanceSettings() {
  const prefs = useRepositoryQuery(
    'global-preferences',
    readGlobalPreferences,
    DEFAULT_GLOBAL_PREFERENCES,
    GLOBAL_PREFERENCES_DEPENDENCIES,
  )

  const onMessageRenderWindowSize = useCallback(async (value: number) => {
    await writeMessageRenderWindowSize(value)
  }, [])
  const onSidebarRenderWindowSize = useCallback(async (value: number) => {
    await writeSidebarRenderWindowSize(value)
  }, [])
  const onMessageRenderWindowLoadMode = useCallback(async (value: RenderWindowLoadMode) => {
    await writeMessageRenderWindowLoadMode(value)
  }, [])
  const onSidebarRenderWindowLoadMode = useCallback(async (value: RenderWindowLoadMode) => {
    await writeSidebarRenderWindowLoadMode(value)
  }, [])

  return (
    <>
      <div data-ui="settings-section">
        <h3>Chat Rendering</h3>
        <div data-ui="field-group" data-ui-inline-number-row="">
          <span>
            Newest messages
            <InfoDisclosure title="Newest messages">
              The active chat mounts only the newest messages initially. Older messages are added in
              batches when you scroll to the top or press Load more.
            </InfoDisclosure>
          </span>
          <input
            type="number"
            aria-label="Newest messages"
            min={MESSAGE_RENDER_WINDOW_SIZE_MIN}
            max={MESSAGE_RENDER_WINDOW_SIZE_MAX}
            step={1}
            value={prefs.messageRenderWindowSize}
            onChange={(e) => void onMessageRenderWindowSize(e.currentTarget.valueAsNumber)}
          />
        </div>
        <div data-ui="field-group">
          <label htmlFor="message-render-window-load-mode">Older messages</label>
          <select
            id="message-render-window-load-mode"
            data-ui="message-render-window-load-mode"
            value={prefs.messageRenderWindowLoadMode}
            onChange={(e) =>
              void onMessageRenderWindowLoadMode(e.target.value as RenderWindowLoadMode)
            }
          >
            {LOAD_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Sidebar Rendering</h3>
        <div data-ui="field-group" data-ui-inline-number-row="">
          <span>
            First rows
            <InfoDisclosure title="First rows">
              The sidebar mounts the first rows in the current sort or search order, then expands in
              batches near the bottom or through Load more.
            </InfoDisclosure>
          </span>
          <input
            type="number"
            aria-label="First rows"
            min={SIDEBAR_RENDER_WINDOW_SIZE_MIN}
            max={SIDEBAR_RENDER_WINDOW_SIZE_MAX}
            step={1}
            value={prefs.sidebarRenderWindowSize}
            onChange={(e) => void onSidebarRenderWindowSize(e.currentTarget.valueAsNumber)}
          />
        </div>
        <div data-ui="field-group">
          <label htmlFor="sidebar-render-window-load-mode">More rows</label>
          <select
            id="sidebar-render-window-load-mode"
            data-ui="sidebar-render-window-load-mode"
            value={prefs.sidebarRenderWindowLoadMode}
            onChange={(e) =>
              void onSidebarRenderWindowLoadMode(e.target.value as RenderWindowLoadMode)
            }
          >
            {LOAD_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  )
}
