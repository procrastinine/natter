import type ts from 'typescript'

export function createProductionTypeScriptProgram(root?: string): ts.Program
export function productionTypeScriptSources(
  program: ts.Program,
  root?: string,
): readonly ts.SourceFile[]
export function exactProductionTypeScriptSource(
  program: ts.Program,
  path: string,
  root?: string,
): ts.SourceFile
export function productionTypeScriptSourceDigest(program: ts.Program, root?: string): string
export function productionTypeScriptFileDigest(root?: string): string
