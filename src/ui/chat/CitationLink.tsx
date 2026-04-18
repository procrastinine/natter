import type { MouseEvent, ReactNode } from 'react'

export interface CitationLinkProps {
  kind: 'url' | 'file'
  href?: string
  fileRef?: string
  chunkId?: string
  title?: string
  children?: ReactNode
  onScrollToFile?: (fileRef: string, chunkId?: string) => void
}

// Citation surfaces in rendered markdown. URL citations behave like regular
// external anchors; file citations scroll to a preview region elsewhere in the
// UI when the host provides an `onScrollToFile` handler.
export function CitationLink({
  kind,
  href,
  fileRef,
  chunkId,
  title,
  children,
  onScrollToFile,
}: CitationLinkProps) {
  if (kind === 'url') {
    return (
      <a
        data-ui="citation-link"
        data-citation-kind="url"
        href={href}
        title={title}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children ?? href}
      </a>
    )
  }
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (fileRef && onScrollToFile) onScrollToFile(fileRef, chunkId)
  }
  return (
    <a
      data-ui="citation-link"
      data-citation-kind="file"
      data-file-ref={fileRef}
      data-chunk-id={chunkId}
      href={`#file:${fileRef}${chunkId ? `@${chunkId}` : ''}`}
      title={title}
      onClick={onClick}
    >
      {children ?? fileRef ?? ''}
    </a>
  )
}
