import { combineMatchProvenance } from './query-language'

/** The subset of a search hit that participates in result provenance. */
type MatchProvenance = { semantic: boolean; literal: boolean }

export type ProvenanceHit = {
  semantic: boolean
  literal: boolean
  result: { provenance?: MatchProvenance }
}

/**
 * Overlay independently satisfied semantic predicates onto final query results.
 *
 * The Boolean AST decides membership before this helper is called. Iterating the
 * final result map (rather than the semantic evidence set) therefore enriches
 * labels without accidentally inserting results that failed the full query.
 */
export function overlaySemanticEvidence<T extends ProvenanceHit>(
  matches: Map<string, T>,
  semanticEvidencePaths: ReadonlySet<string>,
): void {
  for (const [path, hit] of matches) {
    if (!semanticEvidencePaths.has(path)) continue
    const provenance = combineMatchProvenance(
      'OR',
      { semantic: hit.semantic, literal: hit.literal },
      { semantic: true, literal: false },
    ).provenance
    hit.semantic = provenance.semantic
    hit.literal = provenance.literal
    hit.result.provenance = provenance
  }
}
