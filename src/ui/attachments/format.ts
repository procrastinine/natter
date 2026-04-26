import type { Attachment, AttachmentKind } from '../../core/types'

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = units[0]
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024
    unit = units[i] ?? unit
  }
  return value >= 10 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`
}

export function formatDate(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return 'unknown'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

export function storageLabel(attachment: Attachment): string {
  if (attachment.storage.kind === 'local-blob') return 'local'
  if (attachment.storage.kind === 'remote-url') return 'remote'
  return 'missing'
}

export function kindLabel(kind: AttachmentKind): string {
  switch (kind) {
    case 'plaintext':
      return 'text'
    case 'presentation':
      return 'slides'
    default:
      return kind
  }
}

export function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8)
}
