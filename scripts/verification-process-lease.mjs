import { randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const LEASES = new WeakSet()
const LEASE_SCHEMA_VERSION = 1

export function acquireVerificationProcessLease(options) {
  const path = resolve(options.path)
  const owner = processOwner(options.purpose)
  mkdirSync(dirname(path), { recursive: true })
  reclaimLeaseDebris(path)
  for (;;) {
    const claim = debrisPath(path, 'claim', owner)
    try {
      mkdirSync(claim)
      writeFileSync(resolve(claim, 'owner.json'), `${JSON.stringify(owner)}\n`, {
        flag: 'wx',
        mode: 0o444,
      })
    } catch (error) {
      rmSync(claim, { force: true, recursive: true })
      throw error
    }
    try {
      renameSync(claim, path)
      const lease = Object.freeze({ owner, path })
      LEASES.add(lease)
      return lease
    } catch (error) {
      rmSync(claim, { force: true, recursive: true })
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error
    }
    const current = readLeaseOwner(path)
    if (current && processOwnerIsLive(current)) {
      throw new Error(`VerificationProcessLeaseActive:${options.purpose}`)
    }
    const stale = debrisPath(path, 'stale', owner)
    try {
      renameSync(path, stale)
      rmSync(stale, { force: true, recursive: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export function releaseVerificationProcessLease(value) {
  if (!LEASES.has(value)) throw new Error('VerificationProcessLeaseCapabilityRequired')
  const current = readLeaseOwner(value.path)
  if (!current || JSON.stringify(current) !== JSON.stringify(value.owner)) {
    throw new Error('VerificationProcessLeaseOwnershipLost')
  }
  const released = debrisPath(value.path, 'released', value.owner)
  renameSync(value.path, released)
  rmSync(released, { force: true, recursive: true })
  LEASES.delete(value)
}

function reclaimLeaseDebris(path) {
  const parent = dirname(path)
  const stem = basename(path)
  for (const name of readdirSync(parent)) {
    if (!['claim', 'stale', 'released'].some((kind) => name.startsWith(`${stem}.${kind}-`))) {
      continue
    }
    const debris = resolve(parent, name)
    const metadata = lstatSync(debris, { throwIfNoEntry: false })
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue
    const owner = readLeaseOwner(debris) ?? debrisOwner(name, stem)
    if (owner && processOwnerIsLive(owner)) continue
    rmSync(debris, { force: true, recursive: true })
  }
}

function debrisPath(path, kind, owner) {
  const start = owner.processStartToken ?? 'none'
  return `${path}.${kind}-${owner.pid}-${start}-${randomBytes(8).toString('hex')}`
}

function debrisOwner(name, stem) {
  const match = new RegExp(`^${escapeRegex(stem)}\\.(?:claim|stale|released)-(\\d+)-([^-]+)-`).exec(
    name,
  )
  if (!match) return null
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  return {
    pid,
    processStartToken: match[2] === 'none' ? null : match[2],
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function processOwner(purpose) {
  if (typeof purpose !== 'string' || purpose.length === 0) {
    throw new Error('VerificationProcessLeasePurposeInvalid')
  }
  return Object.freeze({
    schemaVersion: LEASE_SCHEMA_VERSION,
    purpose,
    pid: process.pid,
    processStartToken: processStartToken(process.pid),
    nonce: randomBytes(16).toString('hex'),
  })
}

function readLeaseOwner(path) {
  try {
    const value = JSON.parse(readFileSync(resolve(path, 'owner.json'), 'utf8'))
    if (
      value?.schemaVersion !== LEASE_SCHEMA_VERSION ||
      typeof value.purpose !== 'string' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      (value.processStartToken !== null && typeof value.processStartToken !== 'string') ||
      !/^[0-9a-f]{32}$/u.test(value.nonce)
    ) {
      return null
    }
    return Object.freeze(value)
  } catch {
    return null
  }
}

function processOwnerIsLive(owner) {
  if (owner.processStartToken !== null) {
    return processStartToken(owner.pid) === owner.processStartToken
  }
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function processStartToken(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    return (
      stat
        .slice(close + 2)
        .trim()
        .split(/\s+/u)[19] ?? null
    )
  } catch {
    return null
  }
}
