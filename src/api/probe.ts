// llama-server discovery probe.
//
// `GET {serverRoot}/props` returns the running server's configuration —
// chat template, template capabilities, modalities, sleep state, and the
// default generation settings (incl. `n_ctx`). It's used to:
//
// 1. "Test connection", does `baseUrl` actually resolve to a llama-server
//    instance, and is the server up / not sleeping?
// 2. Populate the "Default (server template)" option in the text-completion
//    template picker.
// 3. Detect thinking support via `chat_template_caps` so the reasoning
//    panel can be shown or hidden on llama-server chats.
//
// Per the CLAUDE.md URL-scoping note, `/props` lives at SERVER ROOT, not
// under `/v1`. A llama-server connection profile's `baseUrl` typically
// ends in `/v1` (OpenAI convention); `llamaServerRoot()` strips that.

import type { ConnectionProfile } from '../core/types'
import { fetchWithTimeout } from './client'

export interface LlamaServerProps {
  modelPath: string | null
  chatTemplate: string | null
  chatTemplateCaps: Record<string, unknown>
  modalities: { vision?: boolean }
  isSleeping: boolean
  defaultContextLength: number | null
  buildInfo: string | null
  totalSlots: number | null
}

export interface ProbeSuccess {
  kind: 'ok'
  props: LlamaServerProps
  rootUrl: string
  elapsedMs: number
}

export interface ProbeFailure {
  kind: 'error'
  status: number | null
  message: string
  rootUrl: string
  elapsedMs: number
}

export type ProbeResult = ProbeSuccess | ProbeFailure

// Strip a trailing /v1 (or /v1beta, /v2, …) path segment so root-scoped
// llama.cpp endpoints resolve correctly regardless of whether the user
// entered "http://host:8080" or "http://host:8080/v1".
export function llamaServerRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.replace(/\/v\d+(?:beta\d*)?$/i, '')
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asBool(v: unknown): boolean {
  return v === true
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// Parse a /props response into the compact shape. Accepts any JSON and
// returns null when the response clearly isn't llama-server (missing
// both `chat_template` and `default_generation_settings`).
export function parseLlamaServerProps(body: unknown): LlamaServerProps | null {
  const obj = asRecord(body)
  const chatTemplate = asString(obj.chat_template)
  const defaultGenSettings = asRecord(obj.default_generation_settings)
  if (chatTemplate === null && Object.keys(defaultGenSettings).length === 0) {
    return null
  }
  const modalities = asRecord(obj.modalities)
  return {
    modelPath: asString(obj.model_path),
    chatTemplate,
    chatTemplateCaps: asRecord(obj.chat_template_caps),
    modalities: { vision: asBool(modalities.vision) },
    isSleeping: asBool(obj.is_sleeping),
    defaultContextLength: asNumber(defaultGenSettings.n_ctx),
    buildInfo: asString(obj.build_info),
    totalSlots: asNumber(obj.total_slots),
  }
}

export interface ProbeOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

// One-shot probe. Returns ok+props when /props resolves and parses as
// llama-server; returns error with HTTP status or the fetch failure
// message otherwise. Never throws — the UI uses the result directly.
export async function probeLlamaServer(
  profile: Pick<ConnectionProfile, 'baseUrl'>,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const root = llamaServerRoot(profile.baseUrl)
  const url = `${root}/props`
  const started = performance.now()
  try {
    const init: RequestInit = { method: 'GET', headers: { Accept: 'application/json' } }
    const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {
      timeoutMs: opts.timeoutMs ?? 3_000,
    }
    if (opts.signal) fetchOpts.signal = opts.signal
    const response = await fetchWithTimeout(url, init, fetchOpts)
    const elapsed = Math.round(performance.now() - started)
    if (!response.ok) {
      return { kind: 'error', status: response.status, message: response.statusText, rootUrl: root, elapsedMs: elapsed }
    }
    const body = (await response.json().catch(() => null)) as unknown
    const props = parseLlamaServerProps(body)
    if (!props) {
      return {
        kind: 'error',
        status: response.status,
        message: 'Server responded but does not look like llama-server (no chat_template or default_generation_settings).',
        rootUrl: root,
        elapsedMs: elapsed,
      }
    }
    return { kind: 'ok', props, rootUrl: root, elapsedMs: elapsed }
  } catch (e) {
    const elapsed = Math.round(performance.now() - started)
    return {
      kind: 'error',
      status: null,
      message: e instanceof Error ? e.message : String(e),
      rootUrl: root,
      elapsedMs: elapsed,
    }
  }
}

// POST {root}/apply-template, returns the prompt string that the server
// would feed to the model when these messages are posted to /v1/chat/completions.
// Used as the 'default' text-template option: the server's own Jinja
// template is re-used instead of replicating it client-side.
export interface ApplyTemplateMessage {
  role: string
  content: string
}

export async function applyServerTemplate(
  profile: Pick<ConnectionProfile, 'baseUrl'>,
  messages: ApplyTemplateMessage[],
  opts: ProbeOptions = {},
): Promise<string> {
  const root = llamaServerRoot(profile.baseUrl)
  const url = `${root}/apply-template`
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ messages }),
  }
  const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {
    timeoutMs: opts.timeoutMs ?? 5_000,
  }
  if (opts.signal) fetchOpts.signal = opts.signal
  const response = await fetchWithTimeout(url, init, fetchOpts)
  if (!response.ok) {
    throw new Error(`apply-template failed: ${response.status} ${response.statusText}`)
  }
  const body = (await response.json()) as { prompt?: unknown }
  const prompt = asString(body.prompt)
  if (prompt === null) {
    throw new Error('apply-template returned no prompt string')
  }
  return prompt
}
