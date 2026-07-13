import { memo, useMemo } from 'react'
import type { MessageRole } from '../../core/types'
import { PersonIcon, RobotIcon } from '../icons/Icon'

const WRAP_CACHE_LIMIT = 512
const POPOVER_MAX_WIDTH = 420
const POPOVER_MIN_WIDTH = 80
const POPOVER_MAX_HEIGHT = 252

interface WrappedLine {
  key: string
  text: string
}

interface WrappedLinesCacheEntry {
  sourceText: string
  lines: WrappedLine[]
}

interface ExpandedPreviewProps {
  kind: 'expanded'
  role: MessageRole
  text: string
  width: number
  fontFamily: string
  cacheKey?: string | undefined
}

interface HoverPreviewProps {
  kind: 'hover'
  role: MessageRole
  text?: string | undefined
  failed?: boolean | undefined
  node: { x: number; y: number; width: number }
  viewport: { left: number; top: number; width: number; height: number }
  graphOffsetX: number
  fontFamily: string
}

const wrapCache = new Map<string, WrappedLinesCacheEntry>()

export const BranchTreePreview = memo(function BranchTreePreview(
  props: ExpandedPreviewProps | HoverPreviewProps,
) {
  if (props.kind === 'expanded') return <ExpandedPreview {...props} />
  return <HoverPreview {...props} />
})

function ExpandedPreview({ role, text, width, fontFamily, cacheKey }: ExpandedPreviewProps) {
  const lines = useMemo(
    () => wrappedLines(text, width - 32, 4, fontFamily, cacheKey),
    [cacheKey, fontFamily, text, width],
  )
  return (
    <g data-ui="branch-tree-node-card-content">
      <RoleMarker role={role} x={19} y={21} />
      <text data-ui="branch-tree-node-role" x={37} y={25}>
        {roleLabel(role)}
      </text>
      <text data-ui="branch-tree-node-preview" x={16} y={48}>
        {lines.map((line, index) => (
          <tspan key={line.key} x={16} dy={index === 0 ? 0 : 18}>
            {line.text}
          </tspan>
        ))}
      </text>
    </g>
  )
}

function HoverPreview({
  role,
  text,
  failed,
  node,
  viewport,
  graphOffsetX,
  fontFamily,
}: HoverPreviewProps) {
  const previewText = failed
    ? 'Preview unavailable'
    : text === undefined
      ? 'Loading preview…'
      : text.length > 0
        ? text
        : 'No text content'
  const width = Math.min(POPOVER_MAX_WIDTH, Math.max(POPOVER_MIN_WIDTH, viewport.width - 16))
  const lines = useMemo(
    () => wrappedLines(previewText, width - 32, 10, fontFamily),
    [fontFamily, previewText, width],
  )
  const height = Math.min(POPOVER_MAX_HEIGHT, 54 + Math.max(1, lines.length) * 19)
  const viewportLeft = viewport.left - graphOffsetX
  const left =
    node.x + node.width + 12 + width <= viewportLeft + viewport.width
      ? node.x + node.width + 12
      : Math.max(viewportLeft + 8, node.x - width - 12)
  const top = Math.min(
    Math.max(node.y, viewport.top + 8),
    Math.max(viewport.top + 8, viewport.top + viewport.height - height - 8),
  )
  return (
    <g data-ui="branch-tree-preview" data-role={role} transform={`translate(${left} ${top})`}>
      <rect data-ui="branch-tree-preview-surface" width={width} height={height} rx={10} />
      <text data-ui="branch-tree-preview-role" x={16} y={27}>
        {roleLabel(role)}
      </text>
      <text data-ui="branch-tree-preview-text" x={16} y={53}>
        {lines.map((line, index) => (
          <tspan key={line.key} x={16} dy={index === 0 ? 0 : 19}>
            {line.text}
          </tspan>
        ))}
      </text>
    </g>
  )
}

function wrappedLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  fontFamily: string,
  sourceKey?: string,
): WrappedLine[] {
  const key = sourceKey ? `${sourceKey}\u0000${fontFamily}\u0000${maxWidth}\u0000${maxLines}` : null
  const cached = key ? wrapCache.get(key) : undefined
  if (key && cached?.sourceText === text) {
    wrapCache.delete(key)
    wrapCache.set(key, cached)
    return cached.lines
  }
  const lines = wrapPreviewLines(text, maxWidth, maxLines, fontFamily)
  if (key) {
    wrapCache.set(key, { sourceText: text, lines })
    while (wrapCache.size > WRAP_CACHE_LIMIT) {
      const oldest = wrapCache.keys().next().value
      if (oldest === undefined) break
      wrapCache.delete(oldest)
    }
  }
  return lines
}

function wrapPreviewLines(
  text: string,
  maxWidth: number,
  maxLines: number,
  fontFamily: string,
): WrappedLine[] {
  const normalized = text.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0) return [{ key: 'empty', text: 'No text content' }]
  const characters = Array.from(normalized)
  const lines: WrappedLine[] = []
  let offset = 0
  while (offset < characters.length && lines.length < maxLines) {
    const start = offset
    let end = fittingEnd(characters, offset, maxWidth, fontFamily)
    const lastLine = lines.length === maxLines - 1
    const truncated = end < characters.length
    if (lastLine && truncated) {
      end = fittingEnd(characters, offset, maxWidth - textWidth('…', fontFamily), fontFamily)
    } else if (truncated) {
      for (let boundary = end - 1; boundary > offset; boundary -= 1) {
        if (characters[boundary] !== ' ') continue
        end = boundary
        break
      }
    }
    const line = characters.slice(offset, end).join('').trimEnd()
    lines.push({ key: `${start}:${end}`, text: `${line}${lastLine && truncated ? '…' : ''}` })
    offset = end
    while (characters[offset] === ' ') offset += 1
    if (lastLine) break
  }
  return lines
}

function fittingEnd(
  characters: readonly string[],
  start: number,
  maxWidth: number,
  fontFamily: string,
): number {
  let low = start + 1
  let high = characters.length
  let best = low
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (textWidth(characters.slice(start, middle).join(''), fontFamily) <= maxWidth) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return Math.min(characters.length, best)
}

let measureContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
let measureFont = ''

function textWidth(text: string, fontFamily: string): number {
  if (measureContext === undefined) {
    measureContext = null
    if (typeof document !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined') {
      measureContext = document.createElement('canvas').getContext('2d')
    } else if (typeof OffscreenCanvas !== 'undefined') {
      measureContext = new OffscreenCanvas(1, 1).getContext('2d')
    }
  }
  const font = `13px ${fontFamily}`
  if (measureContext && measureFont !== font) {
    measureContext.font = font
    measureFont = font
  }
  if (measureContext) return measureContext.measureText(text).width
  let width = 0
  for (const character of text) {
    if (/\s/u.test(character)) width += 3.4
    else if (/[ilI.,'`:;|!]/u.test(character)) width += 3.6
    else if (/[MW@#%&]/u.test(character)) width += 10.2
    else if ((character.codePointAt(0) ?? 0) > 0xff) width += 13
    else if (/[A-Z0-9]/u.test(character)) width += 7.5
    else width += 6.7
  }
  return width
}

function RoleMarker({ role, x, y }: { role: MessageRole; x: number; y: number }) {
  if (role === 'user' || role === 'assistant') {
    return (
      <g
        data-ui="branch-tree-role-icon"
        data-role={role}
        transform={`translate(${x - 7} ${y - 7})`}
      >
        {role === 'user' ? <PersonIcon size={14} /> : <RobotIcon size={14} />}
      </g>
    )
  }
  return (
    <rect
      data-ui="branch-tree-role-marker"
      data-role={role}
      x={x - 4.5}
      y={y - 4.5}
      width={9}
      height={9}
      rx={role === 'system' ? 2 : 0}
    />
  )
}

function roleLabel(role: MessageRole): string {
  return role.charAt(0).toLocaleUpperCase() + role.slice(1)
}
