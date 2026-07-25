import type { ProcessAttachmentInput, ProcessAttachmentResult } from './types'

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digestInput = new globalThis.Uint8Array(bytes.length)
  digestInput.set(bytes)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function fileExtension(filename: string): string | undefined {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const lastDot = base.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === base.length - 1) return undefined
  return base.slice(lastDot + 1).toLowerCase()
}

export async function processAttachment(
  input: ProcessAttachmentInput,
): Promise<ProcessAttachmentResult> {
  const { processAttachmentLoaded } = await import('./process-runtime')
  return processAttachmentLoaded(input)
}
