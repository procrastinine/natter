import { waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../../src/app/App'
import {
  type AttachmentDetailSource,
  createAttachmentDetailController,
} from '../../src/store/attachment-detail-session'
import {
  type ConversationPresentationResourcePort,
  createConversationController,
} from '../../src/store/conversation-controller'
import {
  openMountedRepositoryProjections,
  reconcileMountedRepositoryProjections,
} from '../../src/store/mounted-projection-lifecycle'
import type { WorkspaceEffect } from '../../src/store/workspace-effect-hub'

const FENCE = Object.freeze({ workspaceId: 'preopen', replacementEpoch: 0 })

describe('pre-open projection safety', () => {
  it('renders the application shell in StrictMode before a workspace is selected', () => {
    window.location.hash = '#/'

    const markup = renderToString(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(markup).toContain('data-ui="app-shell"')
    expect(markup).toContain('data-ui="sidebar"')
  })

  it('keeps the conversation presentation frame inert before a workspace is selected', () => {
    const controller = createConversationController()
    const request = vi.fn()
    const resources: ConversationPresentationResourcePort = {
      get: () => ({ kind: 'ready' }),
      request,
      subscribe: () => () => undefined,
    }

    const uninstall = controller.installPresentationResourcePort(resources)

    expect(controller.getSnapshot()).toEqual({
      workspaceId: null,
      workspaceEpoch: 0,
      activeChatId: null,
      active: null,
    })
    expect(request).not.toHaveBeenCalled()

    uninstall()
  })

  it('keeps attachment detail inert until the exact workspace opens', async () => {
    let readCount = 0
    const listeners = new Set<(effect: WorkspaceEffect) => void>()
    const source: AttachmentDetailSource = {
      readDetail: async (_attachmentId, _signal) => {
        readCount += 1
        return { ...FENCE, value: undefined }
      },
      subscribeEffects: (apply) => {
        listeners.add(apply)
        return () => listeners.delete(apply)
      },
    }
    const controller = createAttachmentDetailController(source)

    controller.request(FENCE, 'attachment-preopen')

    expect(controller.getSnapshot()).toMatchObject({ status: 'loading', interactive: false })
    expect(readCount).toBe(0)
    expect(listeners.size).toBe(0)

    reconcileMountedRepositoryProjections(FENCE)
    expect(readCount).toBe(0)
    expect(listeners.size).toBe(0)

    openMountedRepositoryProjections()

    await waitFor(() => expect(controller.getSnapshot()?.status).toBe('ready'))
    expect(readCount).toBe(1)
    expect(listeners.size).toBe(1)

    controller.dispose()
    expect(listeners.size).toBe(0)
  })
})
