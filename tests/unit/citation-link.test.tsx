import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CitationLink } from '../../src/ui/chat/CitationLink'

describe('CitationLink', () => {
  it('renders URL citations as external links with noopener', () => {
    render(
      <CitationLink kind="url" href="https://arxiv.org/abs/1234">
        ref
      </CitationLink>,
    )
    const anchor = screen.getByText('ref')
    expect(anchor.getAttribute('href')).toBe('https://arxiv.org/abs/1234')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toMatch(/noopener/)
    expect(anchor.getAttribute('data-citation-kind')).toBe('url')
  })

  it('renders file citations with a scroll-to-chunk handler', () => {
    const onScrollToFile = vi.fn()
    render(
      <CitationLink
        kind="file"
        fileRef="doc-123"
        chunkId="para-42"
        onScrollToFile={onScrollToFile}
      >
        see source
      </CitationLink>,
    )
    fireEvent.click(screen.getByText('see source'))
    expect(onScrollToFile).toHaveBeenCalledWith('doc-123', 'para-42')
    const anchor = screen.getByText('see source')
    expect(anchor.getAttribute('data-citation-kind')).toBe('file')
    expect(anchor.getAttribute('href')).toBe('#file:doc-123@para-42')
  })

  it('falls back to the fileRef label when no children are provided', () => {
    render(<CitationLink kind="file" fileRef="doc-9" />)
    expect(screen.getByText('doc-9')).toBeTruthy()
  })
})
