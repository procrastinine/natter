import type { MessageTreeNode } from './active-path'
import type { BranchPathDescriptor, BranchPathSpan } from './branch-session'

export interface TranscriptWorkBudget {
  readonly minimumRowCount: number
  readonly textCharLimit: number
  readonly renderCostLimit: number
}

export const TRANSCRIPT_BODY_READ_BATCH_ROWS = 24
export const DEFAULT_TRANSCRIPT_INITIAL_ROW_COUNT = 10

export interface TranscriptWorkHeader {
  readonly bodyTextCharCount: number
  readonly bodyRenderCost: number
}

const DEFAULT_VIEWPORT_HEIGHT_PX = 800
const APPROXIMATE_LINE_HEIGHT_PX = 18
const VIEWPORT_OVERSCAN = 3
const WORK_SCALE_RENDER_UNITS = 12
const TEXT_CHARS_PER_RENDER_UNIT = 160

export function initialTranscriptWorkBudget(
  minimumRowCount: number,
  viewportHeightPx = DEFAULT_VIEWPORT_HEIGHT_PX,
): TranscriptWorkBudget {
  const normalizedMinimumRowCount = positiveInteger(minimumRowCount, 1)
  const normalizedViewport = positiveInteger(viewportHeightPx, DEFAULT_VIEWPORT_HEIGHT_PX)
  const viewportUnits =
    Math.ceil(normalizedViewport / APPROXIMATE_LINE_HEIGHT_PX) * VIEWPORT_OVERSCAN
  const renderCostLimit = Math.max(
    viewportUnits,
    normalizedMinimumRowCount * WORK_SCALE_RENDER_UNITS,
  )
  return Object.freeze({
    minimumRowCount: normalizedMinimumRowCount,
    textCharLimit: renderCostLimit * TEXT_CHARS_PER_RENDER_UNIT,
    renderCostLimit,
  })
}

export function transcriptRowFloorBudget(minimumRowCount: number): TranscriptWorkBudget {
  return Object.freeze({
    minimumRowCount: positiveInteger(minimumRowCount, 1),
    textCharLimit: 0,
    renderCostLimit: 0,
  })
}

export function growTranscriptWorkBudget(budget: TranscriptWorkBudget): TranscriptWorkBudget {
  return Object.freeze({
    minimumRowCount: saturatingDouble(budget.minimumRowCount),
    textCharLimit: saturatingDouble(budget.textCharLimit),
    renderCostLimit: saturatingDouble(budget.renderCostLimit),
  })
}

export function transcriptTailSpan<T extends MessageTreeNode & TranscriptWorkHeader>(
  path: BranchPathDescriptor<T>,
  budget: TranscriptWorkBudget,
): BranchPathSpan {
  if (path.length === 0) {
    return { branchLength: 0, offset: 0, limit: 0, boundaryParentId: null }
  }
  let work = { textChars: 0, renderCost: 0, rowCount: 0 }
  return path.tailSpanWhile((header) => {
    if (!transcriptTailFitsAdditionalHeader(work, header, budget)) return false
    work = addTranscriptHeaderWork(work, header)
    return true
  })
}

function transcriptTailFitsAdditionalHeader(
  current: { readonly textChars: number; readonly renderCost: number; readonly rowCount: number },
  header: TranscriptWorkHeader,
  budget: TranscriptWorkBudget,
): boolean {
  if (current.rowCount === 0) return true
  if (current.rowCount < positiveInteger(budget.minimumRowCount, 1)) return true
  return (
    current.textChars + nonNegativeInteger(header.bodyTextCharCount) <= budget.textCharLimit &&
    current.renderCost + Math.max(1, nonNegativeInteger(header.bodyRenderCost)) <=
      budget.renderCostLimit
  )
}

function addTranscriptHeaderWork(
  current: { readonly textChars: number; readonly renderCost: number; readonly rowCount: number },
  header: TranscriptWorkHeader,
): { readonly textChars: number; readonly renderCost: number; readonly rowCount: number } {
  return {
    textChars: current.textChars + nonNegativeInteger(header.bodyTextCharCount),
    renderCost: current.renderCost + Math.max(1, nonNegativeInteger(header.bodyRenderCost)),
    rowCount: current.rowCount + 1,
  }
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function saturatingDouble(value: number): number {
  return value >= Number.MAX_SAFE_INTEGER / 2 ? Number.MAX_SAFE_INTEGER : value * 2
}
