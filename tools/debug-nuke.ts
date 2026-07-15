export function installDebugNuke(): void {
  if (typeof window === 'undefined') return
  ;(
    window as unknown as {
      __nuke: (opts?: { skipReload?: boolean }) => Promise<void>
    }
  ).__nuke = async (opts) => {
    const { wipeSiteStorage } = await import('../src/lib/storage-wipe')
    await wipeSiteStorage(opts)
  }
  console.info(
    '%c[debug] window.__nuke() — wipe IDB / storage / cookies / cache and reload.',
    'color:#888;font-style:italic',
  )
}
