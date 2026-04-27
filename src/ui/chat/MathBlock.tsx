import { useMemo } from 'react'

export interface MathBlockProps {
  source: string
  display?: boolean
}

// Fallback math component used when the KaTeX plugin fails to parse a block
// (per plan/11-rendering.md §11.7). Streamdown's math plugin renders successful
// blocks itself; this component is only for the error path and for callers
// that want to force the raw-source fallback.
export function MathBlock({ source, display }: MathBlockProps) {
  const reason = useMemo(() => diagnose(source), [source])
  if (!reason) {
    return (
      <span data-ui="math-block" data-state="ok" data-display={display ? 'true' : 'false'}>
        {source}
      </span>
    )
  }
  return (
    <span
      data-ui="math-block"
      data-state="error"
      data-display={display ? 'true' : 'false'}
      title={reason}
    >
      {source}
      <span data-ui="math-block-error" role="note">
        Math parse failed: {reason}
      </span>
    </span>
  )
}

// Lightweight pre-parse check so a helpful tooltip can render even when the
// KaTeX plugin isn't loaded. Not a real parser, just flags the obvious
// mismatched-delimiter / lone-backslash cases the plan calls out.
function diagnose(source: string): string | null {
  const trimmed = source.trim()
  if (trimmed.length === 0) return 'empty'
  if (/\\href\b/.test(trimmed)) return '\\href is blocked (rendering trust: false)'
  if ((trimmed.match(/{/g)?.length ?? 0) !== (trimmed.match(/}/g)?.length ?? 0)) {
    return 'mismatched braces'
  }
  return null
}
