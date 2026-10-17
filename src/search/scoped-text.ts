import { buildRenderedText, buildSourceMappedText, matchStructuredText, normalizeMappedText } from './rendered-text'
import type { TextMatchMode } from './query-language'

export type ScopeKind = 'block' | 'section'

export interface ScopeEvidence {
  kind: ScopeKind
  id: string
  start: number
  end: number
}

export interface ScopedTextMatch {
  scope: ScopeEvidence
  sourceMatch: { match: string; offset: number } | null
}

export type ScopeRange = Omit<ScopeEvidence, 'kind'>

/** Return the start of note prose, excluding a leading YAML frontmatter block. */
export function getBodyStartOffset(content: string): number {
  // Accept LF and CRLF frontmatter delimiters. Match the opening delimiter as
  // a complete line so ordinary prose beginning with `---` isn't misclassified.
  const opening = /^---[ \t]*\r?\n/u.exec(content)
  if (!opening) return 0

  let cursor = opening[0].length
  while (cursor <= content.length) {
    const newline = content.indexOf('\n', cursor)
    const lineEnd = newline < 0 ? content.length : newline
    const line = content.slice(cursor, lineEnd).replace(/\r$/u, '')

    if (/^---[ \t]*$/u.test(line)) {
      // Start immediately after the closing delimiter, then skip blank lines
      // (including whitespace-only lines) without consuming the first body line.
      let bodyStart = newline < 0 ? content.length : newline + 1
      while (bodyStart < content.length) {
        const blankLine = /^[ \t]*\r?\n/u.exec(content.slice(bodyStart))
        if (!blankLine) break
        bodyStart += blankLine[0].length
      }
      return bodyStart
    }

    if (newline < 0) break
    cursor = newline + 1
  }

  // An unclosed frontmatter block is not safe to exclude; leave source intact.
  return 0
}

/**
 * Split Markdown-like source into block or heading-section ranges. Sections
 * include their own heading and descendants until the next same-level or
 * higher-level heading, matching the way heading scopes are normally read.
 */
export function getScopeRanges(content: string, kind: ScopeKind): ScopeRange[] {
  const bodyStart = getBodyStartOffset(content)
  if (bodyStart >= content.length) return []

  if (kind === 'block') {
    const ranges: ScopeRange[] = []
    const separator = /\r?\n[ \t]*\r?\n+/gu
    let start = bodyStart
    let match: RegExpExecArray | null
    while ((match = separator.exec(content)) !== null) {
      if (match.index > start && content.slice(start, match.index).trim()) {
        ranges.push({ id: String(start), start, end: match.index })
      }
      start = match.index + match[0].length
    }
    if (start < content.length && content.slice(start).trim()) {
      ranges.push({ id: String(start), start, end: content.length })
    }
    return ranges
  }

  const headings: Array<{ start: number; level: number }> = []
  const headingPattern = /^ {0,3}(#{1,6})[ \t]+[^\r\n]*$/gmu
  let headingMatch: RegExpExecArray | null
  while ((headingMatch = headingPattern.exec(content)) !== null) {
    if (headingMatch.index < bodyStart) continue
    headings.push({ start: headingMatch.index, level: headingMatch[1].length })
  }
  if (!headings.length) return [{ id: String(bodyStart), start: bodyStart, end: content.length }]

  const ranges: ScopeRange[] = []
  if (headings[0].start > bodyStart && content.slice(bodyStart, headings[0].start).trim()) {
    ranges.push({ id: String(bodyStart), start: bodyStart, end: headings[0].start })
  }
  headings.forEach((heading, index) => {
    let end = content.length
    for (const later of headings.slice(index + 1)) {
      if (later.level <= heading.level) {
        end = later.start
        break
      }
    }
    ranges.push({ id: String(heading.start), start: heading.start, end })
  })
  return ranges
}

/**
 * Match a field inside each block/section separately. Returned source offsets
 * always address raw source even when the visible phrase crosses Markdown
 * delimiters such as `**bold**` or a backslash-escaped punctuation character.
 */
export function findScopedTextMatches(
  content: string,
  query: string,
  kind: ScopeKind,
  mode: TextMatchMode,
  normalizeCharacter: (value: string) => string,
  rawQueryPattern = query,
): ScopedTextMatch[] {
  const pattern = normalizeMappedText(buildSourceMappedText(query), normalizeCharacter).text
  if (!pattern) return []
  const matches: ScopedTextMatch[] = []
  for (const range of getScopeRanges(content, kind)) {
    const rawScope = content.slice(range.start, range.end)
    const rendered = normalizeMappedText(buildRenderedText(rawScope), normalizeCharacter)
    if (!matchStructuredText(rendered.text, pattern, mode, rawQueryPattern)) continue

    let startIndex = mode === 'substring' ? rendered.text.indexOf(pattern) : 0
    if (startIndex < 0) continue
    let endIndex = mode === 'exact' || mode === 'glob'
      ? rendered.text.length - 1
      : Math.min(rendered.text.length - 1, startIndex + Math.max(pattern.length, 1) - 1)
    let sourceMatch: ScopedTextMatch['sourceMatch'] = null
    if (rendered.text.length && endIndex >= 0) {
      const sourceStart = range.start + (rendered.sourceOffsets[startIndex] ?? 0)
      const sourceEnd = range.start + (rendered.sourceEnds[endIndex] ?? rawScope.length)
      sourceMatch = {
        match: content.slice(sourceStart, Math.max(sourceStart + 1, sourceEnd)),
        offset: sourceStart,
      }
    }
    matches.push({ scope: { kind, ...range }, sourceMatch })
  }
  return matches
}

export function mergeScopeEvidence(...groups: ScopeEvidence[][]): ScopeEvidence[] {
  const unique = new Map<string, ScopeEvidence>()
  for (const scope of groups.flat()) unique.set(`${scope.kind}:${scope.id}`, scope)
  return [...unique.values()]
}

/**
 * Intersect evidence for two predicates. If both sides constrain the same kind
 * of scope, at least one scope ID must overlap. A null result means that the
 * file-level Boolean intersection is not valid within the declared scope.
 */
export function intersectScopeEvidence(left: ScopeEvidence[], right: ScopeEvidence[]): ScopeEvidence[] | null {
  const leftKinds = new Set(left.map(scope => scope.kind))
  const rightKinds = new Set(right.map(scope => scope.kind))
  const sharedKinds = [...leftKinds].filter(kind => rightKinds.has(kind))
  if (!sharedKinds.length) return mergeScopeEvidence(left, right)
  const accepted = new Map<ScopeKind, Set<string>>()
  for (const kind of sharedKinds) {
    const leftIds = new Set(left.filter(scope => scope.kind === kind).map(scope => scope.id))
    const shared = new Set(right.filter(scope => scope.kind === kind && leftIds.has(scope.id)).map(scope => scope.id))
    if (!shared.size) return null
    accepted.set(kind, shared)
  }
  return mergeScopeEvidence(left, right).filter(scope => !accepted.has(scope.kind) || accepted.get(scope.kind)!.has(scope.id))
}

export function filterMatchesToScopes<T extends { offset: number }>(matches: T[], scopes: ScopeEvidence[]): T[] {
  if (!scopes.length) return matches
  return matches.filter(match => scopes.some(scope => match.offset >= scope.start && match.offset < scope.end))
}
