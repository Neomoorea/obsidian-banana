import { describe, expect, it } from 'vitest'
import { maskQuerySyntaxOccurrences } from '../search/literal-matching'
import { overlaySemanticEvidence } from '../search/match-provenance'

describe('literal query spelling and semantic evidence', () => {
  it('labels a final literal result Both when a positive semantic predicate also matches', () => {
    const makeHit = (semantic: boolean, literal: boolean) => ({
      semantic,
      literal,
      result: { provenance: { semantic, literal } },
    })
    const matches = new Map([
      ['Literal.md', makeHit(false, true)],
      ['Both.md', makeHit(false, true)],
      ['Semantic.md', makeHit(true, false)],
    ])
    // Semantic.md is not the only evidence source: any positive predicate can
    // enrich an OR-admitted literal result. A path absent from final membership
    // must not be inserted just because some predicate matched it.
    const semanticEvidence = new Set(['Both.md', 'Semantic.md', 'NotInResults.md'])

    overlaySemanticEvidence(matches, semanticEvidence)

    expect(matches.get('Literal.md')?.result.provenance).toEqual({ semantic: false, literal: true })
    expect(matches.get('Both.md')?.result.provenance).toEqual({ semantic: true, literal: true })
    expect(matches.get('Semantic.md')?.result.provenance).toEqual({ semantic: true, literal: false })
    expect(matches.has('NotInResults.md')).toBe(false)
  })

  it('masks the exact syntax case-insensitively without shifting source offsets', () => {
    const source = 'Before SECTION:1 after\r\n## 1\r\nMore text'
    const masked = maskQuerySyntaxOccurrences(source, 'section:1')

    expect(masked).toBe(source.replace(/SECTION:1/giu, match => ' '.repeat(match.length)))
    expect(masked.length).toBe(source.length)
    expect(masked.indexOf('## 1')).toBe(source.indexOf('## 1'))
  })

  it('leaves text untouched when the complete query spelling is absent', () => {
    const source = '## 1\nA semantic section heading.'
    expect(maskQuerySyntaxOccurrences(source, 'section:1')).toBe(source)
  })

  it('preserves UTF-16 offsets when query syntax contains supplementary Unicode characters', () => {
    const source = 'content:😀\nA separate 😀 value.'
    const masked = maskQuerySyntaxOccurrences(source, 'content:😀')
    expect(masked.length).toBe(source.length)
    expect(masked.indexOf('A separate')).toBe(source.indexOf('A separate'))
    expect(masked.split('\n')).toHaveLength(2)
  })

  it('preserves all original line breaks while masking repeated expressions', () => {
    const source = 'tag:#research\nA separate tag:#research occurrence.'
    const masked = maskQuerySyntaxOccurrences(source, 'tag:#research')
    expect(masked).toBe(source.replace(/tag:#research/giu, match => ' '.repeat(match.length)))
    expect(masked.split('\n')).toHaveLength(2)
    expect(masked.length).toBe(source.length)
  })
})
