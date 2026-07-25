import type { ConversationProvedSelection, StructuralSnapshot } from '../core/messages'
import type { MessageHeaderRow } from './message-storage'

export interface StructuralSnapshotPresentation {
  destination: ConversationProvedSelection
  structuralHeaders: MessageHeaderRow[]
}

export interface RestoreStructuralSnapshotInput {
  snapshot: StructuralSnapshot
}
