import { describe, expectTypeOf, it } from 'vitest'
import type {
  Attachment,
  ChatProviderToolSettings,
  ChatSettings,
  ChatVersions,
  ChildListState,
  ConnectionProfile,
  DataPolicy,
  GenerationMeta,
  GenerationServerToolCall,
  Message,
  MessageApproval,
  MutationScope,
  ProviderPreferences,
  ResponseFormat,
  ToolDefinition,
  ToolExecution,
  TraceMetadata,
} from '../../src/core/types'

describe('Phase 0 type additions', () => {
  it('ConnectionProfile carries the kind + managementApiKeyRef fields', () => {
    expectTypeOf<ConnectionProfile['kind']>().toEqualTypeOf<
      'openrouter' | 'openai-compatible' | 'anthropic' | 'google' | 'llama-server' | 'custom'
    >()
    expectTypeOf<ConnectionProfile['managementApiKeyRef']>().toEqualTypeOf<string | undefined>()
  })

  it('ProviderPreferences covers routing + sort + budget axes', () => {
    expectTypeOf<ProviderPreferences['order']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<ProviderPreferences['requireParameters']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<ProviderPreferences['only']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<ProviderPreferences['ignore']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<ProviderPreferences['quantizations']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<ProviderPreferences['maxPrice']>().toMatchTypeOf<
      | {
          prompt?: number
          completion?: number
          request?: number
          image?: number
          audio?: number
        }
      | undefined
    >()
  })

  it('ResponseFormat is the three V1 shapes', () => {
    const text: ResponseFormat = { type: 'text' }
    const jsonObject: ResponseFormat = { type: 'json_object' }
    const jsonSchema: ResponseFormat = {
      type: 'json_schema',
      jsonSchema: { name: 's', schema: {}, strict: true },
    }
    expectTypeOf(text).toMatchTypeOf<ResponseFormat>()
    expectTypeOf(jsonObject).toMatchTypeOf<ResponseFormat>()
    expectTypeOf(jsonSchema).toMatchTypeOf<ResponseFormat>()
  })

  it('TraceMetadata has every Phase 0 observability field', () => {
    expectTypeOf<TraceMetadata['traceId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TraceMetadata['traceName']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TraceMetadata['spanName']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TraceMetadata['generationName']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<TraceMetadata['parentSpanId']>().toEqualTypeOf<string | undefined>()
  })

  it('ChatSettings carries metadata, logitBias, and autoContinueToolLoop', () => {
    expectTypeOf<ChatSettings['metadata']>().toEqualTypeOf<Record<string, string> | undefined>()
    expectTypeOf<ChatSettings['logitBias']>().toEqualTypeOf<Record<string, number> | undefined>()
    expectTypeOf<ChatSettings['autoContinueToolLoop']>().toEqualTypeOf<boolean>()
    expectTypeOf<ChatSettings['trace']>().toEqualTypeOf<TraceMetadata | undefined>()
    expectTypeOf<ChatSettings['tools']>().toEqualTypeOf<ChatProviderToolSettings>()
  })

  it('GenerationMeta stores hosted server-tool evidence for message info', () => {
    expectTypeOf<GenerationMeta['serverTools']>().toEqualTypeOf<
      GenerationServerToolCall[] | undefined
    >()
  })

  it('Attachment.contentHash is optional for remote-url rows', () => {
    expectTypeOf<Attachment['contentHash']>().toEqualTypeOf<string | undefined>()
  })

  it('chat/message storage version fields are explicit', () => {
    expectTypeOf<Message['nodeVersion']>().toEqualTypeOf<number>()
    expectTypeOf<ChatVersions['metaVersion']>().toEqualTypeOf<number>()
    expectTypeOf<ChatVersions['summaryVersion']>().toEqualTypeOf<number>()
    expectTypeOf<ChildListState['version']>().toEqualTypeOf<number>()
  })

  it('MutationScope covers chat-meta, message, children, draft, and attachment scopes', () => {
    expectTypeOf<Extract<MutationScope, { kind: 'chat-meta' }>['chatId']>().toEqualTypeOf<string>()
    expectTypeOf<Extract<MutationScope, { kind: 'message' }>['messageId']>().toEqualTypeOf<string>()
    expectTypeOf<Extract<MutationScope, { kind: 'children' }>['parentId']>().toEqualTypeOf<
      string | null
    >()
    expectTypeOf<Extract<MutationScope, { kind: 'draft' }>['chatId']>().toEqualTypeOf<string>()
    expectTypeOf<
      Extract<MutationScope, { kind: 'attachment' }>['attachmentId']
    >().toEqualTypeOf<string>()
  })

  it('Message.approval uses the MessageApproval union', () => {
    expectTypeOf<Message['approval']>().toEqualTypeOf<MessageApproval | undefined>()
    expectTypeOf<MessageApproval['state']>().toEqualTypeOf<'pending' | 'approved' | 'denied'>()
  })

  it('ToolDefinition + ToolExecution carry approval and allowedOrigins', () => {
    expectTypeOf<ToolDefinition['requiresApproval']>().toEqualTypeOf<boolean | undefined>()
    type FetchExec = Extract<ToolExecution, { kind: 'fetch' }>
    type JsExec = Extract<ToolExecution, { kind: 'javascript' }>
    expectTypeOf<FetchExec['allowedOrigins']>().toEqualTypeOf<string[] | undefined>()
    expectTypeOf<JsExec['allowedOrigins']>().toEqualTypeOf<string[] | undefined>()
  })

  it('DataPolicy retains all scraped fields', () => {
    expectTypeOf<DataPolicy['training']>().toEqualTypeOf<boolean>()
    expectTypeOf<DataPolicy['trainingOpenRouter']>().toEqualTypeOf<boolean>()
    expectTypeOf<DataPolicy['retainsPrompts']>().toEqualTypeOf<boolean>()
    expectTypeOf<DataPolicy['retentionDays']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<DataPolicy['canPublish']>().toEqualTypeOf<boolean>()
    expectTypeOf<DataPolicy['requiresUserIDs']>().toEqualTypeOf<boolean | undefined>()
  })
})
