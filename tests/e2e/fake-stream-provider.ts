import { randomUUID } from 'node:crypto'
import type { Page } from './fixtures'

const FAKE_STREAM_CONTROL_ORIGIN = process.env.E2E_FAKE_PROVIDER_ORIGIN ?? 'http://127.0.0.1:4174'

export interface FakeStreamScenarioConfig {
  targetChars?: number
  reasoningChars?: number
  chunkChars?: number
  reasoningChunkChars?: number
  initialDelayMs?: number
  delayMs?: number
  responses?: FakeProviderResponse[]
}

interface FakeProviderResponse {
  method?: string
  path: string
  status?: number
  headers?: Record<string, string>
  json?: unknown
  body?: string
  sseFrames?: Array<
    | string
    | {
        data: unknown
        event?: string
        id?: string
        delayMs?: number
      }
  >
  rawChunks?: Array<
    | string
    | {
        body: string
        delayMs?: number
        close?: boolean
      }
  >
  delayMs?: number
  close?: boolean
}

export interface FakeProviderProfileTarget {
  kind?: 'openrouter' | 'openai-compatible' | 'anthropic' | 'google' | 'llama-server' | 'custom'
  api?: 'auto' | 'chat' | 'responses' | 'text' | 'gemini-native' | 'anthropic-messages'
  model?: string
}

export interface FakeStreamScenarioSnapshot {
  scenarioId: string
  config: FakeStreamScenarioConfig
  activeStreams: number
  requestCount: number
  requests: Array<{
    requestId: string
    receivedAt: number
    method: string
    path: string
    bodyBytes: number
    model: string | null
    stream: boolean | null
    promptChars: number
  }>
  storedBytes: number
  queuedResponses: Array<{
    method: string
    path: string
    status: number
    kind: 'json' | 'body' | 'sseFrames' | 'rawChunks' | 'empty'
    storedBytes: number
    frameCount?: number
    chunkCount?: number
  }>
  providerBaseUrl: string
}

export interface FakeStreamScenario {
  readonly scenarioId: string
  readonly providerBaseUrl: string
  update(config: FakeStreamScenarioConfig): Promise<FakeStreamScenarioSnapshot>
  snapshot(): Promise<FakeStreamScenarioSnapshot>
  dispose(): Promise<void>
}

export async function createFakeStreamScenario(
  config: FakeStreamScenarioConfig,
): Promise<FakeStreamScenario> {
  const scenarioId = `e2e-${process.pid}-${randomUUID()}`
  const controlUrl = `${FAKE_STREAM_CONTROL_ORIGIN}/__control/scenarios/${scenarioId}`
  const initial = await requestScenario(controlUrl, 'PUT', config)
  return {
    scenarioId,
    providerBaseUrl: initial.providerBaseUrl,
    update: (next) => requestScenario(controlUrl, 'PUT', next),
    snapshot: () => requestScenario(controlUrl, 'GET'),
    async dispose() {
      const response = await fetch(controlUrl, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        throw new Error(`FakeStreamScenarioDeleteFailed:${response.status}`)
      }
    },
  }
}

export async function retargetOnlyProfileToFakeProvider(
  page: Page,
  providerBaseUrl: string,
  target: FakeProviderProfileTarget = {},
): Promise<void> {
  const normalizedTarget = {
    kind: target.kind ?? 'openai-compatible',
    api: target.api ?? 'chat',
    model: target.model ?? 'natter/fake-stream',
  }
  await page.evaluate(
    async ({ baseUrl, target }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('natter')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      let onlyProfileId: unknown
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(['profiles', 'presets', 'chats'], 'readwrite')
          const profiles = transaction.objectStore('profiles')
          const presets = transaction.objectStore('presets')
          const chats = transaction.objectStore('chats')
          const read = profiles.getAll()
          let explicitAbort: Error | undefined
          read.onsuccess = () => {
            if (read.result.length !== 1) {
              explicitAbort = new Error(`Expected one E2E profile, found ${read.result.length}`)
              transaction.abort()
              return
            }
            const profile = read.result[0] as Record<string, unknown>
            onlyProfileId = profile.id
            profiles.put({
              ...profile,
              name: 'Loopback fake provider',
              kind: target.kind,
              baseUrl,
              supportsEndpointsApi: false,
              supportsGenerationApi: false,
              supportsPrivacyScrape: false,
              updatedAt: Date.now(),
            })
            const profileId = profile.id
            const presetRead = presets.getAll()
            presetRead.onsuccess = () => {
              for (const preset of presetRead.result as Array<Record<string, unknown>>) {
                const settings = (preset.settings ?? {}) as Record<string, unknown>
                presets.put({
                  ...preset,
                  connectionProfileId: profileId,
                  settings: {
                    ...settings,
                    profileId,
                    api: target.api,
                    model: target.model,
                  },
                  updatedAt: Date.now(),
                })
              }
              const chatRead = chats.getAll()
              chatRead.onsuccess = () => {
                for (const chat of chatRead.result as Array<Record<string, unknown>>) {
                  const settings = (chat.settings ?? {}) as Record<string, unknown>
                  chats.put({
                    ...chat,
                    settings: {
                      ...settings,
                      profileId,
                      api: target.api,
                      model: target.model,
                    },
                  })
                }
              }
            }
          }
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () =>
            reject(explicitAbort ?? transaction.error ?? new Error('Profile retarget aborted'))
        })
      } finally {
        db.close()
      }
      const rawSeed = window.sessionStorage.getItem('natter:active-seed')
      if (!rawSeed) return
      const seed = JSON.parse(rawSeed) as {
        profileId?: string | null
        presetId?: string | null
        settings?: Record<string, unknown> | null
      }
      window.sessionStorage.setItem(
        'natter:active-seed',
        JSON.stringify({
          ...seed,
          settings: {
            ...(seed.settings ?? {}),
            profileId: onlyProfileId,
            api: target.api,
            model: target.model,
          },
        }),
      )
    },
    { baseUrl: providerBaseUrl, target: normalizedTarget },
  )
  await page.reload()
  await page.locator('#root > *').first().waitFor()
}

async function requestScenario(
  controlUrl: string,
  method: 'GET' | 'PUT',
  config?: FakeStreamScenarioConfig,
): Promise<FakeStreamScenarioSnapshot> {
  const response = await fetch(controlUrl, {
    method,
    ...(config
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        }
      : {}),
  })
  if (!response.ok) throw new Error(`FakeStreamScenarioRequestFailed:${method}:${response.status}`)
  return parseScenarioSnapshot(await response.json())
}

function parseScenarioSnapshot(value: unknown): FakeStreamScenarioSnapshot {
  if (!value || typeof value !== 'object') throw new Error('FakeStreamScenarioInvalidSnapshot')
  const snapshot = value as Partial<FakeStreamScenarioSnapshot>
  if (
    typeof snapshot.scenarioId !== 'string' ||
    typeof snapshot.providerBaseUrl !== 'string' ||
    typeof snapshot.activeStreams !== 'number' ||
    typeof snapshot.requestCount !== 'number' ||
    typeof snapshot.storedBytes !== 'number' ||
    !snapshot.config ||
    !Array.isArray(snapshot.requests) ||
    !Array.isArray(snapshot.queuedResponses)
  ) {
    throw new Error('FakeStreamScenarioInvalidSnapshot')
  }
  return snapshot as FakeStreamScenarioSnapshot
}
