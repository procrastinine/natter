import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  projectReasoningEnvelope,
  projectReasoningPresentation,
  type ReasoningEnvelopeLiveProjection,
  type ReasoningPresentation,
} from '../../src/core/reasoning-envelope'
import {
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  reasoningObservationsFromDetails,
} from '../../src/core/reasoning-observation'
import type { ReasoningDetail, ReasoningOriginDialect } from '../../src/core/types'
import { ReasoningBlock } from '../../src/ui/chat/ReasoningBlock'
import { succeededInteractionSettlement } from '../helpers/presentation-interactions'

const GENERATION_OWNER = { kind: 'generation' } as const

function presentationFromDetails(
  details: readonly ReasoningDetail[],
  dialect: ReasoningOriginDialect = 'openrouter-chat',
): ReasoningPresentation {
  const state = createReasoningObservationCodecState()
  applyReasoningObservationBatch(state, {
    observations: reasoningObservationsFromDetails({
      details,
      mode: 'snapshot',
      dialect,
      bridge:
        dialect === 'anthropic-messages'
          ? 'anthropic-direct'
          : dialect === 'gemini-native'
            ? 'google-direct'
            : dialect === 'openrouter-chat'
              ? 'openrouter'
              : 'unknown',
      untypedVisibleKind: dialect === 'gemini-native' ? 'summary' : 'text',
    }),
  })
  return projectReasoningPresentation({
    kind: 'durable',
    owner: GENERATION_OWNER,
    envelope: projectReasoningEnvelope(state.envelope),
  })
}

function renderDetails(
  details: readonly ReasoningDetail[],
  props: Omit<ComponentProps<typeof ReasoningBlock>, 'presentation'> = {},
) {
  return render(<ReasoningBlock presentation={presentationFromDetails(details)} {...props} />)
}

function openSummary(container: HTMLElement) {
  const details = container.querySelector('details')
  if (!details) throw new Error('details missing')
  details.open = true
}

describe('ReasoningBlock', () => {
  it('renders nothing when the envelope is empty', () => {
    const { container } = render(
      <ReasoningBlock
        presentation={projectReasoningPresentation({ kind: 'durable', owner: GENERATION_OWNER })}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders a mix of reasoning.summary and reasoning.text faithfully', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        summary: 'Analyzed the problem by breaking it into components',
        id: 'reasoning-summary-1',
        format: 'anthropic-claude-v1',
        index: 0,
      },
      {
        type: 'reasoning.text',
        text: 'Let me work through this systematically:\n1. First consideration...',
        id: 'reasoning-text-1',
        format: 'anthropic-claude-v1',
        index: 1,
      },
    ]
    const { container } = renderDetails(details)
    openSummary(container)
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="summary"]'),
    ).toBeTruthy()
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="text"]'),
    ).toBeTruthy()
    expect(screen.getByText(/Analyzed the problem/)).toBeTruthy()
    expect(screen.getByText(/work through this systematically/)).toBeTruthy()
    expect(container.querySelector('[data-reasoning-format="plaintext"]')).toBeTruthy()
    expect(container.querySelector('[data-reasoning-count="2"]')).toBeTruthy()
  })

  it('keeps plaintext as the primary kind while preserving an independent opaque carrier', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: 'plain text here', id: 't', format: 'unknown' },
      { type: 'reasoning.encrypted', data: 'AAAABBBB', id: 'e', format: 'unknown' },
    ]
    const { container } = renderDetails(details)
    expect(container.querySelector('[data-reasoning-format="plaintext"]')).toBeTruthy()
    openSummary(container)
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="encrypted"]'),
    ).toBeTruthy()
    expect(screen.getByText(/8 chars/)).toBeTruthy()
  })

  it('does not turn a Claude text signature into an independent encrypted row', () => {
    const presentation = presentationFromDetails(
      [
        {
          type: 'reasoning.text',
          text: 'visible Claude thinking',
          signature: 'opaque-signature',
          id: 'thinking-0',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    )
    const { container } = render(<ReasoningBlock presentation={presentation} />)
    openSummary(container)

    expect(presentation.kind).toBe('plaintext')
    expect(presentation.authentication).toHaveLength(1)
    expect(container.querySelector('[data-reasoning-count="1"]')).toBeTruthy()
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="encrypted"]'),
    ).toBeNull()
    const lock = container.querySelector('[data-ui="reasoning-lock"]')
    expect(lock?.getAttribute('data-kind')).toBe('authentication')
    expect(lock?.getAttribute('title')).toMatch(/^Reasoning authentication preserved/)
  })

  it('does not classify a signature bound only to empty Claude text as authentication', () => {
    const presentation = presentationFromDetails(
      [
        {
          type: 'reasoning.text',
          text: '',
          signature: 'opaque-signature',
          id: 'thinking-0',
          format: 'anthropic-claude-v1',
        },
      ],
      'anthropic-messages',
    )
    const { container } = render(<ReasoningBlock presentation={presentation} />)
    openSummary(container)

    expect(presentation.kind).toBe('encrypted')
    expect(presentation.authentication).toHaveLength(0)
    expect(presentation.opaque).toHaveLength(1)
    expect(container.querySelector('[data-reasoning-count="1"]')).toBeTruthy()
    expect(container.querySelector('[data-ui="reasoning-lock"]')?.getAttribute('data-kind')).toBe(
      'encrypted',
    )
  })

  it('shows both a Gemini summary and its opaque thought-signature carrier', () => {
    const presentation = presentationFromDetails(
      [
        {
          type: 'reasoning.summary',
          summary: 'visible Gemini summary',
          id: 'summary-0',
          providerItemId: 'thought-0',
          format: 'google-gemini-v1',
        },
        {
          type: 'reasoning.encrypted',
          data: 'thought-signature',
          id: 'signature-0',
          providerItemId: 'thought-0',
          format: 'google-gemini-v1',
        },
      ],
      'gemini-native',
    )
    const { container } = render(<ReasoningBlock presentation={presentation} />)
    openSummary(container)

    expect(presentation.kind).toBe('summary')
    expect(presentation.summary).toHaveLength(1)
    expect(presentation.opaque).toHaveLength(1)
    expect(container.querySelector('[data-reasoning-count="2"]')).toBeTruthy()
    expect(screen.getByText('visible Gemini summary')).toBeTruthy()
    expect(
      container.querySelector('[data-ui="reasoning-section"][data-reasoning-kind="encrypted"]'),
    ).toBeTruthy()
  })

  it('filters tool-call leakage at reasoning ingress before presentation', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.text',
        text: 'real reasoning',
        id: 'reasoning-text-1',
        format: 'unknown',
      },
      {
        type: 'reasoning.text',
        text: 'tool-call sig',
        id: 'tool_call_123',
        format: 'unknown',
      },
    ]
    const { container } = renderDetails(details)
    openSummary(container)
    expect(container.querySelector('[data-reasoning-count="1"]')).toBeTruthy()
    expect(screen.getByText('real reasoning')).toBeTruthy()
    expect(screen.queryByText('tool-call sig')).toBeNull()
  })

  it('does not fabricate rows for empty normalized reasoning members', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: '', id: 'r-1', format: 'unknown' },
      { type: 'reasoning.summary', summary: '', id: 's-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details)
    expect(container.firstChild).toBeNull()
  })

  it('auto-expands while streaming with no content yet', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'streaming…', id: 's-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details, { streaming: true, hasContent: false })
    const outer = container.querySelector('details[data-ui="reasoning"]') as HTMLDetailsElement
    expect(outer.open).toBe(true)
    expect(outer.getAttribute('data-streaming')).toBeNull()
  })

  it('does not mistake automatic streaming disclosure changes for a user pin', () => {
    const presentation = presentationFromDetails([
      {
        type: 'reasoning.summary',
        summary: 'streaming…',
        id: 's-1',
        format: 'unknown',
      },
    ])
    const view = render(<ReasoningBlock presentation={presentation} streaming hasContent={false} />)
    const outer = view.container.querySelector('details[data-ui="reasoning"]') as HTMLDetailsElement
    expect(outer.open).toBe(true)
    expect(outer.getAttribute('data-pinned')).toBeNull()

    view.rerender(<ReasoningBlock presentation={presentation} streaming hasContent />)
    expect(outer.open).toBe(false)
    expect(outer.getAttribute('data-pinned')).toBeNull()
  })

  it('renders live reasoning segments without materializing a growing value', () => {
    const live: ReasoningEnvelopeLiveProjection = {
      visible: [
        {
          part: {
            id: 'visible:live',
            groupId: 'group:live',
            kind: 'text',
            format: 'anthropic-claude-v1',
            source: {
              dialect: 'anthropic-messages',
              bridge: 'anthropic-direct',
              itemId: 'thinking-0',
            },
          },
          valueSections: ['one ', 'two '],
          pendingValue: 'three',
          valueLength: 13,
        },
      ],
      carriers: [
        {
          carrier: {
            id: 'carrier:live',
            groupId: 'group:carrier',
            kind: 'responses-encrypted',
            format: 'openai-responses-v1',
            source: {
              dialect: 'openai-responses',
              bridge: 'openai-direct',
              itemId: 'reasoning-0',
            },
          },
          valueLength: 1025,
        },
      ],
    }
    const presentation = projectReasoningPresentation({
      kind: 'live',
      owner: GENERATION_OWNER,
      projection: live,
    })
    expect(presentation.text[0]?.valueSections).toBe(live.visible[0]?.valueSections)
    const { container } = render(<ReasoningBlock presentation={presentation} streaming />)
    openSummary(container)
    expect(container.textContent).toContain('one two three')
    expect(container.querySelector('[data-ui="reasoning-lock"]')?.getAttribute('title')).toMatch(
      /1\.0 KB/,
    )
  })

  it('surfaces a lock badge and retained-size count for opaque reasoning', () => {
    const bytes = 'A'.repeat(2048)
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', data: bytes, id: 'e-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details)
    const lock = container.querySelector('[data-ui="reasoning-lock"]')
    expect(lock).toBeTruthy()
    expect(lock?.getAttribute('title')).toMatch(/2\.0 KB/)
  })

  it('renders Summary, Details, and Encrypted as separate nested disclosures', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'sum', id: 's-1', format: 'unknown' },
      { type: 'reasoning.text', text: 'text', id: 't-1', format: 'unknown' },
      { type: 'reasoning.encrypted', data: 'AAAA', id: 'e-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details)
    const sections = container.querySelectorAll('[data-ui="reasoning-section"]')
    expect(sections).toHaveLength(3)
    const kinds = Array.from(sections).map((el) => el.getAttribute('data-reasoning-kind'))
    expect(kinds).toEqual(['summary', 'text', 'encrypted'])
  })

  it('can keep reasoning rows unmounted until the outer disclosure opens', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'cold summary', id: 's-1', format: 'unknown' },
      { type: 'reasoning.text', text: 'cold details', id: 't-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details, { deferContentUntilOpen: true })
    const outer = container.querySelector('details[data-ui="reasoning"]') as HTMLDetailsElement

    expect(outer.open).toBe(false)
    expect(container.querySelector('[data-ui="reasoning-details"]')).toBeNull()
    expect(container.querySelector('[data-ui="reasoning-row"]')).toBeNull()
    expect(container.textContent).not.toContain('cold summary')
    expect(container.textContent).not.toContain('cold details')

    outer.open = true
    fireEvent(outer, new Event('toggle'))

    expect(container.querySelector('[data-ui="reasoning-details"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-ui="reasoning-row"]')).toHaveLength(2)
    expect(container.textContent).toContain('cold summary')
    expect(container.textContent).toContain('cold details')
  })

  it('keeps eager row mounting by default', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', text: 'eager details', id: 't-1', format: 'unknown' },
    ]
    const { container } = renderDetails(details)

    expect(container.querySelector('details[data-ui="reasoning"]')?.hasAttribute('open')).toBe(
      false,
    )
    expect(container.querySelector('[data-ui="reasoning-row"]')).toBeTruthy()
    expect(container.textContent).toContain('eager details')
  })

  it('routes row-hide actions by stable member identity', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'first', id: 's-1', format: 'unknown' },
      { type: 'reasoning.summary', summary: 'second', id: 's-2', format: 'unknown' },
      { type: 'reasoning.text', text: 'third', id: 't-1', format: 'unknown' },
    ]
    const presentation = presentationFromDetails(details)
    const onToggle = vi.fn()
    const { container } = render(
      <ReasoningBlock presentation={presentation} onToggleHidden={onToggle} />,
    )
    openSummary(container)
    const hideButtons = container.querySelectorAll('[data-ui="reasoning-row-hide"]')
    expect(hideButtons).toHaveLength(3)
    fireEvent.click(hideButtons[1] as HTMLElement)
    expect(onToggle).toHaveBeenCalledWith({
      owner: GENERATION_OWNER,
      kind: 'visible',
      id: presentation.summary[1]?.part.id,
    })
    fireEvent.click(hideButtons[2] as HTMLElement)
    expect(onToggle).toHaveBeenLastCalledWith({
      owner: GENERATION_OWNER,
      kind: 'visible',
      id: presentation.text[0]?.part.id,
    })
  })

  it('edits visible reasoning by stable member identity and keeps opaque rows read-only', async () => {
    const presentation = presentationFromDetails([
      { type: 'reasoning.text', text: 'original thought', id: 't-1', format: 'unknown' },
      { type: 'reasoning.encrypted', data: 'opaque', id: 'e-1', format: 'unknown' },
    ])
    const onEdit = vi.fn(() => succeededInteractionSettlement())
    const { container } = render(
      <ReasoningBlock presentation={presentation} onEditVisible={onEdit} />,
    )
    openSummary(container)

    expect(screen.getAllByRole('button', { name: 'Edit reasoning details' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Edit reasoning details' }))
    const editor = screen.getByRole('textbox', { name: 'Edit reasoning details' })
    expect(editor).toHaveValue('original thought')
    fireEvent.change(editor, { target: { value: 'corrected thought' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(onEdit).toHaveBeenCalledWith(
        {
          owner: GENERATION_OWNER,
          kind: 'visible',
          id: presentation.text[0]?.part.id,
        },
        'corrected thought',
      )
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: 'Edit reasoning details' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('keeps an existing reasoning row mounted when an earlier row arrives', () => {
    const initial = presentationFromDetails([
      { type: 'reasoning.summary', summary: 'stable row', id: 's-2', format: 'unknown' },
    ])
    const view = render(<ReasoningBlock presentation={initial} />)
    openSummary(view.container)
    const stableRow = screen.getByText('stable row').closest('[data-ui="reasoning-row"]')

    const prepended = presentationFromDetails([
      { type: 'reasoning.summary', summary: 'earlier row', id: 's-1', format: 'unknown' },
      { type: 'reasoning.summary', summary: 'stable row', id: 's-2', format: 'unknown' },
    ])
    view.rerender(<ReasoningBlock presentation={prepended} />)

    expect(screen.getByText('stable row').closest('[data-ui="reasoning-row"]')).toBe(stableRow)
  })

  it('marks hidden rows and hides controls for read-only views', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', summary: 'visible', id: 's-1', format: 'unknown' },
      {
        type: 'reasoning.summary',
        summary: 'gone',
        id: 's-2',
        format: 'unknown',
        hidden: true,
      },
    ]
    const presentation = presentationFromDetails(details)
    const toggled = render(
      <ReasoningBlock
        presentation={presentation}
        onToggleHidden={succeededInteractionSettlement}
      />,
    )
    openSummary(toggled.container)
    const rows = toggled.container.querySelectorAll('[data-ui="reasoning-row"]')
    expect(rows[0]?.getAttribute('data-hidden')).toBeNull()
    expect(rows[1]?.getAttribute('data-hidden')).toBe('true')
    expect(
      toggled.container.querySelectorAll('[data-ui="reasoning-row-hide"][data-pressed="true"]'),
    ).toHaveLength(1)
    toggled.unmount()

    const readOnly = render(<ReasoningBlock presentation={presentation} />)
    openSummary(readOnly.container)
    expect(readOnly.container.querySelector('[data-ui="reasoning-row-hide"]')).toBeNull()
  })
})
