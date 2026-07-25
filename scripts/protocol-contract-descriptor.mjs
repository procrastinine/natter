export const PROTOCOL_CONTRACT_STAGE = Object.freeze({
  id: 'protocol-contracts',
  label:
    'Audit production unions, protocol ownership, configuration, durable, stage, and locality contracts',
  policy: 'blocking',
  argv: Object.freeze([
    'node',
    'scripts/audit-protocol-contracts.mjs',
    '--mode',
    'inventory',
    '--facts-output',
    'test-results/protocol-contract-facts.json',
    '--mutation-output',
    'test-results/protocol-contract-mutation-proof.json',
  ]),
})

export const PROTOCOL_CONTRACT_REPORT_IDS = Object.freeze({
  unions: 'production-discriminated-unions',
  production: 'production-protocol',
  configuration: 'configuration-protocol',
  durable: 'durable-command-pipeline',
  stages: 'protocol-stage-coverage',
  locality: 'tab-cross-tab-locality',
})

export const PROTOCOL_CONTRACT_REPORT_ID_LIST = Object.freeze(
  Object.values(PROTOCOL_CONTRACT_REPORT_IDS),
)
