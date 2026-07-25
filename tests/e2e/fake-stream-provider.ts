import { randomUUID } from 'node:crypto'
import { retargetWorkspaceThroughBackupImport } from '../../scripts/workspace-provider-fixture.mjs'
import type { Page } from './fixtures'

const FAKE_STREAM_CONTROL_ORIGIN = process.env.E2E_FAKE_PROVIDER_ORIGIN ?? 'http://127.0.0.1:4174'

export interface FakeStreamScenarioConfig {
  targetChars?: number
  reasoningChars?: number
  chunkChars?: number
  reasoningChunkChars?: number
  initialDelayMs?: number
  delayMs?: number
  holdUntilReleased?: boolean
  usage?: {
    promptTokens?: number
    completionTokens?: number
    reasoningTokens?: number
    cachedTokens?: number
    cacheCreationInputTokens?: number
    cost?: number
    costDetails?: {
      upstreamInferenceCost?: number
      promptCost?: number
      completionCost?: number
    }
  }
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
  releaseOpen: boolean
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
  hold(): Promise<FakeStreamScenarioSnapshot>
  release(): Promise<FakeStreamScenarioSnapshot>
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
    hold: () => requestScenario(`${controlUrl}/hold`, 'POST'),
    release: () => requestScenario(`${controlUrl}/release`, 'POST'),
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
  await retargetWorkspaceThroughBackupImport(page, providerBaseUrl, target)
}

async function requestScenario(
  controlUrl: string,
  method: 'GET' | 'POST' | 'PUT',
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
    typeof snapshot.releaseOpen !== 'boolean' ||
    !snapshot.config ||
    !Array.isArray(snapshot.requests) ||
    !Array.isArray(snapshot.queuedResponses)
  ) {
    throw new Error('FakeStreamScenarioInvalidSnapshot')
  }
  return snapshot as FakeStreamScenarioSnapshot
}
