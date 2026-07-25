import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from '@playwright/test'

const forwardedArguments = process.argv.slice(2)
if (forwardedArguments[0] === '--') forwardedArguments.shift()

const nativeTmpRoot = process.env.E2E_NATIVE_TMP_ROOT ?? '/tmp'
const workingDirectory = mkdtempSync(join(nativeTmpRoot, 'ntr-hv-'))
const openboxLogPath = join(workingDirectory, 'openbox.log')
const chromiumLogPath = join(workingDirectory, 'chromium.log')
const chromiumProfilePath = join(workingDirectory, 'chromium-profile')
const chromiumArtifactsPath = join(workingDirectory, 'chromium-artifacts')
const nativeChildEnvironment = {
  ...process.env,
  TEMP: workingDirectory,
  TMP: workingDirectory,
  TMPDIR: workingDirectory,
}
const openboxLog = openSync(openboxLogPath, 'w')
const openbox = spawn('openbox', ['--sm-disable'], {
  env: {
    ...nativeChildEnvironment,
    XDG_CACHE_HOME: workingDirectory,
    XDG_CONFIG_HOME: join(workingDirectory, 'config'),
  },
  stdio: ['ignore', openboxLog, openboxLog],
})
closeSync(openboxLog)

let playwright
let headedChromium
let cleaningUp = false

try {
  await waitForWindowManager(openbox, openboxLogPath)
  const debuggingPort = await reserveLoopbackPort()
  mkdirSync(chromiumProfilePath, { recursive: true })
  mkdirSync(chromiumArtifactsPath, { recursive: true })
  const chromiumLog = openSync(chromiumLogPath, 'w')
  headedChromium = spawn(
    chromium.executablePath(),
    [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-back-forward-cache',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${chromiumProfilePath}`,
      `--remote-debugging-port=${debuggingPort}`,
      'about:blank',
    ],
    { env: nativeChildEnvironment, stdio: ['ignore', chromiumLog, chromiumLog] },
  )
  closeSync(chromiumLog)
  const endpointURL = `http://127.0.0.1:${debuggingPort}`
  await waitForChromium(headedChromium, endpointURL, chromiumLogPath)
  playwright = spawn(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/@playwright/test/cli.js'),
      'test',
      '--project=chromium-headed-visibility',
      ...forwardedArguments,
    ],
    {
      env: {
        ...process.env,
        E2E_HEADED_VISIBILITY: '1',
        E2E_NATIVE_CDP_ARTIFACTS_DIR: chromiumArtifactsPath,
        E2E_NATIVE_CDP_ENDPOINT: endpointURL,
      },
      stdio: 'inherit',
    },
  )

  const playwrightResult = waitForExit(playwright)
  const openboxResult = waitForExit(openbox).then((result) => ({
    owner: 'openbox',
    ...result,
  }))
  const chromiumResult = waitForExit(headedChromium).then((result) => ({
    owner: 'chromium',
    ...result,
  }))
  const firstResult = await Promise.race([
    playwrightResult.then((result) => ({ owner: 'playwright', ...result })),
    openboxResult,
    chromiumResult,
  ])

  if (firstResult.owner === 'openbox') {
    playwright.kill('SIGTERM')
    await waitForExit(playwright)
    throw new Error(
      `HeadedVisibilityWindowManagerExited:${describeExit(firstResult)}\n${readLog(openboxLogPath)}`,
    )
  }
  if (firstResult.owner === 'chromium') {
    const playwrightExit = await playwrightResult
    if (playwrightExit.code !== 0 || playwrightExit.signal !== null) {
      throw new Error(
        `HeadedVisibilityChromiumExited:${describeExit(firstResult)};Playwright:${describeExit(playwrightExit)}\n${readLog(chromiumLogPath)}`,
      )
    }
  }
  if (firstResult.owner === 'playwright' && firstResult.signal !== null) {
    throw new Error(
      `HeadedVisibilityPlaywrightSignaled:${describeExit(firstResult)}\nChromium:${describeChild(headedChromium)}\nOpenbox:${describeChild(openbox)}\n${readLog(chromiumLogPath)}\n${readLog(openboxLogPath)}`,
    )
  }
  if (firstResult.code !== 0) process.exitCode = firstResult.code ?? 1
} finally {
  cleaningUp = true
  await stopChild(playwright)
  await stopChild(headedChromium)
  await stopChild(openbox)
  rmSync(workingDirectory, { force: true, recursive: true })
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('HeadedVisibilityDebugPortUnavailable'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForChromium(child, endpointURL, logPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `HeadedVisibilityChromiumExited:${describeExit({
          code: child.exitCode,
          signal: child.signalCode,
        })}\n${readLog(logPath)}`,
      )
    }
    try {
      const response = await fetch(`${endpointURL}/json/version`)
      const version = await response.json()
      if (typeof version.webSocketDebuggerUrl === 'string') return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`HeadedVisibilityChromiumUnavailable\n${readLog(logPath)}`)
}

function waitForWindowManager(child, logPath) {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const rejectSpawn = (error) => {
      reject(new Error(`HeadedVisibilityWindowManagerSpawnFailed:${error.message}`))
    }
    child.once('error', rejectSpawn)
    const inspect = () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        child.off('error', rejectSpawn)
        reject(
          new Error(
            `HeadedVisibilityWindowManagerExited:${describeExit({
              code: child.exitCode,
              signal: child.signalCode,
            })}\n${readLog(logPath)}`,
          ),
        )
        return
      }
      const probe = spawnSync('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], {
        encoding: 'utf8',
      })
      if (probe.status === 0 && /window id #/u.test(probe.stdout)) {
        child.off('error', rejectSpawn)
        resolve()
        return
      }
      attempts += 1
      if (attempts >= 100) {
        child.off('error', rejectSpawn)
        reject(
          new Error(`HeadedVisibilityWindowManagerUnavailable\n${probe.stderr}${readLog(logPath)}`),
        )
        return
      }
      setTimeout(inspect, 50)
    }
    inspect()
  })
}

function waitForExit(child) {
  if (!child) return Promise.resolve({ code: 0, signal: null })
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    waitForExit(child).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ])
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await waitForExit(child)
  }
}

function describeExit(result) {
  return `code=${result.code ?? 'null'},signal=${result.signal ?? 'null'}`
}

function describeChild(child) {
  return describeExit({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null })
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (cleaningUp) return
    playwright?.kill(signal)
    headedChromium?.kill(signal)
    openbox.kill(signal)
  })
}
