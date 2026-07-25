export interface VerificationProcessLease {
  readonly path: string
}

export function acquireVerificationProcessLease(options: {
  readonly path: string
  readonly purpose: string
}): VerificationProcessLease

export function releaseVerificationProcessLease(value: VerificationProcessLease): void
