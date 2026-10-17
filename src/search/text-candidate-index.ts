export type CandidateView = 'raw' | 'rendered' | 'metadata'
export type CandidateTextViews = Record<CandidateView, string>

type PostingIndex = Map<string, Set<string>>
type StoredTerms = Record<CandidateView, Set<string>>

/**
 * In-memory n-gram candidate index for query types that MiniSearch cannot
 * tokenize (notably punctuation-only rendered Markdown queries) and explicit
 * raw-literal predicates. It narrows candidates; callers still verify matches
 * and preserve Banana's scoring for ordinary text queries.
 */
export class TextCandidateIndex {
  private readonly postings: Record<CandidateView, PostingIndex> = {
    raw: new Map(),
    rendered: new Map(),
    metadata: new Map(),
  }
  private readonly termsByPath = new Map<string, StoredTerms>()

  clear(): void {
    this.postings.raw.clear()
    this.postings.rendered.clear()
    this.postings.metadata.clear()
    this.termsByPath.clear()
  }

  has(path: string): boolean {
    return this.termsByPath.has(path)
  }

  add(path: string, views: CandidateTextViews): void {
    this.remove(path)
    const stored: StoredTerms = { raw: new Set(), rendered: new Set(), metadata: new Set() }
    for (const view of ['raw', 'rendered', 'metadata'] as const) {
      const terms = this.getTerms(views[view])
      stored[view] = terms
      const posting = this.postings[view]
      for (const term of terms) {
        let paths = posting.get(term)
        if (!paths) posting.set(term, (paths = new Set()))
        paths.add(path)
      }
    }
    this.termsByPath.set(path, stored)
  }

  remove(path: string): void {
    const stored = this.termsByPath.get(path)
    if (!stored) return
    for (const view of ['raw', 'rendered', 'metadata'] as const) {
      const posting = this.postings[view]
      for (const term of stored[view]) {
        const paths = posting.get(term)
        paths?.delete(path)
        if (paths?.size === 0) posting.delete(term)
      }
    }
    this.termsByPath.delete(path)
  }

  find(needle: string, views: readonly CandidateView[]): Set<string> {
    if (!needle) return new Set()
    const matches = new Set<string>()
    for (const view of views) {
      for (const path of this.findInView(needle, this.postings[view])) matches.add(path)
    }
    return matches
  }

  private findInView(needle: string, posting: PostingIndex): Set<string> {
    const entries = [...this.getTerms(needle)].map(term => ({ term, paths: posting.get(term) }))
    if (!entries.length || entries.some(entry => !entry.paths)) return new Set()
    // Start with the rarest n-gram and only intersect smaller candidate sets;
    // resetting to a later, smaller posting list would lose earlier filters.
    entries.sort((left, right) => left.paths!.size - right.paths!.size)
    const candidates = new Set(entries[0].paths)
    for (const entry of entries.slice(1)) {
      const paths = entry.paths!
      for (const candidate of candidates) if (!paths.has(candidate)) candidates.delete(candidate)
      if (candidates.size === 0) return candidates
    }
    return candidates
  }

  private getTerms(value: string): Set<string> {
    const terms = new Set<string>()
    const gramSize = Math.min(3, value.length)
    if (!gramSize) return terms
    // All contiguous 1-, 2-, or 3-code-unit grams are indexed, allowing short
    // punctuation queries while keeping lookup proportional to query length.
    for (let size = 1; size <= gramSize; size++) {
      for (let index = 0; index <= value.length - size; index++) {
        terms.add(value.slice(index, index + size))
      }
    }
    return terms
  }
}
