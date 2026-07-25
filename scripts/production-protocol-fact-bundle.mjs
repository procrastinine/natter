import { resolve } from 'node:path'
import { buildConfigurationProtocolSourceFacts } from './audit-configuration-protocol.mjs'
import { buildDurableCommandPipelineSourceFacts } from './audit-durable-command-pipeline.mjs'
import { buildProductionProtocolSourceFacts } from './audit-production-protocol.mjs'
import { buildProtocolStageSourceFacts } from './audit-protocol-stages.mjs'
import { buildTabCrossTabLocalitySourceFacts } from './audit-tab-cross-tab-locality.mjs'
import { discoverProductionDiscriminatedUnions } from './discover-production-discriminated-unions.mjs'
import {
  createProductionTypeScriptProgram,
  productionTypeScriptSourceDigest,
} from './production-typescript-source.mjs'
import { PROTOCOL_CONTRACT_REPORT_IDS } from './protocol-contract-descriptor.mjs'
import { protocolContractGeneratorDigest } from './protocol-contract-fingerprint.mjs'

const ROOT = resolve(import.meta.dirname, '..')

export function buildProductionProtocolFactBundle(options = {}) {
  const program =
    options.program ?? (options.createProgram ?? createProductionTypeScriptProgram)(ROOT)
  const discovered =
    options.discovered ??
    (options.discoverUnions ?? discoverProductionDiscriminatedUnions)(ROOT, {
      program,
    })
  const production = buildProductionProtocolSourceFacts({ program, discovered })
  const stages = buildProtocolStageSourceFacts({ program, discovered })
  const configuration = buildConfigurationProtocolSourceFacts({ program, discovered })
  const durable = buildDurableCommandPipelineSourceFacts({ program, discovered })
  const locality = buildTabCrossTabLocalitySourceFacts({
    program,
    discovered,
    productionFacts: production,
  })
  const bundle = {
    schemaVersion: 3,
    snapshot: {
      digest: productionTypeScriptSourceDigest(program, ROOT),
      generatorDigest: protocolContractGeneratorDigest(ROOT),
      sourceFiles: discovered.sourceFiles,
    },
    production,
    unionDiscovery: discovered,
    stages,
    configuration,
    durable,
    locality,
    auditCapabilities: [
      auditCapability(PROTOCOL_CONTRACT_REPORT_IDS.production, production.auditedUnionSubjects),
      auditCapability(PROTOCOL_CONTRACT_REPORT_IDS.stages, stages.auditedUnionSubjects),
      auditCapability(
        PROTOCOL_CONTRACT_REPORT_IDS.configuration,
        configuration.auditedUnionSubjects,
      ),
      auditCapability(PROTOCOL_CONTRACT_REPORT_IDS.durable, durable.auditedUnionSubjects),
      auditCapability(PROTOCOL_CONTRACT_REPORT_IDS.locality, locality.auditedUnionSubjects),
    ],
  }
  return freezeDataBundle(bundle)
}

function auditCapability(ownerId, roots) {
  return {
    ownerId,
    roots,
  }
}

export function productionProtocolFactBundleContainsCompilerState(value) {
  const pending = [value]
  const seen = new Set()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === null) continue
    if (typeof current !== 'object') {
      if (
        !['boolean', 'number', 'string'].includes(typeof current) ||
        (typeof current === 'number' && !Number.isFinite(current))
      ) {
        return true
      }
      continue
    }
    if (seen.has(current)) continue
    seen.add(current)
    if (current instanceof Map || current instanceof Set) return true
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      return true
    }
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue
      if (typeof key !== 'string') return true
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return true
      pending.push(descriptor.value)
    }
  }
  return false
}

function freezeDataBundle(value, path = 'bundle', seen = new Set()) {
  if (value === null) return value
  if (typeof value !== 'object') {
    if (
      !['boolean', 'number', 'string'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new Error(`ProductionProtocolFactNotJson:${path}`)
    }
    return value
  }
  if (seen.has(value)) throw new Error(`ProductionProtocolFactCycle:${path}`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new Error(`ProductionProtocolFactNotPlain:${path}`)
  }
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    if (typeof key !== 'string') throw new Error(`ProductionProtocolFactSymbolKey:${path}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      throw new Error(`ProductionProtocolFactDescriptorInvalid:${path}.${key}`)
    }
    freezeDataBundle(descriptor.value, `${path}.${key}`, seen)
  }
  seen.delete(value)
  return Object.freeze(value)
}
