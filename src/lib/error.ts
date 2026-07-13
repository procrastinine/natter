export function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value
  const message = typeof value === 'string' && value.length > 0 ? value : 'Unknown error'
  return new Error(message, { cause: value })
}
