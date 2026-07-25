export const PROTOCOL_CONTRACT_STAGE: Readonly<{
  id: 'protocol-contracts'
  label: string
  policy: 'blocking'
  argv: readonly [
    'node',
    'scripts/audit-protocol-contracts.mjs',
    '--mode',
    'inventory',
    '--facts-output',
    'test-results/protocol-contract-facts.json',
    '--mutation-output',
    'test-results/protocol-contract-mutation-proof.json',
  ]
}>

export const PROTOCOL_CONTRACT_REPORT_IDS: Readonly<{
  unions: 'production-discriminated-unions'
  production: 'production-protocol'
  configuration: 'configuration-protocol'
  durable: 'durable-command-pipeline'
  stages: 'protocol-stage-coverage'
  locality: 'tab-cross-tab-locality'
}>

export const PROTOCOL_CONTRACT_REPORT_ID_LIST: readonly [
  'production-discriminated-unions',
  'production-protocol',
  'configuration-protocol',
  'durable-command-pipeline',
  'protocol-stage-coverage',
  'tab-cross-tab-locality',
]
