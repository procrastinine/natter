// Rough pre-send token estimation. See `plan/14-details.md §14.15`.
//
// Real tokenization needs the model's tokenizer binary and is out of scope for V1.
// These char/token ratios are deliberately conservative (they over-report slightly)
// so the UI context gauge is safer to under-fill. `usage.*_tokens` in the response
// is authoritative and always wins during reconciliation.

export type TokenizerFamily =
  | 'claude'
  | 'gpt'
  | 'gemini'
  | 'llama'
  | 'mistral'
  | 'deepseek'
  | 'qwen'
  | 'unknown'

// Family → characters per token. Lower = more tokens per char = more conservative.
// `gpt` covers both `cl100k_base` and `o200k_base` per the table in §14.15; other
// OSS families share the `llama/mistral/deepseek/qwen = 3.5` bucket.
const CHAR_PER_TOKEN: Readonly<Record<TokenizerFamily, number>> = Object.freeze({
  claude: 3.8,
  gpt: 3.5,
  gemini: 4.0,
  llama: 3.5,
  mistral: 3.5,
  deepseek: 3.5,
  qwen: 3.5,
  unknown: 4.0,
})

// Normalize a tokenizer string from `/endpoints` `architecture.tokenizer` into
// our coarse family bucket. Accepts the canonical names observed across
// OpenRouter (`Claude`, `GPT`, `cl100k_base`, `o200k_base`, `Gemini`, `Llama`,
// `Llama3`, `Mistral`, `DeepSeek`, `Qwen`) and is defensively case-insensitive
// because the field shape isn't formally contracted.
export function tokenizerFamily(name: string | null | undefined): TokenizerFamily {
  if (!name) return 'unknown'
  const s = name.toLowerCase()
  if (s.includes('claude')) return 'claude'
  if (s.includes('gpt') || s.includes('cl100k') || s.includes('o200k')) return 'gpt'
  if (s.includes('gemini')) return 'gemini'
  if (s.includes('llama')) return 'llama'
  if (s.includes('mistral')) return 'mistral'
  if (s.includes('deepseek')) return 'deepseek'
  if (s.includes('qwen')) return 'qwen'
  return 'unknown'
}

export function charPerToken(family: TokenizerFamily): number {
  return CHAR_PER_TOKEN[family]
}

// Rough token count for a text blob. Uses `Math.ceil` so the trailing partial
// token is counted — matches the "slightly over-report" discipline in §14.15.
export function estimateTokens(text: string, family: TokenizerFamily): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / CHAR_PER_TOKEN[family])
}

// Convenience: estimate using a raw `architecture.tokenizer` string directly.
export function estimateTokensByTokenizer(
  text: string,
  tokenizerName: string | null | undefined,
): number {
  return estimateTokens(text, tokenizerFamily(tokenizerName))
}
