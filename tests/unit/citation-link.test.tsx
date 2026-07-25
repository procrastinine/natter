import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ContentAnnotation } from '../../src/core/types'
import { CitationLink } from '../../src/ui/chat/CitationLink'

function urlCitation(): Extract<ContentAnnotation, { type: 'url_citation' }> {
  return {
    type: 'url_citation',
    url: 'https://arxiv.org/abs/1234',
    title: 'Paper',
    startIndex: 0,
    endIndex: 5,
    source: 'openai-responses',
    providerPayload: { type: 'url_citation', url: 'https://arxiv.org/abs/1234' },
  }
}

function fileCitation(
  file: Extract<ContentAnnotation, { type: 'file_citation' }>['file'],
): Extract<ContentAnnotation, { type: 'file_citation' }> {
  return {
    type: 'file_citation',
    file,
    filename: 'evidence.txt',
    startIndex: 0,
    endIndex: 5,
    source: 'openai-responses',
    providerPayload: { type: 'file_citation' },
  }
}

describe('CitationLink', () => {
  it('renders URL citations as external links with noopener', () => {
    render(<CitationLink annotation={urlCitation()}>ref</CitationLink>)
    const anchor = screen.getByText('ref')
    expect(anchor.getAttribute('href')).toBe('https://arxiv.org/abs/1234')
    expect(anchor.getAttribute('target')).toBe('_blank')
    expect(anchor.getAttribute('rel')).toMatch(/noopener/)
    expect(anchor.getAttribute('data-citation-kind')).toBe('url')
  })

  it('point-reads a local attachment only after click', () => {
    const onOpenAttachment = vi.fn()
    render(
      <CitationLink
        annotation={fileCitation({ kind: 'attachment', attachmentId: 'attachment-123' })}
        onOpenAttachment={onOpenAttachment}
      >
        see source
      </CitationLink>,
    )
    expect(onOpenAttachment).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('see source'))
    expect(onOpenAttachment).toHaveBeenCalledWith('attachment-123')
    expect(screen.getByText('see source').getAttribute('data-file-identity')).toBe('attachment')
  })

  it('does not issue a bogus local lookup for a provider file id', () => {
    const onOpenAttachment = vi.fn()
    render(
      <CitationLink
        annotation={fileCitation({
          kind: 'provider-file',
          provider: 'openai-responses',
          fileId: 'file-provider-only',
        })}
        onOpenAttachment={onOpenAttachment}
      />,
    )
    const anchor = screen.getByText('evidence.txt')
    fireEvent.click(anchor)
    expect(onOpenAttachment).not.toHaveBeenCalled()
    expect(anchor.getAttribute('aria-disabled')).toBe('true')
    expect(anchor.getAttribute('data-file-identity')).toBe('provider-file')
  })
})
