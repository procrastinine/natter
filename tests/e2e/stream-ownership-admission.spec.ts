import { expect, test } from './fixtures'

test.skip(
  process.env.E2E_SERVER_MODE === 'preview',
  'This regression drives source-only stream lifecycle entry points.',
)

test('a peer release observer cannot preempt stream ownership admission', async ({ page }) => {
  await page.goto('/')
  const peer = await page.context().newPage()
  await peer.goto('/')
  const chatId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  await peer.evaluate(async (id) => {
    const streamLeasesModule = '/src/store/stream-leases.ts'
    const { onRemoteStreamOwnershipReleased } = (await import(streamLeasesModule)) as unknown as {
      onRemoteStreamOwnershipReleased(
        chatId: string,
        handler: (stream: { chatId: string; streamId: string }) => void,
      ): () => void
    }
    const win = window as Window & { __stopOwnershipProbe?: () => void }
    win.__stopOwnershipProbe = onRemoteStreamOwnershipReleased(id, () => {})
  }, chatId)

  await page.evaluate(async (id) => {
    const requestLifecycleModule = '/src/hooks/requestLifecycle.ts'
    const ulidModule = '/src/lib/ulid.ts'
    const [{ startRequestLifecycle }, { newId }] = (await Promise.all([
      import(requestLifecycleModule),
      import(ulidModule),
    ])) as unknown as [
      {
        startRequestLifecycle(args: {
          chatId: string
          streamId: string
          attemptKind: 'generation'
        }): Promise<{ end(outcome: 'done'): Promise<void> }>
      },
      { newId(): string },
    ]
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const lifecycle = await startRequestLifecycle({
        chatId: id,
        streamId: newId(),
        attemptKind: 'generation',
      })
      await lifecycle.end('done')
    }
  }, chatId)

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const locks = await navigator.locks.query()
        return locks.held?.filter((lock) => lock.name?.startsWith('stream-owner:')).length ?? 0
      }),
    )
    .toBe(0)

  await peer.evaluate(() => {
    const win = window as Window & { __stopOwnershipProbe?: () => void }
    win.__stopOwnershipProbe?.()
    delete win.__stopOwnershipProbe
  })
  await peer.close()
})
