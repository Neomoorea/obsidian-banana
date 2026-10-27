import { describe, expect, it } from 'vitest'
import { Query } from '../search/query'

describe('The Query class', () => {
  const stringQuery =
    "foo bar 'lorem ipsum' -baz dolor \"sit amet\"  -'quoted exclusion'"

  it('should correctly parse string queries', () => {
    // Act
    const query = new Query(stringQuery, {
      ignoreDiacritics: true,
      ignoreArabicDiacritics: true,
    })

    // Assert
    const segments = query.query.text
    expect(segments).toHaveLength(5)
    expect(segments).toContain('foo')
    expect(segments).toContain('bar')
    expect(segments).toContain('lorem ipsum')
    expect(segments).toContain('dolor')
    expect(segments).toContain('sit amet')

    const exclusions = query.query.exclude.text
    expect(exclusions).toHaveLength(2)
    expect(exclusions).toContain('baz')
    expect(exclusions).toContain('quoted exclusion')
  })

  it('searches a word with a parenthesis inside it exactly as typed', () => {
    const options = { ignoreDiacritics: true, ignoreArabicDiacritics: true }
    expect(new Query('foo(bar', options).getExactTerms()).toEqual(['foo(bar'])
    expect(new Query('Foo(Bar) baz', options).getExactTerms()).toEqual(['foo(bar)'])
    // An escaped parenthesis is the same text without its backslash.
    expect(new Query('foo\\(bar', options).getExactTerms()).toEqual(['foo(bar'])
    // Parentheses at the edge of a word are only punctuation.
    expect(new Query('(foo bar)', options).getExactTerms()).toEqual([])
  })

  it('searches the query-syntax characters of free text exactly as typed', () => {
    const options = { ignoreDiacritics: true, ignoreArabicDiacritics: true }
    // `AI LLM*` must not behave like `AI LLM`: the asterisk is part of the text.
    expect(new Query('AI LLM*', options).getExactTerms()).toEqual(['llm*'])
    expect(new Query('foo:bar', options).getExactTerms()).toEqual(['foo:bar'])
    expect(new Query('R&D x^2 a=b', options).getExactTerms()).toEqual(['r&d', 'x^2', 'a=b'])
    // Sentence punctuation and exclusions are left alone.
    expect(new Query('what? wow! (maybe)', options).getExactTerms()).toEqual([])
    expect(new Query('meeting -foo:bar', options).getExactTerms()).toEqual([])
  })

  it('should not exclude words when there is no space before', () => {
    // Act
    const query = new Query('foo bar-baz', {
      ignoreDiacritics: true,
      ignoreArabicDiacritics: true,
    })

    // Assert
    expect(query.query.exclude.text).toHaveLength(0)
  })

  describe('.getExactTerms()', () => {
    it('should an array of strings containg "exact" values', () => {
      // Act
      const query = new Query(stringQuery, {
        ignoreDiacritics: true,
        ignoreArabicDiacritics: true,
      })

      // Assert
      expect(query.getExactTerms()).toEqual(['lorem ipsum', 'sit amet'])
    })
  })
})
