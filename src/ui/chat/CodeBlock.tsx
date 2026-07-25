import { useCallback, useMemo, useState } from 'react'
import { Button } from '../primitives/Button'

interface CodeBlockProps {
  code: string
  language?: string
  fileName?: string
  onHighlightAnyway?: () => void
  highlightAnywayDisabled?: boolean
}

const MAX_LINES_WITHOUT_TOOLBAR = 5
export const CODE_HIGHLIGHT_LIMITS = Object.freeze({
  lines: 10_000,
  sourceChars: 500_000,
  previewLines: 20,
  previewChars: 20_000,
})

// This renderer stays independent of Streamdown context so oversized fences
// can remain bounded before either Streamdown or Shiki sees their full body.
export function CodeBlock({
  code,
  language,
  fileName,
  onHighlightAnyway,
  highlightAnywayDisabled = false,
}: CodeBlockProps) {
  const lineCount = useMemo(() => countLinesUpTo(code, CODE_HIGHLIGHT_LIMITS.lines + 1), [code])
  const overLimit =
    code.length > CODE_HIGHLIGHT_LIMITS.sourceChars || lineCount > CODE_HIGHLIGHT_LIMITS.lines
  const [showLarge, setShowLarge] = useState(false)

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      // Ignore — `clipboard` may not be available in some contexts; the user
      // still has the visible text to select by hand.
    }
  }, [code])

  const onDownload = useCallback(() => {
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName ?? `code.${extensionFor(language)}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [code, fileName, language])

  if (overLimit && !showLarge) {
    return (
      <div data-ui="code-block" data-state="oversized" data-overflow="truncated">
        <div data-ui="code-toolbar">
          <span data-ui="code-toolbar-language">{language ?? 'text'}</span>
          <div data-ui="code-toolbar-actions">
            <Button
              type="button"
              data-ui="code-toolbar-highlight-anyway"
              disabled={highlightAnywayDisabled}
              onClick={() => {
                if (onHighlightAnyway) onHighlightAnyway()
                else setShowLarge(true)
              }}
            >
              Highlight anyway
            </Button>
            <Button type="button" data-ui="code-toolbar-copy" onClick={() => void onCopy()}>
              Copy
            </Button>
            <Button type="button" data-ui="code-toolbar-download" onClick={onDownload}>
              Download
            </Button>
          </div>
        </div>
        <pre data-ui="code-block-body">
          {boundedPreview(code)}
          {'\n…'}
        </pre>
      </div>
    )
  }

  const withNumbers = lineCount > MAX_LINES_WITHOUT_TOOLBAR
  return (
    <div data-ui="code-block" data-state="complete" data-overflow="full">
      <div data-ui="code-toolbar">
        <span data-ui="code-toolbar-language">{language ?? 'text'}</span>
        <div data-ui="code-toolbar-actions">
          <Button type="button" data-ui="code-toolbar-copy" onClick={() => void onCopy()}>
            Copy
          </Button>
          <Button type="button" data-ui="code-toolbar-download" onClick={onDownload}>
            Download
          </Button>
        </div>
      </div>
      <pre data-ui="code-block-body" data-line-numbers={withNumbers ? 'on' : 'off'}>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function countLinesUpTo(code: string, limit: number): number {
  let lines = 1
  for (let index = 0; index < code.length && lines < limit; index += 1) {
    if (code.charCodeAt(index) === 10) lines += 1
  }
  return lines
}

function boundedPreview(code: string): string {
  const characterLimit = Math.min(code.length, CODE_HIGHLIGHT_LIMITS.previewChars)
  let lines = 1
  for (let index = 0; index < characterLimit; index += 1) {
    if (code.charCodeAt(index) !== 10) continue
    lines += 1
    if (lines > CODE_HIGHLIGHT_LIMITS.previewLines) return code.slice(0, index)
  }
  return code.slice(0, characterLimit)
}

function extensionFor(language: string | undefined): string {
  switch (language) {
    case undefined:
      return 'txt'
    case 'ts':
    case 'typescript':
      return 'ts'
    case 'js':
    case 'javascript':
      return 'js'
    case 'py':
    case 'python':
      return 'py'
    case 'sh':
    case 'bash':
      return 'sh'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'md'
    case 'rust':
    case 'rs':
      return 'rs'
    case 'go':
      return 'go'
    default:
      return 'txt'
  }
}
