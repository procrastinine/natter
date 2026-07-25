export interface ReviewedCandidate {
  readonly id: string
  readonly path: string
  readonly line: number
}

export interface ReviewedCandidateEvidence {
  readonly path: string
  readonly line: number
  readonly text: string
  readonly role: string
}

export type ReviewedCandidateDisposition =
  | {
      readonly siteId: string
      readonly siteText: string
      readonly disposition: 'proved'
      readonly evidence: readonly ReviewedCandidateEvidence[]
      readonly identityFlow: string
      readonly rationale: string
    }
  | {
      readonly siteId: string
      readonly siteText: string
      readonly disposition: 'intentional-bounded-lifetime'
      readonly boundary: string
      readonly bound: string
      readonly rationale: string
    }
  | {
      readonly siteId: string
      readonly siteText: string
      readonly disposition: 'architecture-gap'
      readonly rationale: string
    }

export interface ReviewedCandidateDispositionInput {
  readonly siteId: string
  readonly siteText: string
  readonly disposition: string
  readonly rationale: string
  readonly evidence?: readonly ReviewedCandidateEvidence[]
  readonly identityFlow?: string
  readonly boundary?: string
  readonly bound?: string
}

export function validateReviewedCandidateDispositions(input: {
  readonly candidates: readonly ReviewedCandidate[]
  readonly reviews: readonly ReviewedCandidateDispositionInput[]
  readonly root: string
  readonly auditName: string
  readonly proofRoles: ReadonlySet<string>
}): {
  readonly problems: readonly string[]
  readonly dispositionCounts: Readonly<Record<ReviewedCandidateDisposition['disposition'], number>>
}
