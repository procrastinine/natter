import { fireEvent, render, screen } from '@testing-library/react'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { __resetDbForTests } from '../../src/store/db'
import { AttachmentPicker } from '../../src/ui/attachments/AttachmentPicker'

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

beforeEach(async () => {
  await resetDb()
})

describe('AttachmentPicker', () => {
  it('dismisses on Escape', async () => {
    const onClose = vi.fn()
    await ingestAttachmentBytes({
      blob: new Blob(['x']),
      filename: 'escape.txt',
      declaredMime: 'text/plain',
    })
    render(<AttachmentPicker onClose={onClose} onPick={() => {}} />)
    expect(await screen.findByText('escape.txt')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
