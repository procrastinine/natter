import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(process.cwd(), 'src')
const ALLOWED_BACKCOMPAT_IMPORTERS = new Set(['store/db.ts', 'store/import-export.ts'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx'])

describe('backcompat boundary', () => {
  it('keeps compatibility imports behind the DB migration entry point', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/')
      if (rel.startsWith('backcompat/')) continue
      if (ALLOWED_BACKCOMPAT_IMPORTERS.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      if (importsBackcompat(source)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('does not keep removed schema branches in live source', () => {
    const forbidden = [
      'usePreferredOrdering',
      'privacy.ignoreProviders',
      'privacy.onlyProviders',
      'providerPrefs.dataCollection',
      'providerPrefs.zdr',
      'carryForward',
      'AttachmentRef = AttachmentId',
      "typeof ref === 'string'",
      '"global:auto-scroll"',
      "'global:auto-scroll'",
      'natter:active-profile-id',
    ]
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join('/')
      if (rel.startsWith('backcompat/')) continue
      const source = readFileSync(file, 'utf8')
      for (const needle of forbidden) {
        if (source.includes(needle)) offenders.push(`${rel}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

function importsBackcompat(source: string): boolean {
  return (
    /from\s+['"][^'"]*backcompat\//.test(source) ||
    /import\s*\([^)]*['"][^'"]*backcompat\//.test(source)
  )
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    const ext = path.slice(path.lastIndexOf('.'))
    if (SOURCE_EXTENSIONS.has(ext)) out.push(path)
  }
  return out
}
