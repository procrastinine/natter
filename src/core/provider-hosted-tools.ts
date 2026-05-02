import { isOpenAiDirectBaseUrl } from './provider-defaults'
import type {
  AnthropicServerToolId,
  ChatSettings,
  ConnectionProfile,
  GoogleServerToolId,
  OpenAiServerToolId,
  ServerToolId,
} from './types'

export type HostedToolProvider = 'openrouter' | 'openai' | 'anthropic' | 'google'

export function isOpenAiDirectProfile(profile: ConnectionProfile): boolean {
  if (profile.kind !== 'openai-compatible') return false
  return isOpenAiDirectBaseUrl(profile.baseUrl)
}

function enabledHostedToolIds(
  settings: ChatSettings,
  provider: HostedToolProvider,
): readonly string[] {
  return settings.tools[provider].enabledServerToolIds
}

export function hasEnabledHostedTools(
  settings: ChatSettings,
  provider: HostedToolProvider,
): boolean {
  return enabledHostedToolIds(settings, provider).length > 0
}

const OPENROUTER_SERVER_TOOL_TYPES: Readonly<Partial<Record<ServerToolId, string>>> = Object.freeze(
  {
    'web-search': 'openrouter:web_search',
    datetime: 'openrouter:datetime',
    'web-fetch': 'openrouter:web_fetch',
  },
)

export function buildOpenRouterServerTools(settings: ChatSettings): Array<{ type: string }> {
  const tools: Array<{ type: string }> = []
  const seen = new Set<ServerToolId>()
  for (const id of settings.tools.openrouter.enabledServerToolIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const type = OPENROUTER_SERVER_TOOL_TYPES[id]
    if (!type) continue
    tools.push({ type })
  }
  return tools
}

interface OpenAiServerToolsWire {
  tools: unknown[]
  include: string[]
}

export function buildOpenAiServerTools(settings: ChatSettings): OpenAiServerToolsWire {
  const tools: unknown[] = []
  const include: string[] = []
  const seen = new Set<OpenAiServerToolId>()
  const config = settings.tools.openai.config ?? {}
  for (const id of settings.tools.openai.enabledServerToolIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (id === 'web-search') {
      const toolConfig = config['web-search']
      const allowedDomains = sanitizedStringList(toolConfig?.allowedDomains)
      const tool: Record<string, unknown> = { type: 'web_search' }
      if (allowedDomains.length > 0) tool.filters = { allowed_domains: allowedDomains }
      if (toolConfig?.searchContextSize) tool.search_context_size = toolConfig.searchContextSize
      const location = approximateLocationWire(toolConfig?.userLocation)
      if (location) tool.user_location = location
      tools.push(tool)
      if (toolConfig?.includeSources === true) include.push('web_search_call.action.sources')
    } else if (id === 'image-generation') {
      const toolConfig = config['image-generation']
      const tool: Record<string, unknown> = { type: 'image_generation' }
      if (toolConfig?.model) tool.model = toolConfig.model
      if (toolConfig?.quality) tool.quality = toolConfig.quality
      if (toolConfig?.size) tool.size = toolConfig.size
      if (toolConfig?.format) tool.output_format = toolConfig.format
      const partialImages = integerInRange(toolConfig?.partialImages, 0, 3)
      if (partialImages !== undefined) tool.partial_images = partialImages
      tools.push(tool)
    } else if (id === 'code-interpreter') {
      tools.push({ type: 'code_interpreter', container: { type: 'auto' } })
      include.push('code_interpreter_call.outputs')
    } else {
      const toolConfig = config.shell
      const networkPolicy = toolConfig?.networkPolicy
      const environment: Record<string, unknown> = {
        type: 'container_auto',
        network_policy:
          networkPolicy?.type === 'allowlist'
            ? {
                type: 'allowlist',
                allowed_domains: sanitizedStringList(networkPolicy.allowedDomains),
              }
            : { type: 'disabled' },
      }
      tools.push({ type: 'shell', environment })
    }
  }
  return { tools, include: unique(include) }
}

export function buildGoogleServerTools(
  settings: ChatSettings,
  opts: { urlContextText?: string } = {},
): {
  tools: unknown[]
  toolConfig?: unknown
} {
  const tools: unknown[] = []
  const config = settings.tools.google.config ?? {}
  const seen = new Set<GoogleServerToolId>()
  let mapsLocation:
    | {
        latitude: number
        longitude: number
      }
    | undefined

  for (const id of settings.tools.google.enabledServerToolIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (id === 'google-search') {
      tools.push({ googleSearch: {} })
    } else if (id === 'url-context') {
      if (hasUnsafeUrlContextTarget(opts.urlContextText)) continue
      tools.push({ urlContext: {} })
    } else if (id === 'code-execution') {
      tools.push({ codeExecution: {} })
    } else {
      const maps = config['google-maps']
      tools.push({ googleMaps: { ...(maps?.enableWidget === true ? { enableWidget: true } : {}) } })
      if (maps?.location) {
        mapsLocation = {
          latitude: maps.location.latitude,
          longitude: maps.location.longitude,
        }
      }
    }
  }

  if (tools.length === 0) return { tools }
  if (mapsLocation) {
    return { tools, toolConfig: { retrievalConfig: { latLng: mapsLocation } } }
  }
  return { tools }
}

export function buildAnthropicServerTools(settings: ChatSettings): unknown[] {
  const tools: unknown[] = []
  const config = settings.tools.anthropic.config ?? {}
  const seen = new Set<AnthropicServerToolId>()

  for (const id of settings.tools.anthropic.enabledServerToolIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (id === 'web-search') {
      const web = config['web-search'] ?? {}
      const tool: Record<string, unknown> = {
        type: web.version ?? 'web_search_20250305',
        name: 'web_search',
      }
      const maxUses = integerInRange(web.maxUses, 1, 100)
      if (maxUses !== undefined) tool.max_uses = maxUses
      const allowedDomains = sanitizedStringList(web.allowedDomains)
      const blockedDomains = sanitizedStringList(web.blockedDomains)
      if (allowedDomains.length > 0) tool.allowed_domains = allowedDomains
      else if (blockedDomains.length > 0) tool.blocked_domains = blockedDomains
      const location = approximateLocationWire(web.userLocation)
      if (location) tool.user_location = location
      if (web.allowedCallers === 'direct-only') tool.allowed_callers = ['direct']
      tools.push(tool)
    } else if (id === 'web-fetch') {
      const fetch = config['web-fetch'] ?? {}
      const tool: Record<string, unknown> = {
        type: fetch.version ?? 'web_fetch_20250910',
        name: 'web_fetch',
      }
      const maxUses = integerInRange(fetch.maxUses, 1, 100)
      if (maxUses !== undefined) tool.max_uses = maxUses
      const allowedDomains = sanitizedStringList(fetch.allowedDomains)
      const blockedDomains = sanitizedStringList(fetch.blockedDomains)
      if (allowedDomains.length > 0) tool.allowed_domains = allowedDomains
      else if (blockedDomains.length > 0) tool.blocked_domains = blockedDomains
      if (fetch.citationsEnabled !== undefined) {
        tool.citations = { enabled: fetch.citationsEnabled }
      }
      const maxContentTokens = integerInRange(fetch.maxContentTokens, 1, 200_000)
      if (maxContentTokens !== undefined) tool.max_content_tokens = maxContentTokens
      if (fetch.allowedCallers === 'direct-only') tool.allowed_callers = ['direct']
      tools.push(tool)
    } else if (id === 'code-execution') {
      const code = config['code-execution'] ?? {}
      tools.push({
        type: code.version ?? 'code_execution_20250825',
        name: 'code_execution',
      })
    } else {
      if (!anthropicAdvisorAvailable(settings.model)) continue
      const advisor = config.advisor ?? { advisorModel: 'claude-opus-4-7' as const }
      tools.push({
        type: 'advisor_20260301',
        name: 'advisor',
        model: advisor.advisorModel,
      })
    }
  }

  return tools
}

function anthropicAdvisorAvailable(modelId: string): boolean {
  const normalized = modelId
    .replace(/^anthropic\//u, '')
    .replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
    .replace(/-\d{8}$/u, '')
  return new Set([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
  ]).has(normalized)
}

function approximateLocationWire(location: unknown): Record<string, string> | null {
  if (!location || typeof location !== 'object') return null
  const out: Record<string, string> = { type: 'approximate' }
  for (const key of ['country', 'region', 'city', 'timezone'] as const) {
    const value = (location as Partial<Record<typeof key, unknown>>)[key]
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim()
  }
  return Object.keys(out).length > 1 ? out : null
}

function sanitizedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function integerInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const integer = Math.trunc(value)
  if (integer < min || integer > max) return undefined
  return integer
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function hasUnsafeUrlContextTarget(text: string | undefined): boolean {
  if (!text) return false
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]}]+/giu)) {
    try {
      const url = new URL(match[0])
      if (isUnsafeUrlContextHost(url.hostname)) return true
    } catch {
      // Ignore URL-looking substrings that are not valid URLs.
    }
  }
  return false
}

function isUnsafeUrlContextHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    host.startsWith('fe80:')
  ) {
    return true
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u)
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number)
    if (parts.some((part) => part > 255)) return true
    const a = parts[0] ?? -1
    const b = parts[1] ?? -1
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  return [
    'ngrok.io',
    'ngrok-free.app',
    'ngrok.app',
    'loca.lt',
    'localtunnel.me',
    'localhost.run',
    'trycloudflare.com',
    'serveo.net',
  ].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}
