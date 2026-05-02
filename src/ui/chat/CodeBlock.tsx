import { useCallback, useMemo, useState } from 'react'

interface CodeBlockProps {
  code: string
  language?: string
  fileName?: string
}

const MAX_LINES_WITHOUT_TOOLBAR = 5
const HARD_SIZE_CAP_LINES = 10_000

// Minimal standalone code-block component for content that doesn't come
// through the Streamdown pipeline (e.g. programmatic content lanes or
// stream-overflow disclosures). Streamdown-rendered code fences get their
// chrome from the `@streamdown/code` plugin — this module is intentionally
// independent so it can be rendered without any streaming context.
export function CodeBlock({ code, language, fileName }: CodeBlockProps) {
  const lineCount = useMemo(() => code.split('\n').length, [code])
  const overLimit = lineCount > HARD_SIZE_CAP_LINES
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
            <button
              type="button"
              data-ui="code-toolbar-highlight-anyway"
              onClick={() => setShowLarge(true)}
            >
              Highlight anyway
            </button>
            <button type="button" data-ui="code-toolbar-copy" onClick={() => void onCopy()}>
              Copy
            </button>
            <button type="button" data-ui="code-toolbar-download" onClick={onDownload}>
              Download
            </button>
          </div>
        </div>
        <pre data-ui="code-block-body">
          {code.split('\n').slice(0, 20).join('\n')}
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
          <button type="button" data-ui="code-toolbar-copy" onClick={() => void onCopy()}>
            Copy
          </button>
          <button type="button" data-ui="code-toolbar-download" onClick={onDownload}>
            Download
          </button>
        </div>
      </div>
      <pre data-ui="code-block-body" data-line-numbers={withNumbers ? 'on' : 'off'}>
        <code>{code}</code>
      </pre>
    </div>
  )
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
