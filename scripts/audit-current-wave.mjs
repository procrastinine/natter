import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { currentWaveManifest as manifest } from './current-wave-manifest.mjs'
import { verificationCandidateAdmission } from './verification-candidate-admission.mjs'

async function sourceFiles(root) {
  const entries = await readdir(root)
  const files = []
  for (const entry of entries) {
    const absolute = path.join(root, entry)
    const metadata = await stat(absolute)
    if (metadata.isDirectory()) files.push(...(await sourceFiles(absolute)))
    else if (/\.[cm]?[jt]sx?$/.test(entry)) files.push(absolute)
  }
  return files
}

function countMatches(source, pattern) {
  return [...source.matchAll(new RegExp(pattern, 'gu'))].length
}

const failures = []
const sourceByFile = new Map()

for (const root of manifest.roots) {
  for (const file of await sourceFiles(root)) sourceByFile.set(file, await readFile(file, 'utf8'))
}

for (const file of manifest.requiredFiles) {
  if (!sourceByFile.has(file)) failures.push(`required-file-missing:${file}`)
}

for (const file of manifest.forbiddenFiles ?? []) {
  if (sourceByFile.has(file)) failures.push(`forbidden-file-present:${file}`)
}

for (const entry of manifest.forbiddenMatches) {
  let count = 0
  if (entry.file) {
    const source = sourceByFile.get(entry.file)
    if (source !== undefined) count = countMatches(source, entry.pattern)
  } else {
    for (const source of sourceByFile.values()) count += countMatches(source, entry.pattern)
  }
  if (count !== 0) failures.push(`outgoing-owner-present:${entry.id}:${count}`)
}

for (const entry of manifest.requiredMatches) {
  const source = sourceByFile.get(entry.file)
  if (source === undefined) continue
  const count = countMatches(source, entry.pattern)
  if (count !== entry.count) {
    failures.push(`owner-count-drift:${entry.id}:expected=${entry.count}:actual=${count}`)
  }
}

const executableObligations = [...manifest.costBounds, ...manifest.gateObligations]

for (const obligation of executableObligations) {
  if (!obligation.id || obligation.tests.length === 0) {
    failures.push(`executable-obligation-unmapped:${obligation.id || 'unknown'}`)
    continue
  }
  for (const file of obligation.tests) {
    if (!(await stat(file, { throwIfNoEntry: false }))?.isFile()) {
      failures.push(`executable-obligation-proof-missing:${obligation.id}:${file}`)
    }
  }
}

const candidateAdmission = verificationCandidateAdmission(manifest)
if (manifest.mode === 'coherence/gate' && !candidateAdmission.ready) {
  failures.push(
    `coherence-with-open-source-obligations:${candidateAdmission.sourceObligations.join(',')}`,
  )
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exitCode = 1
} else if (manifest.mode === 'breaking-migration') {
  console.log(
    `migration-open-as-declared:${manifest.id}:source=${manifest.sourceObligations.join(',')}:heartbeat=${manifest.heartbeatObligations.join(',')}:cost=${manifest.costObligations.join(',')}:gate=${manifest.gateObligations.map(({ id }) => id).join(',')}`,
  )
} else {
  console.log(
    `migration-coherent:${manifest.id}:cost=${manifest.costBounds.map(({ id }) => id).join(',')}:gate=${manifest.gateObligations.map(({ id }) => id).join(',')}`,
  )
}
