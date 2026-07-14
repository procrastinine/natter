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
import { Button } from '../ui/primitives/Button'
import { ConfirmDialog } from '../ui/primitives/ConfirmDialog'

export interface WorkspaceOpenOptions {
  onBlocked?: (event: IDBVersionChangeEvent) => void
}

interface WorkspaceBootstrapProps {
  children: ReactNode
  openWorkspace: (options: WorkspaceOpenOptions) => Promise<unknown>
  beforeRetry?: () => void
  resetWorkspace?: () => Promise<void>
  reload?: () => void
}

type OpenPhase =
  | { kind: 'opening'; attempt: number }
  | { kind: 'blocked'; oldVersion: number; newVersion: number | null; occurredAt: string }
  | { kind: 'failed'; error: unknown; occurredAt: string }
  | { kind: 'ready' }

type RecoveryCategory = 'quota' | 'version' | 'migration' | 'render' | 'general'

interface RecoveryViewProps {
  stage: 'database-open' | 'render'
  error?: unknown
  blocked?: { oldVersion: number; newVersion: number | null } | undefined
  occurredAt: string
  onRetry: () => void
  onReload: () => void
  onReset?: () => Promise<void>
}

interface RootBoundaryProps {
  children: ReactNode
  reload: () => void
  resetWorkspace?: () => Promise<void>
}

interface RootBoundaryState {
  error: unknown
  occurredAt: string | null
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
  beforeRetry,
  resetWorkspace,
  reload = () => window.location.reload(),
}: WorkspaceBootstrapProps) {
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<OpenPhase>({ kind: 'opening', attempt: 0 })
  const blockedHandlerRef = useRef<(event: IDBVersionChangeEvent) => void>(() => {})
  const openAttemptRef = useRef<{
    attempt: number
    opener: WorkspaceBootstrapProps['openWorkspace']
    promise: Promise<unknown>
  } | null>(null)

  useEffect(() => {
    let active = true
    setPhase({ kind: 'opening', attempt })
    const handleBlocked = (event: IDBVersionChangeEvent) => {
      if (!active) return
      setPhase({
        kind: 'blocked',
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
        occurredAt: nowIso(),
      })
    }
    blockedHandlerRef.current = handleBlocked
    let openAttempt = openAttemptRef.current
    if (!openAttempt || openAttempt.attempt !== attempt || openAttempt.opener !== openWorkspace) {
      openAttempt = {
        attempt,
        opener: openWorkspace,
        promise: Promise.resolve().then(() =>
          openWorkspace({
            onBlocked: (event) => blockedHandlerRef.current(event),
          }),
        ),
      }
      openAttemptRef.current = openAttempt
    }
    void openAttempt.promise.then(
      () => {
        if (active) setPhase({ kind: 'ready' })
      },
      (error: unknown) => {
        if (active) setPhase({ kind: 'failed', error, occurredAt: nowIso() })
      },
    )
    return () => {
      active = false
      if (blockedHandlerRef.current === handleBlocked) blockedHandlerRef.current = () => {}
    }
  }, [attempt, openWorkspace])

  const retryOpen = () => {
    beforeRetry?.()
    setAttempt((current) => current + 1)
  }

  if (phase.kind === 'ready') {
    return (
      <RootErrorBoundary reload={reload} {...(resetWorkspace ? { resetWorkspace } : {})}>
        {children}
      </RootErrorBoundary>
    )
  }

  if (phase.kind === 'opening') {
    return (
      <main data-ui="workspace-bootstrap" data-state="opening">
        <section data-ui="workspace-bootstrap-card" role="status" aria-live="polite">
          <span data-ui="workspace-bootstrap-kicker">Natter</span>
          <h1>Opening local workspace…</h1>
          <p>Applying any required database upgrades before loading chats.</p>
        </section>
      </main>
    )
  }

  return (
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
  )
}
