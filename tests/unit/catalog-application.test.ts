import { describe, expect, it, vi } from 'vitest'
import { CatalogTabController, catalogChatPresentation } from '../../src/store/catalog-application'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function controllerWithTitlePort(
  setManualTitle: (chatId: string, title: string) => Promise<boolean>,
) {
  return new CatalogTabController({
    setSidebarSortMode: vi.fn(async () => undefined),
    setFolderCollapsed: vi.fn(async () => []),
    setManualTitle,
  })
}

describe('catalog tab projections', () => {
  it('keeps only the newest title intent when older work settles out of order', async () => {
    const first = deferred<boolean>()
    const second = deferred<boolean>()
    const setManualTitle = vi
      .fn<(chatId: string, title: string) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const controller = controllerWithTitlePort(setManualTitle)

    const firstWrite = controller.setManualTitle('chat-a', 'First')
    const secondWrite = controller.setManualTitle('chat-a', 'Second')
    expect(
      catalogChatPresentation(controller.getSnapshot(), {
        id: 'chat-a',
        title: 'Stored',
        titleStatus: 'manual',
      }).title,
    ).toBe('Second')

    first.resolve(true)
    await firstWrite
    expect(controller.getSnapshot().manualTitleProjections['chat-a']).toBe('Second')

    second.reject(new Error('newest failed'))
    await expect(secondWrite).rejects.toThrow('newest failed')
    expect(controller.getSnapshot().manualTitleProjections['chat-a']).toBeUndefined()
  })

  it('retires a committed title only after the canonical row matches it', async () => {
    const controller = controllerWithTitlePort(async () => true)
    await controller.setManualTitle('chat-a', 'Accepted')

    controller.observeChatRows([{ id: 'chat-a', title: 'Older', titleStatus: 'manual' }])
    expect(controller.getSnapshot().manualTitleProjections['chat-a']).toBe('Accepted')

    controller.observeChatRows([{ id: 'chat-a', title: 'Accepted', titleStatus: 'manual' }])
    expect(controller.getSnapshot().manualTitleProjections['chat-a']).toBeUndefined()
  })

  it('bounds settled off-page titles and clears workspace-scoped state on replacement', async () => {
    const controller = controllerWithTitlePort(async () => true)
    await Promise.all(
      Array.from({ length: 65 }, (_, index) =>
        controller.setManualTitle(`chat-${index}`, `Title ${index}`),
      ),
    )

    expect(Object.keys(controller.getSnapshot().manualTitleProjections)).toHaveLength(64)
    controller.resetWorkspace()
    expect(controller.getSnapshot().manualTitleProjections).toEqual({})
  })
})
