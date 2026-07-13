const REDACTED = '<redacted>'
const MAX_DEPTH = 5
const MAX_ARRAY_ITEMS = 12
const MAX_OBJECT_KEYS = 24
const MAX_STRING_CHARS = 160

const SENSITIVE_KEYS = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'keydraft',
  'password',
  'passwd',
  'plaintextkey',
  'privatekey',
  'proxyauthorization',
  'setcookie',
  'token',
])

export function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.includes('apikey') ||
    normalized.includes('authorization') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('cookie') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('authtoken') ||
    normalized.endsWith('bearertoken') ||
    normalized.endsWith('idtoken') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('sessiontoken') ||
    normalized.endsWith('securitytoken')
  )
}

export function redactDiagnosticValue(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>())
}

export function malformedStreamFrameDiagnostic(
  eventType: string | undefined,
  data: string,
  error: unknown,
): Record<string, unknown> {
  return {
    eventType: eventType ?? 'message',
    characterCount: data.length,
    fingerprint: fingerprintText(data),
    error: redactDiagnosticValue(error),
  }
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return compactString(value)
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
  seen.add(value)

  if (value instanceof Error) {
    const result: Record<string, unknown> = { name: value.name || 'Error' }
    if (value.cause !== undefined) result.cause = redactValue(value.cause, depth + 1, seen)
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = isSensitiveDiagnosticKey(key) ? REDACTED : redactValue(entry, depth + 1, seen)
    }
    return result
  }

  if (Array.isArray(value)) {
    const result = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => redactValue(entry, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`)
    return result
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
    result[key] = isSensitiveDiagnosticKey(key) ? REDACTED : redactValue(entry, depth + 1, seen)
  }
  if (entries.length > MAX_OBJECT_KEYS) result.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
  return result
}

function compactString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value
  return `${value.slice(0, MAX_STRING_CHARS)}…<${value.length} chars>`
}

function fingerprintText(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
