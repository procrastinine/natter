export type StreamAdapter =
  | 'chat-completions'
  | 'responses'
  | 'gemini-native'
  | 'anthropic-messages'
  | 'text-completions'

export interface StreamIntegrityEvent {
  category: 'malformed-json-frame'
  adapter: StreamAdapter
  eventType: string
  count: number
  fingerprint: string
  characterCount: number
}

export interface StreamIntegrityChunk {
  type: 'integrity'
  integrity: StreamIntegrityEvent
}
