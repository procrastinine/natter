// Inline `<think>`/`<thought>` tag lifter for chat-completions content streams.
// See `plan/05-transforms-and-quirks.md §5.2` ("Inline <think>/<thought>").
//
// Some thinking models emit their chain-of-thought inline in `delta.content`
// rather than via `reasoning_details[]`. DeepSeek-R1 / Qwen3 / Gemma-3 are
// the canonical cases; newer thinking models (Kimi K2 Thinking, GLM-4.x
// thinking, MiniMax, etc.) follow the same pattern. Rather than hardcode a
// registry of every thinking model, this lifter:
//
//   1. Scans the FIRST emitted content chunk for a leading `<think>` /
//      `<thought>` tag (optionally preceded by whitespace). If found,
//      activates reasoning-lift mode for the rest of the stream.
//   2. While in reasoning mode, emits text as `{kind:'reasoning'}` so the
//      splitter routes it to the reasoning lane. Partial close-tags are
//      held back across chunks so we never ship a broken `</think>`
//      through the lane.
//   3. On close-tag, flips back to content mode.
//
// This "auto-detect-at-start" heuristic covers every generic thinking model
// without a per-model registry, while avoiding false positives for regular
// models that merely quote `<think>` somewhere in the middle of a response.
// When the caller knows the exact tag set (via the quirks registry's
// `reasoningInlineTags`), passing `tags` explicitly bypasses auto-detect
// and always lifts.

const DEFAULT_TAGS: readonly string[] = Object.freeze(['think', 'thought'])

export interface InlineReasoningEvent {
  kind: 'text' | 'reasoning'
  text: string
}

export interface InlineReasoningLifterOptions {
  // Tag set to look for. Defaults to ['think', 'thought'] — covers every
  // generic thinking model we know about. Pass an empty array to disable
  // the lifter entirely.
  tags?: readonly string[]
  // When `true` (default), the lifter only activates if the first content
  // chunk begins with a known open tag (after optional whitespace).
  // When `false`, the lifter is always active — suitable for models where
  // the quirks registry has explicitly said "this model uses inline tags".
  autoDetect?: boolean
}

export interface InlineReasoningLifter {
  // Feed incoming content text. Returns zero or more labeled events.
  // Partial tags may be held back until the next call.
  feed(text: string): InlineReasoningEvent[]
  // Flush any buffered text at end-of-stream. Returns one final event
  // (or none if the buffer is empty). When still inside a `<think>` block
  // at end-of-stream (model truncated), the partial contents are flushed
  // as reasoning — matches the plan's "open mid-stream renders to reasoning
  // lane" rule.
  finish(): InlineReasoningEvent[]
}

export function createInlineReasoningLifter(
  opts: InlineReasoningLifterOptions = {},
): InlineReasoningLifter {
  const tags = opts.tags ?? DEFAULT_TAGS
  const autoDetect = opts.autoDetect ?? true
  // Empty tag list disables the lifter — pass-through mode.
  const disabled = tags.length === 0

  type Mode = 'undecided' | 'content' | 'reasoning'
  let mode: Mode = disabled ? 'content' : autoDetect ? 'undecided' : 'content'
  let buffer = ''
  let activeTag: string | null = null

  const maxOpenTagLen = Math.max(...tags.map((t) => t.length + 2), 2)

  function feed(text: string): InlineReasoningEvent[] {
    if (disabled) return text.length > 0 ? [{ kind: 'text', text }] : []
    buffer += text
    const out: InlineReasoningEvent[] = []

    while (true) {
      if (mode === 'undecided') {
        const result = tryUndecided()
        if (result.wait) return out
        if (result.consumed) continue
        return out
      }
      if (mode === 'content') {
        // Look for an open tag mid-content (lifter is explicit / non-auto).
        if (!autoDetect) {
          const openIdx = findOpenTag(buffer, tags)
          if (openIdx.index >= 0) {
            if (openIdx.index > 0) {
              out.push({ kind: 'text', text: buffer.slice(0, openIdx.index) })
            }
            buffer = buffer.slice(openIdx.index + openIdx.tagLen)
            mode = 'reasoning'
            activeTag = openIdx.tag
            continue
          }
          // No complete tag but a partial tag suffix might be open — hold back.
          const safeLen = findSafeContentPrefixLen(buffer, tags)
          if (safeLen > 0) {
            out.push({ kind: 'text', text: buffer.slice(0, safeLen) })
            buffer = buffer.slice(safeLen)
          }
          return out
        }
        if (buffer.length > 0) {
          out.push({ kind: 'text', text: buffer })
          buffer = ''
        }
        return out
      }
      if (mode === 'reasoning') {
        const closeTag = `</${activeTag}>`
        const closeIdx = buffer.indexOf(closeTag)
        if (closeIdx >= 0) {
          if (closeIdx > 0) {
            out.push({ kind: 'reasoning', text: buffer.slice(0, closeIdx) })
          }
          buffer = buffer.slice(closeIdx + closeTag.length)
          mode = 'content'
          activeTag = null
          continue
        }
        const safeLen = findSafeReasoningPrefixLen(buffer, closeTag)
        if (safeLen > 0) {
          out.push({ kind: 'reasoning', text: buffer.slice(0, safeLen) })
          buffer = buffer.slice(safeLen)
        }
        return out
      }
    }
  }

  function tryUndecided(): { wait: boolean; consumed: boolean } {
    const stripped = buffer.trimStart()
    if (stripped.length === 0) return { wait: true, consumed: false }
    for (const tag of tags) {
      const openTag = `<${tag}>`
      if (stripped.startsWith(openTag)) {
        buffer = stripped.slice(openTag.length)
        mode = 'reasoning'
        activeTag = tag
        return { wait: false, consumed: true }
      }
    }
    if (stripped[0] !== '<') {
      mode = 'content'
      return { wait: false, consumed: true }
    }
    if (stripped.length < maxOpenTagLen && couldBePartialOpenTag(stripped, tags)) {
      return { wait: true, consumed: false }
    }
    mode = 'content'
    return { wait: false, consumed: true }
  }

  function finish(): InlineReasoningEvent[] {
    if (buffer.length === 0) return []
    const flush: InlineReasoningEvent[] = [
      {
        kind: mode === 'reasoning' ? 'reasoning' : 'text',
        text: buffer,
      },
    ]
    buffer = ''
    return flush
  }

  return { feed, finish }
}

function couldBePartialOpenTag(prefix: string, tags: readonly string[]): boolean {
  if (!prefix.startsWith('<')) return false
  for (const tag of tags) {
    const full = `<${tag}>`
    if (full.startsWith(prefix)) return true
  }
  return false
}

interface OpenTagHit {
  index: number
  tag: string
  tagLen: number
}

function findOpenTag(buffer: string, tags: readonly string[]): OpenTagHit {
  let best: OpenTagHit = { index: -1, tag: '', tagLen: 0 }
  for (const tag of tags) {
    const full = `<${tag}>`
    const idx = buffer.indexOf(full)
    if (idx >= 0 && (best.index < 0 || idx < best.index)) {
      best = { index: idx, tag, tagLen: full.length }
    }
  }
  return best
}

function findSafeContentPrefixLen(buffer: string, tags: readonly string[]): number {
  // Hold back any suffix that could still be the start of a `<tag>` open.
  const maxHoldBack = Math.max(...tags.map((t) => t.length + 2), 2)
  for (let hb = Math.min(maxHoldBack, buffer.length); hb > 0; hb -= 1) {
    const tail = buffer.slice(buffer.length - hb)
    if (tail.startsWith('<') && couldBePartialOpenTag(tail, tags)) {
      return buffer.length - hb
    }
  }
  return buffer.length
}

function findSafeReasoningPrefixLen(buffer: string, closeTag: string): number {
  for (let hb = closeTag.length - 1; hb > 0; hb -= 1) {
    if (buffer.length < hb) continue
    const tail = buffer.slice(buffer.length - hb)
    if (closeTag.startsWith(tail)) return buffer.length - hb
  }
  return buffer.length
}
