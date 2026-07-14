import type { GeminiStreamChunk } from '../api/gemini-types'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../api/types'
import {
  beginRouteIntent,
  cancelRouteIntent,
  navigateToChatForIntent,
  parseRoute,
} from '../app/router'
import { cloneDefaultChatSettings } from '../core/defaults'
import type { ChatId, ConnectionProfile, MessageId } from '../core/types'
import { type SendTextResult, sendFromMessage, sendText } from '../hooks/useChat'
import { createChat } from '../store/chats'
import { getCachedEndpoints, putCachedEndpoints } from '../store/models-cache'
import { createProfile, getProfile } from '../store/profiles'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'

const DEBUG_PROFILE_ID = 'debug-fake-stream-profile'
const DEBUG_MODEL_ID = 'debug/fake-lorem-stream'
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae sem sed nulla gravida feugiat. '

interface DebugFakeStreamOptions {
  chatId?: ChatId
  parentMessageId?: MessageId
  expectedLeafId?: MessageId | null
  targetChars?: number
  reasoningChars?: number
  chunkChars?: number
  reasoningChunkChars?: number
  delayMs?: number
  prompt?: string
  openChat?: boolean
  reasoningAsSnapshots?: boolean
  providerFixtureChunks?: unknown[]
}

interface DebugFakeStreamResult extends SendTextResult {
  chatId: ChatId
  targetChars: number
  reasoningChars: number
  chunkChars: number
  reasoningChunkChars: number
}

interface DebugMemoryMeasurement {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

interface DebugStoreSnapshot {
  chatStore: {
    chatCursorCount: number
    cursorEntryCount: number
  }
  streamStore: {
    activeCount: number
    activeTargets: Array<{ chatId: ChatId; messageId?: MessageId }>
    liveSnapshotCount: number
    liveTextLength: number
    liveReasoningLength: number
    liveSetCount: number
    liveClearCount: number
    maxLiveTextLength: number
    maxLiveReasoningLength: number
  }
  uiStore: {
    activeChatId: ChatId | null
  }
}

interface DebugFakeStreamApi {
  start(options?: DebugFakeStreamOptions): Promise<DebugFakeStreamResult>
  measure(): DebugMemoryMeasurement
  state(): DebugStoreSnapshot
  resetStats(): void
  recycleTranscript(): void
}

const streamStats = {
  liveSetCount: 0,
  liveClearCount: 0,
  maxLiveTextLength: 0,
  maxLiveReasoningLength: 0,
}
let streamStatsInstalled = false
let debugEnvironmentPromise: Promise<ConnectionProfile> | null = null

declare global {
  interface Window {
    __debugFakeStream?: DebugFakeStreamApi
  }
}

export function installDebugFakeStream(): void {
  if (typeof window === 'undefined') return
  installStreamStats()
  window.__debugFakeStream = {
    start,
    measure,
    state,
    resetStats,
    recycleTranscript,
  }
  console.info(
    '%c[debug] window.__debugFakeStream.start({ targetChars: 100000, reasoningChars: 100000, chunkChars: 128, delayMs, providerFixtureChunks }) — local lorem stream without an API call. window.__debugFakeStream.recycleTranscript() remounts the active transcript without reloading.',
    'color:#888;font-style:italic',
  )
}

function installStreamStats(): void {
  if (streamStatsInstalled) return
  streamStatsInstalled = true
  const current = useStreamStore.getState()
  const originalSetLiveSnapshot = current.setLiveSnapshot
  const originalClearLiveSnapshot = current.clearLiveSnapshot
  useStreamStore.setState({
    setLiveSnapshot: (snapshot) => {
      streamStats.liveSetCount += 1
      streamStats.maxLiveTextLength = Math.max(streamStats.maxLiveTextLength, snapshot.textLength)
      streamStats.maxLiveReasoningLength = Math.max(
        streamStats.maxLiveReasoningLength,
        snapshot.reasoningLength,
      )
      originalSetLiveSnapshot(snapshot)
    },
    clearLiveSnapshot: (messageId, expectedStreamId, replacementEpoch) => {
      streamStats.liveClearCount += 1
      originalClearLiveSnapshot(messageId, expectedStreamId, replacementEpoch)
    },
  })
}

function resetStats(): void {
  streamStats.liveSetCount = 0
  streamStats.liveClearCount = 0
  streamStats.maxLiveTextLength = 0
  streamStats.maxLiveReasoningLength = 0
}

function recycleTranscript(): void {
  window.dispatchEvent(new Event('natter:recycle-transcript'))
}

function state(): DebugStoreSnapshot {
  const chatState = useChatStore.getState()
  const streamState = useStreamStore.getState()
  const uiState = useUiStore.getState()
  const liveSnapshots = streamState.listLiveSnapshots()
  const activeStreams = streamState.listActive()
  const chatStoreStats = chatState.getDebugStats()
  return {
    chatStore: chatStoreStats,
    streamStore: {
      activeCount: activeStreams.length,
      activeTargets: activeStreams.map(({ chatId, messageId }) => ({
        chatId,
        ...(messageId ? { messageId } : {}),
      })),
      liveSnapshotCount: liveSnapshots.length,
      liveTextLength: liveSnapshots.reduce((sum, snapshot) => sum + snapshot.textLength, 0),
      liveReasoningLength: liveSnapshots.reduce(
        (sum, snapshot) => sum + snapshot.reasoningLength,
        0,
      ),
      ...streamStats,
    },
    uiStore: {
      activeChatId: uiState.activeChatId,
    },
  }
}

async function start(options: DebugFakeStreamOptions = {}): Promise<DebugFakeStreamResult> {
  const routeIntent = options.openChat !== false ? beginRouteIntent() : null
  const invocationRoute = typeof window === 'undefined' ? null : parseRoute(window.location.hash)
  const foregroundChatIdAtInvocation =
    !routeIntent && invocationRoute?.kind === 'chat' ? invocationRoute.chatId : null
  const targetChars = Math.max(0, Math.floor(options.targetChars ?? 100_000))
  const reasoningChars = Math.max(0, Math.floor(options.reasoningChars ?? 100_000))
  const chunkChars = Math.max(1, Math.floor(options.chunkChars ?? 128))
  const reasoningChunkChars = Math.max(1, Math.floor(options.reasoningChunkChars ?? chunkChars))
  const delayMs = Math.max(0, Math.floor(options.delayMs ?? 0))
  const { connection, chatId, navigationIntent } = await (async () => {
    try {
      const connection = await ensureDebugEnvironment()
      const chatId = options.chatId ?? (await createDebugChat(connection.id)).id
      const currentRoute = typeof window === 'undefined' ? null : parseRoute(window.location.hash)
      return {
        connection,
        chatId,
        navigationIntent: routeIntent
          ? navigateToChatForIntent(routeIntent, chatId)
          : foregroundChatIdAtInvocation === chatId &&
              currentRoute?.kind === 'chat' &&
              currentRoute.chatId === chatId
            ? useChatStore.getState().beginNavigationIntent(chatId)
            : null,
      }
    } finally {
      if (routeIntent) cancelRouteIntent(routeIntent)
    }
  })()

  const openStream = ({ signal }: { signal: AbortSignal }) =>
    options.providerFixtureChunks
      ? replayProviderFixtureChunks(options.providerFixtureChunks, signal)
      : fakeLoremStream({
          targetChars,
          reasoningChars,
          chunkChars,
          reasoningChunkChars,
          delayMs,
          signal,
          reasoningAsSnapshots: options.reasoningAsSnapshots === true,
        })

  const result = options.parentMessageId
    ? await sendFromMessage({
        chatId,
        navigationIntent,
        connection,
        apiKey: 'debug-fake-key',
        parentMessageId: options.parentMessageId,
        openStream,
      })
    : await sendText({
        chatId,
        navigationIntent,
        ...(options.expectedLeafId !== undefined ? { expectedLeafId: options.expectedLeafId } : {}),
        connection,
        apiKey: 'debug-fake-key',
        content: [
          { type: 'text', text: options.prompt ?? 'Run a local lorem ipsum stress stream.' },
        ],
        openStream,
      })

  return { ...result, chatId, targetChars, reasoningChars, chunkChars, reasoningChunkChars }
}

async function ensureDebugProfile(): Promise<ConnectionProfile> {
  const existing = await getProfile(DEBUG_PROFILE_ID)
  if (existing) return existing
  return createProfile({
    id: DEBUG_PROFILE_ID,
    name: 'Debug fake stream',
    kind: 'openrouter',
    baseUrl: 'https://debug.invalid/api/v1',
    apiKeyRef: 'debug-fake-key',
    appTitle: 'natter',
    appUrl: typeof window !== 'undefined' ? window.location.origin : '',
    supportsEndpointsApi: true,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  })
}

async function ensureDebugEnvironment(): Promise<ConnectionProfile> {
  if (debugEnvironmentPromise) return debugEnvironmentPromise
  const setup = ensureDebugProfile().then(async (connection) => {
    await seedDebugEndpoint(connection.id)
    return connection
  })
  debugEnvironmentPromise = setup
  try {
    return await setup
  } finally {
    if (debugEnvironmentPromise === setup) debugEnvironmentPromise = null
  }
}

async function createDebugChat(profileId: string) {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  settings.model = DEBUG_MODEL_ID
  settings.reasoning = {
    mode: 'enabled',
    exclude: false,
    summary: 'auto',
    include: { encrypted: false, summary: true, text: true },
  }
  return createChat({ title: 'Debug fake stream', settings })
}

async function seedDebugEndpoint(profileId: string): Promise<void> {
  if (await getCachedEndpoints(profileId, DEBUG_MODEL_ID)) return
  await putCachedEndpoints(profileId, DEBUG_MODEL_ID, {
    id: DEBUG_MODEL_ID,
    endpoints: [
      {
        provider_name: 'Debug Local',
        provider_slug: 'debug-local',
        supported_parameters: ['temperature'],
        context_length: 1_000_000_000,
        pricing: {},
        data_policy: {
          training: false,
          training_openrouter: false,
          retains_prompts: false,
          can_publish: false,
        },
      },
    ],
  })
}

async function* fakeLoremStream(args: {
  targetChars: number
  reasoningChars: number
  chunkChars: number
  reasoningChunkChars: number
  delayMs: number
  signal: AbortSignal
  reasoningAsSnapshots: boolean
}): AsyncGenerator<ChatStreamChunk> {
  let reasoningEmitted = 0
  let emitted = 0
  let index = 0
  let reasoningSnapshot = ''
  while (reasoningEmitted < args.reasoningChars) {
    throwIfAborted(args.signal)
    const size = Math.min(args.reasoningChunkChars, args.reasoningChars - reasoningEmitted)
    const reasoning = loremChunk(size, reasoningEmitted)
    reasoningSnapshot = args.reasoningAsSnapshots ? `${reasoningSnapshot}${reasoning}` : ''
    yield {
      type: 'delta',
      generationId: 'debug-fake-generation',
      chunk: {
        id: `debug-fake-reasoning-${index}`,
        model: DEBUG_MODEL_ID,
        provider: 'debug-local',
        choices: [
          {
            delta: args.reasoningAsSnapshots
              ? {
                  reasoning_details: [
                    { type: 'reasoning.text', index: 0, text: reasoningSnapshot },
                  ],
                }
              : { reasoning },
          },
        ],
      },
    }
    reasoningEmitted += size
    index += 1
    if (args.delayMs > 0) await wait(args.delayMs, args.signal)
  }
  while (emitted < args.targetChars) {
    throwIfAborted(args.signal)
    const size = Math.min(args.chunkChars, args.targetChars - emitted)
    yield {
      type: 'delta',
      generationId: 'debug-fake-generation',
      chunk: {
        id: `debug-fake-${index}`,
        model: DEBUG_MODEL_ID,
        provider: 'debug-local',
        choices: [{ delta: { content: loremChunk(size, emitted) } }],
      },
    }
    emitted += size
    index += 1
    if (args.delayMs > 0) await wait(args.delayMs, args.signal)
  }
  yield {
    type: 'delta',
    generationId: 'debug-fake-generation',
    chunk: {
      id: 'debug-fake-final',
      model: DEBUG_MODEL_ID,
      provider: 'debug-local',
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: Math.ceil(args.targetChars / 4),
        completion_tokens_details: { reasoning_tokens: Math.ceil(args.reasoningChars / 4) },
        total_tokens: 8 + Math.ceil((args.targetChars + args.reasoningChars) / 4),
      },
    },
  }
}

async function* replayProviderFixtureChunks(
  chunks: readonly unknown[],
  signal: AbortSignal,
): AsyncGenerator<ChatStreamChunk | ResponsesStreamChunk | GeminiStreamChunk> {
  for (const chunk of chunks) {
    await Promise.resolve()
    throwIfAborted(signal)
    yield structuredClone(chunk) as ChatStreamChunk | ResponsesStreamChunk | GeminiStreamChunk
  }
}

function loremChunk(size: number, offset: number): string {
  let out = ''
  const start = offset % LOREM.length
  if (start > 0) out += LOREM.slice(start)
  while (out.length < size) out += LOREM
  return out.slice(0, size)
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal))
      return
    }
    let timer = 0
    let onAbort = () => {}
    const cleanup = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    timer = window.setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException('aborted', 'AbortError')
}

function measure(): DebugMemoryMeasurement {
  const memory = (performance as unknown as { memory?: DebugMemoryMeasurement }).memory
  return memory ? { ...memory } : {}
}
