import { describe, expect, it } from 'vitest'
import { completeTrailingToken } from '../search/autocomplete'

describe('contextual trailing-token autocomplete', () => {
  it('completes only the final token from a duplicated MiniSearch suggestion', () => {
    expect(completeTrailingToken('machine learn', ['machine learn learning'])).toBe('machine learning')
  })

  it('uses a whole-phrase suggestion without duplicating previous tokens', () => {
    expect(completeTrailingToken('machine learn', ['machine learning'])).toBe('machine learning')
  })

  it('preserves the previously typed query prefix', () => {
    expect(completeTrailingToken('project machine learn', ['project machine learn learning'])).toBe('project machine learning')
  })

  it('does not suggest when the final token is already complete or contains syntax delimiters', () => {
    expect(completeTrailingToken('machine learning', ['machine learning'])).toBeUndefined()
    expect(completeTrailingToken('"machine learn', ['learning'])).toBeUndefined()
    expect(completeTrailingToken('content:machine', ['machine learning'])).toBeUndefined()
  })
})
