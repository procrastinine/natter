import type { ProfileId } from '../../core/types'
import { ConfirmDialog } from '../primitives/ConfirmDialog'

export interface ConnectionDeleteDependents {
  presetCount: number
  chatCount: number
}

export interface ConnectionDeleteReplacementProfile {
  readonly id: ProfileId
  readonly name: string
  readonly archived?: boolean
}

const LOAD_PREVIOUS_PROFILES_VALUE = '__natter_load_previous_profiles__'
const LOAD_MORE_PROFILES_VALUE = '__natter_load_more_profiles__'

export function ConnectionDeleteDialog({
  profileName,
  busy,
  dependents,
  replacementProfiles,
  hasPreviousReplacementProfiles,
  hasMoreReplacementProfiles,
  reassignTo,
  error,
  onCancel,
  onConfirm,
  onLoadPreviousReplacementProfiles,
  onLoadMoreReplacementProfiles,
  onReassignTo,
}: {
  profileName: string
  busy: boolean
  dependents: ConnectionDeleteDependents | null
  replacementProfiles: readonly ConnectionDeleteReplacementProfile[]
  hasPreviousReplacementProfiles: boolean
  hasMoreReplacementProfiles: boolean
  reassignTo: ProfileId | null
  error: string | null
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  onLoadPreviousReplacementProfiles: () => void
  onLoadMoreReplacementProfiles: () => void
  onReassignTo: (profileId: ProfileId | null) => void
}) {
  const presetCount = dependents?.presetCount ?? 0
  const chatCount = dependents?.chatCount ?? 0
  const blocked = presetCount > 0 || chatCount > 0
  const dependencyLabel = `${presetCount} ${presetCount === 1 ? 'preset' : 'presets'} and ${chatCount} ${chatCount === 1 ? 'chat' : 'chats'}`
  return (
    <ConfirmDialog
      title="Delete connection?"
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={busy}
      confirmDisabled={dependents === null || (blocked && reassignTo === null) || error !== null}
      initialFocus="cancel"
      onCancel={onCancel}
      onConfirm={onConfirm}
      closeLabel="Cancel connection delete"
    >
      <div data-ui="confirm-dialog-copy">
        <p>
          Delete <strong>{profileName}</strong>? This cannot be undone.
        </p>
        <p data-role="status" data-state={error ? 'error' : blocked ? 'blocked' : 'ready'}>
          {error ? (
            <strong>{error}</strong>
          ) : dependents === null ? (
            'Checking dependent presets and chats…'
          ) : blocked ? (
            <>{dependencyLabel} still use this connection. Choose where to move them.</>
          ) : (
            'No presets or chats use this connection.'
          )}
        </p>
        {blocked ? (
          <label data-ui="field-group">
            Reassign presets and chats
            <select
              aria-label="Replacement connection"
              value={reassignTo ?? ''}
              onChange={(event) => {
                if (event.target.value === LOAD_PREVIOUS_PROFILES_VALUE) {
                  onLoadPreviousReplacementProfiles()
                  return
                }
                if (event.target.value === LOAD_MORE_PROFILES_VALUE) {
                  onLoadMoreReplacementProfiles()
                  return
                }
                onReassignTo(event.target.value || null)
              }}
            >
              <option value="">Choose a connection…</option>
              {hasPreviousReplacementProfiles ? (
                <option value={LOAD_PREVIOUS_PROFILES_VALUE}>Previous connections…</option>
              ) : null}
              {replacementProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
              {hasMoreReplacementProfiles ? (
                <option value={LOAD_MORE_PROFILES_VALUE}>Next connections…</option>
              ) : null}
            </select>
          </label>
        ) : null}
      </div>
    </ConfirmDialog>
  )
}
