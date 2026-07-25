export function normalizeSource(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

export function sourceFingerprint(value) {
  return fnv1a32(normalizeSource(value))
}

export function sourceLineText(source, line) {
  const starts = source.getLineStarts()
  const start = starts[line] ?? source.text.length
  const end = starts[line + 1] ?? source.text.length
  return source.text.slice(start, end).trim()
}

export function fnv1a32(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
