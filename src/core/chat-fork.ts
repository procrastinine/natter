// "Branch this chat from here" — fork an entire chat at the selected
// message into a NEW Chat row.
//
// Distinct from the per-message structural "branch from here" action
// (§8.4.6 `branchExplicit`), which creates a SIBLING variant in the
// same chat. The fork produces a brand-new chat that contains only the
// active-path ancestors of the selected message (root → … → node,
// inclusive) — no descendants below the node, no sibling variants. The
// user then "continues from here" in a separate chat.
//
// Performance note: a "branch" of a chat really means the selection of
// a leaf. The tree stores every node and branches are just one root→
// leaf walk picked by the cursor. This fork flattens that walk into a
// self-contained Chat, which is why it doesn't need to copy siblings
// or descendants.

// Compute a default title for a fork: "{base} Branch N" where N is the
// smallest positive integer making the title unique in the current chat
// list. If the source chat has no title (titleStatus: 'untitled' or an
// empty title), use the constant placeholder "Untitled chat".
export function computeBranchTitle(baseTitle: string, existingTitles: readonly string[]): string {
  const base = baseTitle.trim() || 'Untitled chat'
  const prefix = `${base} Branch `
  const ordinals = existingTitles.flatMap((title) => {
    const normalized = title.trim()
    if (!normalized.startsWith(prefix)) return []
    const suffix = normalized.slice(prefix.length)
    const ordinal = Number(suffix)
    return Number.isSafeInteger(ordinal) && ordinal > 0 && suffix === String(ordinal)
      ? [ordinal]
      : []
  })
  return computeBranchTitleFromOrdinals(base, ordinals)
}

export function computeBranchTitleFromOrdinals(
  baseTitle: string,
  existingOrdinals: Iterable<number>,
): string {
  const base = baseTitle.trim() || 'Untitled chat'
  const taken = new Set(existingOrdinals)
  let ordinal = 1
  while (taken.has(ordinal)) ordinal += 1
  return `${base} Branch ${ordinal}`
}
