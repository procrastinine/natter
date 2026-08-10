import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import type { MessageBodyAuthoringOperations } from '../../src/core/message-body-authoring'
import type { MessageAttachmentRef } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { __resetDbForTests } from '../../src/store/db'
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
    generationSettled: Promise.resolve(),
    cancel: () => undefined,
  })
}

const startedInlineGeneration = started

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
  it('blocks only submission while another chat request is preparing', () => {
    const onSubmit = vi.fn(() => started())
    render(<Composer submissionPending onSubmit={onSubmit} />)

    const input = screen.getByPlaceholderText('Ask anything…')
    fireEvent.change(input, { target: { value: 'draft stays editable' } })

    expect(input).toBeEnabled()
    expect(input).toHaveValue('draft stays editable')
    expect(screen.getByRole('button', { name: /Preparing/u })).toBeDisabled()
    const form = input.closest('form')
    if (!form) throw new Error('Composer form missing')
    fireEvent.submit(form)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('cancels request preparation without discarding the composer draft', () => {
    const onCancelSubmission = vi.fn()
    render(
      <Composer
        submissionPending
        onCancelSubmission={onCancelSubmission}
        onSubmit={() => started()}
      />,
    )
    const input = screen.getByPlaceholderText('Ask anything…')
    fireEvent.change(input, { target: { value: 'keep this draft' } })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel preparing' }))

    expect(onCancelSubmission).toHaveBeenCalledOnce()
    expect(input).toHaveValue('keep this draft')
  })

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
            generationSettled: Promise.resolve(),
            cancel: () => undefined,
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
          generationSettled: Promise.resolve(),
          cancel: () => undefined,
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

  it.each(BLOCKED_GENERATION_CASES)(
    'preserves the draft and does not invoke submit while generation is %s',
    (_state, capability) => {
      const onSubmit = vi.fn(() => started())
      const { container } = render(
        <Composer generationCapability={capability} onSubmit={onSubmit} />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'retain this exact draft' } })

      const send = screen.getByRole('button', { name: 'Send ⏎' })
      expect(send).toBeDisabled()
      fireEvent.submit(container.querySelector('[data-ui="composer"]') as HTMLFormElement)

      expect(onSubmit).not.toHaveBeenCalled()
      expect(input).toHaveValue('retain this exact draft')
    },
  )

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

      expect(input.style.height).toBe(input.style.minHeight)
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

  it('submits the synchronous attachment draft after a remove and send in one event turn', async () => {
    const onSubmit = vi.fn(
      (_text: string, _opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] }) =>
        started(),
    )
    const { container } = render(<Composer onSubmit={onSubmit} />)
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['remove me'], 'remove-me.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText('remove-me.txt')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )

    act(() => {
      screen.getByRole('button', { name: 'Remove attachment' }).click()
      container
        .querySelector<HTMLFormElement>('[data-ui="composer"]')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce())
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({})
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

  it('commits inline attachment edits through Save', async () => {
    const onSave = vi.fn(
      (
        _text: string,
        _authoring?: MessageBodyAuthoringOperations,
        _attachmentRefs?: MessageAttachmentRef[],
      ) => succeededInteractionSettlement(),
    )
    const { container } = render(
      <InlineEditor initial="assistant answer" onSave={onSave} onCancel={() => {}} />,
    )
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement

    fireEvent.change(fileInput, {
      target: {
        files: [new File(['assistant evidence'], 'assistant-evidence.txt', { type: 'text/plain' })],
      },
    })

    expect(await screen.findByText('assistant-evidence.txt')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0]?.[0]).toBe('assistant answer')
    expect(onSave.mock.calls[0]?.[1]).toBeUndefined()
    expect(onSave.mock.calls[0]?.[2]).toHaveLength(1)
    expect(onSave.mock.calls[0]?.[2]?.[0]).toMatchObject({ includeInContext: true })
  })

  it('passes inline attachments through Save & Send', async () => {
    const onSave = vi.fn((_text: string, _authoring?: MessageBodyAuthoringOperations) =>
      succeededInteractionSettlement(),
    )
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

  it('Save & Send reads the synchronous attachment draft after a same-turn remove', async () => {
    const onSaveAndSend = vi.fn(
      (_text: string, _opts?: { prefillText?: string; attachmentRefs?: MessageAttachmentRef[] }) =>
        startedInlineGeneration(),
    )
    const { container } = render(
      <InlineEditor
        initial="existing message"
        onSave={succeededInteractionSettlement}
        onCancel={() => {}}
        onSaveAndSend={onSaveAndSend}
      />,
    )
    const fileInput = container.querySelector(
      '[data-ui="attachment-hidden-input"]',
    ) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [new File(['remove me'], 'remove-inline.txt', { type: 'text/plain' })] },
    })
    expect(await screen.findByText('remove-inline.txt')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument(),
    )

    act(() => {
      screen.getByRole('button', { name: 'Remove attachment' }).click()
      screen.getByRole('button', { name: 'Save & Send' }).click()
    })

    await waitFor(() => expect(onSaveAndSend).toHaveBeenCalledOnce())
    expect(onSaveAndSend.mock.calls[0]?.[1]).toEqual({})
  })

  it('owns a queued Save & Send until its exact preparation settles', async () => {
    let resolvePreparation!: () => void
    const preparation = new Promise<void>((resolve) => {
      resolvePreparation = resolve
    })
    const onCancel = vi.fn()
    render(
      <InlineEditor
        initial="queued edit"
        onSave={succeededInteractionSettlement}
        onCancel={onCancel}
        onSaveAndSend={() => started(preparation)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    expect(screen.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    resolvePreparation()
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  })

  it('lets Save & Send replace a preparation without surfacing the superseded outcome', async () => {
    let settleFirst!: (outcome: ComposerSubmissionOutcome) => void
    let settleSecond!: (outcome: ComposerSubmissionOutcome) => void
    const firstCompletion = new Promise<ComposerSubmissionOutcome>((resolve) => {
      settleFirst = resolve
    })
    const secondCompletion = new Promise<ComposerSubmissionOutcome>((resolve) => {
      settleSecond = resolve
    })
    const cancelFirst = vi.fn(() => {
      settleFirst({ kind: 'not-prepared', reason: 'superseded' })
    })
    const onSaveAndSend = vi
      .fn()
      .mockReturnValueOnce({
        kind: 'started',
        admission: Promise.resolve({ kind: 'admitted' }),
        completion: firstCompletion,
        generationSettled: Promise.resolve(),
        cancel: cancelFirst,
      })
      .mockReturnValueOnce({
        kind: 'started',
        admission: Promise.resolve({ kind: 'admitted' }),
        completion: secondCompletion,
        generationSettled: Promise.resolve(),
        cancel: () => undefined,
      })
    const onCancel = vi.fn()
    render(
      <InlineEditor
        initial="replace queued edit"
        onSave={succeededInteractionSettlement}
        onCancel={onCancel}
        onSaveAndSend={onSaveAndSend}
      />,
    )

    const saveAndSend = screen.getByRole('button', { name: 'Save & Send' })
    fireEvent.click(saveAndSend)
    expect(saveAndSend).toBeEnabled()
    fireEvent.click(saveAndSend)

    expect(onSaveAndSend).toHaveBeenCalledTimes(2)
    expect(cancelFirst).toHaveBeenCalledOnce()
    await firstCompletion
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onCancel).not.toHaveBeenCalled()

    settleSecond({ kind: 'prepared' })
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
  })

  it('cancels a queued Save & Send without dismissing or discarding the edit', async () => {
    let settle!: (outcome: ComposerSubmissionOutcome) => void
    const completion = new Promise<ComposerSubmissionOutcome>((resolve) => {
      settle = resolve
    })
    const cancelPreparation = vi.fn(() => {
      settle({ kind: 'not-prepared', reason: 'cancelled' })
    })
    const onCancel = vi.fn()
    render(
      <InlineEditor
        initial="queued edit"
        onSave={succeededInteractionSettlement}
        onCancel={onCancel}
        onSaveAndSend={() => ({
          kind: 'started',
          admission: Promise.resolve({ kind: 'not-admitted', reason: 'cancelled' }),
          completion,
          generationSettled: Promise.resolve(),
          cancel: cancelPreparation,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preparing' }))

    expect(cancelPreparation).toHaveBeenCalledOnce()
    await screen.findByRole('alert')
    expect(screen.getByRole('textbox', { name: 'Edit message' })).toHaveValue('queued edit')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps reasoning controls off message roles that do not own reasoning', async () => {
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

  it('authors reasoning and provider-output fields, creation and deletion in one save', async () => {
    const onSave = vi.fn((_text: string, _authoring?: MessageBodyAuthoringOperations) =>
      succeededInteractionSettlement(),
    )
    const initialReasoning = {
      owners: [{ kind: 'generation' }, { kind: 'continuation', streamId: 'continuation-1' }],
      entries: [
        {
          kind: 'visible',
          owner: { kind: 'generation' },
          part: {
            id: 'visible-1',
            groupId: 'group-1',
            kind: 'text',
            text: 'original reasoning',
            format: 'unknown',
            source: { dialect: 'unknown', bridge: 'unknown' },
          },
        },
        {
          kind: 'carrier',
          owner: { kind: 'generation' },
          carrier: {
            id: 'carrier-1',
            groupId: 'carrier-group',
            kind: 'unknown',
            format: 'unknown',
            source: { dialect: 'unknown', bridge: 'unknown' },
          },
          payloadLength: 42,
        },
      ],
    } as const
    const initialProviderOutput = {
      owners: [{ kind: 'generation' }],
      entries: [
        {
          editorId: 'stored:generation:0',
          owner: { kind: 'generation' },
          member: { owner: { kind: 'generation' }, itemIndex: 0 },
          original: {
            dialect: 'openai-responses',
            type: 'web_search_call',
            outputIndex: 0,
            item: { query: 'before', encrypted_content: 'sealed' },
          },
          item: {
            dialect: 'openai-responses',
            type: 'web_search_call',
            outputIndex: 0,
            item: { query: 'before', encrypted_content: 'sealed' },
          },
        },
        {
          editorId: 'stored:generation:1',
          owner: { kind: 'generation' },
          member: { owner: { kind: 'generation' }, itemIndex: 1 },
          original: {
            dialect: 'unknown',
            type: 'delete_me',
            outputIndex: 1,
            item: { obsolete: true },
          },
          item: {
            dialect: 'unknown',
            type: 'delete_me',
            outputIndex: 1,
            item: { obsolete: true },
          },
        },
      ],
    } as const
    render(
      <InlineEditor
        initial="answer"
        initialReasoning={initialReasoning}
        initialProviderOutput={initialProviderOutput}
        onSave={onSave}
        onCancel={() => {}}
      />,
    )

    fireEvent.click(screen.getByText('Reasoning (2)'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning block type' }), {
      target: { value: 'summary' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit summary reasoning' }), {
      target: { value: 'authored summary' },
    })
    const [visibleHide] = screen.getAllByRole('button', { name: 'Hide reasoning block' })
    if (!visibleHide) throw new Error('VisibleReasoningHideMissing')
    fireEvent.click(visibleHide)
    fireEvent.click(screen.getByRole('button', { name: 'Delete opaque reasoning block' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'New reasoning block owner' }), {
      target: { value: '1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add reasoning block' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit plaintext reasoning' }), {
      target: { value: 'continued detail' },
    })
    fireEvent.click(screen.getByText('Tool calls (2)'))
    const providerInputs = await screen.findAllByRole('textbox', {
      name: 'Edit tool call JSON or text',
    })
    const firstProviderInput = providerInputs[0]
    if (!firstProviderInput) throw new Error('ProviderOutputEditorMissing')
    fireEvent.change(firstProviderInput, { target: { value: '{"query":"after"}' } })
    const deleteToolCalls = screen.getAllByRole('button', { name: 'Delete tool call' })
    const deleteSecond = deleteToolCalls[1]
    if (!deleteSecond) throw new Error('SecondProviderOutputDeleteMissing')
    fireEvent.click(deleteSecond)
    fireEvent.click(screen.getByRole('button', { name: 'Add tool call' }))
    const addedProviderInput = screen.getAllByRole('textbox', {
      name: 'Edit tool call JSON or text',
    })[1]
    if (!addedProviderInput) throw new Error('AddedProviderOutputEditorMissing')
    fireEvent.change(addedProviderInput, { target: { value: '{"authored":true}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const authoring = onSave.mock.calls[0]?.[1]
    const operations = authoring?.reasoning
    expect(operations).toHaveLength(3)
    expect(operations?.[0]).toMatchObject({
      kind: 'visible-replace',
      member: { owner: { kind: 'generation' }, kind: 'visible', id: 'visible-1' },
      expected: { id: 'visible-1', kind: 'text', text: 'original reasoning' },
      next: { id: 'visible-1', kind: 'summary', text: 'authored summary', hidden: true },
    })
    expect(operations?.[1]).toMatchObject({
      kind: 'carrier-delete',
      member: { owner: { kind: 'generation' }, kind: 'carrier', id: 'carrier-1' },
      expected: { id: 'carrier-1' },
    })
    expect(operations?.[2]).toMatchObject({
      kind: 'visible-create',
      owner: { kind: 'continuation', streamId: 'continuation-1' },
      part: { kind: 'text', text: 'continued detail', format: 'unknown' },
    })
    expect(authoring?.providerOutput).toHaveLength(3)
    expect(authoring?.providerOutput?.[0]).toMatchObject({
      kind: 'provider-output-replace',
      next: {
        edited: true,
        item: { query: 'after', encrypted_content: 'sealed' },
      },
    })
    expect(authoring?.providerOutput?.[1]).toMatchObject({
      kind: 'provider-output-delete',
      member: { itemIndex: 1 },
    })
    expect(authoring?.providerOutput?.[2]).toMatchObject({
      kind: 'provider-output-create',
      item: { type: 'manual_tool_call', outputIndex: 1, edited: true, item: { authored: true } },
    })
  })

  it('plans reasoning edits from the mounted snapshot without deleting remote additions', async () => {
    const onSave = vi.fn((_text: string, _authoring?: MessageBodyAuthoringOperations) =>
      succeededInteractionSettlement(),
    )
    const original = {
      owners: [{ kind: 'generation' }],
      entries: [
        {
          kind: 'visible',
          owner: { kind: 'generation' },
          part: {
            id: 'visible-original',
            groupId: 'group-original',
            kind: 'text',
            text: 'opening snapshot',
            format: 'unknown',
            source: { dialect: 'unknown', bridge: 'unknown' },
          },
        },
      ],
    } as const
    const remoteAddition = {
      kind: 'visible',
      owner: { kind: 'generation' },
      part: {
        id: 'visible-remote',
        groupId: 'group-remote',
        kind: 'summary',
        text: 'remote addition',
        format: 'unknown',
        source: { dialect: 'unknown', bridge: 'unknown' },
      },
    } as const
    const view = render(
      <InlineEditor
        initial="answer"
        initialReasoning={original}
        onSave={onSave}
        onCancel={() => {}}
      />,
    )

    view.rerender(
      <InlineEditor
        initial="answer"
        initialReasoning={{ ...original, entries: [...original.entries, remoteAddition] }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(screen.getByText('Reasoning (1)'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit plaintext reasoning' }), {
      target: { value: 'local replacement' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    const operations = onSave.mock.calls[0]?.[1]?.reasoning
    expect(operations).toHaveLength(1)
    expect(operations?.[0]).toMatchObject({
      kind: 'visible-replace',
      expected: { id: 'visible-original', text: 'opening snapshot' },
      next: { id: 'visible-original', text: 'local replacement' },
    })
    expect(
      operations?.some(
        (operation) => 'expected' in operation && operation.expected.id === 'visible-remote',
      ),
    ).toBe(false)
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
    let resolveOld!: () => void
    const oldPrepared = new Promise<void>((resolve) => {
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
            admission: Promise.resolve({ kind: 'admitted' }),
            completion: oldPrepared.then(() => ({ kind: 'prepared' })),
            generationSettled: Promise.resolve(),
            cancel: () => undefined,
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
          onSaveAndSend={() => startedInlineGeneration()}
        />
      </StrictMode>,
    )
    resolveOld()
    await oldPrepared
    await Promise.resolve()
    expect(oldCancel).not.toHaveBeenCalled()
    expect(currentCancel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save & Send' }))
    await waitFor(() => expect(currentCancel).toHaveBeenCalledOnce())
  })
})
