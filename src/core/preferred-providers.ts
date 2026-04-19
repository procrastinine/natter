// Preferred-provider tiebreakers. See `plan/09-privacy.md §9.7`.
//
// Applied ONLY when the Pareto filter leaves multiple kept endpoints and
// `privacy.usePreferredOrdering` is true. Reorders within the kept set;
// it never adds or removes providers. Providers not named by the rule
// keep their original relative order and sit after the named ones.

export interface ProviderPreferenceRule {
  match: RegExp
  order: readonly string[]
}

// A small list, applied ONLY when Pareto leaves multiple endpoints. Add
// rules as real tradeoff ties are discovered. Current rules:
//
//   - OpenAI models: Azure first. Azure is clean; OpenAI direct retains
//     prompts for an unknown period and requires user IDs (verified
//     2026-04-19 curl). When Pareto is ON the filter already drops
//     OpenAI direct; this rule matters when the user has disabled Pareto
//     or has pinned both via `onlyProviders`.
//   - Anthropic models: Bedrock > Google Vertex > Anthropic direct.
//     Bedrock is clean; Google Vertex is clean-on-retention but requires
//     user IDs; Anthropic direct has 30d retention + user IDs. For older
//     Anthropic models where Bedrock isn't available (Claude 3.7 Sonnet
//     and earlier), Google Vertex becomes the first acceptable route.
//   - Gemini: AI Studio > Google (Vertex). AI Studio retains for 55 days
//     without user IDs; Vertex is clean on retention but requires user
//     IDs. Neither dominates; user preference breaks the tie.
//   - DeepSeek: historically third-party hosts (DeepInfra, Novita,
//     Chutes) are cleaner than DeepSeek direct (which trains on prompts).
export const PROVIDER_PREFERENCE: readonly ProviderPreferenceRule[] = [
  { match: /^openai\//, order: ['Azure', 'OpenAI'] },
  {
    match: /^anthropic\//,
    order: ['Amazon Bedrock', 'Google', 'Anthropic'],
  },
  { match: /^google\/gemini-/, order: ['Google AI Studio', 'Google'] },
  { match: /^deepseek\//, order: ['DeepInfra', 'Novita', 'Chutes', 'DeepSeek'] },
]

// Return the rule whose `match` fires on `model`, or `null`.
export function findPreferredRule(model: string): ProviderPreferenceRule | null {
  for (const rule of PROVIDER_PREFERENCE) {
    if (rule.match.test(model)) return rule
  }
  return null
}

// Reorder `keptNames` according to the preferred-order rule for `model`.
// Names present in the rule come first in rule order; names not in the
// rule preserve their original relative order at the tail. Returns a new
// array — never mutates the input.
export function applyPreferredOrdering(
  model: string,
  keptNames: readonly string[],
): string[] {
  const rule = findPreferredRule(model)
  if (!rule || keptNames.length <= 1) return [...keptNames]
  const keptSet = new Set(keptNames)
  const named: string[] = []
  for (const name of rule.order) {
    if (keptSet.has(name)) named.push(name)
  }
  const namedSet = new Set(named)
  const rest = keptNames.filter((n) => !namedSet.has(n))
  return [...named, ...rest]
}
