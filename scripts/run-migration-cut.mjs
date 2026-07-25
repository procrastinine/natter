import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { currentWaveManifest } from './current-wave-manifest.mjs'

const root = resolve(import.meta.dirname, '..')
const outputDirectory = resolve(root, 'test-results/migration-cut')
const stages = [
  Object.freeze({
    id: 'app-typecheck',
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: Object.freeze([
      'exec',
      'tsc',
      '-p',
      'tsconfig.app.json',
      '--noEmit',
      '--pretty',
      'false',
    ]),
  }),
  Object.freeze({
    id: 'current-wave-ownership',
    command: process.execPath,
    args: Object.freeze(['scripts/audit-current-wave.mjs']),
  }),
]

if (currentWaveManifest.mode === 'coherence/gate') {
  const tests = [
    ...new Set(
      [...currentWaveManifest.costBounds, ...currentWaveManifest.gateObligations].flatMap(
        ({ tests: proofFiles }) => proofFiles,
      ),
    ),
  ]
  stages.push(
    Object.freeze({
      id: 'semantic-and-cost-gate',
      command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      args: Object.freeze(['exec', 'vitest', 'run', ...tests]),
    }),
  )
}

await mkdir(outputDirectory, { recursive: true })
const results = []
for (const stage of stages) results.push(await runStage(stage))

const summary = Object.freeze({
  wave: currentWaveManifest.id,
  mode: currentWaveManifest.mode,
  outcome: results.every((result) => result.exitCode === 0) ? 'passed' : 'failed',
  results: Object.freeze(results),
})
await writeFile(
  resolve(outputDirectory, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
)
process.stdout.write(
  `migration-cut:${summary.wave}:${summary.outcome}:${results.map((result) => `${result.id}=${result.exitCode}`).join(',')}\n`,
)
if (summary.outcome !== 'passed') process.exitCode = 1

async function runStage(stage) {
  const startedAt = performance.now()
  const child = spawn(stage.command, stage.args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => {
    stdout.push(chunk)
    process.stdout.write(chunk)
  })
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk)
    process.stderr.write(chunk)
  })
  const completion = await new Promise((resolveCompletion, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolveCompletion({ exitCode, signal }))
  })
  const result = Object.freeze({
    id: stage.id,
    exitCode: completion.exitCode ?? 1,
    signal: completion.signal,
    wallMs: performance.now() - startedAt,
  })
  await Promise.all([
    writeFile(resolve(outputDirectory, `${stage.id}.stdout.log`), Buffer.concat(stdout)),
    writeFile(resolve(outputDirectory, `${stage.id}.stderr.log`), Buffer.concat(stderr)),
  ])
  return result
}
