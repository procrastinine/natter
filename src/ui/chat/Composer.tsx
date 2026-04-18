import { useCallback, useState } from 'react'

export interface ComposerProps {
  disabled?: boolean
  onSubmit: (text: string) => void | Promise<void>
}

export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [text, setText] = useState('')
  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    setText('')
    await onSubmit(trimmed)
  }, [text, disabled, onSubmit])
  return (
    <form
      data-ui="composer"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <textarea
        data-ui="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Say something…"
        rows={3}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div data-ui="composer-actions">
        <button type="submit" data-ui="send" disabled={disabled || text.trim() === ''}>
          Send
        </button>
      </div>
    </form>
  )
}
