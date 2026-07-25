import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProfileId } from '../../core/types'
import { useConnectionManagerCatalog } from '../../hooks/useConfigurationCatalog'
import { configurationApplication } from '../../store/configuration-application'
import { interchangeApplication } from '../../store/interchange-application'
import type { ConfigurationConnectionManagerRow } from '../../store/presentation-contracts'
import { useToastStore } from '../../store/zustand/toastStore'
import { ConnectionDeleteDialog } from '../header/ConnectionDeleteDialog'
import {
  importExportErrorMessage,
  natterJsonFilename,
  readJsonFile,
  triggerJsonDownload,
} from '../import-export/json-file'
import { Button } from '../primitives/Button'

export function ConnectionsSettings() {
  const [deleteReassignTo, setDeleteReassignTo] = useState<ProfileId | null>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<ProfileId | null>(null)
  const [deleteCountOverride, setDeleteCountOverride] = useState<{
    readonly revision: number
    readonly presetCount: number
    readonly chatCount: number
  } | null>(null)
  const addressedIds = useMemo(
    () => [...new Set([deleteTargetId, deleteReassignTo].filter((id): id is ProfileId => !!id))],
    [deleteReassignTo, deleteTargetId],
  )
  const managerCatalog = useConnectionManagerCatalog(true, addressedIds)
  const managerSnapshot = managerCatalog.snapshot
  const managerPage = managerCatalog.snapshot?.page
  const rows = managerPage?.rows ?? []
  const managerRows = useMemo(
    () => [
      ...new Map(
        [
          ...rows,
          ...(managerPage?.addressedRows.flatMap((address) => (address.row ? [address.row] : [])) ??
            []),
        ].map((row) => [row.id, row]),
      ).values(),
    ],
    [managerPage?.addressedRows, rows],
  )
  const deleteRow = deleteTargetId
    ? (managerRows.find((row) => row.id === deleteTargetId) ?? null)
    : null
  const effectiveDeleteCountOverride =
    deleteCountOverride?.revision === managerSnapshot?.revision ? deleteCountOverride : null
  const deleteDependents = deleteRow
    ? effectiveDeleteCountOverride
      ? {
          presetCount: effectiveDeleteCountOverride.presetCount,
          chatCount: effectiveDeleteCountOverride.chatCount,
        }
      : { presetCount: deleteRow.presetCount, chatCount: deleteRow.chatCount }
    : null
  const interactive = managerSnapshot?.interactive === true
  const pushToast = useToastStore((state) => state.push)
  const importRef = useRef<HTMLInputElement | null>(null)
  const [busyProfileId, setBusyProfileId] = useState<ProfileId | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    if (
      deleteReassignTo !== null &&
      managerSnapshot?.status === 'ready' &&
      !managerRows.some(
        (row) => row.id === deleteReassignTo && row.id !== deleteTargetId && !row.archived,
      )
    ) {
      setDeleteReassignTo(null)
    }
  }, [deleteReassignTo, deleteTargetId, managerRows, managerSnapshot?.status])

  const runProfileAction = useCallback(
    async (row: ConfigurationConnectionManagerRow, action: () => Promise<unknown>) => {
      setBusyProfileId(row.id)
      try {
        await action()
      } catch (error) {
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      } finally {
        setBusyProfileId(null)
      }
    },
    [pushToast],
  )

  const beginDelete = useCallback((row: ConfigurationConnectionManagerRow) => {
    setDeleteTargetId(row.id)
    setDeleteCountOverride(null)
    setDeleteReassignTo(null)
    setDeleteError(null)
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteRow || !deleteDependents) return
    const hasDependents = deleteDependents.presetCount > 0 || deleteDependents.chatCount > 0
    if (hasDependents && deleteReassignTo === null) return
    setBusyProfileId(deleteRow.id)
    setDeleteError(null)
    try {
      const result = await configurationApplication.deleteConnection(
        deleteRow.id,
        deleteReassignTo === null ? {} : { reassignTo: deleteReassignTo },
      )
      if (result.kind === 'connection-delete-blocked') {
        setDeleteCountOverride({
          revision: managerSnapshot?.revision ?? -1,
          presetCount: result.presetCount,
          chatCount: result.chatCount,
        })
        return
      }
      if (result.kind !== 'connection-deleted') {
        setDeleteError('The connection could not be deleted. Nothing was changed.')
        return
      }
      setDeleteTargetId(null)
      setDeleteReassignTo(null)
      setDeleteCountOverride(null)
      pushToast({ level: 'success', text: `Deleted ${deleteRow.name}.` })
    } catch {
      setDeleteError('The connection could not be deleted. Nothing was changed.')
    } finally {
      setBusyProfileId(null)
    }
  }, [deleteDependents, deleteReassignTo, deleteRow, managerSnapshot?.revision, pushToast])

  const importFile = useCallback(
    async (file: File) => {
      setImportBusy(true)
      try {
        await interchangeApplication.importConnectionProfile(await readJsonFile(file))
        pushToast({ level: 'success', text: 'Connection imported without credentials.' })
      } catch (error) {
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      } finally {
        setImportBusy(false)
      }
    },
    [pushToast],
  )

  return (
    <section data-ui="settings-section" data-ui-section="connections">
      <div data-ui="connection-manager-toolbar">
        <h3>Connections</h3>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void importFile(file)
          }}
        />
        <Button busy={importBusy} busyLabel="Importing…" onClick={() => importRef.current?.click()}>
          Import
        </Button>
      </div>
      <div data-ui="connection-manager-list">
        {managerPage && !managerPage.atStart ? (
          <Button disabled={!interactive} onClick={managerCatalog.demandBefore}>
            Previous connections…
          </Button>
        ) : null}
        {managerSnapshot?.status === 'error' ? (
          <div data-ui="connection-manager-error">
            <span>Connections could not be refreshed.</span>
            <Button onClick={managerCatalog.refresh}>Retry</Button>
          </div>
        ) : null}
        {managerSnapshot?.interactive && managerPage?.exactCount === 0 ? (
          <div data-ui="connection-manager-empty">No connections.</div>
        ) : (
          rows.map((row) => {
            const busy = busyProfileId === row.id
            return (
              <article key={row.id} data-ui="connection-manager-row" data-archived={row.archived}>
                <div data-ui="connection-manager-identity">
                  <strong>{row.name}</strong>
                  <span>{row.kind}</span>
                </div>
                <div data-ui="connection-manager-counts">
                  <span>{row.presetCount} presets</span>
                  <span>{row.chatCount} chats</span>
                  {row.activePresetCount !== row.presetCount ||
                  row.activeChatCount !== row.chatCount ? (
                    <span>
                      {row.activePresetCount} active presets · {row.activeChatCount} active chats
                    </span>
                  ) : null}
                </div>
                <div data-ui="connection-manager-actions">
                  <Button
                    disabled={busy || !interactive}
                    onClick={() =>
                      void runProfileAction(row, () =>
                        configurationApplication.duplicateConnection(row.id),
                      )
                    }
                  >
                    Duplicate
                  </Button>
                  <Button
                    disabled={busy || !interactive}
                    onClick={() =>
                      void runProfileAction(row, () =>
                        row.archived
                          ? configurationApplication.unarchiveConnection(row.id)
                          : configurationApplication.archiveConnection(row.id),
                      )
                    }
                  >
                    {row.archived ? 'Unarchive' : 'Archive'}
                  </Button>
                  <Button
                    disabled={busy || !interactive}
                    onClick={() =>
                      void runProfileAction(row, async () => {
                        triggerJsonDownload(
                          natterJsonFilename('connection', row.name, row.id),
                          await interchangeApplication.exportConnectionProfile(row.id),
                        )
                      })
                    }
                  >
                    Export
                  </Button>
                  <Button
                    tone="danger"
                    disabled={busy || !interactive}
                    onClick={() => beginDelete(row)}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            )
          })
        )}
        {managerPage && !managerPage.atEnd ? (
          <Button disabled={!interactive} onClick={managerCatalog.demandAfter}>
            Next connections…
          </Button>
        ) : null}
      </div>
      {deleteRow ? (
        <ConnectionDeleteDialog
          profileName={deleteRow.name}
          busy={busyProfileId === deleteRow.id}
          dependents={deleteDependents}
          replacementProfiles={managerRows.filter(
            (candidate) => candidate.id !== deleteRow.id && !candidate.archived,
          )}
          hasPreviousReplacementProfiles={managerPage ? !managerPage.atStart : false}
          hasMoreReplacementProfiles={managerPage ? !managerPage.atEnd : false}
          reassignTo={deleteReassignTo}
          error={deleteError}
          onCancel={() => {
            setDeleteTargetId(null)
            setDeleteReassignTo(null)
            setDeleteCountOverride(null)
          }}
          onConfirm={confirmDelete}
          onLoadPreviousReplacementProfiles={managerCatalog.demandBefore}
          onLoadMoreReplacementProfiles={managerCatalog.demandAfter}
          onReassignTo={setDeleteReassignTo}
        />
      ) : null}
    </section>
  )
}
