export const BROWSER_WORKSPACE_CONTROL_DATABASE_NAME = 'natter-control'
export const BROWSER_WORKSPACE_DATABASE_NAMES = Object.freeze([
  'natter',
  'natter-workspace-a',
  'natter-workspace-b',
] as const)
export const NATTER_INDEXED_DATABASE_NAMES = Object.freeze([
  BROWSER_WORKSPACE_CONTROL_DATABASE_NAME,
  ...BROWSER_WORKSPACE_DATABASE_NAMES,
] as const)

export type BrowserWorkspaceDatabaseName = (typeof BROWSER_WORKSPACE_DATABASE_NAMES)[number]
