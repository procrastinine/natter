export const CONTINUE_SYSTEM_PROMPT_PLACEHOLDER = '[SYSTEM_PROMPT]'
export const DEFAULT_CONTINUE_SYSTEM_PROMPT =
  'Continue the chat from the last assistant message. The last assistant message is incomplete. Output only the continuation. Do not repeat prior content, do not add filler text, and do not restate the user question.\n\nThe original system prompt (for reference):\n```\n[SYSTEM_PROMPT]\n```'
export const DEFAULT_CONTINUE_USER_PROMPT =
  'Now please generate only the continuation of the last message, with zero filler text.'

export function resolveContinueSystemPromptTemplate(
  template: string,
  originalSystemPrompt: string,
): string {
  if (template.trim().length === 0) return ''
  return template.split(CONTINUE_SYSTEM_PROMPT_PLACEHOLDER).join(originalSystemPrompt)
}
