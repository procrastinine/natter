import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DISPOSITIONS = new Set(['proved', 'intentional-bounded-lifetime', 'architecture-gap'])

export function validateReviewedCandidateDispositions({
  candidates,
  reviews,
  root,
  auditName,
  proofRoles,
}) {
  const problems = []
  const candidatesById = uniqueIndex(
    candidates,
    (candidate) => candidate.id,
    problems,
    `${auditName}Candidate`,
  )
  const reviewsById = uniqueIndex(
    reviews,
    (review) => review.siteId,
    problems,
    `${auditName}Review`,
  )
  const linesByPath = new Map()
  const sourceLines = (path) => {
    let lines = linesByPath.get(path)
    if (!lines) {
      try {
        lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/u)
      } catch {
        problems.push(`${auditName}ReviewSourceMissing:${path}`)
        return null
      }
      linesByPath.set(path, lines)
    }
    return lines
  }
  const hasSourceText = (path, text) => {
    const lines = sourceLines(path)
    return lines?.some((line) => line.trim() === text) === true
  }

  for (const candidate of candidates) {
    if (!reviewsById.has(candidate.id)) problems.push(`${auditName}ReviewMissing:${candidate.id}`)
  }
  for (const review of reviews) {
    const candidate = candidatesById.get(review.siteId)
    if (!candidate) {
      problems.push(`${auditName}ReviewStaleSite:${review.siteId}`)
      continue
    }
    if (!DISPOSITIONS.has(review.disposition)) {
      problems.push(`${auditName}ReviewDispositionInvalid:${review.siteId}`)
      continue
    }
    if (typeof review.siteText !== 'string' || review.siteText.length === 0) {
      problems.push(`${auditName}ReviewSiteTextMissing:${review.siteId}`)
    } else if (candidate.siteText !== review.siteText) {
      problems.push(`${auditName}ReviewSiteLocatorStale:${review.siteId}`)
    }
    if (typeof review.rationale !== 'string' || review.rationale.length < 24) {
      problems.push(`${auditName}ReviewRationaleMissing:${review.siteId}`)
    }
    if (review.disposition === 'proved') {
      validateProof(review, candidate, proofRoles, hasSourceText, problems, auditName)
    } else if (review.disposition === 'intentional-bounded-lifetime') {
      validateLifetime(review, problems, auditName)
    } else {
      validateGap(review, problems, auditName)
    }
  }

  const dispositionCounts = Object.freeze(
    Object.fromEntries(
      [...DISPOSITIONS].map((disposition) => [
        disposition,
        reviews.filter((review) => review.disposition === disposition).length,
      ]),
    ),
  )
  return Object.freeze({
    problems: Object.freeze([...new Set(problems)]),
    dispositionCounts,
  })
}

function validateProof(review, candidate, proofRoles, hasSourceText, problems, auditName) {
  if (typeof review.identityFlow !== 'string' || review.identityFlow.length < 24) {
    problems.push(`${auditName}ReviewIdentityFlowMissing:${review.siteId}`)
  }
  if (!Array.isArray(review.evidence) || review.evidence.length === 0) {
    problems.push(`${auditName}ReviewEvidenceMissing:${review.siteId}`)
    return
  }
  let ownsTerminalOutcome = false
  for (const evidence of review.evidence) {
    if (
      !evidence ||
      typeof evidence.path !== 'string' ||
      !Number.isSafeInteger(evidence.line) ||
      typeof evidence.text !== 'string' ||
      typeof evidence.role !== 'string'
    ) {
      problems.push(`${auditName}ReviewEvidenceInvalid:${review.siteId}`)
      continue
    }
    if (!hasSourceText(evidence.path, evidence.text)) {
      problems.push(
        `${auditName}ReviewEvidenceLocatorStale:${review.siteId}:${evidence.path}:${evidence.line}`,
      )
    }
    if (proofRoles.has(evidence.role)) {
      ownsTerminalOutcome = true
      if (evidence.path === candidate.path && evidence.text === candidate.siteText) {
        problems.push(`${auditName}ReviewTerminalEvidenceAliasesCandidate:${review.siteId}`)
      }
    }
  }
  if (!ownsTerminalOutcome) problems.push(`${auditName}ReviewTerminalProofMissing:${review.siteId}`)
  if ('boundary' in review || 'bound' in review) {
    problems.push(`${auditName}ReviewProofLifetimeFieldsForbidden:${review.siteId}`)
  }
}

function validateLifetime(review, problems, auditName) {
  if (typeof review.boundary !== 'string' || review.boundary.length === 0) {
    problems.push(`${auditName}ReviewLifetimeBoundaryMissing:${review.siteId}`)
  }
  if (typeof review.bound !== 'string' || review.bound.length < 24) {
    problems.push(`${auditName}ReviewLifetimeBoundMissing:${review.siteId}`)
  }
  if ('evidence' in review || 'identityFlow' in review) {
    problems.push(`${auditName}ReviewLifetimeProofFieldsForbidden:${review.siteId}`)
  }
}

function validateGap(review, problems, auditName) {
  if (
    'evidence' in review ||
    'identityFlow' in review ||
    'boundary' in review ||
    'bound' in review
  ) {
    problems.push(`${auditName}ReviewGapOverrideFieldsForbidden:${review.siteId}`)
  }
}

function uniqueIndex(values, keyFor, problems, label) {
  const result = new Map()
  for (const value of values) {
    const key = keyFor(value)
    if (result.has(key)) problems.push(`${label}Duplicate:${key}`)
    else result.set(key, value)
  }
  return result
}
