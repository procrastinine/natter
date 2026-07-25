import { useMemo, useState } from 'react'
import type { ConversationMutationSettlement } from '../../app/presentation-interactions'
import { type AppliedMessageView, createAppliedMessageView } from '../../core/continuation-content'
import {
  formatProviderOutputValuePreview,
  toolEvidenceSectionsForMessage,
} from '../../core/provider-tool-context'
import type { Message, ProviderOutputMemberRef } from '../../core/types'
import { Button } from '../primitives/Button'

interface ToolEvidenceBlockProps {
  message: Message
  appliedView?: AppliedMessageView
  onToggleHidden?: (member: ProviderOutputMemberRef) => ConversationMutationSettlement
  toggleHiddenDisabled?: boolean
}

const TOOL_EVIDENCE_PAGE_SIZE = 20
const TOOL_EVIDENCE_RAW_PREVIEW_CHARS = 64 * 1024

export function ToolEvidenceBlock({
  message,
  appliedView,
  onToggleHidden,
  toggleHiddenDisabled = false,
}: ToolEvidenceBlockProps) {
  const view = useMemo(
    () => appliedView ?? createAppliedMessageView(message),
    [appliedView, message],
  )
  const [open, setOpen] = useState(false)
  const [window, setWindow] = useState(() => ({
    messageId: message.id,
    limit: TOOL_EVIDENCE_PAGE_SIZE,
  }))
  const count = view.providerOutputCount
  const visibleLimit = window.messageId === message.id ? window.limit : TOOL_EVIDENCE_PAGE_SIZE
  const sections = useMemo(
    () =>
      open
        ? toolEvidenceSectionsForMessage(view, {
            limit: visibleLimit,
          })
        : [],
    [open, view, visibleLimit],
  )
  if (count === 0) return null
  return (
    <details
      data-ui="tool-evidence"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary data-ui="tool-evidence-summary">
        <span data-ui="tool-evidence-title">Tool results</span>
        <span data-ui="tool-evidence-badge">{count}</span>
      </summary>
      <div data-ui="tool-evidence-details">
        {sections.map((section) => (
          <details
            key={section.key}
            data-ui="tool-evidence-section"
            data-hidden={section.hidden ? 'true' : undefined}
            data-edited={section.edited ? 'true' : undefined}
            open
          >
            <summary data-ui="tool-evidence-section-summary">
              <span>{section.label}</span>
              {section.edited ? <span data-ui="tool-evidence-status">edited</span> : null}
              {section.hidden ? <span data-ui="tool-evidence-status">hidden</span> : null}
              {section.badge ? <span data-ui="tool-evidence-status">{section.badge}</span> : null}
              {onToggleHidden ? (
                <Button
                  type="button"
                  data-ui="tool-evidence-hide"
                  data-pressed={section.hidden ? 'true' : undefined}
                  disabled={toggleHiddenDisabled}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void onToggleHidden(section.member)
                  }}
                  aria-label={section.hidden ? 'Unhide tool call' : 'Hide tool call'}
                  title={
                    toggleHiddenDisabled
                      ? 'Wait for this generation to finish before changing tool visibility.'
                      : section.hidden
                        ? 'Hidden — preserved on disk, not sent on next turn. Click to unhide.'
                        : 'Hide this tool call or result (kept on disk, skipped on context replay).'
                  }
                >
                  {section.hidden ? <EyeOffIcon /> : <EyeIcon />}
                </Button>
              ) : null}
            </summary>
            <div data-ui="tool-evidence-section-body">
              {section.rows.map((row) => (
                <div key={row.label} data-ui="tool-evidence-row">
                  <span data-ui="tool-evidence-row-label">{row.label}</span>
                  <pre data-ui="tool-evidence-row-value">{row.value}</pre>
                </div>
              ))}
              {section.sources && section.sources.length > 0 ? (
                <div data-ui="tool-evidence-row">
                  <span data-ui="tool-evidence-row-label">Sources</span>
                  <ul data-ui="tool-evidence-sources">
                    {section.sources.map((source) => (
                      <li key={source}>
                        <a href={source} target="_blank" rel="noreferrer">
                          {source}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <RawEvidenceDisclosure value={section.raw} />
            </div>
          </details>
        ))}
        {visibleLimit < count ? (
          <Button
            type="button"
            data-ui="tool-evidence-more"
            onClick={() =>
              setWindow({
                messageId: message.id,
                limit: Math.min(count, visibleLimit + TOOL_EVIDENCE_PAGE_SIZE),
              })
            }
          >
            Show more
          </Button>
        ) : null}
      </div>
    </details>
  )
}

function RawEvidenceDisclosure({ value }: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const formatted = useMemo(
    () => (open ? formatProviderOutputValuePreview(value, TOOL_EVIDENCE_RAW_PREVIEW_CHARS) : ''),
    [open, value],
  )
  return (
    <details
      data-ui="tool-evidence-raw"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Raw</summary>
      {open ? <pre>{formatted}</pre> : null}
    </details>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
