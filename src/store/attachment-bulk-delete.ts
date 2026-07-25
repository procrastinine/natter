import type { AttachmentId } from '../core/types'
import type { AttachmentCatalogRow, AttachmentCatalogSearchRequest } from './repository'
import type { AttachmentDeleteManyResult } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead, type WorkspaceReadPermit } from './workspace-runtime'

const BULK_DELETE_PAGE_SIZE = 400
const BULK_DELETE_COMMAND_SIZE = 100

type AttachmentBulkDeleteSearch = Omit<
  AttachmentCatalogSearchRequest,
  'cursor' | 'direction' | 'limit'
>

interface AttachmentBulkDeleteUpperBound {
  readonly createdAt: number
  readonly attachmentId: AttachmentId
}

export interface AttachmentBulkDeletePlan {
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly search: AttachmentBulkDeleteSearch
  readonly matchedCount: number
  readonly catalogRevision: number
  readonly scanPageBudget: number
  readonly upperBound?: AttachmentBulkDeleteUpperBound
}

export interface AttachmentBulkDeleteProgress {
  readonly planned: number
  readonly processed: number
  readonly deleted: number
  readonly stubbed: number
  readonly absent: number
  readonly done: boolean
}

export interface AttachmentBulkDeleteResult extends AttachmentBulkDeleteProgress {
  readonly selectedDisposition?: 'deleted' | 'stubbed' | 'absent' | 'unchanged'
}

export async function planAttachmentBulkDelete(
  search: AttachmentBulkDeleteSearch,
  signal?: AbortSignal,
): Promise<AttachmentBulkDeletePlan> {
  const normalizedSearch = normalizeSearch(search)
  return runWorkspaceRead(
    'repository-query',
    async (permit) => {
      let page = await readPage(permit, normalizedSearch, undefined)
      const catalogRevision = page.catalogRevision
      const scanPageBudget = Math.ceil(page.catalogTotalCount / BULK_DELETE_PAGE_SIZE) + 1
      let cursor: string | undefined
      let matchedCount = 0
      let upperBound: AttachmentBulkDeleteUpperBound | undefined
      for (let pageIndex = 0; pageIndex < scanPageBudget; pageIndex += 1) {
        if (page.catalogRevision !== catalogRevision) {
          throw new Error('AttachmentBulkDeletePlanStale')
        }
        matchedCount += page.rows.length
        const last = page.rows.at(-1)
        if (last) upperBound = { createdAt: last.createdAt, attachmentId: last.id }
        if (!page.nextCursor) {
          return Object.freeze({
            workspaceId: permit.workspaceId,
            replacementEpoch: permit.replacementEpoch,
            search: normalizedSearch,
            matchedCount,
            catalogRevision,
            scanPageBudget,
            ...(upperBound ? { upperBound: Object.freeze(upperBound) } : {}),
          })
        }
        if (page.nextCursor === cursor) throw new Error('AttachmentBulkDeleteCursorDidNotAdvance')
        cursor = page.nextCursor
        page = await readPage(permit, normalizedSearch, cursor)
      }
      throw new Error('AttachmentBulkDeletePlanPageBudgetExceeded')
    },
    signal ? { signal } : {},
  )
}

export async function executeAttachmentBulkDelete(
  plan: AttachmentBulkDeletePlan,
  options: {
    readonly signal?: AbortSignal
    readonly selectedAttachmentId?: AttachmentId
    readonly onProgress?: (progress: AttachmentBulkDeleteProgress) => void
    readonly now?: number
  } = {},
): Promise<AttachmentBulkDeleteResult> {
  const now = options.now ?? Date.now()
  return runWorkspaceAction(
    'attachment',
    async (permit) => {
      if (
        permit.workspaceId !== plan.workspaceId ||
        permit.replacementEpoch !== plan.replacementEpoch
      ) {
        throw new Error('AttachmentBulkDeletePlanStale')
      }
      let cursor: string | undefined
      let processed = 0
      let deleted = 0
      let stubbed = 0
      let absent = 0
      let expectedCatalogRevision = plan.catalogRevision
      let selectedDisposition: AttachmentBulkDeleteResult['selectedDisposition'] =
        options.selectedAttachmentId ? 'unchanged' : undefined
      const publish = (done: boolean) => {
        const progress = Object.freeze({
          planned: plan.matchedCount,
          processed,
          deleted,
          stubbed,
          absent,
          done,
        })
        options.onProgress?.(progress)
        return progress
      }
      const upperBound = plan.upperBound
      if (!upperBound) {
        const progress = publish(true)
        return { ...progress, ...(selectedDisposition ? { selectedDisposition } : {}) }
      }
      publish(false)
      let complete = false
      for (let pageIndex = 0; pageIndex < plan.scanPageBudget; pageIndex += 1) {
        throwIfAborted(permit.signal)
        const page = await readPage(permit, plan.search, cursor)
        if (page.catalogRevision !== expectedCatalogRevision) {
          throw new Error('AttachmentBulkDeletePlanStale')
        }
        const candidates = page.rows.filter((row) => atOrBefore(row, upperBound))
        for (let index = 0; index < candidates.length; index += BULK_DELETE_COMMAND_SIZE) {
          throwIfAborted(permit.signal)
          const attachmentIds = candidates
            .slice(index, index + BULK_DELETE_COMMAND_SIZE)
            .map((row) => row.id)
          const commit = await getWorkspaceRepository().execute(permit, {
            kind: 'attachment.delete-many',
            input: {
              attachmentIds,
              expectedCatalogRevision,
              reason: 'deleted',
              now,
            },
          })
          const result = commit.value
          expectedCatalogRevision = result.catalogRevision
          processed += attachmentIds.length
          deleted += result.deletedAttachmentIds.length
          stubbed += result.stubbedAttachmentIds.length
          absent += result.absentAttachmentIds.length
          selectedDisposition = selectedResult(
            options.selectedAttachmentId,
            selectedDisposition,
            result,
          )
          publish(false)
        }
        const reachedUpperBound =
          page.rows.length > candidates.length ||
          candidates.some((row) => sameBoundary(row, upperBound))
        if (reachedUpperBound || !page.nextCursor) {
          complete = true
          break
        }
        if (page.nextCursor === cursor) throw new Error('AttachmentBulkDeleteCursorDidNotAdvance')
        cursor = page.nextCursor
      }
      if (!complete) throw new Error('AttachmentBulkDeleteExecutionPageBudgetExceeded')
      const progress = publish(true)
      return { ...progress, ...(selectedDisposition ? { selectedDisposition } : {}) }
    },
    options.signal ? { signal: options.signal } : {},
  )
}

function normalizeSearch(search: AttachmentBulkDeleteSearch): AttachmentBulkDeleteSearch {
  const query = search.query?.trim()
  return Object.freeze({
    ...(query ? { query } : {}),
    ...(search.filters ? { filters: Object.freeze({ ...search.filters }) } : {}),
    sort: 'created-asc',
  })
}

async function readPage(
  permit: WorkspaceReadPermit,
  search: AttachmentBulkDeleteSearch,
  cursor: string | undefined,
) {
  return getWorkspaceRepository()
    .query(
      permit,
      {
        kind: 'attachment.catalog-page',
        search: {
          ...search,
          limit: BULK_DELETE_PAGE_SIZE,
          direction: 'forward',
          ...(cursor ? { cursor } : {}),
        },
      },
      { signal: permit.signal },
    )
    .then((envelope) => envelope.value)
}

function atOrBefore(
  row: AttachmentCatalogRow,
  upperBound: AttachmentBulkDeleteUpperBound,
): boolean {
  return (
    row.createdAt < upperBound.createdAt ||
    (row.createdAt === upperBound.createdAt && row.id.localeCompare(upperBound.attachmentId) <= 0)
  )
}

function sameBoundary(
  row: AttachmentCatalogRow,
  upperBound: AttachmentBulkDeleteUpperBound,
): boolean {
  return row.createdAt === upperBound.createdAt && row.id === upperBound.attachmentId
}

function selectedResult(
  selectedAttachmentId: AttachmentId | undefined,
  current: AttachmentBulkDeleteResult['selectedDisposition'],
  result: AttachmentDeleteManyResult,
): AttachmentBulkDeleteResult['selectedDisposition'] {
  if (!selectedAttachmentId) return undefined
  if (result.deletedAttachmentIds.includes(selectedAttachmentId)) return 'deleted'
  if (result.stubbedAttachmentIds.includes(selectedAttachmentId)) return 'stubbed'
  if (result.absentAttachmentIds.includes(selectedAttachmentId)) return 'absent'
  return current
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw signal.reason ?? new DOMException('Attachment bulk delete aborted', 'AbortError')
}
