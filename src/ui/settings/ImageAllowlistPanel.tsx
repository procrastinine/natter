import { useCallback, useState } from 'react'
import { DEFAULT_IMAGE_ORIGINS } from '../../core/image-allowlist'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { configurationApplication } from '../../store/configuration-application'
import { TrashIcon } from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'

export function normalizeOrigin(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return trimmed
  }
  if (/^https?:\/\//.test(trimmed)) {
    const candidate = trimmed.replace(/\/$/, '')
    try {
      const u = new URL(candidate)
      return u.origin
    } catch {
      return candidate
    }
  }
  if (trimmed.startsWith('*.')) {
    return `https://${trimmed}`
  }
  return `https://${trimmed}`
}

export function ImageAllowlistPanel() {
  const allowlist = useConfigurationPreferences()?.imageAllowlist ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onAdd = useCallback(async () => {
    const normalized = normalizeOrigin(draft)
    if (!normalized) {
      setError('Enter an origin like https://example.com or https://*.example.com.')
      return
    }
    if (allowlist.includes(normalized) || DEFAULT_IMAGE_ORIGINS.includes(normalized)) {
      setError('Origin already allowed.')
      return
    }
    setError(null)
    setDraft('')
    await configurationApplication.addImageOrigin(normalized)
  }, [allowlist, draft])

  const onRemove = useCallback(async (origin: string) => {
    await configurationApplication.removeImageOrigin(origin)
  }, [])

  return (
    <div data-ui="settings-section">
      <h3>
        Image whitelist
        <InfoDisclosure title="Image whitelist">
          Images from origins not on this whitelist are replaced with a blocked-image stub. Built-in
          origins are always allowed.
        </InfoDisclosure>
      </h3>
      <div data-ui="image-allowlist-add">
        <input
          aria-label="Origin to allow"
          data-ui="image-allowlist-input"
          type="text"
          placeholder="https://example.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void onAdd()
            }
          }}
        />
        <Button type="button" data-ui="image-allowlist-add-button" onClick={() => void onAdd()}>
          Add
        </Button>
      </div>
      {error ? (
        <span data-ui="helper" data-validation="invalid" role="alert">
          {error}
        </span>
      ) : null}
      <table data-ui="image-allowlist">
        <thead>
          <tr>
            <th scope="col">Origin</th>
            <th scope="col">Source</th>
            <th scope="col" data-ui="image-allowlist-action-col">
              <span data-ui="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {DEFAULT_IMAGE_ORIGINS.map((origin) => (
            <tr key={origin} data-ui="image-allowlist-row" data-origin={origin} data-builtin="true">
              <td>
                <code>{origin}</code>
              </td>
              <td data-ui="image-allowlist-source">built-in</td>
              <td data-ui="image-allowlist-action-cell" />
            </tr>
          ))}
          {allowlist.map((origin) => (
            <tr
              key={origin}
              data-ui="image-allowlist-row"
              data-origin={origin}
              data-builtin="false"
            >
              <td>
                <code>{origin}</code>
              </td>
              <td data-ui="image-allowlist-source">custom</td>
              <td data-ui="image-allowlist-action-cell">
                <IconButton
                  type="button"
                  data-ui="icon-button"
                  data-size="sm"
                  data-variant="danger"
                  data-role="image-allowlist-remove"
                  aria-label={`Remove ${origin}`}
                  title="Remove"
                  onClick={() => void onRemove(origin)}
                >
                  <TrashIcon size={14} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
