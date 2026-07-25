import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { redactDiagnosticValue } from '../lib/diagnostic-redaction'
import type {
  BrowserWorkspaceOpenOptions,
  BrowserWorkspaceOpenProgress,
} from '../store/presentation-contracts'
import { registerWorkspacePresentationRoot } from '../store/workspace-presentation-lifecycle'
import { Button } from '../ui/primitives/Button'
import { ConfirmDialog } from '../ui/primitives/ConfirmDialog'

export type WorkspaceOpenOptions = BrowserWorkspaceOpenOptions

interface WorkspaceBootstrapProps {
  children: ReactNode
  openWorkspace: (options: WorkspaceOpenOptions) => Promise<unknown>
  onReady?: () => void
  resetWorkspace?: () => Promise<unknown>
  reload?: () => void
}

type OpenPhase =
  | { kind: 'opening'; attempt: number; progress: BrowserWorkspaceOpenProgress }
  | { kind: 'blocked'; oldVersion: number; newVersion: number | null; occurredAt: string }
  | { kind: 'failed'; error: unknown; occurredAt: string }
  | { kind: 'ready' }

type RecoveryCategory = 'quota' | 'version' | 'migration' | 'integrity' | 'render' | 'general'

interface RecoveryViewProps {
  stage: 'database-open' | 'render'
  error?: unknown
  blocked?: { oldVersion: number; newVersion: number | null } | undefined
  occurredAt: string
  onRetry: () => void
  onReload: () => void
  onReset?: () => Promise<unknown>
}

interface RootBoundaryProps {
  children: ReactNode
  reload: () => void
  resetWorkspace?: () => Promise<unknown>
}

interface RootBoundaryState {
  error: unknown
  occurredAt: string | null
}

const INITIAL_OPEN_PROGRESS: BrowserWorkspaceOpenProgress = {
  kind: 'storage-administration',
}

function nowIso(): string {
  return new Date().toISOString()
}

function safeDiagnosticToken(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80)
  return normalized || fallback
}

function errorNameChain(error: unknown): string[] {
  const names: string[] = []
  const seen = new Set<object>()
  let current: unknown = error
  while (current && typeof current === 'object' && names.length < 5 && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { name?: unknown; cause?: unknown }
    names.push(safeDiagnosticToken(candidate.name, 'Error'))
    current = candidate.cause
  }
  return names.length > 0 ? names : ['UnknownError']
}

function recoveryCategory(stage: RecoveryViewProps['stage'], error: unknown): RecoveryCategory {
  if (stage === 'render') return 'render'
  const names = errorNameChain(error)
  if (names.some((name) => name.includes('QuotaExceeded'))) return 'quota'
  if (names.some((name) => name.includes('VersionError'))) return 'version'
  if (names.some((name) => name.includes('SchemaIntegrity'))) return 'integrity'
  if (names.some((name) => /Migration|Upgrade/u.test(name))) return 'migration'
  return 'general'
}

function recoveryCopy(category: RecoveryCategory): { title: string; detail: string } {
  switch (category) {
    case 'quota':
      return {
        title: 'Local storage is unavailable or full',
        detail:
          'Free browser or disk space, then try again. If Natter still works in another tab, export a backup there first.',
      }
    case 'version':
      return {
        title: 'This workspace needs a newer Natter version',
        detail:
          'Open it with the newer build that last used this workspace. An older build cannot safely downgrade the database.',
      }
    case 'migration':
      return {
        title: 'The workspace upgrade did not finish',
        detail:
          'The upgrade was rolled back without replacing the previous database. Retry, or export a backup from any tab that can still open it.',
      }
    case 'integrity':
      return {
        title: 'The local workspace is incomplete',
        detail:
          'A required canonical database store is missing or has an incompatible primary key. Import a workspace backup if one is available, or reset local data to start a verified empty workspace.',
      }
    case 'render':
      return {
        title: 'Natter could not render the workspace',
        detail:
          'Try rendering it again. If the problem repeats, reload and keep the diagnostics below for troubleshooting.',
      }
    case 'general':
      return {
        title: 'Natter could not open the local workspace',
        detail:
          'Close other Natter tabs, check available browser storage, and try again. Reloading does not erase local data.',
      }
  }
}

function openingCopy(progress: BrowserWorkspaceOpenProgress): string {
  switch (progress.kind) {
    case 'storage-administration':
      return 'Coordinating access to local browser storage.'
    case 'database-selection':
      return databaseSelectionOpeningCopy(progress)
    case 'schema-preflight':
      return `Inspecting the physical schema for ${progress.databaseName}.`
    case 'database-open':
      return `Opening ${progress.databaseName} at storage version ${progress.targetVersion}.`
    case 'database-upgrade': {
      const count =
        progress.processedRows > 0
          ? ` Processed ${progress.processedRows.toLocaleString()} rows (${progress.processedBytes.toLocaleString()} estimated bytes).`
          : ''
      return `Upgrading ${progress.databaseName}: ${progress.operation}.${count}`
    }
    case 'workspace-metadata':
      return `Reading the workspace identity from ${progress.databaseName}.`
    case 'runtime-resources':
      return `Starting workspace capabilities: ${progress.operation}.`
  }
}

function databaseSelectionOpeningCopy(
  progress: Extract<BrowserWorkspaceOpenProgress, { kind: 'database-selection' }>,
): string {
  const databaseName = progress.databaseName ? ` (${progress.databaseName})` : ''
  switch (progress.operation) {
    case 'read-active-slot':
      return 'Reading the active workspace database slot.'
    case 'acquire-active-slot':
      return `Opening the active workspace slot${databaseName}.`
    case 'confirm-active-slot':
      return `Confirming the active workspace slot${databaseName}.`
    case 'retry-changed-slot':
      return 'The active workspace changed during opening; following the committed slot.'
  }
}

function openingDiagnosticsText(attempt: number, progress: BrowserWorkspaceOpenProgress): string {
  return JSON.stringify(
    redactDiagnosticValue({
      stage: 'database-open',
      attempt,
      progress,
      observedAt: nowIso(),
    }),
    null,
    2,
  )
}

function diagnosticsText({
  stage,
  error,
  blocked,
  occurredAt,
}: Pick<RecoveryViewProps, 'stage' | 'error' | 'blocked' | 'occurredAt'>): string {
  const category = blocked ? 'blocked' : recoveryCategory(stage, error)
  return JSON.stringify(
    redactDiagnosticValue({
      stage,
      category,
      occurredAt,
      ...(blocked
        ? { oldVersion: blocked.oldVersion, newVersion: blocked.newVersion }
        : { errorNames: errorNameChain(error) }),
    }),
    null,
    2,
  )
}

function RecoveryView({
  stage,
  error,
  blocked,
  occurredAt,
  onRetry,
  onReload,
  onReset,
}: RecoveryViewProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetFailed, setResetFailed] = useState(false)
  const diagnostics = useMemo(
    () => diagnosticsText({ stage, error, blocked, occurredAt }),
    [blocked, error, occurredAt, stage],
  )
  const copy = blocked
    ? {
        title: 'Workspace upgrade is waiting',
        detail:
          'Another Natter tab or older app window is holding the database open. Close it; this page will continue automatically.',
      }
    : recoveryCopy(recoveryCategory(stage, error))

  const copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(diagnostics)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  const reset = async () => {
    if (!onReset) return
    setResetBusy(true)
    setResetFailed(false)
    try {
      await onReset()
      onReload()
    } catch {
      setResetFailed(true)
      setResetConfirmOpen(false)
    } finally {
      setResetBusy(false)
    }
  }

  return (
    <main data-ui="workspace-bootstrap" data-state={blocked ? 'blocked' : 'failed'}>
      <section
        data-ui="workspace-bootstrap-card"
        role="alert"
        aria-labelledby="workspace-error-title"
      >
        <span data-ui="workspace-bootstrap-kicker">Local workspace</span>
        <h1 id="workspace-error-title">{copy.title}</h1>
        <p>{copy.detail}</p>
        <p data-ui="workspace-bootstrap-safety">
          Natter did not reset your workspace. Avoid clearing site data unless you have exhausted
          the recovery options below.
        </p>
        <div data-ui="workspace-bootstrap-actions">
          <Button tone="accent" appearance="solid" onClick={onRetry}>
            Try again
          </Button>
          <Button appearance="outline" onClick={onReload}>
            Reload
          </Button>
          <Button appearance="outline" onClick={() => void copyDiagnostics()}>
            {copyState === 'copied' ? 'Copied diagnostics' : 'Copy diagnostics'}
          </Button>
        </div>
        {copyState === 'failed' ? (
          <p data-ui="workspace-bootstrap-inline-error" role="status">
            Clipboard access failed. Select and copy the diagnostics below.
          </p>
        ) : null}
        <details data-ui="workspace-bootstrap-diagnostics">
          <summary>Redacted diagnostics</summary>
          <section aria-label="Redacted diagnostics">
            <pre>{diagnostics}</pre>
          </section>
        </details>
        {onReset ? (
          <details data-ui="workspace-bootstrap-reset">
            <summary>Last resort</summary>
            <p>
              Resetting permanently removes every local chat, attachment, connection, and saved key
              for this browser origin. Export from another working tab first if possible.
            </p>
            <Button tone="danger" appearance="outline" onClick={() => setResetConfirmOpen(true)}>
              Reset local data
            </Button>
          </details>
        ) : null}
        {resetFailed ? (
          <p data-ui="workspace-bootstrap-inline-error" role="alert">
            Reset did not complete. Close other Natter tabs and try again.
          </p>
        ) : null}
      </section>
      {resetConfirmOpen ? (
        <ConfirmDialog
          title="Reset all local Natter data?"
          confirmLabel="Reset everything"
          busyLabel="Resetting…"
          busy={resetBusy}
          initialFocus="cancel"
          onCancel={() => setResetConfirmOpen(false)}
          onConfirm={reset}
          closeLabel="Cancel workspace reset"
        >
          <blockquote data-ui="confirm-delete-preview">
            This cannot be undone. It removes chats, attachments, connections, saved keys, and local
            settings from this browser origin.
          </blockquote>
        </ConfirmDialog>
      ) : null}
    </main>
  )
}

class RootErrorBoundary extends Component<RootBoundaryProps, RootBoundaryState> {
  override state: RootBoundaryState = { error: null, occurredAt: null }

  static getDerivedStateFromError(error: unknown): RootBoundaryState {
    return { error, occurredAt: nowIso() }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Natter root render failed', redactDiagnosticValue(error), {
      componentDepth: info.componentStack?.split('\n').filter(Boolean).length ?? 0,
    })
  }

  private retry = () => {
    this.setState({ error: null, occurredAt: null })
  }

  override render() {
    if (this.state.occurredAt !== null) {
      return (
        <RecoveryView
          stage="render"
          error={this.state.error}
          occurredAt={this.state.occurredAt}
          onRetry={this.retry}
          onReload={this.props.reload}
          {...(this.props.resetWorkspace ? { onReset: this.props.resetWorkspace } : {})}
        />
      )
    }
    return this.props.children
  }
}

export function WorkspaceBootstrap({
  children,
  openWorkspace,
  onReady,
  resetWorkspace,
  reload = () => window.location.reload(),
}: WorkspaceBootstrapProps) {
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<OpenPhase>({
    kind: 'opening',
    attempt: 0,
    progress: INITIAL_OPEN_PROGRESS,
  })
  const [presentationSuspensionGeneration, setPresentationSuspensionGeneration] = useState<
    number | null
  >(null)
  const presentationSuspensionAckRef = useRef<{
    readonly generation: number
    readonly resolve: () => void
  } | null>(null)
  const currentAttemptRef = useRef(0)
  const readyNotifiedAttemptRef = useRef<number | null>(null)
  const openAttemptRef = useRef<{
    attempt: number
    opener: WorkspaceBootstrapProps['openWorkspace']
    promise: Promise<unknown>
    blocked: { oldVersion: number; newVersion: number | null } | null
    progress: BrowserWorkspaceOpenProgress
    blockedListeners: Set<(blocked: { oldVersion: number; newVersion: number | null }) => void>
    progressListeners: Set<(progress: BrowserWorkspaceOpenProgress) => void>
  } | null>(null)

  useEffect(
    () =>
      registerWorkspacePresentationRoot(
        ({ generation }) =>
          new Promise<void>((resolve) => {
            presentationSuspensionAckRef.current = { generation, resolve }
            setPresentationSuspensionGeneration(generation)
          }),
      ),
    [],
  )

  useEffect(() => {
    if (presentationSuspensionGeneration === null) return
    const pendingAck = presentationSuspensionAckRef.current
    if (!pendingAck || pendingAck.generation !== presentationSuspensionGeneration) return
    presentationSuspensionAckRef.current = null
    pendingAck.resolve()
  }, [presentationSuspensionGeneration])

  useEffect(() => {
    if (phase.kind !== 'ready' || readyNotifiedAttemptRef.current === attempt) return
    readyNotifiedAttemptRef.current = attempt
    onReady?.()
  }, [attempt, onReady, phase.kind])

  useEffect(() => {
    if (attempt !== currentAttemptRef.current) return
    let active = true
    const handleBlocked = (blocked: { oldVersion: number; newVersion: number | null }) => {
      if (!active) return
      setPhase({
        kind: 'blocked',
        oldVersion: blocked.oldVersion,
        newVersion: blocked.newVersion,
        occurredAt: nowIso(),
      })
    }
    const handleProgress = (progress: BrowserWorkspaceOpenProgress) => {
      if (!active) return
      setPhase({ kind: 'opening', attempt, progress })
    }
    let openAttempt = openAttemptRef.current
    if (!openAttempt || openAttempt.attempt !== attempt || openAttempt.opener !== openWorkspace) {
      const blockedListeners = new Set<
        (blocked: { oldVersion: number; newVersion: number | null }) => void
      >()
      const progressListeners = new Set<(progress: BrowserWorkspaceOpenProgress) => void>()
      openAttempt = {
        attempt,
        opener: openWorkspace,
        blocked: null,
        progress: INITIAL_OPEN_PROGRESS,
        blockedListeners,
        progressListeners,
        promise: Promise.resolve().then(() =>
          openWorkspace({
            onBlocked: (event) => {
              if (currentAttemptRef.current !== attempt) return
              const current = openAttemptRef.current
              if (!current || current.attempt !== attempt || current.opener !== openWorkspace)
                return
              current.blocked = { oldVersion: event.oldVersion, newVersion: event.newVersion }
              for (const listener of [...current.blockedListeners]) listener(current.blocked)
            },
            onProgress: (progress) => {
              if (currentAttemptRef.current !== attempt) return
              const current = openAttemptRef.current
              if (!current || current.attempt !== attempt || current.opener !== openWorkspace)
                return
              current.progress = progress
              for (const listener of [...current.progressListeners]) listener(progress)
            },
          }),
        ),
      }
      openAttemptRef.current = openAttempt
    }
    openAttempt.blockedListeners.add(handleBlocked)
    openAttempt.progressListeners.add(handleProgress)
    handleProgress(openAttempt.progress)
    if (openAttempt.blocked) handleBlocked(openAttempt.blocked)
    void openAttempt.promise.then(
      () => {
        if (active && currentAttemptRef.current === attempt) setPhase({ kind: 'ready' })
      },
      (error: unknown) => {
        if (active && currentAttemptRef.current === attempt) {
          setPhase({ kind: 'failed', error, occurredAt: nowIso() })
        }
      },
    )
    return () => {
      active = false
      openAttempt.blockedListeners.delete(handleBlocked)
      openAttempt.progressListeners.delete(handleProgress)
    }
  }, [attempt, openWorkspace])

  const retryOpen = () => {
    const nextAttempt = currentAttemptRef.current + 1
    currentAttemptRef.current = nextAttempt
    setPhase({ kind: 'opening', attempt: nextAttempt, progress: INITIAL_OPEN_PROGRESS })
    setAttempt(nextAttempt)
  }

  if (presentationSuspensionGeneration !== null) {
    return (
      <main data-ui="workspace-bootstrap" data-state="suspending">
        <section data-ui="workspace-bootstrap-card" role="status" aria-live="polite">
          <span data-ui="workspace-bootstrap-kicker">Local workspace</span>
          <h1>Closing local workspace…</h1>
          <p>Finishing active views before local storage is replaced.</p>
        </section>
      </main>
    )
  }

  return (
    <RootErrorBoundary reload={reload} {...(resetWorkspace ? { resetWorkspace } : {})}>
      {children}
      {phase.kind === 'opening' ? (
        <main
          data-ui="workspace-bootstrap"
          data-state="opening"
          data-presentation="nonblocking"
          data-open-stage={phase.progress.kind}
          data-open-operation={'operation' in phase.progress ? phase.progress.operation : undefined}
        >
          <section data-ui="workspace-bootstrap-card" role="status" aria-live="polite">
            <span data-ui="workspace-bootstrap-kicker">Natter</span>
            <h1>Opening local workspace…</h1>
            <p>{openingCopy(phase.progress)}</p>
            <details data-ui="workspace-bootstrap-opening-diagnostics">
              <summary>Opening diagnostics</summary>
              <section aria-label="Opening diagnostics">
                <pre>{openingDiagnosticsText(phase.attempt, phase.progress)}</pre>
              </section>
            </details>
          </section>
        </main>
      ) : phase.kind === 'ready' ? null : (
        <RecoveryView
          stage="database-open"
          {...(phase.kind === 'blocked'
            ? {
                blocked: { oldVersion: phase.oldVersion, newVersion: phase.newVersion },
                occurredAt: phase.occurredAt,
              }
            : { error: phase.error, occurredAt: phase.occurredAt })}
          onRetry={retryOpen}
          onReload={reload}
          {...(resetWorkspace ? { onReset: resetWorkspace } : {})}
        />
      )}
    </RootErrorBoundary>
  )
}
