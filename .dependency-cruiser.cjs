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
      severity: 'warn',
      from: {},
      to: { circular: true },
    },
    {
      name: 'ui-must-not-import-db-directly',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/store/db\\.ts$' },
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
  ],
  options: {
    includeOnly: '^src',
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
  },
}
