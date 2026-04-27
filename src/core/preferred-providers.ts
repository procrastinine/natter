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

// Known-good OSS-model hosts, in rough preference order. Used by every
// open-weights model below (DeepSeek, Qwen, Llama, Mistral, Gemma, etc).
// Chutes is deliberately excluded. It doesn't train on prompts, but per
// user report (2026-04-19) it retains prompts for an unknown period. Live
// OpenRouter policy data should make Pareto dominate it whenever a clean
// host is available; the user can still manually include it if accepting
// the tradeoff.
// The user's curated list was: DeepInfra, Together, Novita, Parasail, Fireworks.
const OSS_PREFERRED: readonly string[] = [
  'DeepInfra',
  'Together',
  'Novita',
  'Parasail',
  'Fireworks',
]

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
// Open-weights labs whose models route through the OSS_PREFERRED hosts.
// Matched by the **author/lab segment** of the slug (everything before the
// first `/`) — `deepseek/deepseek-r1`, `moonshotai/kimi-k2`,
// `z-ai/glm-4.6`, etc. The author segment is the stable identifier; model
// names within a lab churn faster than the lab itself.
//
// Not listed: anthropic, openai, google (proprietary; have their own rules);
// cohere, x-ai, perplexity, nvidia, etc. (either not open-weights, or their
// OSS routing isn't worth a curated rule yet).
const OSS_LABS: readonly string[] = [
  'qwen',
  'deepseek',
  'moonshotai',
  'z-ai',
  'minimax',
  'meta-llama',
  'mistralai',
]

function ossRuleForLab(lab: string): ProviderPreferenceRule {
  // `/^lab\//` anchors on the author segment. Anchoring avoids false
  // positives like "qwen-plus" or "z-ai-hosted-gemini" appearing inside a
  // longer slug. Periods, hyphens, and underscores in lab names are safe
  // inside a JS regex character class but the RegExp stays literal-ish
  // since all listed labs are alphanumeric-plus-hyphen.
  const escaped = lab.replace(/[-]/g, '\\-')
  return { match: new RegExp(`^${escaped}/`), order: OSS_PREFERRED }
}

// A small list, applied ONLY when Pareto leaves multiple endpoints. The
// proprietary-vendor rules (OpenAI, Anthropic, Gemini) encode manual
// knowledge about dominance on a fixed provider set. The OSS-lab rules
// steer open-weights models to the known-good host list.
//
// DeepSeek direct is NEVER listed as a preferred host. It trains on
// prompts, so live policy data should hard-deny it before ordering ever
// runs. Chutes is NEVER listed either; it retains for an unknown period
// (user report 2026-04-19) and gets dominated by any clean host via
// Pareto when live policy data is available.
export const PROVIDER_PREFERENCE: readonly ProviderPreferenceRule[] = [
  { match: /^openai\//, order: ['Azure', 'OpenAI'] },
  {
    match: /^anthropic\//,
    order: ['Amazon Bedrock', 'Google', 'Anthropic'],
  },
  { match: /^google\/gemini-/, order: ['Google AI Studio', 'Google'] },
  ...OSS_LABS.map(ossRuleForLab),
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
// array; never mutates the input.
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
