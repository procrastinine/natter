import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { staticAuditState } from './audit-result-state.mjs'
import { buildTestEvidenceInventory, TEST_EVIDENCE_DIMENSIONS } from './test-evidence-inventory.mjs'
import {
  ALLOWED_DEV_BUILT_DIVERGENCES,
  DECLARED_TEST_DOMAINS,
  TEST_GUARANTEE_CLAIMS,
} from './test-evidence-manifest.mjs'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const PNPM_ACTION_SETUP_REVISION = '0977fd99725f1db4007ccb2928dbb4e90d06cc86'
const MINIMUM_VERIFY_TIMEOUT_MINUTES = 90
const VALID_STATUSES = new Set(['covered', 'partial', 'gap'])
const VALID_PROOF_KINDS = new Set([
  'static',
  'unit',
  'integration',
  'browser',
  'performance',
  'live',
])
const REQUIRED_INTERROGATED_IDS = new Set([
  'startup-active-stream-shell-clickability',
  'hidden-tab-projection-visual-continuity',
  'background-new-chat-first-activation',
  'destination-first-transcript-prepend-scroll-continuity',
  'pending-generation-capability-preserves-first-submit-intent',
  'destination-frame-complete-window-budget',
  'dev-and-built-artifact-exercise-equivalent-application-paths',
  'verification-hygiene-failures-affect-exit-code',
  'verification-performance-stage-measures-current-runtime',
  'isolated-send-critical-path-latency',
  'every-presentation-interaction-site-has-outcome-proof',
])

export function auditTestEvidence(options = {}) {
  const root = options.root ?? DEFAULT_ROOT
  const inventory = options.inventory ?? buildTestEvidenceInventory(root)
  const declaredDomains = options.declaredDomains ?? DECLARED_TEST_DOMAINS
  const claims = options.claims ?? TEST_GUARANTEE_CLAIMS
  const allowedDivergences = options.allowedDivergences ?? ALLOWED_DEV_BUILT_DIVERGENCES
  const problems = []
  const canonicalDomains = new Set(inventory.canonicalDomains ?? [])
  const fileByPath = uniqueByPath(inventory.files, problems)

  validateDeclaredDomains({ declaredDomains, canonicalDomains, fileByPath, problems })
  for (const file of fileByPath.values()) validateFile(file, canonicalDomains, problems)
  validateClaims({ claims, root, fileByPath, problems })
  validateInteractionEvidence(inventory.interactionEvidence, problems)
  const parity = validateVerificationParity(root, problems)
  const divergences = validateDevBuiltDivergences(root, allowedDivergences, problems)
  for (const requiredId of REQUIRED_INTERROGATED_IDS) {
    const claim = claims.find((candidate) => candidate.id === requiredId)
    if (!claim) problems.push(`claims: missing required interrogated guarantee: ${requiredId}`)
  }

  const suites = [...fileByPath.values()].filter((file) =>
    ['suite', 'embedded-suite'].includes(file.role),
  )
  const supportFiles = [...fileByPath.values()].filter((file) => file.role === 'support')
  const fixtureFiles = [...fileByPath.values()].filter((file) => file.role === 'fixture')
  const testDefinitions = suites.flatMap((file) => file.definitions.tests)
  const activeDefinitions = testDefinitions.filter((definition) => definition.status === 'active')
  const dynamicDefinitions = testDefinitions.filter(
    (definition) => definition.titleKind !== 'static',
  )
  const statusCounts = countBy(claims, (claim) => claim.status)
  const proofKindCounts = countMany(suites, (file) => file.proofKinds)
  const dimensionCounts = countMany(suites, (file) => Object.keys(file.evidenceSignals))
  const domainCounts = countMany(suites, (file) => file.domains)
  const gaps = claims
    .filter((claim) => claim.status !== 'covered')
    .map((claim) => ({
      id: claim.id,
      status: claim.status,
      rationale: claim.rationale,
      ...(claim.missing ? { missing: claim.missing } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return Object.freeze({
    ok: problems.length === 0,
    structurallyValid: problems.length === 0,
    counts: Object.freeze({
      files: fileByPath.size,
      suites: suites.length,
      supportFiles: supportFiles.length,
      fixtureFiles: fixtureFiles.length,
      testDefinitions: testDefinitions.length,
      activeDefinitions: activeDefinitions.length,
      dynamicDefinitions: dynamicDefinitions.length,
      guaranteeClaims: claims.length,
    }),
    statusCounts: Object.freeze(statusCounts),
    proofKindCounts: Object.freeze(proofKindCounts),
    dimensionCounts: Object.freeze(dimensionCounts),
    domainCounts: Object.freeze(domainCounts),
    gaps: Object.freeze(gaps),
    parity,
    divergences,
    problems: Object.freeze(problems.sort()),
    inventory,
  })
}

function validateInteractionEvidence(interactionEvidence, problems) {
  if (!interactionEvidence || !Array.isArray(interactionEvidence.sites)) {
    problems.push('interaction-evidence: exact sites must be an array')
    return
  }
  const ids = new Set()
  for (const site of interactionEvidence.sites) {
    if (!site.id || !site.path || !site.line || !site.kind || !site.event) {
      problems.push('interaction-evidence: incomplete site metadata')
      continue
    }
    if (ids.has(site.id)) problems.push(`interaction-evidence: duplicate site id: ${site.id}`)
    ids.add(site.id)
  }
  if (interactionEvidence.siteCount !== interactionEvidence.sites.length) {
    problems.push('interaction-evidence: siteCount does not match exact site inventory')
  }
  if (interactionEvidence.perSiteOutcomeProofCount !== 0) {
    problems.push(
      'interaction-evidence: per-site proof cannot be inferred from source-level candidate tests',
    )
  }
}

function validateVerificationParity(root, problems) {
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8')
  const ciRunner = readFileSync(resolve(root, 'scripts/run-ci-verification.mjs'), 'utf8')
  const runner = readFileSync(resolve(root, 'scripts/run-verification.mjs'), 'utf8')
  const playwright = readFileSync(resolve(root, 'playwright.config.ts'), 'utf8')
  const nodeVersion = readFileSync(resolve(root, '.node-version'), 'utf8').trim()
  const dependencyImage = readFileSync(
    resolve(root, 'scripts/verification-dependency-image.mjs'),
    'utf8',
  )
  const dependencyImageTest = readFileSync(
    resolve(root, 'tests/unit/verification-dependency-image.test.ts'),
    'utf8',
  )
  const verifyTimeoutMinutes = Number(/timeout-minutes:\s*(\d+)/u.exec(workflow)?.[1])
  const assertions = [
    parityAssertion(
      'shared-entrypoint',
      packageJson.scripts?.['verify:ci'] === 'node scripts/run-ci-verification.mjs' &&
        packageJson.scripts?.['verify:exact'] === 'node scripts/run-verification.mjs' &&
        packageJson.scripts?.['verify:slice'] === 'node scripts/launch-slice-verification.mjs' &&
        typeof packageJson.scripts?.['verify:migration-cut'] === 'string' &&
        occurrences(workflow, 'run: pnpm verify:ci') === 1 &&
        workflow.indexOf('run: pnpm install --frozen-lockfile') <
          workflow.indexOf('run: pnpm verify:ci') &&
        ciRunner.includes("currentWaveManifest.mode === 'breaking-migration'") &&
        ciRunner.includes("import('./plan-slice-verification.mjs')") &&
        ciRunner.includes("import('./verification-candidate-preparation.mjs')") &&
        ciRunner.includes("import('./launch-slice-verification.mjs')") &&
        ciRunner.includes("runnerKind: 'checkpoint'") &&
        workflow.includes('test-results/verification-checkpoint/') &&
        workflow.includes('test-results/verification-stages/'),
      'Local and CI share pnpm verify:ci, which explicitly dispatches migration work or the sealed candidate gate and preserves its evidence.',
    ),
    parityAssertion(
      'cross-browser-gate',
      workflow.includes('playwright install --with-deps chromium firefox') &&
        runner.includes("stage('chromium-e2e'") &&
        runner.includes("'firefox-e2e',") &&
        runner.indexOf("'firefox-e2e',") > runner.indexOf("stage('chromium-e2e'"),
      'The sealed local and GitHub checkpoint executes both required browser engines against the same production artifact.',
    ),
    parityAssertion(
      'isolated-send-latency',
      playwright.includes("name: 'chromium-send-performance'") &&
        playwright.includes("name: 'firefox-send-performance'") &&
        playwright.includes('testMatch: sendPerformanceSpec') &&
        playwright.includes("? ['chromium-large-workspace']") &&
        playwright.includes("dependencies: ['firefox']") &&
        runner.includes("'--project=chromium-send-performance'") &&
        runner.includes("'--project=firefox-send-performance'"),
      'Strict send latency runs alone after each complete engine suite, so unrelated parallel stress CPU cannot enter its wall clock.',
    ),
    parityAssertion(
      'pinned-node',
      packageJson.engines?.node === nodeVersion &&
        workflow.includes('node-version-file: .node-version'),
      'The package engine, local pin, and GitHub setup use the same Node version.',
    ),
    parityAssertion(
      'pinned-pnpm',
      /^pnpm@\d+\.\d+\.\d+$/u.test(packageJson.packageManager ?? '') &&
        workflow.includes(`pnpm/action-setup@${PNPM_ACTION_SETUP_REVISION}`) &&
        dependencyImage.includes('resolvePnpmLauncherTarget') &&
        dependencyImage.includes('node_modules/.modules.yaml') &&
        dependencyImageTest.includes("uses the source install's recorded store") &&
        dependencyImageTest.includes(PNPM_ACTION_SETUP_REVISION),
      'The immutable pnpm action, its self-update shim layout, exact packageManager target and source-install store authority are locally coupled.',
    ),
    parityAssertion(
      'ci-time-budget',
      verifyTimeoutMinutes >= MINIMUM_VERIFY_TIMEOUT_MINUTES,
      'The GitHub job budget exceeds the measured unchanged-candidate verification duration.',
    ),
    parityAssertion(
      'non-fail-fast-runner',
      runner.includes('for (let index = 0; index < stages.length; index += 1)') &&
        runner.includes("execution: 'sequential-non-fail-fast'"),
      'The runner records every independent stage and defers its aggregate exit code.',
    ),
    parityAssertion(
      'fixed-child-environment',
      runner.includes("E2E_DEV_PORT: '4175'") &&
        runner.includes("E2E_FAKE_PROVIDER_PORT: '4174'") &&
        runner.includes("E2E_PORT: '4173'") &&
        runner.includes("E2E_SERIALIZE_LARGE_WORKSPACE_CLOSURE: '1'") &&
        runner.includes("TZ: 'UTC'"),
      'All child stages receive fixed ports, timezone, and isolated large-workspace browser ordering.',
    ),
    parityAssertion(
      'built-preview-browser-path',
      playwright.includes("process.env.E2E_SKIP_BUILD === '1'") &&
        playwright.includes('command: applicationServerCommand') &&
        playwright.includes("process.env.E2E_REUSE_EXISTING_SERVER === '1'") &&
        runner.includes("stage('production-build'") &&
        runner.includes("'firefox-e2e',") &&
        runner.includes("'headed-hidden-tab-visual-continuity',") &&
        runner.includes("'dev-preview-parity',") &&
        runner.includes('].includes(item.id)'),
      'Direct Playwright builds then previews, while checkpoint execution builds once and every later browser workload consumes that exact artifact.',
    ),
    parityAssertion(
      'dev-preview-public-path',
      runner.includes("'dev-preview-parity',") &&
        runner.includes("environment.E2E_DEV_PREVIEW_PARITY = '1'") &&
        playwright.includes('const devPreviewParity = process.env.E2E_DEV_PREVIEW_PARITY') &&
        playwright.includes("name: 'chromium-preview-parity'") &&
        playwright.includes("name: 'chromium-dev-parity'") &&
        playwright.includes('testMatch: devPreviewParitySpec'),
      'One blocking runtime stage executes the same public-path spec against Vite dev and the already-built preview.',
    ),
    parityAssertion(
      'external-fake-provider',
      playwright.includes('$' + '{packageManagerCommand} fake-provider') &&
        playwright.includes('/healthz'),
      'The provider harness is a separate loopback server.',
    ),
    parityAssertion(
      'ci-does-not-bypass-runner',
      !/^\s*run:\s+.*(?:vitest|playwright test|pnpm (?:test|e2e))\b/mu.test(workflow),
      'GitHub does not replace the shared runner with a shorter test command.',
    ),
  ]
  for (const assertion of assertions) {
    if (!assertion.satisfied)
      problems.push(`verification-parity:${assertion.id}: ${assertion.detail}`)
  }
  return Object.freeze({
    nodeVersion,
    packageManager: packageJson.packageManager ?? null,
    assertions: Object.freeze(assertions),
    unavoidableEnvironmentDifferences: Object.freeze([
      'operating-system',
      'CI and GITHUB_ACTIONS environment flags',
      'GitHub-hosted Chromium system dependencies',
    ]),
  })
}

function validateDevBuiltDivergences(root, allowedDivergences, problems) {
  const discovered = []
  for (const path of walkAuditSourceFiles(resolve(root, 'src'), root)) {
    const source = readFileSync(resolve(root, path), 'utf8')
    if (source.includes('import.meta.env.DEV')) {
      discovered.push({ path, locator: 'import.meta.env.DEV' })
    }
    for (const match of source.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]*)/gu)) {
      if (match[1] !== 'DEV') {
        problems.push(`dev-built-divergence:${path}: unclassified environment gate: ${match[0]}`)
      }
    }
  }
  const viteConfig = readFileSync(resolve(root, 'vite.config.ts'), 'utf8')
  if (viteConfig.includes("'/_or_scrape': {")) {
    discovered.push({ path: 'vite.config.ts', locator: "'/_or_scrape': {" })
  }

  const discoveredKeys = new Set(discovered.map((site) => `${site.path}#${site.locator}`))
  const allowedKeys = new Set()
  for (const divergence of allowedDivergences) {
    const key = `${divergence.path}#${divergence.locator}`
    if (allowedKeys.has(key)) problems.push(`dev-built-divergence: duplicate allowance: ${key}`)
    allowedKeys.add(key)
    if (!divergence.id || !divergence.category || !divergence.rationale) {
      problems.push(`dev-built-divergence:${key}: incomplete allowance metadata`)
    }
    validateReference(divergence, root, `dev-built-divergence:${divergence.id}`, problems)
    if (!discoveredKeys.has(key)) {
      problems.push(`dev-built-divergence: stale allowance: ${key}`)
    }
  }
  for (const site of discovered) {
    const key = `${site.path}#${site.locator}`
    if (!allowedKeys.has(key)) problems.push(`dev-built-divergence: unclassified gate: ${key}`)
  }
  return Object.freeze({
    discoveredRuntimeGateCount: discovered.length,
    allowedCount: allowedDivergences.length,
    allowed: allowedDivergences,
  })
}

function walkAuditSourceFiles(directory, root) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) paths.push(...walkAuditSourceFiles(absolutePath, root))
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
      paths.push(relative(root, absolutePath).split('\\').join('/'))
    }
  }
  return paths
}

function parityAssertion(id, satisfied, detail) {
  return Object.freeze({ id, satisfied, detail })
}

function occurrences(source, needle) {
  return source.split(needle).length - 1
}

function validateDeclaredDomains({ declaredDomains, canonicalDomains, fileByPath, problems }) {
  for (const [path, domains] of Object.entries(declaredDomains)) {
    if (!fileByPath.has(path)) problems.push(`declared-domains: stale test path: ${path}`)
    if (!Array.isArray(domains) || domains.length === 0) {
      problems.push(`declared-domains:${path}: domains must be a non-empty array`)
      continue
    }
    for (const duplicate of duplicates(domains)) {
      problems.push(`declared-domains:${path}: duplicate domain: ${duplicate}`)
    }
    for (const domain of domains) {
      if (!canonicalDomains.has(domain))
        problems.push(`declared-domains:${path}: stale domain: ${domain}`)
    }
  }
}

function validateFile(file, canonicalDomains, problems) {
  const prefix = `files:${file.path}`
  if (!['suite', 'embedded-suite', 'support', 'fixture'].includes(file.role)) {
    problems.push(`${prefix}: invalid role: ${file.role}`)
  }
  if (['suite', 'embedded-suite'].includes(file.role) && file.definitions.tests.length === 0) {
    problems.push(`${prefix}: suite has no statically inventoried test definition`)
  }
  if (
    !Array.isArray(file.proofKinds) ||
    (['suite', 'embedded-suite'].includes(file.role) && file.proofKinds.length === 0)
  ) {
    problems.push(`${prefix}: suite has no proof kind`)
  }
  for (const proofKind of file.proofKinds ?? []) {
    if (!VALID_PROOF_KINDS.has(proofKind))
      problems.push(`${prefix}: invalid proof kind: ${proofKind}`)
  }
  if (file.role !== 'fixture' && (!Array.isArray(file.domains) || file.domains.length === 0)) {
    problems.push(`${prefix}: no production domain owner or explicit feature-domain declaration`)
  }
  for (const domain of file.domains ?? []) {
    if (!canonicalDomains.has(domain)) problems.push(`${prefix}: stale domain: ${domain}`)
  }
  if (!file.execution) problems.push(`${prefix}: missing execution shape`)
  if (!file.productionOwners?.source)
    problems.push(`${prefix}: missing owner discovery disposition`)
  const dispositionKeys = Object.keys(file.dimensionDispositions ?? {}).sort()
  const expectedDimensionKeys = [...TEST_EVIDENCE_DIMENSIONS].sort()
  if (JSON.stringify(dispositionKeys) !== JSON.stringify(expectedDimensionKeys)) {
    problems.push(`${prefix}: evidence dimension dispositions are incomplete or stale`)
  }
  for (const [dimension, disposition] of Object.entries(file.dimensionDispositions ?? {})) {
    if (!['candidate-signal', 'not-deterministically-signaled'].includes(disposition.status)) {
      problems.push(`${prefix}: invalid ${dimension} disposition: ${disposition.status}`)
    }
  }
  for (const definition of file.definitions.tests) {
    if (!definition.title || !definition.line) problems.push(`${prefix}: invalid test definition`)
    if (definition.status === 'only')
      problems.push(`${prefix}:${definition.line}: focused test is forbidden`)
  }
}

function validateClaims({ claims, root, fileByPath, problems }) {
  const byId = new Map()
  for (const claim of claims) {
    const prefix = `claims:${claim.id ?? '<missing>'}`
    if (!claim.id) {
      problems.push('claims: id must be non-empty')
      continue
    }
    if (byId.has(claim.id)) problems.push(`${prefix}: duplicate id`)
    byId.set(claim.id, claim)
    if (!VALID_STATUSES.has(claim.status))
      problems.push(`${prefix}: invalid status: ${claim.status}`)
    if (!claim.rationale) problems.push(`${prefix}: rationale must be non-empty`)
    if (!Array.isArray(claim.requiredProofKinds) || claim.requiredProofKinds.length === 0) {
      problems.push(`${prefix}: requiredProofKinds must be non-empty`)
    }
    for (const kind of claim.requiredProofKinds ?? []) {
      if (!VALID_PROOF_KINDS.has(kind) && kind !== 'multi-tab') {
        problems.push(`${prefix}: invalid required proof kind: ${kind}`)
      }
    }
    if (
      claim.status === 'covered' &&
      (!Array.isArray(claim.evidence) || claim.evidence.length === 0)
    ) {
      problems.push(`${prefix}: covered claim needs exact evidence`)
    }
    if (claim.status === 'gap' && Array.isArray(claim.evidence) && claim.evidence.length > 0) {
      problems.push(`${prefix}: gap cannot carry proof evidence; use touchedBy`)
    }
    if (claim.status === 'partial' && !claim.missing) {
      problems.push(`${prefix}: partial claim must state the missing proof`)
    }
    const references = [...(claim.evidence ?? []), ...(claim.touchedBy ?? [])]
    for (const reference of references) validateReference(reference, root, prefix, problems)
    if (claim.status !== 'gap') {
      const availableProofKinds = new Set(
        (claim.evidence ?? []).flatMap((reference) =>
          proofKindsForEvidence(reference.path, fileByPath),
        ),
      )
      for (const required of claim.requiredProofKinds ?? []) {
        if (required === 'multi-tab') continue
        if (!availableProofKinds.has(required)) {
          problems.push(`${prefix}: ${claim.status} claim lacks ${required} evidence`)
        }
      }
    }
  }
}

function validateReference(reference, root, prefix, problems) {
  if (!reference?.path || !reference?.locator) {
    problems.push(`${prefix}: evidence needs an exact path and locator`)
    return
  }
  const absolutePath = resolve(root, reference.path)
  const relativePath = relative(root, absolutePath)
  if (relativePath.startsWith('..')) {
    problems.push(`${prefix}: evidence path escapes root: ${reference.path}`)
    return
  }
  if (!statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) {
    problems.push(`${prefix}: evidence path is missing: ${reference.path}`)
    return
  }
  if (!readFileSync(absolutePath, 'utf8').includes(reference.locator)) {
    problems.push(`${prefix}: stale locator in ${reference.path}: ${reference.locator}`)
  }
}

function proofKindsForEvidence(path, fileByPath) {
  const file = fileByPath.get(path)
  if (file) return file.proofKinds
  return ['static']
}

function uniqueByPath(files, problems) {
  const byPath = new Map()
  for (const file of files ?? []) {
    if (!file?.path) {
      problems.push('files: path must be non-empty')
      continue
    }
    if (byPath.has(file.path)) problems.push(`files: duplicate path: ${file.path}`)
    byPath.set(file.path, file)
  }
  return byPath
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated].sort()
}

function countBy(values, keyFor) {
  const counts = {}
  for (const value of values) {
    const key = keyFor(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function countMany(values, keysFor) {
  const counts = {}
  for (const value of values) {
    for (const key of keysFor(value)) counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  )
}

function parseArgs(argv) {
  let json = false
  let summary = false
  let mode = 'inventory'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--summary') {
      summary = true
      continue
    }
    if (arg === '--mode') {
      mode = argv[index + 1]
      if (!['inventory', 'enforce'].includes(mode))
        throw new Error(`Invalid test evidence mode: ${mode}`)
      index += 1
      continue
    }
    throw new Error(`Unknown test evidence argument: ${arg}`)
  }
  return { json, mode, summary }
}

function printReport(report, mode) {
  console.log('Test evidence inventory')
  console.log(`- files: ${report.counts.files}`)
  console.log(`- suites: ${report.counts.suites}`)
  console.log(`- support files: ${report.counts.supportFiles}`)
  console.log(`- fixture files: ${report.counts.fixtureFiles}`)
  console.log(`- static test declarations: ${report.counts.testDefinitions}`)
  console.log(`- guarantee claims: ${report.counts.guaranteeClaims}`)
  console.log(`- claim status: ${JSON.stringify(report.statusCounts)}`)
  console.log(`- proof kinds: ${JSON.stringify(report.proofKindCounts)}`)
  console.log(`- candidate evidence dimensions: ${JSON.stringify(report.dimensionCounts)}`)
  console.log(
    `- verification parity assertions: ${report.parity.assertions.filter((item) => item.satisfied).length}/${report.parity.assertions.length}`,
  )
  console.log(
    `- dev/built divergence gates: ${report.divergences.discoveredRuntimeGateCount} discovered, ${report.divergences.allowedCount} explicitly allowed`,
  )
  console.log(
    `- production interaction sites: ${report.inventory.interactionEvidence.siteCount}; exact per-site outcome proofs: ${report.inventory.interactionEvidence.perSiteOutcomeProofCount}`,
  )
  console.log(`- mode: ${mode}`)
  if (report.gaps.length > 0) {
    console.log('- explicit unclosed guarantees:')
    for (const gap of report.gaps) console.log(`  - ${gap.status}: ${gap.id}`)
  }
  if (report.problems.length > 0) {
    console.log('- structural problems:')
    for (const problem of report.problems) console.log(`  - ${problem}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = auditTestEvidence()
  const enforcedGaps = args.mode === 'enforce' ? report.gaps : []
  const structurallyValid = report.problems.length === 0
  const output = {
    ...report,
    structurallyValid,
    ...staticAuditState({ structurallyValid, gaps: report.gaps }),
    ok: report.problems.length === 0 && enforcedGaps.length === 0,
    mode: args.mode,
  }
  if (args.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  else if (args.summary) {
    process.stdout.write(
      `test-evidence inventory=${output.inventoryComplete} manifest=${output.manifestFresh} closed=${output.guaranteeClosed} suites=${output.counts.suites} gaps=${output.gaps.length} structuralProblems=${output.problems.length}\n`,
    )
  } else printReport(output, args.mode)
  if (!output.ok) process.exitCode = 1
}

if (
  process.argv[1] &&
  fileURLToPath(pathToFileURL(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  await main()
}
