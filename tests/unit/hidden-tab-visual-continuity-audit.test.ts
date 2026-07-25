import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const AUDIT_URL = pathToFileURL(
  resolve(ROOT, 'scripts/audit-hidden-tab-visual-continuity.mjs'),
).href
const INVENTORY_URL = pathToFileURL(
  resolve(ROOT, 'scripts/hidden-tab-visual-continuity-inventory.mjs'),
).href

interface PaintedSurface {
  readonly id: string
  readonly locator: string
  readonly [field: string]: unknown
}

interface HiddenTabProof {
  readonly id: string
  readonly requiredLocators?: readonly string[]
  readonly [field: string]: unknown
}

interface ContinuityAcceptance {
  readonly id: string
  readonly proofKinds: readonly string[]
  readonly [field: string]: unknown
}

interface HiddenTabInventory {
  readonly HIDDEN_TAB_PAINTED_SURFACES: readonly PaintedSurface[]
  readonly HIDDEN_TAB_PRESENTATION_TRANSITIONS: readonly Readonly<Record<string, unknown>>[]
  readonly HIDDEN_TAB_EXISTING_PROOFS: readonly HiddenTabProof[]
  readonly HIDDEN_TAB_VISUAL_CONTINUITY_GAPS: readonly Readonly<Record<string, unknown>>[]
  readonly HIDDEN_TAB_VISUAL_CONTINUITY_ACCEPTANCE: readonly ContinuityAcceptance[]
}

interface HiddenTabReport {
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly surfaceCount: number
  readonly transitionCount: number
  readonly proofCount: number
  readonly gapCount: number
  readonly acceptanceCount: number
  readonly gaps: readonly { readonly id: string }[]
  readonly problems: readonly string[]
}

interface HiddenTabAuditModule {
  evaluateHiddenTabVisualContinuity(
    inventory: unknown,
    mode: 'inventory' | 'enforce',
    root: string,
  ): HiddenTabReport
  auditHiddenTabVisualContinuity(
    root: string,
    inventory: unknown,
  ): { readonly problems: readonly string[] }
}

let inventory: HiddenTabInventory
let auditHiddenTabVisualContinuity: HiddenTabAuditModule['auditHiddenTabVisualContinuity']
let evaluateHiddenTabVisualContinuity: HiddenTabAuditModule['evaluateHiddenTabVisualContinuity']

beforeAll(async () => {
  const loadedAudit: unknown = await import(AUDIT_URL)
  const loadedInventory: unknown = await import(INVENTORY_URL)
  const audit = loadedAudit as HiddenTabAuditModule
  inventory = loadedInventory as HiddenTabInventory
  auditHiddenTabVisualContinuity = audit.auditHiddenTabVisualContinuity
  evaluateHiddenTabVisualContinuity = audit.evaluateHiddenTabVisualContinuity
})

describe('hidden-tab visual continuity architecture audit', () => {
  it('keeps every painted surface, transition, proof, gap, and acceptance invariant explicit', () => {
    const result = evaluateHiddenTabVisualContinuity(inventory, 'inventory', ROOT)

    expect(result).toMatchObject({
      ok: true,
      structurallyValid: true,
      surfaceCount: 8,
      transitionCount: 4,
      proofCount: 10,
      gapCount: 0,
      acceptanceCount: 7,
      problems: [],
    })
    expect(result.gaps).toEqual([])
  })

  it('closes enforce mode only with the native headed proof set', () => {
    const result = evaluateHiddenTabVisualContinuity(inventory, 'enforce', ROOT)

    expect(result.ok).toBe(true)
    expect(result.structurallyValid).toBe(true)
    expect(result.gapCount).toBe(0)
    expect(result.problems).toEqual([])
  })

  it('rejects an omitted surface or a stale source locator', () => {
    const mutated = {
      ...inventory,
      HIDDEN_TAB_PAINTED_SURFACES: inventory.HIDDEN_TAB_PAINTED_SURFACES.filter(
        (surface) => surface.id !== 'profile-glyph-svg',
      ).map((surface) =>
        surface.id === 'connection-provider-svg'
          ? { ...surface, locator: 'retiredConnectionProviderAsset()' }
          : surface,
      ),
    }
    const result = evaluateHiddenTabVisualContinuity(mutated, 'inventory', ROOT)

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'surfaces: missing id: profile-glyph-svg',
        'surfaces: canonical order changed',
        'surfaces:connection-provider-svg: locator occurrences=0; expected=1: retiredConnectionProviderAsset()',
      ]),
    )
  })

  it('rejects an invented proof kind or dynamic resident import', () => {
    const mutated = {
      ...inventory,
      HIDDEN_TAB_PAINTED_SURFACES: inventory.HIDDEN_TAB_PAINTED_SURFACES.map((surface) =>
        surface.id === 'chat-settings-static-bundle'
          ? { ...surface, locator: "import('../ui/settings/ChatModelPanel')" }
          : surface,
      ),
      HIDDEN_TAB_VISUAL_CONTINUITY_ACCEPTANCE:
        inventory.HIDDEN_TAB_VISUAL_CONTINUITY_ACCEPTANCE.map((entry) =>
          entry.id === 'real-tab-first-frame-continuity'
            ? { ...entry, proofKinds: ['browser', 'paint-by-hope'] }
            : entry,
        ),
    }
    const result = evaluateHiddenTabVisualContinuity(mutated, 'inventory', ROOT)

    expect(result.ok).toBe(false)
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'acceptance:real-tab-first-frame-continuity: invalid proof kind: paint-by-hope',
        "surfaces:chat-settings-static-bundle: locator occurrences=0; expected=1: import('../ui/settings/ChatModelPanel')",
        'surfaces:chat-settings-static-bundle: resident surface uses a dynamic import',
      ]),
    )
  })

  it('rejects a headed proof whose required runtime assertion disappears', () => {
    const mutated = {
      ...inventory,
      HIDDEN_TAB_EXISTING_PROOFS: inventory.HIDDEN_TAB_EXISTING_PROOFS.map((proof) =>
        proof.id === 'first-foreground-paint-fingerprints'
          ? { ...proof, requiredLocators: ['retiredForegroundPixelAssertion()'] }
          : proof,
      ),
    }
    const result = evaluateHiddenTabVisualContinuity(mutated, 'inventory', ROOT)

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(
      'proofs:first-foreground-paint-fingerprints: locator occurrences=0; expected=1: retiredForegroundPixelAssertion()',
    )
  })

  it('keeps the pure inventory validator available to the CLI and test harness', () => {
    expect(auditHiddenTabVisualContinuity(ROOT, inventory).problems).toEqual([])
  })
})
