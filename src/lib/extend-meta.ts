/**
 * (fix 293) Merging metadata of an extension combined file with the sidecar
 * of the SOURCE (route /api/comfy/concat cannot export helpers —
 * Next.js allows only HTTP methods in a route file, so the function is here).
 *
 * Pure function (extracted for testing):
 *  • references — if client did not send them (extend tab carried no refs in meta),
 *    inherit from source (references / minimax_h3_references);
 *  • extend_prompts — source chain + clip prompts of this extension:
 *    accumulated across multiple extensions, duplicates at junctions collapsed;
 *  • source_prompt — prompt of the source (or its source_prompt — the earliest
 *    in chain), if different from combined prompt. We do not overwrite prompt.
 */
export function mergeExtendMeta(
  bodyMeta: Record<string, unknown>,
  sourceMeta: Record<string, unknown> | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...bodyMeta }
  if (!sourceMeta) return merged

  const hasRefs = Array.isArray(merged.references) && (merged.references as unknown[]).length > 0
  if (!hasRefs) {
    const srcRefs = Array.isArray(sourceMeta.references) ? sourceMeta.references
      : Array.isArray(sourceMeta.minimax_h3_references) ? sourceMeta.minimax_h3_references
      : null
    if (srcRefs && srcRefs.length > 0) merged.references = srcRefs
  }

  const srcChain = (Array.isArray(sourceMeta.extend_prompts) ? sourceMeta.extend_prompts : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
  const clipPrompts = (Array.isArray(merged.extend_prompts) ? (merged.extend_prompts as unknown[]) : [])
    .filter((p): p is string => typeof p === 'string' && (p as string).trim().length > 0)
  const chain = [...srcChain, ...clipPrompts]
  const deduped = chain.filter((p, i) => i === 0 || p !== chain[i - 1])
  if (deduped.length > 0) merged.extend_prompts = deduped
  else delete merged.extend_prompts

  // The earliest prompt in the chain is more important: source_prompt of the source first.
  if (typeof sourceMeta.source_prompt === 'string' && sourceMeta.source_prompt.trim()
      && sourceMeta.source_prompt !== merged.prompt && merged.source_prompt === undefined) {
    merged.source_prompt = sourceMeta.source_prompt
  } else if (typeof sourceMeta.prompt === 'string' && sourceMeta.prompt.trim()
      && sourceMeta.prompt !== merged.prompt && merged.source_prompt === undefined) {
    merged.source_prompt = sourceMeta.prompt
  }
  return merged
}
