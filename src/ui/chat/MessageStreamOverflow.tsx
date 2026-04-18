import { useState, type ReactNode } from 'react'

export interface MessageStreamOverflowProps {
  totalChars: number
  truncatedChildren: ReactNode
  fullChildren: ReactNode
  threshold?: number
}

export const DEFAULT_OVERFLOW_THRESHOLD = 20_000

// Renders a "show full" affordance when the stream lane grew past the
// oversized threshold. See plan/10-ui.md §10.19.7 "Show full oversized stream
// lane" and plan/11-rendering.md §11.10.
export function MessageStreamOverflow({
  totalChars,
  truncatedChildren,
  fullChildren,
  threshold = DEFAULT_OVERFLOW_THRESHOLD,
}: MessageStreamOverflowProps) {
  const [revealed, setRevealed] = useState(false)
  const oversized = totalChars > threshold
  if (!oversized || revealed) {
    return <>{fullChildren}</>
  }
  return (
    <>
      <div data-overflow="truncated">{truncatedChildren}</div>
      <div data-ui="stream-overflow" data-state="truncated">
        <span>
          This message is {totalChars.toLocaleString()} characters long and
          was truncated for performance.
        </span>
        <button
          type="button"
          data-ui="stream-overflow-reveal"
          onClick={() => setRevealed(true)}
        >
          Show full
        </button>
      </div>
    </>
  )
}
