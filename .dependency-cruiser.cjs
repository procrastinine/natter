module.exports = {
  forbidden: [
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-uninventoried-production-orphans',
      severity: 'error',
      from: {
        orphan: true,
        path: '^src/',
        pathNot: [
          '^src/(main\\.tsx|vite-env\\.d\\.ts)$',
        ],
      },
      to: {},
    },
    {
      name: 'presentation-must-use-workspace-boundary',
      severity: 'error',
      from: { path: '^src/(ui|hooks)/' },
      to: {
        path: '^src/store/(browser-(repo|import-export|domain-mutations|lock-record)|db)\\.ts$',
      },
    },
    {
      name: 'backcompat-must-not-import-runtime-db',
      severity: 'error',
      from: { path: '^src/backcompat/' },
      to: {
        path: '^src/store/(browser-(repo|import-export|domain-mutations)|db|workspace-repository)\\.ts$',
      },
    },
    {
      name: 'core-must-not-import-api-or-application',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/(api|app|hooks|store|ui)/' },
    },
    {
      name: 'api-must-not-import-application',
      severity: 'error',
      from: { path: '^src/api/' },
      to: { path: '^src/(app|hooks|store|ui)/' },
    },
    {
      name: 'store-must-not-import-ui',
      severity: 'error',
      from: { path: '^src/store/' },
      to: { path: '^src/ui/' },
    },
    {
      name: 'conversation-ui-mutations-must-use-application-service',
      severity: 'error',
      from: { path: '^src/(hooks|ui)/' },
      to: {
        path: '^src/store/(chat-fork|conversation-command-client|conversation-workspace|generation-engine|structural-undo)\\.ts$',
      },
    },
    {
      name: 'conversation-app-command-client-has-one-owner',
      severity: 'error',
      from: { path: '^src/app/(?!conversation-actions\\.ts$)' },
      to: { path: '^src/store/conversation-command-client\\.ts$' },
    },
    {
      name: 'generation-engine-has-one-application-client',
      severity: 'error',
      from: { path: '^src/(app|hooks|ui)/' },
      to: { path: '^src/store/generation-engine\\.ts$' },
    },
    {
      name: 'runtime-must-not-import-devtools',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^tools/' },
    },
    {
      name: 'runtime-must-not-import-scripts',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^scripts/' },
    },
  ],
  options: {
    includeOnly: '^(src|tools|scripts)/',
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
  },
}
