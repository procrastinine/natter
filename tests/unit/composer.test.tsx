import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/ui/chat/Composer'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Composer', () => {
  it('restores the submitted draft when onSubmit rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <Composer
        onSubmit={async () => {
          throw new Error('preflight failed')
        }}
      />,
    )
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'keep this draft' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(input).toHaveValue('keep this draft'))
  })

  it('reports live draft changes for prompt-budget estimation', () => {
    const onDraftChange = vi.fn()
    render(<Composer onSubmit={() => {}} onDraftChange={onDraftChange} />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: 'count this draft' } })

    expect(onDraftChange).toHaveBeenLastCalledWith('count this draft')
  })
})
