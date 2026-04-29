import type { ProcessAttachmentResult } from './types'

type OpenRouterImageDetail = 'auto' | 'low' | 'high'

type OpenRouterContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: OpenRouterImageDetail } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }

interface BuildOpenRouterPartOptions {
  imageDetail?: OpenRouterImageDetail
}

interface OpenRouterFileParserPlugin {
  id: 'file-parser'
  pdf: {
    engine: 'cloudflare-ai' | 'mistral-ocr' | 'native'
  }
}

export function buildOpenRouterContentPart(
  result: ProcessAttachmentResult,
  bytes?: Uint8Array,
  options: BuildOpenRouterPartOptions = {},
): OpenRouterContentPart | undefined {
  const attachment = result.attachment
  if (attachment.storageState === 'missing') return undefined

  if (result.openRouter.contextForm === 'text-artifact') {
    const text = result.artifacts.find((artifact) => artifact.kind === 'text')?.text
    return text ? { type: 'text', text } : undefined
  }

  if (result.openRouter.contextForm === 'download-only') return undefined

  const url = sourceUrlOrDataUrl(result, bytes)
  if (!url && result.openRouter.contextForm !== 'input_audio') return undefined

  if (result.openRouter.contextForm === 'image_url') {
    if (!url) return undefined
    const imageUrl = {
      url,
      ...(options.imageDetail ? { detail: options.imageDetail } : {}),
    }
    return { type: 'image_url', image_url: imageUrl }
  }

  if (result.openRouter.contextForm === 'video_url') {
    return url ? { type: 'video_url', video_url: { url } } : undefined
  }

  if (result.openRouter.contextForm === 'file') {
    return url
      ? {
          type: 'file',
          file: {
            filename: attachment.filename,
            file_data: url,
          },
        }
      : undefined
  }

  if (result.openRouter.contextForm === 'input_audio') {
    if (!bytes) return undefined
    return {
      type: 'input_audio',
      input_audio: {
        data: base64Encode(bytes),
        format: audioFormat(attachment.mime, attachment.extension),
      },
    }
  }

  return undefined
}

export function buildOpenRouterPdfPlugin(
  result: ProcessAttachmentResult,
): OpenRouterFileParserPlugin | undefined {
  if (result.attachment.kind !== 'pdf') return undefined
  const engine = result.openRouter.pdfEngine
  return engine ? { id: 'file-parser', pdf: { engine } } : undefined
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64Encode(bytes)}`
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  let index = 0
  while (index + 2 < bytes.length) {
    const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0)
    output +=
      alphabet.charAt((chunk >> 18) & 63) +
      alphabet.charAt((chunk >> 12) & 63) +
      alphabet.charAt((chunk >> 6) & 63) +
      alphabet.charAt(chunk & 63)
    index += 3
  }
  if (index < bytes.length) {
    const byteA = bytes[index] ?? 0
    const byteB = bytes[index + 1]
    const chunk = (byteA << 16) | ((byteB ?? 0) << 8)
    output += alphabet.charAt((chunk >> 18) & 63) + alphabet.charAt((chunk >> 12) & 63)
    output += byteB === undefined ? '=' : alphabet.charAt((chunk >> 6) & 63)
    output += '='
  }
  return output
}

function sourceUrlOrDataUrl(result: ProcessAttachmentResult, bytes?: Uint8Array): string | undefined {
  const attachment = result.attachment
  if (attachment.storageState === 'remote-url' && attachment.sourceUrl) return attachment.sourceUrl
  return bytes ? dataUrl(attachment.mime, bytes) : undefined
}

function audioFormat(mime: string, extension?: string): string {
  if (extension === 'mp3' || mime === 'audio/mpeg') return 'mp3'
  if (extension === 'm4a' || mime === 'audio/mp4') return 'm4a'
  if (extension === 'wav' || mime === 'audio/wav') return 'wav'
  return extension ?? 'wav'
}
