export function installDebugNuke(): void {
  if (typeof window === 'undefined') return
  ;(
    window as unknown as {
      __nuke: (opts?: { skipReload?: boolean }) => Promise<void>
    }
  ).__nuke = async (opts) => {
    const { clearLocalWorkspaceStorage } = await import('../src/store/storage-administration')
    await clearLocalWorkspaceStorage(opts)
  }
  console.info(
    '%c[debug] window.__nuke() — wipe IDB / storage / cookies / cache and reload.',
    'color:#888;font-style:italic',
  )
}
