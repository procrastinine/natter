import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { currentWaveManifest } from './current-wave-manifest.mjs'

const root = resolve(import.meta.dirname, '..')
let completion
if (currentWaveManifest.mode === 'breaking-migration') {
  process.stdout.write(`verification-mode:${currentWaveManifest.mode}:verify:migration-cut\n`)
  const child = spawn(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['verify:migration-cut'],
    {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    },
  )
  completion = await new Promise((resolveCompletion, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolveCompletion({ exitCode, signal }))
  })
} else {
  process.stdout.write(`verification-mode:${currentWaveManifest.mode}:sealed-candidate\n`)
  const [
    { beginVerificationSlice },
    { prepareVerificationCandidate },
    { launchCandidateResidentVerification },
  ] = await Promise.all([
    import('./plan-slice-verification.mjs'),
    import('./verification-candidate-preparation.mjs'),
    import('./launch-slice-verification.mjs'),
  ])
  const baseline = await beginVerificationSlice({ root })
  const prepared = await prepareVerificationCandidate({
    root,
    manifest: currentWaveManifest,
  })
  completion = await launchCandidateResidentVerification({
    evidenceRoot: root,
    baselineId: baseline.baselineId,
    candidateId: prepared.candidate.id,
    runnerKind: 'checkpoint',
  })
}
if (completion.signal) process.kill(process.pid, completion.signal)
process.exitCode = completion.exitCode ?? 1
