// Rendered beneath the chat title bar while `useUiStore.editTreeMode` is on.
// Exposes the cascade-delete checkbox and an Escape-able exit button so tree
// edits stay discoverable.

import { useUiStore } from '../../store/zustand/uiStore'
import { CloseIcon } from '../icons/Icon'

export function EditTreeToolbar() {
  const editTreeMode = useUiStore((s) => s.editTreeMode)
  const cascadeDelete = useUiStore((s) => s.cascadeDelete)
  const setEditTreeMode = useUiStore((s) => s.setEditTreeMode)
  const setCascadeDelete = useUiStore((s) => s.setCascadeDelete)
  if (!editTreeMode) return null
  return (
    <div data-ui="edit-tree-toolbar" role="toolbar" aria-label="Edit tree mode">
      <label data-ui="edit-tree-cascade">
        <input
          type="checkbox"
          data-ui="edit-tree-cascade-checkbox"
          checked={cascadeDelete}
          onChange={(e) => setCascadeDelete(e.target.checked)}
        />
        Also delete descendants
      </label>
      <span data-ui="edit-tree-spacer" />
      <button
        type="button"
        data-ui="icon-button"
        data-role="edit-tree-exit"
        aria-label="Exit edit tree mode"
        title="Exit edit tree mode (Esc)"
        onClick={() => setEditTreeMode(false)}
      >
        <CloseIcon size={14} />
      </button>
    </div>
  )
}
