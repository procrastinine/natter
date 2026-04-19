import { useEffect, useState } from 'react'
import { CloseIcon } from '../icons/Icon'
import { AppearanceSettings } from './AppearanceSettings'
import { GeneralSettings } from './GeneralSettings'
import { ImageAllowlistPanel } from './ImageAllowlistPanel'

export type GlobalSettingsTab = 'general' | 'appearance' | 'images'

const TAB_LABELS: Record<GlobalSettingsTab, string> = {
  general: 'General',
  appearance: 'Appearance',
  images: 'Images',
}

export interface GlobalSettingsModalProps {
  open: boolean
  onClose: () => void
}

export function GlobalSettingsModal({ open, onClose }: GlobalSettingsModalProps) {
  const [tab, setTab] = useState<GlobalSettingsTab>('general')
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      data-ui="global-settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Global settings"
    >
      <div
        data-ui="global-settings-scrim"
        onClick={onClose}
        role="button"
        tabIndex={-1}
        aria-label="Close global settings"
      />
      <section data-ui="global-settings-modal" data-ui-modal="global-settings">
        <header data-ui="global-settings-header">
          <h2>Settings</h2>
          <button
            type="button"
            data-ui="icon-button"
            data-role="global-settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div role="tablist" data-ui="settings-tabs">
          {(['general', 'appearance', 'images'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              data-ui="settings-tab"
              data-tab={value}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {TAB_LABELS[value]}
            </button>
          ))}
        </div>
        <div role="tabpanel" data-ui="settings-panel" data-active-tab={tab}>
          {tab === 'general' ? <GeneralSettings /> : null}
          {tab === 'appearance' ? <AppearanceSettings /> : null}
          {tab === 'images' ? <ImageAllowlistPanel /> : null}
        </div>
      </section>
    </div>
  )
}
