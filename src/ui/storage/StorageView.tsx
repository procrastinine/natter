import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type ChangeEvent,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  attachmentMutationTarget,
  definePresentationInteraction,
} from '../../app/presentation-interactions'
import type { StorageRoute } from '../../app/router'
import {
  attachmentHref,
  beginRouteIntent,
  cancelRouteIntent,
  chatHref,
  isRouteIntentCurrent,
  makeAnchorClickHandler,
  navigate,
  navigateForIntent,
  storageHref,
} from '../../app/router'
import { isWorkspaceReplacementRecoveryRequiredError } from '../../core/import-export/errors'
import type {
  AttachmentBlob,
  AttachmentId,
  AttachmentKind,
  ChatId,
  ChatSidebarRow,
  MessageId,
} from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import {
  useArchiveCatalogApplication,
  useAttachmentManagerCatalogApplication,
  useStorageOverviewCatalogApplication,
} from '../../hooks/useStorageCatalogApplication'
import type {
  AttachmentCatalogRow,
  AttachmentManagerDetail,
  AttachmentReferenceRow,
  PreparedAttachmentBundle,
  QuotaSnapshot,
  StorageGlobalCalibrationModel,
  StorageProbeState,
  StorageProbeStatus,
} from '../../store/presentation-contracts'
import {
  probePersisted,
  probePersistRequest,
  probeQuota,
  requestNotificationPermissionForStoragePersistence,
  storagePersistenceAvailable,
  storagePersistenceNotificationMayHelp,
} from '../../store/quota'
import { storageApplication } from '../../store/storage-application'
import { useToastStore } from '../../store/zustand/toastStore'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { AttachmentPreview } from '../attachments/AttachmentPreview'
import {
  type AttachmentDisplayRow,
  formatBytes,
  formatDate,
  kindLabel,
  shortId,
  storageLabel,
} from '../attachments/format'
import {
  ArchiveIcon,
  CloseIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  MessageSquareIcon,
  SearchIcon,
  SidebarIcon,
  TrashIcon,
  UnarchiveIcon,
  UploadIcon,
} from '../icons/Icon'
import { triggerBrowserBlobDownload } from '../import-export/chat-download'
import {
  importExportErrorMessage,
  jsonDocumentBlob,
  natterJsonFilename,
  readJsonFile,
} from '../import-export/json-file'
import { Button, IconButton } from '../primitives/Button'
import { ConfirmDialog } from '../primitives/ConfirmDialog'
import { useVirtualSpacerHeight } from '../primitives/virtual-spacer'

import {
  displayChatTitle,
  formatCalibrationRatio,
  formatInteger,
  permanentDeleteBlockedMessage,
  pluralize,
} from './storage-surface-shared'

const loadStorageChatsSurface = () => import('./StorageChatsSurface')
const ChatsStorageSurface = lazy(loadStorageChatsSurface)

const storageCalibrationInteraction = definePresentationInteraction<'workspace'>({
  id: 'storage-calibration.clear',
  label: 'Clear token calibration',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
  pendingMessage: 'Another calibration update is already in progress.',
})

const storageArchiveInteraction = definePresentationInteraction<'archive'>({
  id: 'storage-archive.mutate',
  label: 'Archive update',
  concurrency: 'reject',
  lifetime: 'workspace-tab',
  pendingMessage: 'Another archive update is already in progress.',
  describeFailure: (error) => {
    const blocked = permanentDeleteBlockedMessage(error)
    if (blocked) return { message: blocked, tone: 'warning' }
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { message: `Archive update failed: ${message}`, tone: 'danger' }
  },
})

interface StorageViewProps {
  route: StorageRoute
  onOpenSidebar: () => void
}

type ManagerFilter =
  | 'all'
  | 'missing'
  | 'unreferenced'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'document'
  | 'remote'
  | 'generated'

const FILTERS: ManagerFilter[] = [
  'all',
  'missing',
  'unreferenced',
  'image',
  'pdf',
  'audio',
  'video',
  'document',
  'remote',
  'generated',
]

const STORAGE_USAGE_DETAIL_LABELS: Record<string, string> = {
  caches: 'Cache API',
  fileSystem: 'Origin file system',
  indexedDB: 'IndexedDB',
  serviceWorkerRegistrations: 'Service workers',
}

export function StorageView({ route, onOpenSidebar }: StorageViewProps) {
  const section = route.section === 'backups' ? 'overview' : route.section
  const renderedRoute = useDeferredValue(route)
  const renderedSection = renderedRoute.section === 'backups' ? 'overview' : renderedRoute.section
  return (
    <main data-ui="storage-view">
      <header data-ui="storage-header">
        <IconButton
          type="button"
          data-ui="icon-button"
          data-role="mobile-sidebar-toggle"
          aria-label="Open sidebar"
          onClick={onOpenSidebar}
        >
          <SidebarIcon size={17} />
        </IconButton>
        <span data-ui="storage-title">
          <DatabaseIcon size={18} />
          Storage
        </span>
        <nav data-ui="storage-nav" aria-label="Storage sections">
          <a
            href={storageHref()}
            onClick={makeAnchorClickHandler(storageHref())}
            aria-current={section === 'overview' ? 'page' : undefined}
            aria-label="Overview"
            title="Overview"
          >
            <DatabaseIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'chats' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'chats' }))}
            onPointerEnter={() => void loadStorageChatsSurface()}
            onPointerDown={() => void loadStorageChatsSurface()}
            onFocus={() => void loadStorageChatsSurface()}
            aria-current={section === 'chats' ? 'page' : undefined}
            aria-label="Chats"
            title="Chats"
          >
            <MessageSquareIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'archive' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'archive' }))}
            aria-current={section === 'archive' ? 'page' : undefined}
            aria-label="Archive"
            title="Archive"
          >
            <ArchiveIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'attachments' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'attachments' }))}
            aria-current={section === 'attachments' ? 'page' : undefined}
            aria-label="Attachments"
            title="Attachments"
          >
            <FileIcon size={15} />
          </a>
        </nav>
      </header>
      <Suspense fallback={<section data-ui="storage-surface-loading" aria-busy="true" />}>
        {renderedSection === 'overview' ? <StorageOverview /> : null}
        {renderedSection === 'chats' ? <ChatsStorageSurface /> : null}
        {renderedSection === 'attachments' && renderedRoute.section === 'attachments' ? (
          <AttachmentManager route={renderedRoute} />
        ) : null}
        {renderedSection === 'archive' ? <ArchiveManager /> : null}
      </Suspense>
    </main>
  )
}

function StorageOverview() {
  const pushToast = useToastStore((s) => s.push)
  const {
    chats: chatAggregate,
    attachments: attachmentAggregate,
    calibration,
    workspace: workspaceMeta,
  } = useStorageOverviewCatalogApplication()
  const [quotaProbe, setQuotaProbe] = useState<StorageProbeState<QuotaSnapshot>>({
    status: 'checking',
  })
  const [persistenceProbe, setPersistenceProbe] = useState<StorageProbeState<boolean>>({
    status: 'checking',
  })
  const [persistenceRequestResult, setPersistenceRequestResult] = useState<
    'granted' | 'denied' | null
  >(null)
  const [persistenceBusy, setPersistenceBusy] = useState(false)
  const [workspaceTransferBusy, setWorkspaceTransferBusy] = useState<
    'export' | 'import' | 'clear' | null
  >(null)
  const [workspaceRecoveryRequired, setWorkspaceRecoveryRequired] = useState(false)
  const [workspaceExportConfirmOpen, setWorkspaceExportConfirmOpen] = useState(false)
  const workspaceImportInputRef = useRef<HTMLInputElement | null>(null)
  const workspaceBackendKind = workspaceMeta?.backendKind
  const isIndexedDbMode = workspaceBackendKind === 'browser-idb'
  useEffect(() => {
    if (!workspaceBackendKind) {
      setQuotaProbe({ status: 'checking' })
      setPersistenceProbe({ status: 'checking' })
      return
    }
    if (!isIndexedDbMode) {
      setQuotaProbe({ status: 'unavailable' })
      setPersistenceProbe({ status: 'unavailable' })
      setPersistenceRequestResult(null)
      return
    }
    let active = true
    setQuotaProbe({ status: 'checking' })
    setPersistenceProbe({ status: 'checking' })
    void probeQuota().then((result) => {
      if (active) setQuotaProbe(result)
    })
    void probePersisted().then((result) => {
      if (active) setPersistenceProbe(result)
    })
    return () => {
      active = false
    }
  }, [isIndexedDbMode, workspaceBackendKind])
  const handleRequestPersistence = async () => {
    if (!isIndexedDbMode) {
      setPersistenceProbe({ status: 'unavailable' })
      setPersistenceRequestResult(null)
      return
    }
    if (!storagePersistenceAvailable()) {
      setPersistenceProbe({ status: 'unavailable' })
      setPersistenceRequestResult(null)
      return
    }
    setPersistenceBusy(true)
    setPersistenceProbe({ status: 'checking' })
    setPersistenceRequestResult(null)
    try {
      await requestNotificationPermissionForStoragePersistence()
      const requestResult = await probePersistRequest()
      const persistedResult =
        requestResult.status === 'ready' && requestResult.value
          ? requestResult
          : await probePersisted()
      const finalResult =
        requestResult.status === 'ready' && requestResult.value
          ? requestResult
          : persistedResult.status === 'ready' && persistedResult.value
            ? persistedResult
            : requestResult.status === 'ready' && persistedResult.status === 'ready'
              ? requestResult
              : requestResult.status !== 'ready'
                ? requestResult
                : persistedResult
      setPersistenceProbe(finalResult)
      if (finalResult.status === 'ready' && finalResult.value) {
        setPersistenceRequestResult('granted')
        console.info('Natter storage persistence granted for this origin.')
        pushToast({ level: 'success', text: 'Storage persistence granted.' })
      } else if (finalResult.status === 'ready') {
        setPersistenceRequestResult('denied')
        console.warn(
          'Natter storage persistence denied by the browser. Chromium grants this only for origins it considers important, such as installed, bookmarked, notification-permitted, or high-engagement sites.',
        )
        pushToast({ level: 'warning', text: 'Browser denied storage persistence.' })
      } else {
        pushToast({ level: 'warning', text: 'Storage persistence status unavailable.' })
      }
      setQuotaProbe({ status: 'checking' })
      void probeQuota().then(setQuotaProbe)
    } finally {
      setPersistenceBusy(false)
    }
  }
  const handleExportWorkspace = async () => {
    setWorkspaceTransferBusy('export')
    try {
      const blob = await storageApplication.transfer.exportWorkspaceDocument(jsonDocumentBlob)
      triggerBrowserBlobDownload(natterJsonFilename('workspace-backup'), blob)
      setWorkspaceExportConfirmOpen(false)
      pushToast({ level: 'success', text: 'Exported workspace backup.', durationMs: 2500 })
    } catch (error) {
      console.error('Failed to export workspace backup', error)
      pushToast({
        level: 'danger',
        text: importExportErrorMessage(error),
      })
    } finally {
      setWorkspaceTransferBusy(null)
    }
  }
  const handleImportWorkspaceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0] ?? null
    input.value = ''
    if (!file) return
    if (
      !window.confirm(
        'Importing this backup replaces all local chats, presets, connections, keys, and attachments. Continue?',
      )
    ) {
      return
    }
    const routeIntent = beginRouteIntent()
    setWorkspaceTransferBusy('import')
    try {
      const value = await readJsonFile(file)
      const result = await storageApplication.transfer.restoreWorkspace(value)
      pushToast({
        level: 'success',
        text: `Imported workspace backup (${result.chatCount} chats).`,
        durationMs: 3000,
      })
      navigateForIntent(routeIntent, storageHref())
    } catch (error) {
      console.error('Failed to import workspace backup', error)
      if (isWorkspaceReplacementRecoveryRequiredError(error)) {
        setWorkspaceRecoveryRequired(true)
      }
      pushToast({
        level: 'danger',
        text: importExportErrorMessage(error),
      })
    } finally {
      cancelRouteIntent(routeIntent)
      setWorkspaceTransferBusy(null)
    }
  }
  const handleClearWorkspace = async () => {
    if (
      !window.confirm(
        'Clear all local Natter data for this browser origin? This removes chats, presets, connections, keys, attachments, databases, storage buckets, origin-private files, local storage, caches, cookies, and service workers, then reloads.',
      )
    ) {
      return
    }
    setWorkspaceTransferBusy('clear')
    try {
      await storageApplication.storage.clearAll()
    } catch (error) {
      console.error('Failed to clear local workspace data', error)
      pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      setWorkspaceTransferBusy(null)
    }
  }
  const quota = quotaProbe.status === 'ready' ? quotaProbe.value : null
  const spaceValue =
    quotaProbe.status === 'ready'
      ? `${formatBytes(quotaProbe.value.usage)} / ${formatBytes(quotaProbe.value.quota)}`
      : quotaProbe.status === 'checking'
        ? 'Checking'
        : 'Unavailable'
  const spaceDetail =
    quotaProbe.status === 'error'
      ? quotaProbe.reason === 'timeout'
        ? 'Browser probe timed out'
        : 'Browser probe failed'
      : quotaProbe.status === 'unavailable'
        ? 'Storage estimate API unavailable'
        : 'Browser-reported usage / quota'
  const persistenceValue =
    persistenceRequestResult === 'denied'
      ? 'Denied'
      : persistenceProbe.status === 'ready'
        ? persistenceProbe.value
          ? 'Persistent'
          : 'Best effort'
        : persistenceProbe.status === 'unavailable'
          ? 'Unsupported'
          : persistenceProbe.status === 'error'
            ? 'Unavailable'
            : 'Checking'
  let persistenceDetail: string | undefined
  if (persistenceRequestResult === 'granted') persistenceDetail = 'Granted by browser'
  else if (persistenceRequestResult === 'denied') persistenceDetail = 'Denied by browser'
  else if (persistenceProbe.status === 'ready' && persistenceProbe.value)
    persistenceDetail = 'Eviction protected'
  else if (persistenceProbe.status === 'ready')
    persistenceDetail = 'Browser may evict under pressure'
  else if (persistenceProbe.status === 'unavailable') persistenceDetail = 'API unavailable'
  else if (persistenceProbe.status === 'error')
    persistenceDetail =
      persistenceProbe.reason === 'timeout' ? 'Browser probe timed out' : 'Browser probe failed'
  const showPersistenceHelp =
    isIndexedDbMode &&
    persistenceProbe.status === 'ready' &&
    !persistenceProbe.value &&
    storagePersistenceNotificationMayHelp()
  const modeValue =
    workspaceMeta?.backendKind === 'browser-idb'
      ? 'IndexedDB'
      : workspaceMeta
        ? 'Daemon'
        : 'Checking'
  const modeDetail =
    workspaceMeta?.backendKind === 'browser-idb' ? 'Browser workspace' : 'Workspace'
  return (
    <section data-ui="storage-overview">
      <div data-ui="storage-panel-row">
        <StoragePanel title="Mode" value={modeValue} detail={modeDetail}>
          {isIndexedDbMode ? (
            <>
              <StoragePanelMetric
                label="Persistence"
                value={persistenceValue}
                detail={persistenceDetail}
                state={persistenceProbe.status}
              />
              {storagePersistenceAvailable() ? (
                <Button
                  type="button"
                  data-ui="storage-action"
                  onClick={() => void handleRequestPersistence()}
                  disabled={
                    persistenceBusy ||
                    (persistenceProbe.status === 'ready' && persistenceProbe.value)
                  }
                  title="Request persistent browser storage"
                >
                  <DatabaseIcon size={14} />
                  {persistenceBusy
                    ? 'Requesting'
                    : persistenceRequestResult === 'denied'
                      ? 'Request again'
                      : 'Request persistence'}
                </Button>
              ) : null}
              {showPersistenceHelp ? (
                <span data-ui="storage-persistence-help">
                  For Chromium and Safari, allowing notifications if prompted, bookmarking this
                  page, installing Natter as an app, or regular use may help the browser grant
                  persistent storage.
                </span>
              ) : null}
              <span data-ui="storage-workspace-actions">
                <Button
                  type="button"
                  data-ui="storage-action"
                  onClick={() => setWorkspaceExportConfirmOpen(true)}
                  disabled={workspaceTransferBusy !== null || workspaceRecoveryRequired}
                  title="Export the full IndexedDB workspace"
                >
                  <DownloadIcon size={14} />
                  {workspaceTransferBusy === 'export' ? 'Exporting' : 'Export all'}
                </Button>
                <Button
                  type="button"
                  data-ui="storage-action"
                  onClick={() => workspaceImportInputRef.current?.click()}
                  disabled={workspaceTransferBusy !== null || workspaceRecoveryRequired}
                  title={
                    workspaceRecoveryRequired
                      ? 'Reload before another workspace transfer'
                      : 'Import a full workspace backup'
                  }
                >
                  <UploadIcon size={14} />
                  {workspaceTransferBusy === 'import' ? 'Importing' : 'Import all'}
                </Button>
                <Button
                  type="button"
                  data-ui="storage-action"
                  tone="danger"
                  onClick={() => void handleClearWorkspace()}
                  disabled={workspaceTransferBusy !== null || workspaceRecoveryRequired}
                  title="Clear all local Natter data and reload"
                >
                  <TrashIcon size={14} />
                  {workspaceTransferBusy === 'clear' ? 'Clearing' : 'Clear all'}
                </Button>
              </span>
              <input
                ref={workspaceImportInputRef}
                data-ui="storage-workspace-import-input"
                type="file"
                accept="application/json,.json"
                hidden
                onChange={(event) => void handleImportWorkspaceFile(event)}
              />
            </>
          ) : null}
        </StoragePanel>
        <StoragePanel
          title="Origin space"
          value={spaceValue}
          detail={spaceDetail}
          state={quotaProbe.status}
        >
          <StorageUsageDetails quota={quota} />
        </StoragePanel>
        <StoragePanel
          title="Chats"
          value={String(chatAggregate.totalCount)}
          href={storageHref({ section: 'chats' })}
        />
        <StoragePanel
          title="Attachments"
          value={`${attachmentAggregate.totalCount} (${formatBytes(attachmentAggregate.totalSizeBytes)})`}
          href={storageHref({ section: 'attachments' })}
        />
      </div>
      <div data-ui="storage-panel-row" data-role="calibration">
        <StorageGlobalCalibrationPanel model={calibration} />
      </div>
      {workspaceExportConfirmOpen ? (
        <ConfirmDialog
          title="Export sensitive workspace backup?"
          confirmLabel="Export sensitive backup"
          busyLabel="Exporting…"
          busy={workspaceTransferBusy === 'export'}
          confirmTone="warning"
          initialFocus="cancel"
          onCancel={() => setWorkspaceExportConfirmOpen(false)}
          onConfirm={handleExportWorkspace}
          closeLabel="Cancel sensitive workspace export"
        >
          <div data-ui="confirm-dialog-copy">
            <p>
              This file can include all chats, attachments, connection settings, encrypted API-key
              records, and this browser&apos;s install secret.
            </p>
            <p data-role="status" data-state="blocked">
              <strong>Keys saved without a passphrase can be recovered from the backup.</strong>{' '}
              Passphrase-protected keys still require their passphrase.
            </p>
            <p>Store the file like a password; do not share or upload it.</p>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  )
}

function StorageUsageDetails({ quota }: { quota: QuotaSnapshot | null }) {
  const entries = quota
    ? Object.entries(quota.usageDetails)
        .filter(([, bytes]) => bytes > 0)
        .sort((left, right) => right[1] - left[1])
    : []
  return (
    <>
      <span data-ui="storage-origin-note">
        Includes all storage for this browser origin; the estimate can include browser overhead and
        may lag after deletion.
      </span>
      {entries.length > 0 ? (
        <span data-ui="storage-usage-details">
          {entries.map(([key, bytes]) => (
            <StoragePanelMetric
              key={key}
              label={STORAGE_USAGE_DETAIL_LABELS[key] ?? key}
              value={formatBytes(bytes)}
            />
          ))}
        </span>
      ) : null}
    </>
  )
}

function StorageGlobalCalibrationPanel({ model }: { model: StorageGlobalCalibrationModel }) {
  const rows = model.rows
  const calibrationInteraction = usePresentationInteraction(storageCalibrationInteraction)
  const handleClearFamily = (calibrationKey: string) => {
    calibrationInteraction.run({
      target: 'workspace',
      action: () => storageApplication.calibration.clearFamilyEverywhere(calibrationKey),
    })
  }
  const handleClearAll = () => {
    calibrationInteraction.run({
      target: 'workspace',
      action: () => storageApplication.calibration.clearAllEverywhere(),
    })
  }
  return (
    <StoragePanel
      title="Global token calibration"
      value={`${rows.length} ${pluralize('family', rows.length)}`}
      detail="Materialized from per-chat samples"
    >
      {rows.length === 0 ? (
        <span data-ui="storage-calibration-empty">No calibration samples.</span>
      ) : (
        <div data-ui="storage-global-calibration-list">
          {rows.map(([key, sample]) => (
            <div key={key} data-ui="storage-global-calibration-item">
              <span data-ui="storage-global-calibration-key">{key}</span>
              <span data-ui="storage-global-calibration-ratio">
                {formatCalibrationRatio(sample)}
              </span>
              <span data-ui="storage-global-calibration-samples">
                {formatInteger(sample.sampleCount)} samples
              </span>
              <Button
                type="button"
                data-ui="storage-action"
                aria-label={`Clear calibration for ${key}`}
                disabled={calibrationInteraction.isPending('workspace')}
                onClick={() => handleClearFamily(key)}
              >
                Clear
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        type="button"
        data-ui="storage-action"
        disabled={calibrationInteraction.isPending('workspace') || rows.length === 0}
        onClick={handleClearAll}
      >
        Clear all calibration globally
      </Button>
    </StoragePanel>
  )
}

function StoragePanel({
  title,
  value,
  detail,
  href,
  state,
  children,
}: {
  title: string
  value: string
  detail?: string | undefined
  href?: string | undefined
  state?: StorageProbeStatus | undefined
  children?: ReactNode
}) {
  const content = (
    <>
      <span data-ui="storage-panel-title">{title}</span>
      <span data-ui="storage-panel-value">{value}</span>
      {detail ? <span data-ui="storage-panel-detail">{detail}</span> : null}
      {children ? <span data-ui="storage-panel-extra">{children}</span> : null}
    </>
  )
  if (href) {
    return (
      <a
        data-ui="storage-panel"
        data-state={state}
        href={href}
        onClick={makeAnchorClickHandler(href)}
      >
        {content}
      </a>
    )
  }
  return (
    <section data-ui="storage-panel" data-state={state}>
      {content}
    </section>
  )
}

function StoragePanelMetric({
  label,
  value,
  detail,
  state,
}: {
  label: string
  value: string
  detail?: string | undefined
  state?: StorageProbeStatus | undefined
}) {
  return (
    <span data-ui="storage-panel-metric" data-state={state}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </span>
  )
}

function ArchiveManager() {
  const { session: catalogSession, loadMore } = useArchiveCatalogApplication()
  const archiveInteraction = usePresentationInteraction(storageArchiveInteraction)
  const archiveBusy = archiveInteraction.isPending('archive')
  const archived = catalogSession?.page.rows ?? []
  const archivedCount = catalogSession?.page.exactCount ?? 0
  const archiveListRef = useRef<HTMLUListElement | null>(null)
  const archiveLoadRef = useRef<HTMLLIElement | null>(null)
  const archiveVirtualizer = useVirtualizer<HTMLUListElement, HTMLLIElement>({
    count: archived.length,
    getScrollElement: () => archiveListRef.current,
    estimateSize: () => 58,
    getItemKey: (index) => archived[index]?.id ?? index,
    overscan: 8,
    initialRect: { width: 800, height: 720 },
    enabled: archived.length > 100,
  })
  const measuredArchiveItems = archiveVirtualizer.getVirtualItems()
  const archiveItems =
    archived.length <= 100 || measuredArchiveItems.length > 0
      ? measuredArchiveItems
      : Array.from({ length: Math.min(30, archived.length) }, (_, index) => ({
          index,
          start: index * 58,
          end: (index + 1) * 58,
        }))
  const archiveTopSpacer = archiveItems[0]?.start ?? 0
  const archiveTotalSize =
    measuredArchiveItems.length > 0 ? archiveVirtualizer.getTotalSize() : archived.length * 58
  const archiveBottomSpacer =
    archiveItems.length === 0 ? 0 : Math.max(0, archiveTotalSize - (archiveItems.at(-1)?.end ?? 0))
  const archiveTopSpacerRef = useVirtualSpacerHeight<HTMLLIElement>(archiveTopSpacer)
  const archiveBottomSpacerRef = useVirtualSpacerHeight<HTMLLIElement>(archiveBottomSpacer)

  useEffect(() => {
    if (
      !catalogSession?.interactive ||
      catalogSession.status === 'refreshing' ||
      !catalogSession.page.nextCursor ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return
    }
    const root = archiveListRef.current
    const target = archiveLoadRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore()
      },
      { root, rootMargin: '0px 0px 240px 0px', threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [
    catalogSession?.interactive,
    catalogSession?.page.nextCursor,
    catalogSession?.status,
    loadMore,
  ])

  if (catalogSession?.status === 'error' && archived.length === 0) throw catalogSession.error

  const handleRestore = (chat: ChatSidebarRow) => {
    archiveInteraction.run({
      target: 'archive',
      action: () => storageApplication.chat.unarchive(chat.id),
    })
  }
  const handleDelete = (chat: ChatSidebarRow) => {
    const title = displayChatTitle(chat)
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return
    archiveInteraction.run({
      target: 'archive',
      action: () => storageApplication.chat.deleteArchived(chat.id),
    })
  }
  const handleEmpty = () => {
    if (archivedCount === 0) return
    if (!window.confirm(`Permanently delete ${archivedCount} archived chats?`)) return
    archiveInteraction.run({
      target: 'archive',
      action: () => storageApplication.chat.emptyArchive(),
    })
  }

  return (
    <section data-ui="archive-manager">
      <div data-ui="archive-toolbar">
        <span data-ui="archive-count">{archivedCount}</span>
        <IconButton
          type="button"
          data-ui="storage-action"
          tone="danger"
          aria-label="Empty trash"
          title="Empty trash"
          disabled={archivedCount === 0 || archiveBusy || !catalogSession?.interactive}
          onClick={handleEmpty}
        >
          <TrashIcon size={14} />
        </IconButton>
      </div>
      {archived.length === 0 ? (
        <p data-ui="helper">
          {catalogSession?.status === 'ready' ? 'No archived chats.' : 'Loading archived chats…'}
        </p>
      ) : (
        <ul ref={archiveListRef} data-ui="archive-list">
          {archiveTopSpacer > 0 ? (
            <li ref={archiveTopSpacerRef} aria-hidden="true" data-ui="archive-virtual-spacer" />
          ) : null}
          {(archived.length <= 100 ? archived.map((_, index) => ({ index })) : archiveItems).map(
            (virtual) => {
              const chat = archived[virtual.index]
              if (!chat) return null
              const title = displayChatTitle(chat)
              const href = chatHref(chat.id)
              return (
                <li
                  key={chat.id}
                  data-index={virtual.index}
                  data-ui="archive-row"
                  ref={archived.length > 100 ? archiveVirtualizer.measureElement : undefined}
                >
                  <a
                    data-ui="archive-row-link"
                    href={catalogSession?.interactive ? href : undefined}
                    aria-disabled={!catalogSession?.interactive || undefined}
                    tabIndex={catalogSession?.interactive ? undefined : -1}
                    onClick={
                      catalogSession?.interactive
                        ? makeAnchorClickHandler(href)
                        : (event) => event.preventDefault()
                    }
                  >
                    <span data-ui="archive-row-main">
                      <strong>{title}</strong>
                      <span>{chat.previewText || shortId(chat.id)}</span>
                    </span>
                    <span data-ui="archive-row-meta">{formatDate(chat.updatedAt)}</span>
                  </a>
                  <span data-ui="archive-row-actions">
                    <IconButton
                      type="button"
                      data-ui="archive-restore-button"
                      aria-label={`Restore ${title}`}
                      title="Restore to sidebar"
                      disabled={archiveBusy || !catalogSession?.interactive}
                      onClick={() => handleRestore(chat)}
                    >
                      <UnarchiveIcon size={14} />
                    </IconButton>
                    <Button
                      type="button"
                      aria-label={`Permanently delete ${title}`}
                      title="Delete permanently"
                      disabled={archiveBusy || !catalogSession?.interactive}
                      onClick={() => handleDelete(chat)}
                    >
                      <TrashIcon size={14} />
                    </Button>
                  </span>
                </li>
              )
            },
          )}
          {archiveBottomSpacer > 0 ? (
            <li ref={archiveBottomSpacerRef} aria-hidden="true" data-ui="archive-virtual-spacer" />
          ) : null}
          {catalogSession?.page.nextCursor ? (
            <li ref={archiveLoadRef} data-ui="archive-window-load">
              <Button
                type="button"
                disabled={!catalogSession.interactive || catalogSession.status === 'refreshing'}
                onClick={loadMore}
              >
                {catalogSession.status === 'refreshing' ? 'Loading…' : 'Load more'}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  )
}

function AttachmentManager({
  route,
}: {
  route: Extract<StorageRoute, { section: 'attachments' }>
}) {
  const pushToast = useToastStore((state) => state.push)
  const routeFilter = route.filter ?? 'all'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ManagerFilter>(routeFilter)
  const [replaceTarget, setReplaceTarget] = useState<AttachmentReferenceRow | null>(null)
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{
    readonly phase: 'planning' | 'deleting'
    readonly processed: number
    readonly planned: number
  } | null>(null)
  const bulkDeleteControllerRef = useRef<AbortController | null>(null)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const replaceUploadRef = useRef<HTMLInputElement | null>(null)
  const selectedId = route.attachmentId
  const searchFilters = useMemo(() => filterToSearch(filter), [filter])
  const searchRequest = useMemo(
    () => ({
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(searchFilters ? { filters: searchFilters } : {}),
      sort: 'size-desc' as const,
    }),
    [query, searchFilters],
  )
  const {
    search: searchSession,
    detail: detailSession,
    detailId,
    loadMore: loadMoreAttachments,
  } = useAttachmentManagerCatalogApplication(searchRequest, selectedId)
  const rows = searchSession?.rows ?? []
  const exactDetail = detailSession?.detail?.row.id === detailId ? detailSession.detail : undefined
  const displaySelected =
    exactDetail?.row ??
    (detailId ? rows.find((row) => row.id === detailId) : undefined) ??
    detailSession?.detail?.row
  const references = exactDetail?.references ?? []
  const exactMatchCount =
    searchSession?.matchedCount ?? (searchSession?.complete ? rows.length : undefined)
  const unknownSelected = Boolean(
    selectedId &&
      detailSession?.attachmentId === selectedId &&
      detailSession.status === 'ready' &&
      !exactDetail,
  )

  useEffect(
    () => () => {
      bulkDeleteControllerRef.current?.abort()
      bulkDeleteControllerRef.current = null
    },
    [],
  )

  if (searchSession?.status === 'error' && rows.length === 0) throw searchSession.error
  if (detailSession?.status === 'error' && !displaySelected) throw detailSession.error

  const handleDeleteAttachment = async (attachment: AttachmentDisplayRow) => {
    if (!confirmDeleteAttachment(attachment)) return
    const routeIntent = selectedId === attachment.id ? beginRouteIntent() : null
    try {
      const removed = await deleteAttachmentForStorage(attachment)
      if (routeIntent && removed) {
        navigateForIntent(routeIntent, attachmentListHrefForFilter(filter))
      }
    } finally {
      if (routeIntent) cancelRouteIntent(routeIntent)
    }
  }
  return (
    <section data-ui="attachment-manager">
      <div data-ui="attachment-manager-toolbar">
        <label data-ui="attachment-search">
          <SearchIcon size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search id, name, MIME, hash, URL, extracted text…"
          />
        </label>
        <div data-ui="attachment-filter-row">
          <fieldset data-ui="attachment-filter-strip" aria-label="Attachment filters">
            {FILTERS.map((value) => (
              <Button
                key={value}
                type="button"
                data-ui="attachment-filter"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {filterLabel(value)}
              </Button>
            ))}
          </fieldset>
          <Button
            type="button"
            data-ui="storage-action"
            tone="danger"
            disabled={
              bulkDeleteProgress === null && (rows.length === 0 || !searchSession?.interactive)
            }
            onClick={() => {
              if (bulkDeleteControllerRef.current) {
                bulkDeleteControllerRef.current.abort()
                return
              }
              void (async () => {
                const routeIntent = beginRouteIntent()
                const controller = new AbortController()
                bulkDeleteControllerRef.current = controller
                setBulkDeleteProgress({ phase: 'planning', processed: 0, planned: 0 })
                try {
                  const plan = await storageApplication.attachment.planBulkDelete(
                    searchRequest,
                    controller.signal,
                  )
                  if (plan.matchedCount === 0) return
                  if (!isRouteIntentCurrent(routeIntent)) return
                  if (!confirmDeleteAll(filter, query, plan.matchedCount)) return
                  setBulkDeleteProgress({
                    phase: 'deleting',
                    processed: 0,
                    planned: plan.matchedCount,
                  })
                  const result = await storageApplication.attachment.executeBulkDelete(plan, {
                    signal: controller.signal,
                    ...(selectedId ? { selectedAttachmentId: selectedId } : {}),
                    onProgress: (progress) =>
                      setBulkDeleteProgress({
                        phase: 'deleting',
                        processed: progress.processed,
                        planned: progress.planned,
                      }),
                  })
                  if (
                    selectedId &&
                    (result.selectedDisposition === 'deleted' ||
                      result.selectedDisposition === 'absent')
                  ) {
                    navigateForIntent(routeIntent, attachmentListHrefForFilter(filter))
                  }
                } catch (error) {
                  if (!controller.signal.aborted) {
                    console.error('Failed to bulk delete attachments', error)
                    pushToast({ level: 'danger', text: 'Attachment deletion failed.' })
                  }
                } finally {
                  cancelRouteIntent(routeIntent)
                  if (bulkDeleteControllerRef.current === controller) {
                    bulkDeleteControllerRef.current = null
                    setBulkDeleteProgress(null)
                  }
                }
              })()
            }}
          >
            <TrashIcon size={14} />
            {bulkDeleteProgress
              ? bulkDeleteProgress.phase === 'planning'
                ? 'Cancel check'
                : `Cancel delete (${bulkDeleteProgress.processed}/${bulkDeleteProgress.planned})`
              : `Delete all${exactMatchCount === undefined ? '' : ` (${exactMatchCount})`}`}
          </Button>
        </div>
      </div>
      {unknownSelected ? (
        <div data-ui="notice-banner" data-tone="warning" role="status">
          Attachment not found in this workspace.
        </div>
      ) : null}
      <div data-ui="attachment-manager-grid">
        <AttachmentTable
          rows={rows}
          selectedId={displaySelected?.id}
          interactive={Boolean(searchSession?.interactive)}
          hasMore={Boolean(searchSession?.nextCursor)}
          loadingMore={searchSession?.status === 'refreshing'}
          onLoadMore={loadMoreAttachments}
          onDelete={handleDeleteAttachment}
        />
        <AttachmentDetails
          attachment={displaySelected}
          detail={exactDetail}
          interactive={Boolean(exactDetail && detailSession?.interactive)}
          references={references}
          onReplaceRef={setReplaceTarget}
          onRestoreUpload={() => uploadRef.current?.click()}
          onReplaceUpload={() => replaceUploadRef.current?.click()}
          onDelete={handleDeleteAttachment}
        />
      </div>
      <input
        ref={uploadRef}
        data-ui="attachment-hidden-input"
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file || !displaySelected) return
          void (async () => {
            const replacement = await storageApplication.attachment.ingestBytes({
              blob: file,
              filename: file.name,
              origin: 'user-upload',
              ...(file.type ? { declaredMime: file.type } : {}),
            })
            await storageApplication.attachment.restoreMissing({
              missingAttachmentId: displaySelected.id,
              replacementAttachmentId: replacement.attachment.id,
              refs: references.map(referenceTarget),
            })
          })()
        }}
      />
      <input
        ref={replaceUploadRef}
        data-ui="attachment-hidden-input"
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file || !displaySelected) return
          const routeIntent = beginRouteIntent()
          void (async () => {
            try {
              const result = await storageApplication.attachment.replaceBytes({
                attachmentId: displaySelected.id,
                blob: file,
                filename: file.name,
                origin: 'user-upload',
                ...(file.type ? { declaredMime: file.type } : {}),
              })
              if (result.reusedExisting && result.bundle.attachment.id !== displaySelected.id) {
                if (references.length > 0) {
                  await storageApplication.attachment.batchRelinkRefs({
                    oldAttachmentId: displaySelected.id,
                    newAttachmentId: result.bundle.attachment.id,
                    refs: references.map(referenceTarget),
                  })
                }
                await storageApplication.attachment.deleteUnreferenced(displaySelected.id)
                navigateForIntent(routeIntent, attachmentHref(result.bundle.attachment.id))
              }
            } finally {
              cancelRouteIntent(routeIntent)
            }
          })()
        }}
      />
      {replaceTarget ? (
        <AttachmentPicker
          sessionSurface="picker-storage-reference"
          title="Relink reference"
          excludeAttachmentId={replaceTarget.ref.attachmentId}
          interactionTarget={attachmentMutationTarget(referenceTarget(replaceTarget))}
          onClose={() => setReplaceTarget(null)}
          onPick={async (attachment) => {
            await storageApplication.attachment.relinkRef({
              ...referenceTarget(replaceTarget),
              newAttachmentId: attachment.id,
            })
          }}
        />
      ) : null}
    </section>
  )
}

function AttachmentTable({
  rows,
  selectedId,
  interactive,
  hasMore,
  loadingMore,
  onLoadMore,
  onDelete,
}: {
  rows: readonly AttachmentCatalogRow[]
  selectedId: string | undefined
  interactive: boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onDelete: (attachment: AttachmentCatalogRow) => void | Promise<void>
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const loadRef = useRef<HTMLSpanElement | null>(null)
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 10,
    initialRect: { width: 720, height: 720 },
    enabled: rows.length > 100,
  })
  const measuredItems = virtualizer.getVirtualItems()
  const virtualItems =
    rows.length <= 100 || measuredItems.length > 0
      ? measuredItems
      : Array.from({ length: Math.min(40, rows.length) }, (_, index) => ({
          index,
          start: index * 45,
          end: (index + 1) * 45,
        }))
  const topSpacer = virtualItems[0]?.start ?? 0
  const totalSize = measuredItems.length > 0 ? virtualizer.getTotalSize() : rows.length * 45
  const bottomSpacer =
    virtualItems.length === 0 ? 0 : Math.max(0, totalSize - (virtualItems.at(-1)?.end ?? 0))
  const topSpacerRef = useVirtualSpacerHeight<HTMLTableCellElement>(topSpacer)
  const bottomSpacerRef = useVirtualSpacerHeight<HTMLTableCellElement>(bottomSpacer)

  useEffect(() => {
    if (!interactive || !hasMore || loadingMore || typeof IntersectionObserver === 'undefined') {
      return
    }
    const root = scrollRef.current
    const target = loadRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
      },
      { root, rootMargin: '0px 0px 240px 0px', threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasMore, interactive, loadingMore, onLoadMore])

  return (
    <div ref={scrollRef} data-ui="attachment-table-wrap">
      <table data-ui="attachment-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>State</th>
            <th>Refs</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {topSpacer > 0 ? (
            <tr data-ui="attachment-virtual-spacer">
              <td ref={topSpacerRef} colSpan={5} />
            </tr>
          ) : null}
          {(rows.length <= 100 ? rows.map((_, index) => ({ index })) : virtualItems).map(
            (virtual) => {
              const attachment = rows[virtual.index]
              if (!attachment) return null
              const href = attachmentHref(attachment.id)
              return (
                <tr
                  key={attachment.id}
                  data-index={virtual.index}
                  data-selected={selectedId === attachment.id ? 'true' : undefined}
                  data-inert={!interactive || undefined}
                  ref={rows.length > 100 ? virtualizer.measureElement : undefined}
                  tabIndex={interactive ? 0 : -1}
                  onClick={(event) => {
                    if (!interactive) return
                    if (
                      (event.target as HTMLElement).closest('a, button, input, select, textarea')
                    ) {
                      return
                    }
                    navigate(href)
                  }}
                  onKeyDown={(event) => {
                    if (!interactive) return
                    if (
                      (event.target as HTMLElement).closest('a, button, input, select, textarea')
                    ) {
                      return
                    }
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    navigate(href)
                  }}
                >
                  <td>
                    <a
                      href={interactive ? href : undefined}
                      aria-disabled={!interactive || undefined}
                      tabIndex={interactive ? undefined : -1}
                      onClick={
                        interactive
                          ? makeAnchorClickHandler(href)
                          : (event) => event.preventDefault()
                      }
                    >
                      <FileIcon size={14} />
                      <span>{attachment.filename}</span>
                      <small>{shortId(attachment.id)}</small>
                    </a>
                  </td>
                  <td>
                    {formatBytes(attachment.sizeBytes)} · {storageLabel(attachment)}
                  </td>
                  <td>{attachment.refCount}</td>
                  <td>{formatDate(attachment.createdAt)}</td>
                  <td data-ui="attachment-table-actions">
                    <IconButton
                      type="button"
                      data-ui="icon-button"
                      data-size="xs"
                      size="xs"
                      aria-label={`Delete ${attachment.filename}`}
                      title="Delete"
                      disabled={!interactive}
                      onClick={() => void onDelete(attachment)}
                    >
                      <TrashIcon size={13} />
                    </IconButton>
                  </td>
                </tr>
              )
            },
          )}
          {bottomSpacer > 0 ? (
            <tr data-ui="attachment-virtual-spacer">
              <td ref={bottomSpacerRef} colSpan={5} />
            </tr>
          ) : null}
        </tbody>
        {hasMore ? (
          <tfoot>
            <tr data-ui="attachment-window-load">
              <td colSpan={5}>
                <span ref={loadRef}>
                  <Button type="button" disabled={!interactive || loadingMore} onClick={onLoadMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                </span>
              </td>
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

function AttachmentDetails({
  attachment,
  detail,
  interactive,
  references,
  onReplaceRef,
  onRestoreUpload,
  onReplaceUpload,
  onDelete,
}: {
  attachment: AttachmentCatalogRow | undefined
  detail: AttachmentManagerDetail | undefined
  interactive: boolean
  references: readonly AttachmentReferenceRow[]
  onReplaceRef: (reference: AttachmentReferenceRow) => void
  onRestoreUpload: () => void
  onReplaceUpload: () => void
  onDelete: (attachment: AttachmentCatalogRow) => void | Promise<void>
}) {
  const pushToast = useToastStore((s) => s.push)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const canDownload = Boolean(attachment && attachment.storage.kind !== 'missing')
  const textPreview = detail?.artifacts.find((artifact) => artifact.kind === 'text')?.textPreview
  const handleDownload = useCallback(async () => {
    if (!attachment || !canDownload) return
    setDownloadBusy(true)
    try {
      await downloadAttachment(attachment)
    } catch (error) {
      console.error('Failed to download attachment', error)
      pushToast({ level: 'danger', text: 'Attachment download failed.' })
    } finally {
      setDownloadBusy(false)
    }
  }, [attachment, canDownload, pushToast])

  if (!attachment) {
    return (
      <aside data-ui="attachment-details">
        <p data-ui="helper">Select an attachment.</p>
      </aside>
    )
  }
  return (
    <aside data-ui="attachment-details">
      <header data-ui="attachment-details-header">
        <span data-ui="attachment-details-title">
          <FileIcon size={16} />
          {attachment.filename}
        </span>
      </header>
      <AttachmentPreview attachment={attachment} textPreview={textPreview} variant="panel" />
      <dl data-ui="attachment-metadata">
        <Meta label="id" value={attachment.id} />
        <Meta label="kind" value={kindLabel(attachment.kind)} />
        <Meta label="MIME" value={attachment.mime} />
        <Meta label="size" value={formatBytes(attachment.sizeBytes)} />
        <Meta label="state" value={storageLabel(attachment)} />
        <Meta label="hash" value={attachment.contentHash ?? 'none'} />
        <Meta label="origin" value={attachment.origin} />
        <Meta label="created" value={formatDate(attachment.createdAt)} />
        <Meta label="updated" value={formatDate(attachment.updatedAt)} />
        <Meta
          label="references"
          value={`${attachment.messageRefCount} message · ${attachment.draftRefCount} draft · ${attachment.visibleRefCount} in context`}
        />
        {attachment.sourceUrl ? <Meta label="URL" value={attachment.sourceUrl} /> : null}
        {attachment.pageCount !== undefined ? (
          <Meta label="pages" value={String(attachment.pageCount)} />
        ) : null}
        {attachment.dimensions ? (
          <Meta
            label="pixels"
            value={`${attachment.dimensions.width}×${attachment.dimensions.height}`}
          />
        ) : null}
        {attachment.durationMs !== undefined ? (
          <Meta label="duration" value={`${Math.round(attachment.durationMs / 1000)}s`} />
        ) : null}
        {attachment.processing.map((state) => (
          <Meta
            key={state.processorId}
            label={`processor · ${state.processorId}`}
            value={state.errorCode ? `${state.status} · ${state.errorCode}` : state.status}
          />
        ))}
        {detail?.jobs.map((job) => (
          <Meta
            key={job.id}
            label={`job · ${job.processorId}`}
            value={job.error ? `${job.status} · ${job.error.code}` : job.status}
          />
        ))}
      </dl>
      <div data-ui="attachment-lifecycle-actions">
        {canDownload ? (
          <Button
            type="button"
            data-ui="storage-action"
            disabled={downloadBusy || !interactive}
            aria-label={`Download ${attachment.filename}`}
            onClick={() => void handleDownload()}
          >
            <DownloadIcon size={14} />
            {downloadBusy ? 'Downloading...' : 'Download'}
          </Button>
        ) : null}
        <Button
          type="button"
          data-ui="storage-action"
          disabled={!interactive}
          onClick={onReplaceUpload}
        >
          <UploadIcon size={14} />
          Replace
        </Button>
        {attachment.storage.kind === 'missing' ? (
          <Button
            type="button"
            data-ui="storage-action"
            disabled={!interactive}
            onClick={onRestoreUpload}
          >
            <UploadIcon size={14} />
            Restore
          </Button>
        ) : null}
        <Button
          type="button"
          data-ui="storage-action"
          tone="danger"
          disabled={!interactive}
          onClick={() => void onDelete(attachment)}
        >
          <TrashIcon size={14} />
          Delete
        </Button>
      </div>
      <section data-ui="attachment-reference-section">
        <h3>References</h3>
        {references.length === 0 ? (
          <p data-ui="helper">No live message or draft refs.</p>
        ) : (
          <ul data-ui="attachment-reference-list">
            {references.map((row) => (
              <li key={`${row.ownerKind}:${row.messageId ?? row.draftChatId}:${row.ref.refId}`}>
                <div data-ui="attachment-reference-main">
                  <strong>{row.chatTitle}</strong>
                  <span>
                    {row.ownerKind === 'message'
                      ? `${row.role ?? 'message'} · ${formatDate(row.messageCreatedAt)}`
                      : 'draft'}
                  </span>
                </div>
                <div data-ui="attachment-reference-actions">
                  <IconButton
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    size="xs"
                    aria-pressed={row.ref.includeInContext}
                    aria-label={
                      row.ref.includeInContext ? 'Hide from context' : 'Include in context'
                    }
                    title={
                      row.ref.includeInContext
                        ? 'Hide this exact reference from future context'
                        : 'Include this exact reference in future context'
                    }
                    disabled={!interactive}
                    onClick={() =>
                      void storageApplication.attachment.setRefVisibility({
                        ...referenceTarget(row),
                        includeInContext: !row.ref.includeInContext,
                      })
                    }
                  >
                    {row.ref.includeInContext ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
                  </IconButton>
                  <IconButton
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    size="xs"
                    aria-label="Relink reference"
                    title="Relink this exact reference to another stored attachment"
                    disabled={!interactive}
                    onClick={() => onReplaceRef(row)}
                  >
                    <DatabaseIcon size={13} />
                  </IconButton>
                  <IconButton
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    size="xs"
                    aria-label="Detach reference"
                    title="Detach this exact reference"
                    disabled={!interactive}
                    onClick={() =>
                      void storageApplication.attachment.detachRef(referenceTarget(row))
                    }
                  >
                    <CloseIcon size={13} />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div data-ui="attachment-meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

async function downloadAttachment(attachment: AttachmentDisplayRow): Promise<void> {
  if (attachment.storage.kind === 'missing') throw new Error(`AttachmentMissing:${attachment.id}`)
  if (attachment.storage.kind === 'remote-url') {
    triggerRemoteAttachmentDownload(attachment.filename, attachment.storage.url)
    return
  }

  const bundle = await storageApplication.attachment.getBundle(attachment.id)
  const blobRow = selectAttachmentDownloadBlob(attachment, bundle)
  if (!blobRow) throw new Error(`AttachmentBlobMissing:${attachment.id}`)
  const blob = await attachmentDownloadBlob(blobRow)
  triggerBrowserBlobDownload(attachment.filename, blob)
}

async function attachmentDownloadBlob(blobRow: AttachmentBlob): Promise<Blob> {
  if (blobRow.blob.type || !blobRow.mime) return blobRow.blob
  if (typeof blobRow.blob.slice === 'function') {
    return blobRow.blob.slice(0, blobRow.blob.size, blobRow.mime)
  }
  if (typeof blobRow.blob.arrayBuffer === 'function') {
    return new Blob([await blobRow.blob.arrayBuffer()], { type: blobRow.mime })
  }
  if (typeof blobRow.blob.text === 'function') {
    return new Blob([await blobRow.blob.text()], { type: blobRow.mime })
  }
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error ?? new Error('BlobReadFailed'))
      reader.onload = () => {
        if (!(reader.result instanceof ArrayBuffer)) {
          reject(new Error('BlobReadFailed'))
          return
        }
        resolve(new Blob([reader.result], { type: blobRow.mime }))
      }
      reader.readAsArrayBuffer(blobRow.blob)
    })
  }
  throw new Error('BlobReadUnsupported')
}

function selectAttachmentDownloadBlob(
  attachment: AttachmentDisplayRow,
  bundle: PreparedAttachmentBundle | undefined,
) {
  if (!bundle || attachment.storage.kind !== 'local-blob') return undefined
  const blobId = attachment.storage.blobId
  return (
    bundle.blobs.find((row) => row.id === blobId) ??
    bundle.blobs.find((row) => row.role === 'original') ??
    bundle.blobs.find((row) => row.role === 'normalized') ??
    bundle.blobs[0]
  )
}

function triggerRemoteAttachmentDownload(filename: string, url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.target = '_blank'
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function filterToSearch(filter: ManagerFilter) {
  if (filter === 'missing') return { storageKind: 'missing' as const }
  if (filter === 'unreferenced') return { maxRefCount: 0 }
  if (filter === 'remote') return { storageKind: 'remote-url' as const }
  if (filter === 'image' || filter === 'pdf' || filter === 'audio' || filter === 'video') {
    return { kind: filter as AttachmentKind }
  }
  if (filter === 'document') return { kind: 'document' as AttachmentKind }
  if (filter === 'generated') return { origin: 'generated-output' as const }
  return undefined
}

export async function deleteAttachmentForStorage(
  attachment: AttachmentDisplayRow,
): Promise<boolean> {
  if (attachment.refCount === 0) {
    const result = await storageApplication.attachment.deleteUnreferenced(attachment.id)
    return result.deleted
  }
  await storageApplication.attachment.deleteReferencedBytes(attachment.id, 'deleted')
  return false
}

function confirmDeleteAttachment(attachment: AttachmentDisplayRow): boolean {
  if (attachment.refCount === 0) {
    return window.confirm(`Delete "${attachment.filename}"?`)
  }
  return window.confirm(
    `Delete "${attachment.filename}"? ${attachment.refCount} message/draft refs will keep stubs.`,
  )
}

function confirmDeleteAll(filter: ManagerFilter, query: string, count: number): boolean {
  const scope = query.trim()
    ? `${filterLabel(filter)} matching "${query.trim()}"`
    : filterLabel(filter)
  const noun = count === 1 ? 'attachment' : 'attachments'
  return window.confirm(
    `Delete ${count} ${noun} in ${scope}? Referenced message/draft refs will keep stubs.`,
  )
}

function attachmentListHrefForFilter(filter: ManagerFilter): string {
  if (filter === 'missing' || filter === 'unreferenced') {
    return storageHref({ section: 'attachments', filter })
  }
  return storageHref({ section: 'attachments' })
}

function filterLabel(filter: ManagerFilter): string {
  if (filter === 'all') return 'All'
  if (filter === 'remote') return 'Remote'
  if (filter === 'generated') return 'Generated'
  return kindLabel(filter as AttachmentKind)
}

function referenceTarget(row: AttachmentReferenceRow): {
  refId: string
  expectedAttachmentId: AttachmentId
  messageId?: MessageId
  draftChatId?: ChatId
} {
  return {
    refId: row.ref.refId,
    expectedAttachmentId: row.ref.attachmentId,
    ...(row.ownerKind === 'message'
      ? { messageId: row.messageId as MessageId }
      : { draftChatId: row.draftChatId as ChatId }),
  }
}
