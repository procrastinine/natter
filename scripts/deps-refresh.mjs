import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { currentRuntimeCapability } from './verification-dependency-image.mjs'

const root = resolve(import.meta.dirname, '..')
const checkOnly = process.argv.includes('--check')
const REQUIRED_POLICY = Object.freeze({
  minimumReleaseAge: '1440',
  minimumReleaseAgeStrict: 'true',
  minimumReleaseAgeIgnoreMissingTime: 'false',
  trustPolicy: 'no-downgrade',
  trustLockfile: 'false',
  blockExoticSubdeps: 'true',
  strictDepBuilds: 'true',
})
let verifiedRuntime = null

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'))
}

function readPolicy() {
  const text = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  const lines = []
  for (const [key, expected] of Object.entries(REQUIRED_POLICY)) {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    const actual = match?.[1]?.trim()
    if (actual !== expected) {
      throw new Error(
        `DependencyPolicyMismatch:${key}:expected=${expected}:actual=${actual ?? 'missing'}`,
      )
    }
    lines.push(`${key}: ${actual}`)
  }
  const ignoredUpdateBlock = text.match(/^update:\s*\n {2}ignoreDeps:\s*\n((?: {4}- .+\n?)*)/m)
  if (ignoredUpdateBlock?.[1]) {
    const dependencies = ignoredUpdateBlock[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
    lines.push(`update.ignoreDeps: ${dependencies.join(', ')}`)
  }
  if (!ignoredUpdateBlock?.[1]) throw new Error('DependencyPolicyUpdateIgnoreMissing')
  return lines
}

async function verifyRuntime(packageJson) {
  const expectedNodeVersion = readFileSync(resolve(root, '.node-version'), 'utf8').trim()
  if (packageJson.engines?.node !== expectedNodeVersion) {
    throw new Error(
      `DependencyNodeDeclarationMismatch:pin=${expectedNodeVersion}:engine=${String(packageJson.engines?.node)}`,
    )
  }
  if (process.versions.node !== expectedNodeVersion) {
    throw new Error(
      `DependencyNodeRuntimeMismatch:expected=${expectedNodeVersion}:actual=${process.versions.node}`,
    )
  }
  const expectedPnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager)?.[1]
  if (!expectedPnpmVersion) throw new Error('DependencyPnpmDeclarationMissing')
  const capability = currentRuntimeCapability(root)
  const actualPnpmVersion = capability.identity.pnpmVersion
  if (actualPnpmVersion !== expectedPnpmVersion) {
    throw new Error(
      `DependencyPnpmRuntimeMismatch:expected=${expectedPnpmVersion}:actual=${actualPnpmVersion}`,
    )
  }
  verifiedRuntime = capability
  return { node: expectedNodeVersion, pnpm: expectedPnpmVersion }
}

function readPatchedDependencies() {
  const text = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'patchedDependencies:')
  if (start < 0) return []
  const patched = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue
    const match = line.match(/^ {2}([^:]+):\s*(.+)$/)
    if (!match) break
    const reference = match[1].trim()
    const separator = reference.lastIndexOf('@')
    if (separator <= 0 || separator === reference.length - 1) {
      throw new Error(`Invalid patched dependency reference: ${reference}`)
    }
    patched.push({
      name: reference.slice(0, separator),
      version: reference.slice(separator + 1),
      path: match[2].trim(),
    })
  }
  return patched
}

function verifyPatchedDependencies(patched) {
  for (const entry of patched) {
    if (!existsSync(resolve(root, entry.path))) {
      throw new Error(`Patched dependency file is missing: ${entry.path}`)
    }
    const installedPath = resolve(root, 'node_modules', entry.name, 'package.json')
    if (!existsSync(installedPath)) {
      throw new Error(`Install dependencies before refreshing the patch for ${entry.name}.`)
    }
    const installed = JSON.parse(readFileSync(installedPath, 'utf8')).version
    if (installed !== entry.version) {
      throw new Error(
        `Patched dependency ${entry.name} is installed at ${installed}, but the reviewed patch targets ${entry.version}. Reevaluate ${entry.path} against upstream before refreshing.`,
      )
    }
  }
}

function verifyPatchedUpdates(patched, outdated) {
  for (const entry of patched) {
    const update = outdated.find((row) => row.name === entry.name)
    if (!update || update.latest === entry.version) continue
    throw new Error(
      `Patched dependency ${entry.name} has upstream ${update.latest}, while ${entry.path} targets ${entry.version}. Reevaluate or remove the patch before refreshing dependencies.`,
    )
  }
}

function pnpmInvocation(args) {
  if (verifiedRuntime) {
    return {
      command: verifiedRuntime.nodeExecutablePath,
      args: [
        verifiedRuntime.pnpmExecutablePath,
        '--config.manage-package-manager-versions=false',
        ...args,
      ],
    }
  }
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
    return []
  }
  const entries = Object.entries(parsed)
  if (entries.length === 0) {
    console.log('No outdated packages visible under the current pnpm policy.')
    return []
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
  return rows
}

async function showOutdated(label) {
  const result = await run(['outdated', '--format', 'json'], {
    allowExitCodes: [0, 1],
    capture: true,
  })
  if (result.code !== 0 && !result.stdout.trim().startsWith('{')) {
    throw new Error(`pnpm outdated failed\n${result.stderr.trim()}`)
  }
  return printOutdated(label, result.stdout, result.stderr)
}

async function main() {
  const pkg = readJson('package.json')
  const runtime = await verifyRuntime(pkg)
  const policy = readPolicy()
  const patched = readPatchedDependencies()
  verifyPatchedDependencies(patched)
  section('Dependency Refresh')
  console.log(`packageManager: ${pkg.packageManager}`)
  console.log(`runtime: Node ${runtime.node}, pnpm ${runtime.pnpm}`)
  console.log(`mode: ${checkOnly ? 'check only' : 'refresh'}`)
  console.log(
    'install scripts: disabled while resolving; only reviewed builds run during reconciliation',
  )

  section('pnpm Policy')
  for (const line of policy) console.log(line)

  const outdatedBefore = await showOutdated('Outdated Before')
  verifyPatchedUpdates(patched, outdatedBefore)

  if (!checkOnly) {
    section('Refresh')
    console.log('Running: pnpm update --latest --ignore-scripts')
    await run(['update', '--latest', '--ignore-scripts'])
    console.log('Running: pnpm install --frozen-lockfile')
    await run(['install', '--frozen-lockfile'])
    rmSync(resolve(root, 'node_modules', '.vite'), { recursive: true, force: true })
    console.log('Cleared the derived Vite dependency cache.')
  }

  section('Peer Compatibility')
  await run(['peers', 'check'])

  section('Audit')
  await run(['audit', '--audit-level', 'moderate'])

  section('Build Script Policy')
  console.log('strictDepBuilds rejects every unreviewed dependency build during reconciliation.')

  const outdatedAfter = await showOutdated('Outdated After')
  verifyPatchedUpdates(patched, outdatedAfter)
  const eligibleRemaining = outdatedAfter.filter((row) => row.current !== row.wanted)
  if (!checkOnly && eligibleRemaining.length > 0) {
    throw new Error(
      `EligibleDependencyUpdatesRemain:${eligibleRemaining.map((row) => row.name).join(',')}`,
    )
  }

  section('Next Checks')
  console.log('Recommended after dependency diffs: pnpm typecheck && pnpm build')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
