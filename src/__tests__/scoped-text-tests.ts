import { describe, expect, it } from 'vitest'
import { findScopedTextMatches, getBodyStartOffset, getScopeRanges, intersectScopeEvidence } from '../search/scoped-text'

const normalizeCharacter = (value: string): string => value.normalize('NFKC').toLocaleLowerCase()
const matches = (source: string, query: string, kind: 'block' | 'section') =>
  findScopedTextMatches(source, query, kind, 'substring', normalizeCharacter)

function evidence(source: string, query: string, kind: 'block' | 'section') {
  return matches(source, query, kind).map(match => match.scope)
}

describe('block and section scoped matching', () => {
  it('excludes YAML frontmatter and separator blank lines from rendered body scopes', () => {
    const source = '---\nstatus: active\n---\n\nVisible body text.\n'
    expect(getBodyStartOffset(source)).toBe(source.indexOf('Visible'))
    expect(getScopeRanges(source, 'block').map(range => source.slice(range.start, range.end).trim())).toEqual(['Visible body text.'])
  })

  it('handles frontmatter followed immediately by the body', () => {
    const source = '---\nstatus: active\n---\nVisible body text.\n'
    expect(getBodyStartOffset(source)).toBe(source.indexOf('Visible'))
  })

  it('handles CRLF frontmatter and multiple blank separator lines', () => {
    const source = '---\r\nstatus: active\r\n---\r\n\r\n\r\nVisible body text.\r\n'
    expect(getBodyStartOffset(source)).toBe(source.indexOf('Visible'))
    expect(getScopeRanges(source, 'block').map(range => source.slice(range.start, range.end).trim())).toEqual(['Visible body text.'])
  })

  it('keeps a blank line inside the frontmatter from pulling frontmatter text into the first block', () => {
    const source = '---\nstatus: active\n\nowner: me\n---\nVisible body text.\n\nSecond block.\n'
    const blocks = getScopeRanges(source, 'block')
    expect(blocks.map(range => source.slice(range.start, range.end).trim())).toEqual(['Visible body text.', 'Second block.'])
    expect(blocks[0].start).toBe(getBodyStartOffset(source))
    expect(matches(source, 'owner', 'block')).toEqual([])
    expect(matches(source, 'visible', 'block')).toHaveLength(1)
  })

  it('anchors a wildcard pattern in a scope by its match mode', () => {
    const source = 'AI LLM\n\nAI LLMs\n\ndefinitions of AI LLM\n'
    const found = (query: string, mode: 'exact' | 'prefix' | 'substring' | 'glob', globPattern?: string) =>
      findScopedTextMatches(source, query, 'block', mode, normalizeCharacter, globPattern)
        .map(match => source.slice(match.scope.start, match.scope.end).trim())
    expect(found('AI LLM*', 'exact', 'AI LLM*')).toEqual(['AI LLM', 'AI LLMs'])
    expect(found('AI*', 'prefix', 'AI*')).toEqual(['AI LLM', 'AI LLMs'])
    expect(found('of*LLM', 'substring', 'of*LLM')).toEqual(['definitions of AI LLM'])
    expect(found('AI LLM', 'exact')).toEqual(['AI LLM'])
  })

  it('does not exclude content when the frontmatter closing fence is missing', () => {
    const source = '---\nstatus: active\n\nVisible body text.\n'
    expect(getBodyStartOffset(source)).toBe(0)
  })

  it('requires both block predicates to match the same blank-line-delimited block', () => {
    const source = 'Alpha appears here.\n\nBeta appears separately.\n'
    const alpha = evidence(source, 'alpha', 'block')
    const beta = evidence(source, 'beta', 'block')
    expect(alpha).toHaveLength(1)
    expect(beta).toHaveLength(1)
    expect(intersectScopeEvidence(alpha, beta)).toBeNull()

    const sameBlock = 'Alpha and Beta appear together.\n'
    expect(intersectScopeEvidence(evidence(sameBlock, 'alpha', 'block'), evidence(sameBlock, 'beta', 'block'))).not.toBeNull()
  })

  it('requires section evidence to overlap by heading scope and supports nested sections', () => {
    const source = '# Parent\n\nAlpha overview.\n\n## Child\n\nBeta detail.\n\n# Next\n\nGamma elsewhere.\n'
    const alpha = evidence(source, 'alpha', 'section')
    const beta = evidence(source, 'beta', 'section')
    expect(intersectScopeEvidence(alpha, beta)).not.toBeNull() // both occur within Parent's section
    const gamma = evidence(source, 'gamma', 'section')
    expect(intersectScopeEvidence(alpha, gamma)).toBeNull()
  })

  it('maps a rendered phrase across emphasis syntax back to the raw source span', () => {
    const source = 'a **bbb** a'
    const finding = matches(source, 'a bbb a', 'block')[0]
    expect(finding?.sourceMatch).toMatchObject({ offset: 0, match: source })
  })

  it('supports a file without Markdown headings as one implicit section', () => {
    const source = 'A plain body with a phrase.\n\nAnother paragraph.'
    const ranges = getScopeRanges(source, 'section')
    expect(ranges).toEqual([{ id: '0', start: 0, end: source.length }])
    expect(matches(source, 'phrase', 'section')).toHaveLength(1)
  })
})
