import type { SearchMatch } from '../globals'

/**
 * Locate a tag value in YAML frontmatter. Obsidian exposes frontmatter tags as
 * metadata even when the source spells them as `tags: [research]` rather than
 * the inline Markdown spelling `#research`; returning a source range here lets
 * result navigation highlight the actual value without guessing an offset.
 */
export function findTagFrontmatterSourceMatch(source: string, tagPath: string): SearchMatch | null {
  const frontmatterMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source)
  if (!frontmatterMatch) return null

  const frontmatter = frontmatterMatch[1]
  const frontmatterOffset = frontmatterMatch.index + frontmatterMatch[0].indexOf(frontmatter)
  const escapedTag = tagPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const tokenPattern = new RegExp(`(?<![\\w/-])#?${escapedTag}(?![\\w/-])`, 'iu')
  const lines = frontmatter.split(/\r?\n/u)
  let offset = frontmatterOffset
  let tagPropertyIndent: number | null = null

  let explicitTagInFrontmatter: SearchMatch | null = null
  for (const line of lines) {
    const property = /^(\s*)(?:tags?|tag)\s*:\s*(.*)$/iu.exec(line)
    if (property) {
      tagPropertyIndent = property[1].length
      const value = property[2]
      const found = tokenPattern.exec(value)
      if (found?.index !== undefined) {
        return { match: found[0], offset: offset + line.indexOf(value) + found.index }
      }
    } else if (tagPropertyIndent !== null) {
      if (!line.trim() || /^\s*#/u.test(line)) {
        // Blank/comment lines may appear between YAML list entries.
      } else {
        const indentation = /^\s*/u.exec(line)?.[0].length ?? 0
        if (indentation <= tagPropertyIndent) {
          tagPropertyIndent = null
        } else {
          const listItem = /^\s*-\s*(.*?)\s*$/u.exec(line)
          if (listItem) {
            const value = listItem[1]
            const found = tokenPattern.exec(value)
            if (found?.index !== undefined) {
              return { match: found[0], offset: offset + line.indexOf(value) + found.index }
            }
          }
        }
      }
    }

    // Obsidian recognizes hashtags in frontmatter values outside the canonical
    // `tags:` property too (for example `topic: "#research"`). Metadata still
    // makes `tag:#research` a semantic predicate, so point navigation should
    // highlight that exact source token rather than falling back to the title.
    if (!explicitTagInFrontmatter && line.includes('#')) {
      const explicitTagPattern = new RegExp(`(?<![\\w/-])#${escapedTag}(?![\\w/-])`, 'iu')
      const explicit = explicitTagPattern.exec(line)
      if (explicit?.index !== undefined) {
        explicitTagInFrontmatter = {
          match: explicit[0],
          offset: offset + explicit.index,
        }
      }
    }
    offset += line.length + (source.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : source[offset + line.length] === '\n' ? 1 : 0)
  }
  return explicitTagInFrontmatter
}
