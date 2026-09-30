import { mergeConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import { vitestProjectConfigurations, vitestProjects } from './scripts/vitest-projects.mjs'
import VitestProofReporter, { selectVitestProofFiles } from './scripts/vitest-proof-reporter.mjs'
import { GlobalTestSequencer } from './scripts/vitest-sequencer.mjs'
import viteConfig from './vite.config.ts'

export default defineConfig((environment) => {
  const projects = vitestProjects()
  const proofPath = process.env.VERIFICATION_VITEST_PROOF_PATH
  const proofFiles = proofPath
    ? selectVitestProofFiles(projects, process.env.VERIFICATION_VITEST_SELECTION)
    : []
  const createBaseConfig = () =>
    mergeConfig(viteConfig(environment), {
      test: {
        sequence: { sequencer: GlobalTestSequencer },
        ...(proofPath ? { allowOnly: false } : {}),
        globals: false,
        css: false,
        // Node's BroadcastChannel crosses worker_threads within a single process,
        // which makes the default `threads` pool leak cross-tab broadcast events
        // between parallel test files. Forks give each file its own process and
        // keep that leakage out of tests that assert on event fan-out.
        pool: 'forks',
        execArgv: ['--no-experimental-webstorage'],
        maxWorkers: 2,
      },
    })
  return mergeConfig(createBaseConfig(), {
    test: {
      ...(proofPath
        ? {
            reporters: [
              'default',
              new VitestProofReporter({
                path: proofPath,
                expected: proofFiles,
                invocation: process.env.VERIFICATION_VITEST_INVOCATION,
              }),
            ],
          }
        : {}),
      projects: vitestProjectConfigurations(projects, (project) =>
        mergeConfig(createBaseConfig(), project),
      ),
    },
  })
})
