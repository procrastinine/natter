import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export function createVerificationRuntimeInvocation(argv, runtime = null) {
  const kind = argv[0]
  if (kind === 'node') {
    return Object.freeze({
      command: runtime?.nodeExecutablePath ?? process.execPath,
      args: Object.freeze(argv.slice(1)),
    })
  }
  if (kind !== 'pnpm') throw new Error(`VerificationProcessKindInvalid:${kind ?? 'missing'}`)
  return Object.freeze({
    command: runtime?.nodeExecutablePath ?? pnpmCommand(),
    args: Object.freeze([
      ...(runtime ? [runtime.pnpmExecutablePath] : []),
      '--config.manage-package-manager-versions=false',
      ...argv.slice(1),
    ]),
  })
}

export function verificationChildEnvironment(options) {
  const environment = { ...options.baseEnv }
  if (options.kind !== 'vitest') return environment
  const localStorageOption = `--localstorage-file=${resolve(
    options.root,
    `test-results/verification-vitest-${safeFilePart(options.runId)}.localstorage`,
  )}`
  const existingNodeOptions = environment.NODE_OPTIONS?.trim() ?? ''
  if (!/(?:^|\s)--localstorage-file(?:=|\s)/u.test(existingNodeOptions)) {
    environment.NODE_OPTIONS = [existingNodeOptions, localStorageOption].filter(Boolean).join(' ')
  }
  return environment
}

export async function executeFileBackedVerificationProcess(options) {
  await mkdir(options.runDirectory, { recursive: true })
  const stdoutAbsolute = resolve(options.runDirectory, `${safeFilePart(options.id)}.stdout.log`)
  const stderrAbsolute = resolve(options.runDirectory, `${safeFilePart(options.id)}.stderr.log`)
  const diagnostics = []
  const prefix = options.diagnosticPrefix ?? 'VerificationProcess'
  const [stdoutFile, stderrFile] = await Promise.all([
    openArtifact(stdoutAbsolute, 'stdout', prefix, diagnostics),
    openArtifact(stderrAbsolute, 'stderr', prefix, diagnostics),
  ])
  if (!stdoutFile || !stderrFile) {
    await closeArtifacts(
      [
        { label: 'stdout', file: stdoutFile },
        { label: 'stderr', file: stderrFile },
      ],
      prefix,
      diagnostics,
    )
    return processExecution(
      null,
      null,
      diagnostics,
      stdoutFile ? stdoutAbsolute : null,
      stderrFile ? stderrAbsolute : null,
      options.artifactRoot,
    )
  }

  let child
  try {
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
    })
  } catch (error) {
    diagnostics.push(errorMessage(error))
    await closeArtifacts(
      [
        { label: 'stdout', file: stdoutFile },
        { label: 'stderr', file: stderrFile },
      ],
      prefix,
      diagnostics,
    )
    return processExecution(
      null,
      null,
      diagnostics,
      stdoutAbsolute,
      stderrAbsolute,
      options.artifactRoot,
    )
  }

  const closed = await new Promise((resolveClosed) => {
    child.once('error', (error) => diagnostics.push(error.message))
    child.once('close', (exitCode, signal) => resolveClosed({ exitCode, signal }))
  })
  await closeArtifacts(
    [
      { label: 'stdout', file: stdoutFile },
      { label: 'stderr', file: stderrFile },
    ],
    prefix,
    diagnostics,
  )
  if (options.forwardOutput) {
    const destinations = options.outputDestinations ?? {
      stdout: process.stdout,
      stderr: process.stderr,
    }
    const forwardingResults = await Promise.allSettled([
      forwardArtifact(stdoutAbsolute, destinations.stdout),
      forwardArtifact(stderrAbsolute, destinations.stderr),
    ])
    for (const [index, result] of forwardingResults.entries()) {
      if (result.status === 'rejected') {
        diagnostics.push(
          `${prefix}LogForwardFailed:${index === 0 ? 'stdout' : 'stderr'}:${errorName(result.reason)}`,
        )
      }
    }
  }
  return processExecution(
    closed.exitCode,
    closed.signal,
    diagnostics,
    stdoutAbsolute,
    stderrAbsolute,
    options.artifactRoot,
  )
}

async function openArtifact(path, label, prefix, diagnostics) {
  try {
    return await open(path, 'w')
  } catch (error) {
    diagnostics.push(`${prefix}LogOpenFailed:${label}:${errorName(error)}:${errorMessage(error)}`)
    return null
  }
}

async function closeArtifacts(artifacts, prefix, diagnostics) {
  const results = await Promise.allSettled(
    artifacts.map((artifact) => artifact.file?.close() ?? Promise.resolve()),
  )
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const artifact = artifacts[index]
    if (result?.status !== 'rejected' || !artifact) continue
    diagnostics.push(`${prefix}LogCloseFailed:${artifact.label}:${errorName(result.reason)}`)
  }
}

async function forwardArtifact(path, destination) {
  await pipeline(createReadStream(path), nonEndingDestination(destination))
}

function nonEndingDestination(destination) {
  let proxy
  let activeWrite = null
  let destinationFailure = null
  const fail = (error) => {
    destinationFailure ??= error
    const callback = activeWrite
    activeWrite = null
    if (callback) callback(destinationFailure)
    else proxy.destroy(destinationFailure)
  }
  const onError = (error) => fail(error)
  const onClose = () => fail(new Error('VerificationOutputDestinationClosed'))
  proxy = new Writable({
    write(chunk, encoding, callback) {
      if (destinationFailure) {
        callback(destinationFailure)
        return
      }
      activeWrite = callback
      try {
        destination.write(chunk, encoding, (error) => {
          if (activeWrite !== callback) return
          if (error) {
            if (destinationFailure) {
              activeWrite = null
              callback(destinationFailure)
            }
            return
          }
          activeWrite = null
          callback()
        })
      } catch (error) {
        if (activeWrite !== callback) return
        activeWrite = null
        callback(error)
      }
    },
    destroy(error, callback) {
      destination.off('error', onError)
      destination.off('close', onClose)
      activeWrite = null
      callback(error)
    },
  })
  destination.on('error', onError)
  destination.on('close', onClose)
  if (destination.destroyed || destination.writableEnded) {
    fail(new Error('VerificationOutputDestinationUnavailable'))
  }
  return proxy
}

function processExecution(exitCode, signal, diagnostics, stdoutPath, stderrPath, root) {
  return Object.freeze({
    exitCode,
    signal,
    diagnostics: Object.freeze([...diagnostics]),
    stdoutPath: stdoutPath === null ? null : repositoryRelative(root, stdoutPath),
    stderrPath: stderrPath === null ? null : repositoryRelative(root, stderrPath),
  })
}

function repositoryRelative(root, path) {
  const output = relative(root, path).replaceAll('\\', '/')
  if (output === '' || output === '..' || output.startsWith('../')) {
    throw new Error('VerificationArtifactOutsideEvidenceRoot')
  }
  return output
}

function safeFilePart(value) {
  return String(value).replaceAll(/[^A-Za-z0-9._-]/gu, '-')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error) {
  return error instanceof Error ? error.name : 'UnknownError'
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}
