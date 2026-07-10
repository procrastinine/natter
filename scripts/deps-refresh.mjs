import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const checkOnly = process.argv.includes('--check')

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

function readPolicy() {
  const text = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  const policyKeys = [
    'minimumReleaseAge',
    'trustPolicy',
    'blockExoticSubdeps',
    'strictDepBuilds',
  ]
  const lines = []
  for (const key of policyKeys) {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (match) lines.push(`${key}: ${match[1]}`)
  }
  const swcBuildPolicy = text.match(/^  "@swc\/core":\s*(.+)$/m)
  if (swcBuildPolicy) lines.push(`allowBuilds["@swc/core"]: ${swcBuildPolicy[1]}`)
  return lines
}

function pnpmInvocation(args) {
  const pnpmArgs = ['--config.manage-package-manager-versions=false', ...args]
  const npmExecPath = process.env.npm_execpath
  if (!npmExecPath) return { command: 'pnpm', args: pnpmArgs }
  if (/\.[cm]?js$/.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...pnpmArgs] }
  }
  return { command: npmExecPath, args: pnpmArgs }
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

function run(args, { allowExitCodes = [0], capture = false } = {}) {
  const { command, args: commandArgs } = pnpmInvocation(args)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }
    child.on('error', reject)
    child.on('close', (code) => {
      const exitCode = code ?? 1
      if (!allowExitCodes.includes(exitCode)) {
        const rendered = ['pnpm', ...args].join(' ')
        reject(new Error(`${rendered} exited with ${exitCode}${stderr ? `\n${stderr}` : ''}`))
        return
      }
      resolvePromise({ stdout, stderr, code: exitCode })
    })
  })
}

function printOutdated(label, stdout, stderr) {
  section(label)
  if (stderr.trim()) console.error(stderr.trim())
  let parsed
  try {
    parsed = JSON.parse(stdout.trim() || '{}')
  } catch {
    console.log(stdout.trim() || 'Unable to parse pnpm outdated output.')
    return
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    console.log('No outdated packages visible under the current pnpm policy.')
    return
  }
  const rows = entries
    .map(([name, info]) => ({
      name,
      current: info.current ?? '?',
      wanted: info.wanted ?? '?',
      latest: info.latest ?? '?',
      type: info.dependencyType ?? '?',
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const nameWidth = Math.max(...rows.map((row) => row.name.length), 'package'.length)
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(nameWidth)}  ${row.current} -> ${row.latest} ` +
        `(wanted ${row.wanted}, ${row.type})`,
    )
  }
}

async function showOutdated(label) {
  const result = await run(['outdated', '--format', 'json'], {
    allowExitCodes: [0, 1],
    capture: true,
  })
  if (result.code !== 0 && !result.stdout.trim().startsWith('{')) {
    throw new Error(`pnpm outdated failed\n${result.stderr.trim()}`)
  }
  printOutdated(label, result.stdout, result.stderr)
}

async function main() {
  const pkg = readJson('package.json')
  section('Dependency Refresh')
  console.log(`packageManager: ${pkg.packageManager}`)
  console.log(`mode: ${checkOnly ? 'check only' : 'refresh'}`)
  console.log('install scripts: disabled during refresh (--ignore-scripts)')

  section('pnpm Policy')
  for (const line of readPolicy()) console.log(line)

  await showOutdated('Outdated Before')

  if (!checkOnly) {
    section('Refresh')
    console.log('Running: pnpm update --latest --ignore-scripts')
    await run(['update', '--latest', '--ignore-scripts'])
  }

  section('Audit')
  await run(['audit', '--audit-level', 'moderate'])

  section('Ignored Builds')
  const ignoredBuilds = await run(['ignored-builds'], {
    allowExitCodes: [0, 1],
    capture: true,
  })
  const ignoredOutput = `${ignoredBuilds.stdout}${ignoredBuilds.stderr}`.trim()
  console.log(ignoredOutput || 'No ignored dependency builds reported.')

  await showOutdated('Outdated After')

  section('Next Checks')
  console.log('Recommended after dependency diffs: pnpm typecheck && pnpm build')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
