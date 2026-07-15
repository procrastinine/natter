import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MessageContent } from '../../src/ui/chat/MessageContent'

describe('MessageContent', () => {
  it('renders generated output images even when the text lane is empty', () => {
    const url = 'data:image/png;base64,abc123'
    const { container } = render(
      <MessageContent content={[{ type: 'output_image', url, prompt: 'red square' }]} text="" />,
    )
    const image = container.querySelector('[data-ui="message-output-image"] img')
    expect(image?.getAttribute('src')).toBe(url)
    expect(image?.getAttribute('alt')).toBe('red square')
    expect(container.textContent).not.toContain('Blocked image')
  })

  it('does not prefetch raw generated audio or video before localization', () => {
    const { container } = render(
      <MessageContent
        content={[
          { type: 'audio_output', url: 'https://media.example.test/output.mp3' },
          { type: 'output_video', url: 'https://media.example.test/output.mp4' },
        ]}
        text=""
      />,
    )

    expect(container.querySelector('audio')?.getAttribute('preload')).toBe('none')
    expect(container.querySelector('video')?.getAttribute('preload')).toBe('none')
  })
})
