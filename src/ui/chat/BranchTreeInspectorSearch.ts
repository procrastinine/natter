import { findLiteralSearchRanges } from '../../core/search-query'

const MATCH_HIGHLIGHT = 'branch-tree-inspector-search-match'
const CURRENT_HIGHLIGHT = 'branch-tree-inspector-search-current'
const STYLE_ID = 'branch-tree-inspector-search-highlights'
const MAX_RENDERED_RANGES = 1_000

export interface RenderedSearchMatches {
  ranges: Range[]
  totalCount: number
}

export interface BranchTreeInspectorSearchTools {
  installSearchHighlightStyles: () => void
  renderedSearchRanges: (root: Element, query: string) => RenderedSearchMatches
  clearSearchHighlights: () => void
  paintSearchHighlights: (ranges: readonly Range[], currentIndex: number) => void
  scrollSearchRangeIntoView: (range: Range | undefined) => void
}

export function installSearchHighlightStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
::highlight(${MATCH_HIGHLIGHT}) {
  background-color: color-mix(in srgb, var(--color-warning) 48%, transparent);
}
::highlight(${CURRENT_HIGHLIGHT}) {
  background-color: var(--color-accent);
  color: var(--color-accent-contrast);
}`
  document.head.append(style)
}

export function renderedSearchRanges(root: Element, query: string): RenderedSearchMatches {
  const markdown = root.querySelector('[data-ui="markdown"]')
  if (!markdown) return { ranges: [], totalCount: 0 }
  const textNodes: Text[] = []
  const starts: number[] = []
  const textParts: string[] = []
  let visibleChars = 0
  const walker = document.createTreeWalker(markdown, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const textNode = node as Text
    if (textNode.data.length > 0) {
      starts.push(visibleChars)
      textNodes.push(textNode)
      textParts.push(textNode.data)
      visibleChars += textNode.data.length
    }
    node = walker.nextNode()
  }
  if (visibleChars === 0) return { ranges: [], totalCount: 0 }
  const visibleText = textParts.join('')

  const literalMatches = findLiteralSearchRanges(visibleText, query, MAX_RENDERED_RANGES)
  const ranges: Range[] = []
  let startNodeIndex = 0
  let endNodeIndex = 0
  for (const match of literalMatches.ranges) {
    const start = match.start
    const end = match.end
    while (
      startNodeIndex < textNodes.length - 1 &&
      (starts[startNodeIndex] ?? 0) + (textNodes[startNodeIndex]?.data.length ?? 0) <= start
    ) {
      startNodeIndex += 1
    }
    endNodeIndex = Math.max(endNodeIndex, startNodeIndex)
    while (
      endNodeIndex < textNodes.length - 1 &&
      (starts[endNodeIndex] ?? 0) + (textNodes[endNodeIndex]?.data.length ?? 0) < end
    ) {
      endNodeIndex += 1
    }
    const startNode = textNodes[startNodeIndex]
    const endNode = textNodes[endNodeIndex]
    if (startNode && endNode) {
      const range = document.createRange()
      range.setStart(startNode, start - (starts[startNodeIndex] ?? 0))
      range.setEnd(endNode, end - (starts[endNodeIndex] ?? 0))
      ranges.push(range)
    }
  }
  return { ranges, totalCount: literalMatches.totalCount }
}

export function clearSearchHighlights(): void {
  const registry = highlightRegistry()
  registry?.delete(MATCH_HIGHLIGHT)
  registry?.delete(CURRENT_HIGHLIGHT)
}

export function paintSearchHighlights(ranges: readonly Range[], currentIndex: number): void {
  const registry = highlightRegistry()
  if (!registry) return
  registry.delete(MATCH_HIGHLIGHT)
  registry.delete(CURRENT_HIGHLIGHT)
  const current = ranges[currentIndex]
  if (ranges.length > (current ? 1 : 0)) {
    const matches = new Highlight()
    for (const [index, range] of ranges.entries()) {
      if (index !== currentIndex) matches.add(range)
    }
    matches.type = 'highlight'
    registry.set(MATCH_HIGHLIGHT, matches)
  }
  if (current) {
    const currentHighlight = new Highlight()
    currentHighlight.add(current)
    currentHighlight.type = 'highlight'
    currentHighlight.priority = 1
    registry.set(CURRENT_HIGHLIGHT, currentHighlight)
  }
}

export function scrollSearchRangeIntoView(range: Range | undefined): void {
  range?.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined' || typeof Highlight === 'undefined') return null
  return CSS.highlights
}
