import { useCallback } from 'react'
import { primaryKeys } from '../../store/reactive-dependencies'
import { useRepositoryQuery } from '../../store/reactive-query'
import { getSetting, setSetting } from '../../store/settings'
import { Button } from '../primitives/Button'

const DISMISS_KEY = 'sample-prompts:dismissed'

interface Prompt {
  title: string
  body: string
  preview: string
}

const SAMPLE_PROMPTS: readonly Prompt[] = [
  {
    title: 'Explain to a beginner',
    body: 'Explain how TCP congestion control works for a beginner.',
    preview: 'Beginner-friendly walkthroughs',
  },
  {
    title: 'Brainstorm titles',
    body: 'Generate ten blog post titles about the difference between branching and swiping in chat UIs.',
    preview: 'Idea generation',
  },
  {
    title: 'Refactor this snippet',
    body: 'Refactor the following TypeScript code for readability and suggest a simpler type for the generic.\n\n```ts\n// paste code here\n```',
    preview: 'Code refactor',
  },
  {
    title: 'Summarize a long doc',
    body: 'Summarize this article for a senior engineer who just wants the highlights:\n\n<paste article here>',
    preview: 'Long-form summarization',
  },
]

interface EmptyStateProps {
  onPick: (text: string) => void
}

export function EmptyState({ onPick }: EmptyStateProps) {
  const dismissed = useRepositoryQuery(
    `setting:${DISMISS_KEY}`,
    () => getSetting<boolean>(DISMISS_KEY).then((v) => v === true),
    false,
    primaryKeys('settings', DISMISS_KEY),
  )
  const onDismiss = useCallback(async () => {
    await setSetting(DISMISS_KEY, true)
  }, [])
  const onRestore = useCallback(async () => {
    await setSetting(DISMISS_KEY, false)
  }, [])
  return (
    <div data-ui="empty-state">
      <div>
        <h2>Pick or start a chat.</h2>
        <p>
          Every chat is a branching tree; feel free to swipe and regenerate without losing history.
        </p>
      </div>
      {dismissed ? (
        <Button type="button" data-ui="sample-prompts-restore" onClick={() => void onRestore()}>
          Show sample prompts
        </Button>
      ) : (
        <>
          <div data-ui="sample-prompts">
            {SAMPLE_PROMPTS.map((prompt) => (
              <Button
                type="button"
                data-ui="sample-prompt"
                key={prompt.title}
                onClick={() => onPick(prompt.body)}
              >
                <strong>{prompt.title}</strong>
                <span>{prompt.preview}</span>
              </Button>
            ))}
          </div>
          <Button type="button" data-ui="sample-prompts-dismiss" onClick={() => void onDismiss()}>
            Dismiss sample prompts
          </Button>
        </>
      )}
    </div>
  )
}
