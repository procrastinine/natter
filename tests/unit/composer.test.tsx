import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AVAILABLE_GENERATION_CAPABILITY,
  failedGenerationCapability,
  type NonReadyGenerationCapability,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../../src/core/interaction-capability'
import type { MessageAttachmentRef } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests } from '../../src/store/db'
import type { GenerationStartResult } from '../../src/store/generation-engine'
import { COMPOSER_DRAFT_PREFIX } from '../../src/store/workspace-tab-session'
import {
  Composer,
  type ComposerSubmission,
  type ComposerSubmissionOutcome,
} from '../../src/ui/chat/Composer'
import { useComposerContextDraft } from '../../src/ui/chat/composer-draft-state'
import { InlineEditor } from '../../src/ui/chat/InlineEditor'
import {
  createInteractionSettlementHarness,
  succeededInteractionSettlement,
} from '../helpers/presentation-interactions'

const DB_NAME = 'natter'

function started(completion: Promise<void> = Promise.resolve()): ComposerSubmission {
  return Object.freeze({
    kind: 'started',
    admission: Promise.resolve(Object.freeze({ kind: 'admitted' })),
    completion: completion.then(
      (): ComposerSubmissionOutcome => Object.freeze({ kind: 'prepared' }),
    ),
  })
}

function startedInlineGeneration(): GenerationStartResult {
  const prepared = Object.freeze({
    streamId: 'inline-stream',
    chatId: 'chat-1',
    assistantMessageId: 'assistant-1',
  })
  return Object.freeze({
    kind: 'started',
    handle: Object.freeze({
      streamId: prepared.streamId,
      chatId: prepared.chatId,
      prepared: Promise.resolve(prepared),
      completed: Promise.resolve(Object.freeze({ ...prepared, outcome: 'done' as const })),
    }),
  })
}

const BLOCKED_GENERATION_CASES = [
  ['unavailable', unavailableGenerationCapability('connection-missing')],
  ['failed', failedGenerationCapability('configuration')],
] as const satisfies readonly (readonly [string, NonReadyGenerationCapability])[]

async function resetDb() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

function ComposerContextProbe({ draftKey }: { draftKey: string }) {
  const draft = useComposerContextDraft(draftKey)
  return (
    <output
      data-ui="composer-context-probe"
      data-text={draft.text}
      data-prefill={draft.prefillText}
      data-attachments={draft.attachmentRefs.length}
    />
  )
}

beforeEach(async () => {
  await openBrowserWorkspace()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await shutdownBrowserWorkspace()
  await resetDb()
})

describe('Composer', () => {
  it('keeps the committed composer mounted but inert while its target is retained', () => {
    const onSubmit = vi.fn(() => started())
    const view = render(<Composer draftKey="retained-composer" onSubmit={onSubmit} />)
    const composer = view.container.querySelector('[data-ui="composer"]')
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'committed draft' } })

    view.rerender(<Composer draftKey="retained-composer" onSubmit={onSubmit} presentationOnly />)

    expect(view.container.querySelector('[data-ui="composer"]')).toBe(composer)
    expect(screen.getByRole('textbox')).toBe(input)
    expect(input).toHaveValue('committed draft')
    expect(composer).toHaveAttribute('inert')
    expect(composer).toHaveAttribute('data-presentation-only', 'true')
    fireEvent.submit(composer as HTMLFormElement)
    expect(onSubmit).not.toHaveBeenCalled()

    view.rerender(<Composer draftKey="retained-composer" onSubmit={onSubmit} />)
    expect(view.container.querySelector('[data-ui="composer"]')).toBe(composer)
    expect(composer).not.toHaveAttribute('inert')
    expect(input).toHaveValue('committed draft')
  })

  it('flushes a pending debounced draft when the page is hidden', () => {
    const draftKey = 'pagehide-persistence'
    const storageKey = `${COMPOSER_DRAFT_PREFIX}${encodeURIComponent(draftKey)}`
    sessionStorage.removeItem(storageKey)
    render(<Composer draftKey={draftKey} onSubmit={() => started()} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'persist before leaving' } })
    expect(sessionStorage.getItem(storageKey)).toBeNull()

    try {
      window.dispatchEvent(new Event('pagehide'))
      expect(sessionStorage.getItem(storageKey)).toBe('persist before leaving')
    } finally {
      sessionStorage.removeItem(storageKey)
      window.dispatchEvent(new Event('pageshow'))
    }
  })

  it('makes a successful draft clear authoritative before the next read', async () => {
    const draftKey = 'successful-clear-read-after-write'
    const storageKey = `${COMPOSER_DRAFT_PREFIX}${encodeURIComponent(draftKey)}`
    sessionStorage.removeItem(storageKey)
    const mounted = render(<Composer draftKey={draftKey} onSubmit={() => started()} />)
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'already sent' } })
    window.dispatchEvent(new Event('pagehide'))
    expect(sessionStorage.getItem(storageKey)).toBe('already sent')
    window.dispatchEvent(new Event('pageshow'))

    fireEvent.submit(mounted.container.querySelector('[data-ui="composer"]') as HTMLFormElement)
    await waitFor(() => expect(input).toHaveValue(''))
    mounted.unmount()

    render(<Composer draftKey={draftKey} onSubmit={() => started()} />)
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(sessionStorage.getItem(storageKey)).toBeNull()
  })

  it('restores the submitted draft when onSubmit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <Composer onSubmit={() => started(Promise.reject(new Error('preflight failed')))} />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    await waitFor(() => expect(input).toHaveValue('keep this draft'))
  })

  it('does not clear a draft when synchronous admission is no longer current', () => {
    const onSubmit = vi.fn(
      (): ComposerSubmission => ({
        kind: 'not-started',
        capability: pendingGenerationCapability('prompt-path'),
      }),
    )
    const { container } = render(<Composer onSubmit={onSubmit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'preserve without a flash' } })

    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('preserve without a flash')
  })

  it('retains a draft when preparation settles as a typed rejection', async () => {
    let settle: (outcome: ComposerSubmissionOutcome) => void = () => undefined
    const completion = new Promise<ComposerSubmissionOutcome>((resolve) => {
      settle = resolve
    })
    const { container } = render(
      <Composer
        onSubmit={() =>
          Object.freeze({
            kind: 'started',
            admission: completion.then((outcome) =>
              outcome.kind === 'prepared'
                ? Object.freeze({ kind: 'admitted' as const })
                : Object.freeze({ kind: 'not-admitted' as const, reason: outcome.reason }),
            ),
            completion,
          })
        }
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'retain rejected submit' } })

    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    const send = screen.getByRole('button', { name: 'Send ⏎' })
    await waitFor(() => expect(send).toBeDisabled())
    settle(Object.freeze({ kind: 'not-prepared', reason: 'failed' }))
    await waitFor(() => expect(send).toBeEnabled())
    expect(input).toHaveValue('retain rejected submit')
  })

  it('owns one pending first submit and clears only after admission', async () => {
    let admit: () => void = () => undefined
    const admission = new Promise<void>((resolve) => {
      admit = resolve
    })
    let resolvePreparation: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      resolvePreparation = resolve
    })
    const onSubmit = vi.fn(
      (): ComposerSubmission =>
        Object.freeze({
          kind: 'started',
          admission: admission.then(() => Object.freeze({ kind: 'admitted' })),
          completion: completion.then(() => Object.freeze({ kind: 'prepared' })),
        }),
    )
    const { container } = render(
      <Composer
        generationCapability={pendingGenerationCapability('prompt-path')}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'retain until prepared' } })

    const send = screen.getByRole('button', { name: 'Send ⏎' })
    expect(send).toBeEnabled()
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(input).toHaveValue('retain until prepared')
    admit()
    await waitFor(() => expect(input).toHaveValue(''))
    expect(input).toHaveValue('')
    resolvePreparation()
    await waitFor(() => expect(input).toHaveValue(''))
  })

  it('preserves a whitespace-only draft edit made while preparation is pending', async () => {
    let resolvePreparation: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      resolvePreparation = resolve
    })
    const onSubmit = vi.fn(() => started(completion))
    const { container } = render(<Composer onSubmit={onSubmit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'exact draft' } })
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    fireEvent.change(input, { target: { value: ' exact draft ' } })
    resolvePreparation()

    await waitFor(() => expect(input).toHaveValue(' exact draft '))
    expect(onSubmit).toHaveBeenCalledWith('exact draft', {})
  })

  it.each(
    BLOCKED_GENERATION_CASES,
  )('preserves the draft and does not invoke submit while generation is %s', (_state, capability) => {
    const onSubmit = vi.fn(() => started())
    const { container } = render(<Composer generationCapability={capability} onSubmit={onSubmit} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'retain this exact draft' } })

    const send = screen.getByRole('button', { name: 'Send ⏎' })
    expect(send).toBeDisabled()
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    expect(onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveValue('retain this exact draft')
  })

  it('selects send and reply capability independently from the inactive action', async () => {
    const onSubmit = vi.fn((_text: string) => started())
    const onReplyToTrailingUser = vi.fn(() => started())
    const replyView = render(
      <Composer
        trailingUserMessage
        generationCapability={failedGenerationCapability('configuration')}
        replyGenerationCapability={AVAILABLE_GENERATION_CAPABILITY}
        onReplyToTrailingUser={onReplyToTrailingUser}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.submit(replyView.container.querySelector('[data-ui="composer"]') as HTMLFormElement)
    await waitFor(() => expect(onReplyToTrailingUser).toHaveBeenCalledOnce())
    expect(onSubmit).not.toHaveBeenCalled()
    replyView.unmount()

    const sendView = render(
      <Composer
        generationCapability={AVAILABLE_GENERATION_CAPABILITY}
        replyGenerationCapability={pendingGenerationCapability('prompt-path')}
        trailingUserMessage
        onReplyToTrailingUser={onReplyToTrailingUser}
        onSubmit={onSubmit}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ordinary send stays independent' } })
    fireEvent.submit(sendView.container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onReplyToTrailingUser).toHaveBeenCalledOnce()
  })

  it('does not report or restore an aborted submit while the page is being replaced', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(
      <Composer
        onSubmit={() => {
          window.dispatchEvent(new Event('pagehide'))
          return started(Promise.reject(new Dexie.AbortError('page replacement')))
        }}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'leaving page' } })
    try {
      fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)
      await waitFor(() => expect(input).toHaveValue(''))
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      window.dispatchEvent(new Event('pageshow'))
    }
  })

  it('does not report an aborted trailing-user reply while the page is being replaced', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onReplyToTrailingUser = vi.fn((): ComposerSubmission => {
      window.dispatchEvent(new Event('pagehide'))
      throw new Dexie.AbortError('page replacement')
    })
    const { container } = render(
      <Composer
        trailingUserMessage
        onReplyToTrailingUser={onReplyToTrailingUser}
        onSubmit={() => started()}
      />,
    )
    try {
      fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)
      await waitFor(() => expect(onReplyToTrailingUser).toHaveBeenCalledTimes(1))
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      window.dispatchEvent(new Event('pageshow'))
    }
  })

  it('uses exact zero and one labels before approximating longer drafts', () => {
    render(<Composer onSubmit={() => started()} />)
    const input = screen.getByRole('textbox')
    const counter = screen.getByText('0 draft tokens')

    expect(counter).not.toHaveAttribute('aria-live')

    fireEvent.change(input, { target: { value: 'x' } })
    expect(counter).toHaveTextContent('1 draft token')

    fireEvent.change(input, { target: { value: 'count this draft' } })

    expect(counter).toHaveTextContent('≈ 4 draft tokens')
    expect(counter).toHaveAttribute(
      'title',
      expect.stringContaining('drafts longer than one character are approximate'),
    )
  })

  it('publishes deferred text and prefill for the current tab context estimate', async () => {
    const { container } = render(
      <>
        <Composer draftKey="context-probe" showPrefillButton onSubmit={() => started()} />
        <ComposerContextProbe draftKey="context-probe" />
      </>,
    )
    const probe = container.querySelector('[data-ui="composer-context-probe"]')
    const input = container.querySelector('[data-ui="composer-input"]') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: 'pending user text' } })
    await waitFor(() => expect(probe).toHaveAttribute('data-text', 'pending user text'))

    fireEvent.click(screen.getByRole('button', { name: 'Open assistant prefill' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Assistant prefill text' }), {
      target: { value: 'pending assistant prefill' },
    })
    await waitFor(() => expect(probe).toHaveAttribute('data-prefill', 'pending assistant prefill'))
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
      render(<Composer autoSize onSubmit={() => started()} />)
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

  it('keeps one-line height stable across empty versus text scroll-height rounding', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
    )
    const nativeGetComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = nativeGetComputedStyle(element)
      return new Proxy(style, {
        get(target, property) {
          if (property === 'fontSize') return '15px'
          if (property === 'lineHeight') return '22.5px'
          if (property === 'paddingTop' || property === 'paddingBottom') return '12px'
          if (property === 'borderTopWidth' || property === 'borderBottomWidth') return '0px'
          return target[property as keyof CSSStyleDeclaration]
        },
      })
    })
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return this.value.length === 0 ? 47 : 49
      },
    })
    try {
      render(<Composer autoSize onSubmit={() => started()} />)
      const input = screen.getByRole('textbox')
      expect(input.style.height).toBe('47px')

      fireEvent.change(input, { target: { value: 'x' } })
      expect(input.style.height).toBe('47px')
      expect(input.style.overflowY).toBe('hidden')

      fireEvent.change(input, { target: { value: '' } })
      expect(input.style.height).toBe('47px')
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
    const onSubmit = vi.fn(
      (_text: string, _opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] }) =>
        started(),
    )
    const { container } = render(
      <>
        <Composer draftKey="attachment-context-probe" onSubmit={onSubmit} />
        <ComposerContextProbe draftKey="attachment-context-probe" />
      </>,
    )
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
    await waitFor(() =>
      expect(container.querySelector('[data-ui="composer-context-probe"]')).toHaveAttribute(
        'data-attachments',
        '1',
      ),
    )
    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const options = onSubmit.mock.calls[0]?.[1] as
      | { attachmentRefs?: Array<{ includeInContext: boolean }> }
      | undefined
    expect(options?.attachmentRefs).toHaveLength(1)
    expect(options?.attachmentRefs?.[0]).toMatchObject({ includeInContext: true })
  })

  it('preserves attachment edits and additions made while preparation is pending', async () => {
    let resolvePreparation: () => void = () => undefined
    const completion = new Promise<void>((resolve) => {
      resolvePreparation = resolve
    })
    const onSubmit = vi.fn(
      (_text: string, _opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] }) =>
        started(completion),
    )
    const { container } = render(<Composer onSubmit={onSubmit} />)
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['first'], 'first.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText('first.txt')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )

    fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'Hide attachment from context' }))
    fireEvent.change(fileInput, {
      target: { files: [new File(['second'], 'second.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText('second.txt')).toBeInTheDocument()
    resolvePreparation()

    await waitFor(() =>
      expect(container.querySelectorAll('[data-ui="attachment-file-card"]')).toHaveLength(2),
    )
    expect(
      screen.getByText('first.txt').closest('[data-ui="attachment-file-card"]'),
    ).toHaveAttribute('data-context', 'excluded')
    const submitted = onSubmit.mock.calls[0]?.[1]?.attachmentRefs
    expect(submitted).toHaveLength(1)
    expect(submitted?.[0]).toMatchObject({ includeInContext: true })
  })

  it('passes inline attachments only through Save & Send', async () => {
    const onSave = vi.fn(() => succeededInteractionSettlement())
    const onSaveAndSend = vi.fn(
      (
        _text: string,
        _options?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] },
      ) => startedInlineGeneration(),
    )
    const { container } = render(
      <InlineEditor
        initial="existing message"
        onSave={onSave}
        onCancel={() => {}}
        onSaveAndSend={onSaveAndSend}
      />,
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
    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))

    await waitFor(() => expect(onSaveAndSend).toHaveBeenCalledTimes(1))
    expect(onSave).not.toHaveBeenCalled()
    const options = onSaveAndSend.mock.calls[0]?.[1]
    expect(options?.attachmentRefs).toHaveLength(1)
    expect(options?.attachmentRefs?.[0]).toMatchObject({ includeInContext: true })
  })

  it('keeps reasoning and provider output outside the content-only editor', async () => {
    const onSave = vi.fn(() => succeededInteractionSettlement())
    const { container } = render(
      <InlineEditor initial="existing message" onSave={onSave} onCancel={() => {}} />,
    )

    expect(container.querySelector('[data-ui="inline-editor-reasoning"]')).toBeNull()
    expect(container.querySelector('[data-ui="inline-editor-tool-calls"]')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'existing message updated' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith('existing message updated')
  })

  it('lets only the mounted edit session dismiss after Save settles', async () => {
    const settlements = createInteractionSettlementHarness()
    let resolveOld!: () => void
    const oldSave = new Promise<void>((resolve) => {
      resolveOld = resolve
    })
    const oldCancel = vi.fn()
    const oldView = render(
      <StrictMode>
        <InlineEditor
          initial="same message"
          onSave={() => settlements.run(() => oldSave)}
          onCancel={oldCancel}
        />
      </StrictMode>,
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'old pending edit' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    oldView.unmount()

    const currentCancel = vi.fn()
    render(
      <StrictMode>
        <InlineEditor
          initial="same message"
          onSave={() => settlements.succeed()}
          onCancel={currentCancel}
        />
      </StrictMode>,
    )
    resolveOld()
    await oldSave
    await Promise.resolve()
    expect(oldCancel).not.toHaveBeenCalled()
    expect(currentCancel).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox', { name: 'Edit message' }), {
      target: { value: 'current edit' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(currentCancel).toHaveBeenCalledOnce())
  })

  it('lets only the mounted edit session dismiss after Save & Send prepares', async () => {
    let resolveOld!: (value: {
      streamId: string
      chatId: string
      assistantMessageId: string
    }) => void
    const oldPrepared = new Promise<{
      streamId: string
      chatId: string
      assistantMessageId: string
    }>((resolve) => {
      resolveOld = resolve
    })
    const oldCancel = vi.fn()
    const oldView = render(
      <StrictMode>
        <InlineEditor
          initial="same message"
          onSave={succeededInteractionSettlement}
          onCancel={oldCancel}
          onSaveAndSend={() => ({
            kind: 'started',
            handle: {
              streamId: 'old-stream',
              chatId: 'chat-1',
              prepared: oldPrepared,
              completed: Promise.resolve({
                streamId: 'old-stream',
                chatId: 'chat-1',
                assistantMessageId: 'assistant-old',
                outcome: 'done',
              }),
            },
          })}
        />
      </StrictMode>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    oldView.unmount()

    const currentCancel = vi.fn()
    render(
      <StrictMode>
        <InlineEditor
          initial="same message"
          onSave={succeededInteractionSettlement}
          onCancel={currentCancel}
          onSaveAndSend={startedInlineGeneration}
        />
      </StrictMode>,
    )
    resolveOld({
      streamId: 'old-stream',
      chatId: 'chat-1',
      assistantMessageId: 'assistant-old',
    })
    await oldPrepared
    await Promise.resolve()
    expect(oldCancel).not.toHaveBeenCalled()
    expect(currentCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    await waitFor(() => expect(currentCancel).toHaveBeenCalledOnce())
  })
})
