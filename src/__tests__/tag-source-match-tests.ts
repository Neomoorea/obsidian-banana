import { describe, expect, it } from 'vitest'
import { findTagFrontmatterSourceMatch } from '../search/tag-source-match'

describe('frontmatter tag source locations', () => {
  it('maps a flow-style tags property to the exact tag value', () => {
    const source = '---\ntags: [work, research]\nstatus: active\n---\nBody text.'
    const match = findTagFrontmatterSourceMatch(source, 'research')
    expect(match).not.toBeNull()
    expect(source.slice(match!.offset, match!.offset + match!.match.length)).toBe('research')
  })

  it('maps a list-style nested tag path and supports CRLF', () => {
    const source = '---\r\ntags:\r\n  - machine-learning/research\r\n---\r\nBody text.'
    const match = findTagFrontmatterSourceMatch(source, 'machine-learning/research')
    expect(match).not.toBeNull()
    expect(source.slice(match!.offset, match!.offset + match!.match.length)).toBe('machine-learning/research')
  })

  it('highlights a hashtag in another frontmatter property', () => {
    const source = '---\ntopic: "#research"\nstatus: active\n---\nBody text.'
    const match = findTagFrontmatterSourceMatch(source, 'research')
    expect(match).not.toBeNull()
    expect(match!.match).toBe('#research')
    expect(source.slice(match!.offset, match!.offset + match!.match.length)).toBe('#research')
  })

  it('does not highlight unrelated frontmatter properties or body text', () => {
    const source = '---\nstatus: research\ntags: [work]\n---\nresearch'
    expect(findTagFrontmatterSourceMatch(source, 'research')).toBeNull()
  })
})
