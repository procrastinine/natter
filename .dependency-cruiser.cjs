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
      name: 'core-must-not-import-ui',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { path: '^src/ui/' },
    },
    {
      name: 'store-must-not-import-ui',
      severity: 'error',
      from: { path: '^src/store/' },
      to: { path: '^src/ui/' },
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
