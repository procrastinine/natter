import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { DEFAULT_GLOBAL_PREFERENCES } from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import type { ConfigurationApplication } from '../../src/store/configuration-domain'
import type { AttachmentCatalogRow, WorkspaceFence } from '../../src/store/presentation-contracts'
import { reconcileWorkspaceTabSessionStorage } from '../../src/store/workspace-tab-session'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { AttachmentPreview } from '../../src/ui/attachments/AttachmentPreview'
import { AttachmentRefChips } from '../../src/ui/attachments/AttachmentRefChips'
import { ConfirmDeleteDialog } from '../../src/ui/chat/ConfirmDeleteDialog'
import { EditTreeToolbar } from '../../src/ui/chat/EditTreeToolbar'
import { MessageContent } from '../../src/ui/chat/MessageContent'
import { PrefillSettingsPrompt } from '../../src/ui/chat/PrefillSettingsPrompt'
import { ZeroEligibleModal } from '../../src/ui/chat/ZeroEligibleModal'
import { ConnectionDeleteDialog } from '../../src/ui/header/ConnectionDeleteDialog'
import { CachingPanel } from '../../src/ui/settings/CachingPanel'
import { ImageAllowlistPanel } from '../../src/ui/settings/ImageAllowlistPanel'
import { InfoDisclosure } from '../../src/ui/settings/InfoDisclosure'
import { LlamaServerSection } from '../../src/ui/settings/LlamaServerSection'
import { PerformanceSettings } from '../../src/ui/settings/PerformanceSettings'
import { PrivacySection } from '../../src/ui/settings/PrivacySection'
import { PromptsTab } from '../../src/ui/settings/PromptsTab'

const configurationMocks = vi.hoisted(() => ({
  patchChatSettings: vi.fn(),
  patchChatSettingsFields: vi.fn(),
  addImageOrigin: vi.fn(),
  removeImageOrigin: vi.fn(),
  editConnection: vi.fn<ConfigurationApplication['editConnection']>(),
}))

const preferenceMocks = vi.hoisted(() => ({
  writeMessageInitialRenderWork: vi.fn(),
  writeMessageRenderWindowLoadMode: vi.fn(),
  writeSidebarRenderWindowLoadMode: vi.fn(),
  writeSidebarRenderWindowSize: vi.fn(),
}))

const attachmentCatalogState = vi.hoisted(() => ({
  rowsById: new Map<string, AttachmentCatalogRow>(),
  workspaceFence: null as WorkspaceFence | null,
}))

vi.mock('../../src/store/configuration-application', () => ({
  configurationApplication: configurationMocks,
}))

vi.mock('../../src/store/preferences-application', () => preferenceMocks)

vi.mock('../../src/hooks/useConfigurationPreferences', () => ({
  useConfigurationPreferences: () => ({
    global: DEFAULT_GLOBAL_PREFERENCES,
    rendering: DEFAULT_RENDERING_PREFS,
    imageAllowlist: [],
  }),
}))

vi.mock('../../src/hooks/useSettledConfigurationEdit', () => ({
  useSettledConfigurationEdit: ({ storedValue }: { storedValue: unknown }) => ({
    value: storedValue,
    setValue: vi.fn(),
    onBlur: vi.fn(),
  }),
  useSettledChatSettingsEdit: ({ storedValue }: { storedValue: unknown }) => ({
    value: storedValue,
    setValue: vi.fn(),
    onBlur: vi.fn(),
  }),
}))

vi.mock('../../src/ui/attachments/useAttachmentCatalogRows', () => ({
  useAttachmentCatalogRows: () => ({
    status: 'ready',
    interactive: true,
    rowsById: attachmentCatalogState.rowsById,
    workspaceFence: attachmentCatalogState.workspaceFence,
  }),
}))

vi.mock('../../src/ui/attachments/useAttachmentMedia', () => ({
  useAttachmentMedia: () => ({ status: 'idle', media: null, workspaceFence: null }),
}))

vi.mock('../../src/ui/attachments/useAttachmentObjectUrl', () => ({
  useAttachmentObjectUrl: () => undefined,
}))

function makeChat(model = 'anthropic/claude-haiku-4.5') {
  const settings = cloneDefaultChatSettings()
  settings.model = model
  return {
    id: 'chat-interaction',
    title: 'Interactions',
    titleStatus: 'manual' as const,
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function attachmentRow(overrides: Partial<AttachmentCatalogRow> = {}): AttachmentCatalogRow {
  return {
    id: 'attachment-1',
    kind: 'plaintext',
    mime: 'text/plain',
    filename: 'context.txt',
    sizeBytes: 7,
    origin: 'user-upload',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'remote-url', url: 'https://example.test/context.txt' },
    refCount: 1,
    messageRefCount: 1,
    draftRefCount: 0,
    visibleRefCount: 1,
    hiddenRefCount: 0,
    missingVisibleRefCount: 0,
    processing: [],
    ...overrides,
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  const workspaceFence = {
    workspaceId: `interaction-surfaces-${crypto.randomUUID()}`,
    replacementEpoch: 1,
  }
  attachmentCatalogState.workspaceFence = workspaceFence
  reconcileWorkspaceTabSessionStorage(workspaceFence)
  for (const mock of Object.values(configurationMocks))
    mock.mockReset().mockResolvedValue(undefined)
  for (const mock of Object.values(preferenceMocks)) mock.mockReset().mockResolvedValue(undefined)
  attachmentCatalogState.rowsById = new Map()
  useUiStore.setState({
    editTreeMode: false,
    cascadeDelete: false,
    treeExpanded: false,
    zeroEligibleChatId: null,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('focused interaction surfaces', () => {
  it('keeps the PDF fallback in AttachmentPreview actionable', () => {
    const onClick = vi.fn((event: Event) => event.preventDefault())
    const row = attachmentRow({
      kind: 'pdf',
      mime: 'application/pdf',
      filename: 'paper.pdf',
      storage: { kind: 'remote-url', url: 'https://example.test/paper.pdf' },
    })
    const view = render(<AttachmentPreview attachment={row} variant="panel" />)
    const link = screen.getByRole('link', { name: 'Open PDF' })
    link.addEventListener('click', onClick)

    fireEvent.click(link)

    expect(view.container.querySelector('[data-ui="attachment-preview"]')).toHaveAttribute(
      'data-media',
      'pdf',
    )
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('routes AttachmentRefChips context visibility through the message mutation boundary', () => {
    attachmentCatalogState.rowsById = new Map([['attachment-1', attachmentRow()]])
    const onMutateMessageRef = vi.fn()
    render(
      <AttachmentRefChips
        refs={[
          {
            refId: 'ref-1',
            attachmentId: 'attachment-1',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        messageId="message-1"
        onMutateMessageRef={onMutateMessageRef}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Hide attachment from context' }))

    expect(screen.getByText('context.txt').closest('[data-ui="attachment-chip"]')).toHaveAttribute(
      'data-context',
      'included',
    )
    expect(onMutateMessageRef).toHaveBeenCalledWith({
      kind: 'visibility',
      refId: 'ref-1',
      includeInContext: false,
    })
  })

  it('shares one attachment pending owner between chips and generated-media controls', async () => {
    attachmentCatalogState.rowsById = new Map([['attachment-1', attachmentRow()]])
    const work = deferred<void>()
    const onMutateAttachmentRef = vi.fn(() => work.promise)
    const ref = {
      refId: 'ref-shared',
      attachmentId: 'attachment-1',
      includeInContext: true,
      presentation: {},
      createdAt: 1,
      updatedAt: 1,
    }
    render(
      <div>
        <AttachmentRefChips
          refs={[ref]}
          messageId="message-shared"
          onMutateMessageRef={onMutateAttachmentRef}
        />
        <MessageContent
          content={[{ type: 'output_image', attachmentId: 'attachment-1' }]}
          text=""
          messageId="message-shared"
          attachmentRefs={[ref]}
          onMutateAttachmentRef={onMutateAttachmentRef}
        />
      </div>,
    )
    const chipToggle = screen.getByRole('button', { name: 'Hide attachment from context' })
    const generatedToggle = screen.getByRole('button', {
      name: 'Hide generated image from context',
    })

    fireEvent.click(chipToggle)

    expect(chipToggle).toBeDisabled()
    expect(generatedToggle).toBeDisabled()
    fireEvent.click(generatedToggle)
    expect(onMutateAttachmentRef).toHaveBeenCalledOnce()

    work.resolve()
    await waitFor(() => {
      expect(chipToggle).not.toBeDisabled()
      expect(generatedToggle).not.toBeDisabled()
    })
  })

  it('passes the explicit pair choice through ConfirmDeleteDialog', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDeleteDialog
        previewText="Delete this turn"
        pairDefault
        onCancel={() => {}}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByRole('checkbox').closest('[data-ui="confirm-delete-pair"]')).not.toBeNull()
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('applies EditTreeToolbar cascade and exit actions to the tab-local UI store', () => {
    useUiStore.setState({ editTreeMode: true, cascadeDelete: false })
    render(<EditTreeToolbar />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Also delete descendants' }))
    expect(useUiStore.getState().cascadeDelete).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Exit edit tree mode' }))

    expect(screen.queryByRole('toolbar', { name: 'Edit tree mode' })).toBeNull()
    expect(useUiStore.getState().editTreeMode).toBe(false)
  })

  it('makes ZeroEligibleModal disable Pareto through one configuration command', async () => {
    useUiStore.setState({ zeroEligibleChatId: 'chat-zero' })
    render(<ZeroEligibleModal chatId="chat-zero" modelLabel="test model" />)

    fireEvent.click(screen.getByRole('button', { name: 'Disable Pareto for this chat' }))

    await waitFor(() => {
      expect(configurationMocks.patchChatSettingsFields).toHaveBeenCalledWith('chat-zero', [
        { path: ['privacy', 'paretoFilter'], value: false },
      ])
    })
    expect(useUiStore.getState().zeroEligibleChatId).toBeNull()
  })

  it('keeps a prefill recommendation visible until its configuration write succeeds', async () => {
    const reasoning = { ...cloneDefaultChatSettings().reasoning, mode: 'off' as const }
    const work = deferred<void>()
    configurationMocks.patchChatSettings.mockReturnValueOnce(work.promise)
    render(
      <PrefillSettingsPrompt
        chatId="chat-prefill"
        plan={{
          availability: 'supported',
          continueStrategy: 'prefill',
          request: 'send-once',
          semanticRetry: 'never',
          serialization: { kind: 'assistant-tail', marker: 'partial' },
          basis: 'endpoint-capability',
          recommendation: {
            issues: ['turn reasoning off'],
            patch: { reasoning },
          },
        }}
      />,
    )

    expect(screen.getByRole('status')).toHaveAttribute('data-ui', 'prefill-settings-prompt')
    expect(
      screen.getByRole('button', { name: 'Apply' }).closest('[data-ui="prefill-settings-actions"]'),
    ).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(configurationMocks.patchChatSettings).toHaveBeenCalledWith('chat-prefill', {
      reasoning,
    })
    expect(screen.getByRole('status')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDisabled()

    work.resolve()

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('requires an explicit replacement through ConnectionDeleteDialog', () => {
    const onReassignTo = vi.fn()
    const onConfirm = vi.fn()
    render(
      <ConnectionDeleteDialog
        profileName="Old connection"
        busy={false}
        dependents={{ presetCount: 1, chatCount: 1 }}
        replacementProfiles={[{ id: 'profile-2', name: 'Replacement', archived: false }]}
        hasPreviousReplacementProfiles={false}
        hasMoreReplacementProfiles={false}
        reassignTo={null}
        error={null}
        onCancel={() => {}}
        onConfirm={onConfirm}
        onLoadPreviousReplacementProfiles={() => {}}
        onLoadMoreReplacementProfiles={() => {}}
        onReassignTo={onReassignTo}
      />,
    )

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Replacement connection'), {
      target: { value: 'profile-2' },
    })

    expect(onReassignTo).toHaveBeenCalledWith('profile-2')
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('routes CachingPanel mode changes through the configuration command', () => {
    const chat = makeChat()
    render(<CachingPanel chat={chat} capability={null} connectionKind="openrouter" />)

    fireEvent.click(screen.getByRole('button', { name: 'on' }))

    expect(configurationMocks.patchChatSettingsFields).toHaveBeenCalledWith(chat.id, [
      { path: ['anthropicCache', 'mode'], value: 'automatic' },
    ])
  })

  it('normalizes ImageAllowlistPanel additions before persisting them', async () => {
    render(<ImageAllowlistPanel />)

    fireEvent.change(screen.getByLabelText('Origin to allow'), {
      target: { value: 'https://example.test/path' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => {
      expect(configurationMocks.addImageOrigin).toHaveBeenCalledWith('https://example.test')
    })
  })

  it('opens and dismisses InfoDisclosure through its keyboard boundary', () => {
    render(<InfoDisclosure title="Interaction detail">Bounded explanation</InfoDisclosure>)

    fireEvent.click(screen.getByRole('button', { name: 'More info' }))
    expect(screen.getByRole('note')).toHaveTextContent('Bounded explanation')
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('note')).toBeNull()
  })

  it('routes LlamaServerSection cache reuse changes through configuration', () => {
    const chat = makeChat('local/model')
    chat.settings.profileId = 'profile-llama'
    render(
      <LlamaServerSection
        chat={chat}
        profile={{
          id: 'profile-llama',
          name: 'llama-server',
          kind: 'llama-server',
          baseUrl: 'http://127.0.0.1:8080/v1',
          defaultHeaders: {},
          appTitle: 'Natter',
          appUrl: '',
          supportsEndpointsApi: false,
          supportsGenerationApi: false,
          supportsPrivacyScrape: false,
          createdAt: 1,
          updatedAt: 1,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reuse KV cache between requests' }))

    expect(configurationMocks.patchChatSettings).toHaveBeenCalledWith(chat.id, {
      cachePrompt: false,
    })
  })

  it('routes PerformanceSettings load modes through durable preferences', () => {
    render(<PerformanceSettings />)

    fireEvent.change(screen.getByLabelText('Older messages'), { target: { value: 'manual' } })
    fireEvent.change(screen.getByLabelText('More rows'), { target: { value: 'manual' } })

    expect(preferenceMocks.writeMessageRenderWindowLoadMode).toHaveBeenCalledWith('manual')
    expect(preferenceMocks.writeSidebarRenderWindowLoadMode).toHaveBeenCalledWith('manual')
  })

  it('routes PrivacySection toggles through field-level configuration writes', () => {
    const chat = makeChat('openrouter/model')
    render(<PrivacySection chat={chat} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /Pareto filter/u }))

    expect(configurationMocks.patchChatSettingsFields).toHaveBeenCalledWith(chat.id, [
      { path: ['privacy', 'paretoFilter'], value: false },
    ])
  })

  it('routes direct prefill capability through the connection configuration owner', async () => {
    const chat = makeChat('local/model')
    chat.settings.profileId = 'profile-custom'
    const work = deferred<Awaited<ReturnType<ConfigurationApplication['editConnection']>>>()
    configurationMocks.editConnection.mockReturnValueOnce(work.promise)
    const profile: Parameters<ConfigurationApplication['editConnection']>[0]['profile'] = {
      id: 'profile-custom',
      name: 'Custom',
      kind: 'custom',
      baseUrl: 'https://example.test/v1',
      defaultHeaders: {},
      appTitle: 'Natter',
      appUrl: '',
      supportsEndpointsApi: false,
      supportsGenerationApi: false,
      supportsPrivacyScrape: false,
      createdAt: 1,
      updatedAt: 1,
    }
    render(
      <PromptsTab
        chat={chat}
        profile={profile}
        prefillPlan={{
          availability: 'supported',
          continueStrategy: 'prefill',
          request: 'send-once',
          semanticRetry: 'never',
          serialization: { kind: 'assistant-tail', marker: 'none' },
          basis: 'endpoint-capability',
        }}
      />,
    )
    const select = screen.getByRole('combobox', { name: /Direct endpoint assistant prefill/u })

    fireEvent.change(select, { target: { value: 'assistant-tail:partial' } })

    expect(configurationMocks.editConnection).toHaveBeenCalledTimes(1)
    const intent = configurationMocks.editConnection.mock.calls[0]?.[0]
    expect(intent?.profile.id).toBe('profile-custom')
    expect(intent?.patch.capabilityOverrides).toEqual({
      'local/model': { prefill: { kind: 'assistant-tail', marker: 'partial' } },
    })
    expect(select).toBeDisabled()

    work.resolve({ kind: 'connection-saved', profile })
    await waitFor(() => expect(select).toBeEnabled())
  })
})
