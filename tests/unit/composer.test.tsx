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

  it('updates the live character count without prompt-budget callbacks', () => {
    render(<Composer onSubmit={() => {}} />)
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'count this draft' } })

    expect(screen.getByText('16 chars')).toBeInTheDocument()
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
    const options = onSubmit.mock.calls[0]?.[1] as
      | { attachmentRefs?: Array<{ includeInContext: boolean }> }
      | undefined
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
    const attachmentRefs = onSave.mock.calls[0]?.[2] as
      | Array<{ includeInContext: boolean }>
      | undefined
    expect(attachmentRefs).toHaveLength(1)
    expect(attachmentRefs?.[0]).toMatchObject({ includeInContext: true })
  })

  it('preserves provider sealed fields when editing tool-call JSON', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <InlineEditor
        initial="existing message"
        onSave={onSave}
        onCancel={() => {}}
        initialProviderOutputItems={[
          {
            dialect: 'anthropic-claude',
            type: 'web_search_tool_result',
            item: {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Original title',
                  url: 'https://example.com',
                  encrypted_content: 'sealed-result-payload',
                },
              ],
            },
          },
        ]}
      />,
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'existing message updated' },
    })
    fireEvent.change(screen.getByLabelText('Edit tool call JSON or text'), {
      target: {
        value: JSON.stringify(
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [
              {
                type: 'web_search_result',
                title: 'Edited title',
                url: 'https://example.com',
              },
            ],
          },
          null,
          2,
        ),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0]?.[0]).toBe('existing message updated')
    expect(onSave.mock.calls[0]?.[3]).toEqual([
      {
        dialect: 'anthropic-claude',
        type: 'web_search_tool_result',
        edited: true,
        item: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              title: 'Edited title',
              url: 'https://example.com',
              encrypted_content: 'sealed-result-payload',
            },
          ],
        },
      },
    ])
  })
})
