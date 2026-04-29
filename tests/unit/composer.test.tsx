import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests } from '../../src/store/db'
import { Composer } from '../../src/ui/chat/Composer'
import { InlineEditor } from '../../src/ui/chat/InlineEditor'

const DB_NAME = 'natter'

async function resetDb() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

afterEach(async () => {
  vi.restoreAllMocks()
  await resetDb()
})

describe('Composer', () => {
  it('restores the submitted draft when onSubmit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <Composer
        onSubmit={async () => {
          throw new Error('preflight failed')
        }}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    await waitFor(() => expect(input).toHaveValue('keep this draft'))
  })

  it('reports live draft changes for prompt-budget estimation', () => {
    const onDraftChange = vi.fn()
    render(<Composer onSubmit={() => {}} onDraftChange={onDraftChange} />)
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'count this draft' } })

    expect(onDraftChange).toHaveBeenLastCalledWith('count this draft')
  })

  it('does not show an empty autosized textarea scrollbar', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
    )
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 48,
    })
    try {
      render(<Composer autoSize onSubmit={() => {}} />)
      const input = screen.getByRole('textbox')

      expect(input.style.height).toBe('48px')
      expect(input.style.overflowY).toBe('hidden')
    } finally {
      if (descriptor) {
        Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', descriptor)
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight')
      }
    }
  })

  it('uploads selected files, shows a file tile, and sends attachment refs', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const { container } = render(<Composer onSubmit={onSubmit} />)
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement
    const file = new File(['# Upload\n\nvisible file body'], 'notes.md', {
      type: 'text/markdown',
    })

    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(await screen.findByText('notes.md')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const options = onSubmit.mock.calls[0]?.[1]
    expect(options?.attachmentRefs).toHaveLength(1)
    expect(options?.attachmentRefs?.[0]).toMatchObject({ includeInContext: true })
  })

  it('lets inline message edits add attachment refs', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const { container } = render(
      <InlineEditor initial="existing message" onSave={onSave} onCancel={() => {}} />,
    )
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement
    const file = new File(['retroactive edit file'], 'edit-file.txt', {
      type: 'text/plain',
    })

    fireEvent.change(fileInput, { target: { files: [file] } })

    expect(await screen.findByText('edit-file.txt')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit message' }), {
      key: 'Enter',
      metaKey: true,
    })

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[2]).toHaveLength(1)
    expect(onSave.mock.calls[0]?.[2]?.[0]).toMatchObject({ includeInContext: true })
  })
})
