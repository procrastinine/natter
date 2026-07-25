import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { ImportModal } from '../../src/ui/chat/ImportModal'

const actions = vi.hoisted(() => ({ importMessages: vi.fn() }))

vi.mock('../../src/app/conversation-actions', () => ({
  conversationActions: { importMessages: actions.importMessages },
}))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  useAnnouncementStore.getState().reset()
})

describe('ImportModal conversation action boundary', () => {
  it('keeps an existing-chat import bound to the captured chat while its action is pending', async () => {
    const pending = deferred<void>()
    actions.importMessages.mockReturnValue(pending.promise)
    const onClose = vi.fn()
    const { rerender } = render(
      <ImportModal chatId="target-chat" slot={{ kind: 'at-end' }} onClose={onClose} />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message 1' }), {
      target: { value: ' background import ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(actions.importMessages).toHaveBeenCalledWith({
      chatId: 'target-chat',
      slot: { kind: 'at-end' },
      messages: [{ role: 'user', text: 'background import' }],
    })
    rerender(
      <ImportModal chatId="newer-visible-chat" slot={{ kind: 'at-end' }} onClose={onClose} />,
    )
    await act(async () => pending.resolve())

    expect(actions.importMessages).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('materializes a new chat once and submits to the returned identity', async () => {
    actions.importMessages.mockResolvedValue(undefined)
    const materializeChat = vi.fn().mockResolvedValue({ chatId: 'materialized-chat' })
    const onClose = vi.fn()
    render(
      <ImportModal
        chatId={null}
        slot={{ kind: 'at-end' }}
        materializeChat={materializeChat}
        onClose={onClose}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message 1' }), {
      target: { value: 'new chat import' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(actions.importMessages).toHaveBeenCalledOnce())
    expect(materializeChat).toHaveBeenCalledOnce()
    expect(actions.importMessages).toHaveBeenCalledWith({
      chatId: 'materialized-chat',
      slot: { kind: 'at-end' },
      messages: [{ role: 'user', text: 'new chat import' }],
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not submit or close when new-chat materialization is abandoned', async () => {
    const materializeChat = vi.fn().mockResolvedValue(null)
    const onClose = vi.fn()
    render(
      <ImportModal
        chatId={null}
        slot={{ kind: 'at-end' }}
        materializeChat={materializeChat}
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(materializeChat).toHaveBeenCalledOnce())

    expect(actions.importMessages).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('submits the exact shared-trunk slot and ordered message roles', async () => {
    actions.importMessages.mockResolvedValue(undefined)
    const onDone = vi.fn()
    render(
      <ImportModal
        chatId="tree-chat"
        slot={{ kind: 'after-all', parentId: 'parent' }}
        onClose={() => {}}
        onDone={onDone}
      />,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Message 1' }), {
      target: { value: 'first inserted' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add another message/i }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message 2' }), {
      target: { value: 'second inserted' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(actions.importMessages).toHaveBeenCalledOnce())
    expect(actions.importMessages).toHaveBeenCalledWith({
      chatId: 'tree-chat',
      slot: { kind: 'after-all', parentId: 'parent' },
      messages: [
        { role: 'user', text: 'first inserted' },
        { role: 'assistant', text: 'second inserted' },
      ],
    })
    expect(onDone).toHaveBeenCalledOnce()
    expect(useAnnouncementStore.getState().polite.at(-1)?.text).toBe(
      'Imported 2 messages (after this parent, before all of its children).',
    )
  })

  it('keeps the modal open and surfaces action failure', async () => {
    actions.importMessages.mockRejectedValue(new Error('tree changed'))
    const onClose = vi.fn()
    render(<ImportModal chatId="tree-chat" slot={{ kind: 'at-end' }} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText('Import failed: tree changed')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
  })
})
