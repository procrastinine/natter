import { useState } from 'react'
import { CloseIcon } from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { Dialog } from '../primitives/Dialog'
import { AppearanceSettings } from './AppearanceSettings'
import { GeneralSettings } from './GeneralSettings'
import { ImageAllowlistPanel } from './ImageAllowlistPanel'
import { PerformanceSettings } from './PerformanceSettings'

type GlobalSettingsTab = 'general' | 'appearance' | 'performance' | 'images'

const TAB_LABELS: Record<GlobalSettingsTab, string> = {
  general: 'General',
  appearance: 'Appearance',
  performance: 'Performance',
  images: 'Images',
}

const GLOBAL_SETTINGS_TABS: readonly GlobalSettingsTab[] = [
  'general',
  'appearance',
  'performance',
  'images',
]

interface GlobalSettingsModalProps {
  open: boolean
  onClose: () => void
}

export function GlobalSettingsModal({ open, onClose }: GlobalSettingsModalProps) {
  const [tab, setTab] = useState<GlobalSettingsTab>('general')
  if (!open) return null
  return (
    <Dialog
      onClose={onClose}
      overlayUi="global-settings-overlay"
      scrimUi="global-settings-scrim"
      surfaceUi="global-settings-modal"
      surfaceAs="section"
      ariaLabel="Global settings"
      scrimLabel="Close global settings"
      backdrop="blurred"
      surfaceProps={{ 'data-ui-modal': 'global-settings' }}
    >
      <header data-ui="global-settings-header">
        <h2>Settings</h2>
        <IconButton
          type="button"
          data-ui="icon-button"
          data-role="global-settings-close"
          onClick={onClose}
          aria-label="Close settings"
        >
          <CloseIcon size={16} />
        </IconButton>
      </header>
      <div role="tablist" data-ui="settings-tabs">
        {GLOBAL_SETTINGS_TABS.map((value) => (
          <Button
            key={value}
            type="button"
            role="tab"
            data-ui="settings-tab"
            data-tab={value}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {TAB_LABELS[value]}
          </Button>
        ))}
      </div>
      <div role="tabpanel" data-ui="settings-panel" data-active-tab={tab}>
        {tab === 'general' ? <GeneralSettings /> : null}
        {tab === 'appearance' ? <AppearanceSettings /> : null}
        {tab === 'performance' ? <PerformanceSettings /> : null}
        {tab === 'images' ? <ImageAllowlistPanel /> : null}
      </div>
    </Dialog>
  )
}
