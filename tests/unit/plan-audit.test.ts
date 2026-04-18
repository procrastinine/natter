// Phase 0 static audit: the interaction inventory and stylesheet ownership
// tables must exist in `plan/10-ui.md` before UI implementation starts, and
// every inventory row must name at least one UI surface and at least one
// stylesheet that is declared as owning something.
//
// See `plan/13-delivery.md §13.2.3`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PLAN_UI_PATH = resolve(__dirname, '../../../plan/10-ui.md')

function readPlan(): string {
  return readFileSync(PLAN_UI_PATH, 'utf8')
}

// Extracts every row of every pipe-table inside the given section bounds.
// Returns a list of { columns: string[] } where the first two rows (header +
// separator) are dropped.
function extractTableRows(markdown: string): string[][] {
  const lines = markdown.split('\n')
  const rows: string[][] = []
  let inTable = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      inTable = false
      continue
    }
    // Separator row like `|---|---|`
    if (/^\|[\s:\-|]+\|$/.test(trimmed)) {
      inTable = true
      continue
    }
    if (!inTable) continue
    const columns = trimmed
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim())
    rows.push(columns)
  }
  return rows
}

function sliceSection(markdown: string, startHeading: RegExp, endHeading: RegExp): string {
  const start = markdown.search(startHeading)
  const end = markdown.search(endHeading)
  if (start < 0) return ''
  const to = end > start ? end : markdown.length
  return markdown.slice(start, to)
}

describe('Phase 0 plan audit — interaction inventory', () => {
  const plan = readPlan()
  const inventory = sliceSection(plan, /^## 10\.19\b/m, /^## 10\.20\b/m)
  const ownership = sliceSection(plan, /^## 10\.20\b/m, /^## 10\.21\b/m)

  it('plan/10-ui.md §10.19 (interaction inventory) is present', () => {
    expect(inventory.length).toBeGreaterThan(0)
    expect(inventory).toMatch(/^## 10\.19 Interaction inventory/)
  })

  it('plan/10-ui.md §10.20 (stylesheet file ownership) is present', () => {
    expect(ownership.length).toBeGreaterThan(0)
    expect(ownership).toMatch(/^## 10\.20 Stylesheet file ownership/)
  })

  it('inventory has many rows (not a placeholder stub)', () => {
    const rows = extractTableRows(inventory)
    expect(rows.length).toBeGreaterThan(100)
  })

  it('every inventory row names at least one UI surface and one stylesheet', () => {
    const rows = extractTableRows(inventory)
    const declared = declaredStylesheets(ownership)
    expect(declared.size).toBeGreaterThan(10)

    const failures: string[] = []
    for (const row of rows) {
      if (row.length < 4) continue
      const [interaction, surface, _components, stylesheets] = row as [
        string,
        string,
        string,
        string,
      ]
      if (!surface.trim()) {
        failures.push(`Missing UI surface for interaction: ${interaction}`)
        continue
      }
      // `(none)` in the stylesheet column marks a deliberate non-rendered row
      // (see §10.19 intro). Skip the stylesheet presence check for these.
      if (stylesheets.trim() === '(none)') continue
      const refs = extractStylesheetRefs(stylesheets)
      if (refs.length === 0) {
        failures.push(`No stylesheet referenced for interaction: ${interaction}`)
        continue
      }
      const unknown = refs.filter((name) => !declared.has(name))
      if (unknown.length > 0) {
        failures.push(
          `Interaction "${interaction}" references undeclared stylesheet(s): ${unknown.join(', ')}`,
        )
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
  })
})

function extractStylesheetRefs(cell: string): string[] {
  // Matches `name.css` regardless of backticks or surrounding punctuation.
  const matches = cell.match(/[a-z0-9][a-z0-9_-]*\.css/gi) ?? []
  return Array.from(new Set(matches.map((m) => m.toLowerCase())))
}

function declaredStylesheets(ownership: string): Set<string> {
  const rows = extractTableRows(ownership)
  const declared = new Set<string>()
  for (const row of rows) {
    if (row.length === 0) continue
    const first = row[0] ?? ''
    for (const match of first.matchAll(/[a-z0-9][a-z0-9_-]*\.css/gi)) {
      declared.add(match[0].toLowerCase())
    }
  }
  return declared
}
