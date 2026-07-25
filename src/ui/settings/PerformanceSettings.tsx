import { useCallback } from 'react'
import { workspaceConfigurationWriteInteraction } from '../../app/presentation-interactions'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  MESSAGE_INITIAL_RENDER_WORK_MAX,
  MESSAGE_INITIAL_RENDER_WORK_MIN,
  MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY,
  type RenderWindowLoadMode,
  SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY,
  SIDEBAR_RENDER_WINDOW_SIZE_MAX,
  SIDEBAR_RENDER_WINDOW_SIZE_MIN,
} from '../../core/global-settings'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { useSettledConfigurationEdit } from '../../hooks/useSettledConfigurationEdit'
import {
  writeMessageInitialRenderWork,
  writeMessageRenderWindowLoadMode,
  writeSidebarRenderWindowLoadMode,
  writeSidebarRenderWindowSize,
} from '../../store/preferences-application'
import { InfoDisclosure } from './InfoDisclosure'

const LOAD_MODE_OPTIONS: ReadonlyArray<{ value: RenderWindowLoadMode; label: string }> = [
  { value: 'auto', label: 'Auto load while scrolling' },
  { value: 'manual', label: 'Require Load more' },
]

export function PerformanceSettings() {
  const { run: runWorkspaceConfigurationWrite } = usePresentationInteraction(
    workspaceConfigurationWriteInteraction,
    { observePending: false },
  )
  const prefs = useConfigurationPreferences()?.global ?? DEFAULT_GLOBAL_PREFERENCES
  const messageInitialRenderWork = useSettledConfigurationEdit({
    fieldKey: 'global.messageInitialRenderWork',
    storedValue: prefs.messageInitialRenderWork,
    commit: writeMessageInitialRenderWork,
  })
  const sidebarRenderWindowSize = useSettledConfigurationEdit({
    fieldKey: 'global.sidebarRenderWindowSize',
    storedValue: prefs.sidebarRenderWindowSize,
    commit: writeSidebarRenderWindowSize,
  })
  const onMessageRenderWindowLoadMode = useCallback(
    (value: RenderWindowLoadMode) =>
      runWorkspaceConfigurationWrite({
        target: MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY,
        action: () => writeMessageRenderWindowLoadMode(value),
      }),
    [runWorkspaceConfigurationWrite],
  )
  const onSidebarRenderWindowLoadMode = useCallback(
    (value: RenderWindowLoadMode) =>
      runWorkspaceConfigurationWrite({
        target: SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY,
        action: () => writeSidebarRenderWindowLoadMode(value),
      }),
    [runWorkspaceConfigurationWrite],
  )

  return (
    <>
      <div data-ui="settings-section">
        <h3>Chat Rendering</h3>
        <div data-ui="field-group" data-ui-inline-number-row="">
          <span>
            Initial render work
            <InfoDisclosure title="Initial render work">
              After the newest reply paints, fills at least this many messages in the background.
              Text, media, and viewport work may include more. It never limits chat length; older
              messages remain reachable through automatic scrolling or Load more.
            </InfoDisclosure>
          </span>
          <input
            type="number"
            aria-label="Initial render work"
            min={MESSAGE_INITIAL_RENDER_WORK_MIN}
            max={MESSAGE_INITIAL_RENDER_WORK_MAX}
            step={1}
            value={messageInitialRenderWork.value}
            onChange={(e) => {
              if (Number.isFinite(e.currentTarget.valueAsNumber)) {
                messageInitialRenderWork.setValue(e.currentTarget.valueAsNumber)
              }
            }}
            onBlur={messageInitialRenderWork.onBlur}
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
            value={sidebarRenderWindowSize.value}
            onChange={(e) => {
              if (Number.isFinite(e.currentTarget.valueAsNumber)) {
                sidebarRenderWindowSize.setValue(e.currentTarget.valueAsNumber)
              }
            }}
            onBlur={sidebarRenderWindowSize.onBlur}
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
