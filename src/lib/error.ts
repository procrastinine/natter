export function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value
  const message = typeof value === 'string' && value.length > 0 ? value : 'Unknown error'
  return new Error(message, { cause: value })
}

export function errorHasName(value: unknown, name: string): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && value.name === name
}
