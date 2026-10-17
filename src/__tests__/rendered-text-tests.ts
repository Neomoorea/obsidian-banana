import { describe, expect, it } from 'vitest'
import { buildRenderedText, buildSourceMappedText, matchStructuredText, normalizeMappedText } from '../search/rendered-text'
import { normalizeQueryValue } from '../search/query-language'

describe('rendered Markdown matching and source offsets', () => {
  const normalizeCharacter = (value: string) => value.normalize('NFKC').toLocaleLowerCase()

  it('finds escaped punctuation in the rendered representation without erasing raw source', () => {
    const raw = String.raw`Before \%\%\% after`
    const source = buildSourceMappedText(raw)
    const rendered = buildRenderedText(raw)
    const rawNormalized = normalizeMappedText(source, normalizeCharacter)
    const renderedNormalized = normalizeMappedText(rendered, normalizeCharacter)
    expect(rawNormalized.text).toContain(String.raw`\%\%\%`)
    expect(renderedNormalized.text).toContain('%%%')
    const index = renderedNormalized.text.indexOf('%%%')
    expect(raw.slice(renderedNormalized.sourceOffsets[index], renderedNormalized.sourceEnds[index + 2])).toBe(String.raw`\%\%\%`)
    expect(rawNormalized.text).not.toContain('%%%')
  })

  it('does not strip asterisks that are ordinary punctuation', () => {
    const raw = '5*3 equals 15, and this is **bold** text'
    const rendered = buildRenderedText(raw).text
    expect(rendered).toContain('5*3 equals 15')
    expect(rendered).toContain('bold')
    expect(buildRenderedText('a *small* change').text).toBe('a small change')
    expect(rendered).not.toContain('**')
  })

  it('matches a phrase across inline Markdown formatting and maps it to the full source range', () => {
    const raw = 'a **bbb** a'
    const rendered = normalizeMappedText(buildRenderedText(raw), normalizeCharacter)
    const phrase = normalizeQueryValue('a bbb a')
    const at = rendered.text.indexOf(phrase)
    expect(rendered.text).toContain(phrase)
    const start = rendered.sourceOffsets[at]
    const end = rendered.sourceEnds[at + phrase.length - 1]
    expect(raw.slice(start, end)).toBe('a **bbb** a')
  })

  it('keeps raw-source phrase matching distinct from a phrase rendered across Markdown formatting', () => {
    const raw = 'A **convolutional** neural network.'
    const phrase = normalizeQueryValue('convolutional neural network')
    const source = normalizeMappedText(buildSourceMappedText(raw), normalizeCharacter)
    const rendered = normalizeMappedText(buildRenderedText(raw), normalizeCharacter)

    expect(source.text).not.toContain(phrase)
    expect(rendered.text).toContain(phrase)
  })

  it('projects visible Markdown link labels and entities while omitting frontmatter prose', () => {
    const raw = '---\nstatus: active\n---\nA [readable label](https://example.test) &amp; [[Target|friendly alias]].'
    const rendered = buildRenderedText(raw).text
    expect(rendered).not.toContain('status: active')
    expect(rendered).toContain('A readable label & friendly alias.')
    expect(rendered).not.toContain('https://example.test')
    const linkAt = rendered.indexOf('readable')
    const mapped = buildRenderedText(raw)
    expect(raw.slice(mapped.sourceOffsets[linkAt], mapped.sourceEnds[linkAt + 'readable'.length - 1])).toBe('readable')
  })

  it('matches structured values by exact, prefix, substring and glob modes', () => {
    expect(matchStructuredText('README.md', 'README.md', 'exact')).toBe(true)
    expect(matchStructuredText('README copy.md', 'README.md', 'exact')).toBe(false)
    expect(matchStructuredText('Projects/Research', 'Projects/', 'prefix')).toBe(true)
    expect(matchStructuredText('Priority Active', 'tive', 'substring')).toBe(true)
    expect(matchStructuredText('Priority Active', '*tive', 'glob')).toBe(true)
    expect(matchStructuredText('Priority Active', '*active', 'glob')).toBe(true)
    expect(matchStructuredText('star*tail-final', 'star*tail*', 'glob', String.raw`star\*tail*`)).toBe(true)
    expect(matchStructuredText('starXtail-final', 'star*tail*', 'glob', String.raw`star\*tail*`)).toBe(false)
  })
})

describe('text candidate index', () => {
  it('narrows punctuation and literal lookups to candidate notes and removes stale paths', async () => {
    const { TextCandidateIndex } = await import('../search/text-candidate-index')
    const index = new TextCandidateIndex()
    index.add('Escaped.md', { raw: String.raw`raw \%\%\%`, rendered: 'raw %%%', metadata: 'Escaped.md Escaped' })
    index.add('Literal.md', { raw: 'the literal syntax tag:#mytag', rendered: 'the literal syntax tag:#mytag', metadata: 'Literal.md Literal' })
    index.add('FalsePositive.md', { raw: 'alpha beta gamma', rendered: 'alpha beta gamma', metadata: 'FalsePositive.md' })
    const phraseSource = 'a **bbb** a'
    index.add('Formatted.md', { raw: phraseSource, rendered: buildRenderedText(phraseSource).text, metadata: 'Formatted.md' })
    expect([...index.find('a bbb a', ['rendered'])]).toEqual(['Formatted.md'])
    expect([...index.find('a bbb a', ['raw'])]).toEqual([])
    expect([...index.find('%%%', ['rendered'])]).toEqual(['Escaped.md'])
    expect([...index.find('tag:#mytag', ['raw'])]).toEqual(['Literal.md'])
    expect([...index.find('alphabetagamma', ['raw'])]).toEqual([])
    index.remove('Literal.md')
    expect([...index.find('tag:#mytag', ['raw'])]).toEqual([])
  })
})
