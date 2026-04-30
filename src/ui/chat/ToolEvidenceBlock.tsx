import { toolEvidenceSectionsForMessage } from '../../core/provider-tool-context'
import type { Message } from '../../core/types'

interface ToolEvidenceBlockProps {
  message: Message
  onToggleHidden?: (itemIndex: number) => void
}

export function ToolEvidenceBlock({ message, onToggleHidden }: ToolEvidenceBlockProps) {
  const sections = toolEvidenceSectionsForMessage(message)
  if (sections.length === 0) return null
  return (
    <details data-ui="tool-evidence">
      <summary data-ui="tool-evidence-summary">
        <span data-ui="tool-evidence-title">Tool results</span>
        <span data-ui="tool-evidence-badge">{sections.length}</span>
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
                <button
                  type="button"
                  data-ui="tool-evidence-hide"
                  data-pressed={section.hidden ? 'true' : undefined}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onToggleHidden(section.itemIndex)
                  }}
                  aria-label={section.hidden ? 'Unhide tool call' : 'Hide tool call'}
                  title={
                    section.hidden
                      ? 'Hidden — preserved on disk, not sent on next turn. Click to unhide.'
                      : 'Hide this tool call or result (kept on disk, skipped on context replay).'
                  }
                >
                  {section.hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
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
              <details data-ui="tool-evidence-raw">
                <summary>Raw</summary>
                <pre>{formatRaw(section.raw)}</pre>
              </details>
            </div>
          </details>
        ))}
      </div>
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

function formatRaw(value: unknown): string {
  try {
    return JSON.stringify(redactNoisyFields(value), null, 2)
  } catch {
    return String(value)
  }
}

function redactNoisyFields(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactNoisyFields)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    out[key] = key === 'encrypted_content' ? '[encrypted]' : redactNoisyFields(child)
  }
  return out
}
