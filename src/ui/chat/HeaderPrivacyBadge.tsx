// Header privacy badge. See `plan/09-privacy.md §9.11`.
//
// Rendered in the chat title bar next to info/settings. Shows the
// overall privacy tier for the currently active chat's model, derived
// from the kept providers after the privacy filter runs. Click opens a
// popover listing the kept providers and their policies. Hidden for
// non-OpenRouter connections and for free models.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef, useState } from 'react'
import type { Chat, ChatId } from '../../core/types'
import { providerDisplayLabel, providerEndpointKey } from '../../core/provider-identity'
import { getChat } from '../../store/chats'
import { usePrivacyRouting } from '../../hooks/usePrivacyRouting'
import { CloseIcon, LockIcon, LockOpenIcon } from '../icons/Icon'
import {
  tierToLockLabel,
  reasonsToTooltip,
  type PickerRow,
  buildPickerRows,
} from '../settings/provider-picker-rows'
import type { PrivacyTier } from '../../core/privacy-filter'

export interface HeaderPrivacyBadgeProps {
  chatId: ChatId
}

export function HeaderPrivacyBadge({ chatId }: HeaderPrivacyBadgeProps) {
  const chat = useLiveQuery(() => getChat(chatId), [chatId], undefined) as Chat | undefined
  if (!chat) return null
  return <Inner chat={chat} />
}

function Inner({ chat }: { chat: Chat }) {
  const routing = usePrivacyRouting(chat)
  const { filter, endpoints, scrapeApplicable, isFreeModel, loading } = routing
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  // Dismiss on outside-click / Escape — standard popover behavior so the
  // badge doesn't swallow keyboard focus or trap clicks when the user
  // moves on.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Free models skip the filter entirely — render the open lock so the
  // user understands privacy routing doesn't apply here.
  if (isFreeModel) {
    return (
      <button
        type="button"
        data-ui="icon-button"
        data-ui-surface="header-privacy-badge"
        data-privacy-tier="open"
        aria-label="Privacy: free model (routing unfiltered)"
        title="Privacy routing is disabled on :free models"
        disabled
      >
        <LockOpenIcon size={18} />
      </button>
    )
  }

  // Non-OpenRouter connections don't expose a per-model data policy, so
  // the badge is simply not rendered. Direct-provider privacy is an
  // always-on attribute of the profile itself.
  if (!scrapeApplicable) return null

  // While the filter is resolving for the first time on this
  // (profile, model) pair, a muted lock is rendered rather than jumping
  // from "unavailable" to real tier on arrival.
  const rows = filter
    ? buildPickerRows(endpoints, filter, {
        providerPrefs: chat.settings.providerPrefs,
        privacy: chat.settings.privacy,
      })
    : []
  const kept = rows.filter((r) => r.state === 'kept')
  const badgeTier: PrivacyTier = kept.length > 0 ? worstTier(kept) : loading ? 'unavailable' : 'red'
  const label = kept.length === 0 && !loading
    ? 'No eligible providers'
    : tierToLockLabel(badgeTier)

  return (
    <div data-ui="header-privacy-badge">
      <button
        ref={btnRef}
        type="button"
        data-ui="icon-button"
        data-privacy-tier={badgeTier}
        aria-label={`Privacy: ${label}`}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        <LockIcon size={18} />
      </button>
      {open ? (
        <div
          ref={popRef}
          data-ui="header-privacy-popover"
          role="dialog"
          aria-label="Privacy summary"
        >
          <div data-ui="header-privacy-popover-header">
            <span>Privacy</span>
            <button
              type="button"
              data-ui="icon-button"
              data-size="sm"
              aria-label="Close privacy summary"
              onClick={() => setOpen(false)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <div data-ui="header-privacy-popover-body">
            {rows.length === 0 ? (
              <p data-ui="helper">Loading providers…</p>
            ) : (
              <ul data-ui="header-privacy-list">
                {rows.map((r) => (
                  <PopoverRow
                    key={providerEndpointKey(r.endpoint)}
                    row={r}
                    endpoints={endpoints}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PopoverRow({
  row,
  endpoints,
}: {
  row: PickerRow
  endpoints: readonly PickerRow['endpoint'][]
}) {
  const isKept = row.state === 'kept'
  const tip = isKept
    ? tierToLockLabel(row.tier)
    : [tierToLockLabel(row.tier), reasonsToTooltip(row.reasons, row.policy)]
        .filter(Boolean)
        .join('\n\n')
  return (
    <li
      data-ui="header-privacy-row"
      data-allowed={isKept ? 'true' : 'false'}
      data-privacy-tier={row.tier}
      title={tip}
    >
      <span data-ui="header-privacy-row-lock" data-privacy-tier={row.tier}>
        <LockIcon size={12} />
      </span>
      <span data-ui="header-privacy-row-name">{providerDisplayLabel(row.endpoint, endpoints)}</span>
      <span data-ui="header-privacy-row-state">{isKept ? 'in use' : 'excluded'}</span>
    </li>
  )
}

// Highest tier rank among kept providers, the badge reflects the
// worst-case routing target, not the best case. If routing ends up
// failing over to a worse-tier provider, the badge should reflect that.
function worstTier(rows: readonly PickerRow[]): PrivacyTier {
  const rank: Record<PrivacyTier, number> = {
    green: 0,
    yellow: 1,
    orange: 2,
    red: 3,
    open: -1,
    unavailable: 4,
  }
  let worst: PrivacyTier = 'green'
  for (const r of rows) {
    if (rank[r.tier] > rank[worst]) worst = r.tier
  }
  return worst
}
